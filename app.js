// 내 자동매매 PWA — 화면 로직.
// 위쪽: 순수 함수 (DOM 없음, node --test 대상) / 아래쪽: DOM 렌더링 (브라우저에서만 boot()).
// 보안: 외부 데이터는 textContent 로만 넣는다. style 속성 금지 (CSP) — 동적 값은 CSS 변수(CSSOM)로.
import {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  GitHubClient,
  GitHubError,
  REQUEST_ID_PATTERN,
  buildRequest,
  kstParts,
  validateConnection,
} from "./github.js";
import {
  buildComparisonChart,
  buildDrawdownChart,
  gaugeFraction,
  nearestIndex,
  prepareComparison,
} from "./charts.js";

export const APP_VERSION = "1.0.1";
export const SNAPSHOT_SCHEMA = 1;
// 샘플 모드 (?sample=1): 같은 출처의 합성 예시 스냅샷만 읽는다 — 토큰·GitHub 호출·요청 전송·저장소 쓰기 없음
export const SAMPLE_PARAM = "sample";
export const SAMPLE_TAB_PARAM = "tab";
export const SAMPLE_URL = "sample/snapshot.json";
export const STORAGE_KEYS = Object.freeze({
  connection: "stockdash.connection",   // {owner, repo}
  token: "stockdash.token",             // fine-grained 토큰 (이 기기 localStorage 에만)
  cache: "stockdash.snapshot",          // {owner, repo, fetched_at, text}
  pending: "stockdash.pending",         // 보냈지만 스냅샷에 아직 안 보이는 요청
  tab: "stockdash.tab",
});

export const DEFAULT_CUMULATIVE_STOP = 0.18;
export const DEFAULT_MDD_LIMIT = 0.2;
export const PENDING_MAX_AGE_DAYS = 14;
export const PENDING_MAX_COUNT = 30;
export const STALE_SNAPSHOT_HOURS = 30;      // 화~금: 이보다 오래된 스냅샷은 경고 (거래일 하루 1회 이상 동기화 가정)
export const STALE_SNAPSHOT_HOURS_WEEKEND = 78;   // 토·일·월: 금요일 오후 스냅샷이 월요일 밤까지 유효
export const AUTO_REFRESH_MINUTES = 5;       // 앱으로 돌아왔을 때 이보다 오래됐으면 자동 새로고침
export const TOAST_MS = 4500;
export const FLOAT_EPS = 1e-9;
export const RATIO_DIGITS = 6;
export const PAUSE_KEY = "live.paused";
export const RISK_KEYS = Object.freeze({
  derisk: "risk.drawdown_derisk",
  halt: "risk.drawdown_halt",
  cumulativeStop: "risk.cumulative_stop",
});
export const FIELD_TYPES = Object.freeze(["bool", "float", "int", "choice"]);
const ALLOCATION_KEY_RE = /^sleeves\.[^.]+\.allocation$/;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const MINUS = "−";
const EMPTY = "—";

export const RUN_STATUS_LABELS = Object.freeze({
  OK: "정상 완료",
  SKIPPED: "건너뜀",
  STALE: "데이터 지연",
  HALTED: "중지 상태",
  KILLED: "완전 중지",
  ERROR: "오류",
  SENDING: "전송 중 중단",
});
export const PHASE_LABELS = Object.freeze({ open: "시가", refill: "보충" });
export const SIDE_LABELS = Object.freeze({ BUY: "매수", SELL: "매도" });
export const MODE_LABELS = Object.freeze({ paper: "모의투자", real: "실전", dry: "점검" });
const MODE_CHIP_LABELS = Object.freeze({ paper: "모의", real: "실전", dry: "점검" });   // 상단 좁은 칩용
export const RISK_KIND_LABELS = Object.freeze({
  DERISK: "증액 축소",
  HALT: "매매 중지",
  KILL: "완전 중지",
  RESUME: "매매 재개",
  RESET: "중지 해제",
  HARD_STOP: "종목 손절",
  DAILY_PAUSE: "일간 손실 제한",
  CAP: "비중 상한",
  BLOCKED: "주문 차단",
});
export const CHOICE_LABELS = Object.freeze({
  monthly: "매월",
  weekly: "매주",
  rsi_pullback: "RSI 눌림목",
  donchian_breakout: "돈키안 돌파",
  etf_dual_momentum: "ETF 듀얼 모멘텀",
});
export const BOOL_LABELS = Object.freeze({ [PAUSE_KEY]: ["매매 중", "일시정지"] });
export const REQUEST_STATUS_LABELS = Object.freeze({
  applied: "적용됨",
  rejected: "거부됨",
  pending: "PC 처리 대기",
  submitted: "보냄 · PC 동기화 대기",
});
export const COMMAND_LABELS = Object.freeze({ reset_halt: "중지 해제 (고점 재설정)" });
const REQUEST_STATUSES = ["applied", "rejected", "pending"];

// ================================================================ 숫자·날짜 표기

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const numberFormats = new Map();
function numberFormat(digits) {
  if (!numberFormats.has(digits)) {
    numberFormats.set(digits, new Intl.NumberFormat("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return numberFormats.get(digits);
}

/** 천단위 콤마. 음수는 U+2212. 반올림해서 0 이면 부호 없음. 숫자가 아니면 "—". */
export function formatNumber(value, digits = 0) {
  if (!isFiniteNumber(value)) return EMPTY;
  const rounded = Number(Math.abs(value).toFixed(digits));
  const text = numberFormat(digits).format(rounded);
  return value < 0 && rounded !== 0 ? `${MINUS}${text}` : text;
}

function signPrefix(value, digits) {
  const rounded = Number(Math.abs(value).toFixed(digits));
  if (rounded === 0) return "";
  return value > 0 ? "+" : MINUS;
}

export function formatWon(value) {
  return isFiniteNumber(value) ? `${formatNumber(value)}원` : EMPTY;
}

/** 부호 표기 금액: +12,345원 / −12,345원 / 0원 (색맹 대응: 색과 함께 부호). */
export function formatSignedWon(value) {
  if (!isFiniteNumber(value)) return EMPTY;
  return `${signPrefix(value, 0)}${formatNumber(Math.abs(value))}원`;
}

/** 큰 금액 축약: 1.04억원 / 1,035만원 / 9,800원. */
export function formatWonCompact(value) {
  if (!isFiniteNumber(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${formatNumber(value / 1e8, 2)}억원`;
  if (abs >= 1e4) return `${formatNumber(value / 1e4, 0)}만원`;
  return formatWon(value);
}

export function formatPercent(ratio, digits = 1) {
  return isFiniteNumber(ratio) ? `${formatNumber(ratio * 100, digits)}%` : EMPTY;
}

export function formatSignedPercent(ratio, digits = 2) {
  if (!isFiniteNumber(ratio)) return EMPTY;
  const pct = ratio * 100;
  return `${signPrefix(pct, digits)}${formatNumber(Math.abs(pct), digits)}%`;
}

/** 손익 색 클래스: up(이익·빨강) / down(손실·파랑) / flat. */
export function signClass(value, eps = 1e-12) {
  if (!isFiniteNumber(value) || Math.abs(value) <= eps) return "flat";
  return value > 0 ? "up" : "down";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseTime(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** ISO 시각 → KST "2026-10-15 09:31". */
export function formatKstDateTime(iso) {
  const ms = parseTime(iso);
  if (ms === null) return EMPTY;
  const p = kstParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** ISO 시각 → KST "10/15 09:31". */
export function formatKstShort(iso) {
  const ms = parseTime(iso);
  if (ms === null) return EMPTY;
  const p = kstParts(ms);
  return `${p.month}/${p.day} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "2026-10-15" → "10/15". */
export function formatShortDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return match ? `${Number(match[2])}/${Number(match[3])}` : EMPTY;
}

export function formatRelativeTime(thenMs, nowMs) {
  if (!isFiniteNumber(thenMs) || !isFiniteNumber(nowMs)) return EMPTY;
  const diff = nowMs - thenMs;
  if (diff < MS_PER_MINUTE) return "방금";
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}분 전`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}시간 전`;
  return `${Math.floor(diff / MS_PER_DAY)}일 전`;
}

export function snapshotAgeHours(generatedAt, nowMs) {
  const ms = parseTime(generatedAt);
  return ms === null || !isFiniteNumber(nowMs) ? null : (nowMs - ms) / MS_PER_HOUR;
}

/** 스냅샷이 오래됐는지 (PC 동기화 멈춤 의심). 주말을 지나는 동안은 기준을 늘린다. 공휴일은 고려하지 않음. */
export function isSnapshotStale(generatedAt, nowMs) {
  const age = snapshotAgeHours(generatedAt, nowMs);
  if (age === null) return false;
  const weekday = new Date(nowMs + 9 * MS_PER_HOUR).getUTCDay();   // KST 요일 (0=일)
  const limit = weekday === 0 || weekday === 1 || weekday === 6 ? STALE_SNAPSHOT_HOURS_WEEKEND : STALE_SNAPSHOT_HOURS;
  return age > limit;
}

// ================================================================ 낙폭·상태

/** 고점 대비 낙폭 (양수 비율). 고점이 없거나 0 이하면 0. */
export function drawdownFrom(equity, peak) {
  if (!isFiniteNumber(equity) || !isFiniteNumber(peak) || peak <= 0) return 0;
  return Math.max(0, 1 - equity / peak);
}

export function cumulativeReturn(equity, initialCapital) {
  if (!isFiniteNumber(equity) || !isFiniteNumber(initialCapital) || initialCapital <= 0) return null;
  return equity / initialCapital - 1;
}

/** 상태 배지: 완전중지 > 중지 > 일시정지 > 정상. */
export function tradingState(status) {
  if (!status) return { level: "unknown", label: "알 수 없음", detail: "스냅샷이 없습니다." };
  if (status.killed) {
    return { level: "killed", label: "완전중지", detail: "누적 낙폭 한도에 도달해 전량 청산했습니다. 수동 해제 전까지 매매하지 않습니다." };
  }
  if (status.halted) {
    return { level: "halted", label: "중지", detail: "고점 대비 낙폭 한도에 도달해 매매를 멈췄습니다. 수동 해제가 필요합니다." };
  }
  if (status.paused) return { level: "paused", label: "일시정지", detail: "사용자 요청으로 주문을 내지 않습니다 (보유 종목 유지)." };
  return { level: "ok", label: "정상", detail: "자동매매가 동작 중입니다." };
}

export function canResetHalt(status) {
  return Boolean(status && (status.halted || status.killed));
}

/** 낙폭 단계: ok < caution(증액 축소) < warning(매매 중지) < critical(누적 중지). */
export function drawdownSeverity(value, limits) {
  if (!isFiniteNumber(value)) return "ok";
  if (isFiniteNumber(limits.cumulativeStop) && value >= limits.cumulativeStop - FLOAT_EPS) return "critical";
  if (isFiniteNumber(limits.halt) && value >= limits.halt - FLOAT_EPS) return "warning";
  if (isFiniteNumber(limits.derisk) && value >= limits.derisk - FLOAT_EPS) return "caution";
  return "ok";
}

// ================================================================ 스냅샷 파싱 (C8 schema 1)

export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotError";
  }
}

const num = (v) => (isFiniteNumber(v) ? v : null);
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
const strOrNull = (v) => (typeof v === "string" && v ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);
const bool = (v) => v === true;
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function byDateDesc(a, b) {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

/** 날짜별 1행 (뒤에 온 행 우선), 오름차순. */
function dateSeries(rows, valueKey, extraKeys = []) {
  const map = new Map();
  for (const raw of arr(rows)) {
    const row = obj(raw);
    if (!row || !DATE_RE.test(str(row.date)) || !isFiniteNumber(row[valueKey])) continue;
    const item = { date: row.date, [valueKey]: row[valueKey] };
    for (const key of extraKeys) item[key] = num(row[key]);
    map.set(row.date, item);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function parsePosition(raw, equity) {
  const row = obj(raw);
  if (!row || !str(row.symbol)) return null;
  const quantity = num(row.quantity) ?? 0;
  const lastPrice = num(row.last_price);
  const avgPrice = num(row.avg_price);
  const marketValue = num(row.market_value) ?? (lastPrice !== null ? quantity * lastPrice : null);
  return {
    symbol: row.symbol,
    name: str(row.name) || row.symbol,
    sleeve: str(row.sleeve),
    quantity,
    avg_price: avgPrice,
    last_price: lastPrice,
    market_value: marketValue,
    weight: num(row.weight) ?? (marketValue !== null && equity > 0 ? marketValue / equity : null),
    unrealized_return: num(row.unrealized_return)
      ?? (avgPrice && lastPrice !== null && avgPrice > 0 ? lastPrice / avgPrice - 1 : null),
    entry_date: strOrNull(row.entry_date),
  };
}

function parseFieldSpec(raw) {
  const spec = obj(raw);
  if (!spec || !str(spec.key) || !FIELD_TYPES.includes(spec.type)) return null;
  return {
    key: spec.key,
    label: str(spec.label) || spec.key,
    type: spec.type,
    value: spec.value,
    min: num(spec.min),
    max: num(spec.max),
    options: spec.type === "choice" ? arr(spec.options).filter((o) => typeof o === "string") : [],
    help: str(spec.help),
  };
}

function parseRequest(raw) {
  const r = obj(raw);
  if (!r || !str(r.id)) return null;
  return {
    id: r.id,
    submitted_at: strOrNull(r.submitted_at),
    status: REQUEST_STATUSES.includes(r.status) ? r.status : "pending",
    message: str(r.message),
    changes: obj(r.changes) ?? {},
    commands: arr(r.commands).filter((c) => typeof c === "string"),
    processed_at: strOrNull(r.processed_at),
  };
}

/**
 * 스냅샷 JSON(문자열 또는 객체) → 정규화된 객체. schema 불일치·형식 오류는 SnapshotError.
 * 빠진 배열은 [], 숫자가 아닌 값은 null 로 둔다 (화면은 "—" 표시).
 */
export function parseSnapshot(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new SnapshotError("스냅샷 JSON 형식이 올바르지 않습니다.");
    }
  }
  const root = obj(data);
  if (!root) throw new SnapshotError("스냅샷 내용이 비어 있습니다.");
  if (root.schema !== SNAPSHOT_SCHEMA) {
    throw new SnapshotError(`지원하지 않는 스냅샷 형식입니다 (schema ${String(root.schema)}). 앱을 최신 버전으로 새로고침하세요.`);
  }

  const statusRaw = obj(root.status) ?? {};
  const lastRunRaw = obj(statusRaw.last_run);
  const status = {
    last_run: lastRunRaw
      ? {
          date: str(lastRunRaw.date),
          status: str(lastRunRaw.status),
          phase: str(lastRunRaw.phase),
          run_id: str(lastRunRaw.run_id),
          message: str(lastRunRaw.message),
        }
      : null,
    paused: bool(statusRaw.paused),
    halted: bool(statusRaw.halted),
    killed: bool(statusRaw.killed),
    drawdown: num(statusRaw.drawdown),
    cumulative_drawdown: num(statusRaw.cumulative_drawdown),
    peak_equity: num(statusRaw.peak_equity),
    all_time_peak: num(statusRaw.all_time_peak),
    next_action: str(statusRaw.next_action),
  };

  const accountRaw = obj(root.account) ?? {};
  const equity = num(accountRaw.equity);
  const cash = num(accountRaw.cash);
  const account = {
    asof: strOrNull(accountRaw.asof),
    cash,
    equity,
    invested_ratio: num(accountRaw.invested_ratio)
      ?? (equity !== null && cash !== null && equity > 0 ? 1 - cash / equity : null),
    positions: arr(accountRaw.positions).map((p) => parsePosition(p, equity ?? 0)).filter(Boolean),
  };

  const sleeves = arr(root.sleeves)
    .map(obj)
    .filter((s) => s && str(s.name))
    .map((s) => ({
      name: s.name,
      label: str(s.label) || s.name,
      strategy: str(s.strategy),
      allocation: num(s.allocation),
      value: num(s.value),
      weight: num(s.weight),
    }));

  const recentOrders = arr(root.recent_orders)
    .map(obj)
    .filter((o) => o && str(o.symbol))
    .map((o) => ({
      date: str(o.date),
      phase: str(o.phase),
      symbol: o.symbol,
      name: str(o.name) || o.symbol,
      side: str(o.side),
      quantity: num(o.quantity),
      ref_price: num(o.ref_price),
      accepted: bool(o.accepted),
      message: str(o.message),
      sleeve: str(o.sleeve),
    }))
    .sort(byDateDesc);

  const recentFills = arr(root.recent_fills)
    .map(obj)
    .filter((f) => f && str(f.symbol))
    .map((f) => ({
      date: str(f.date),
      symbol: f.symbol,
      name: str(f.name) || f.symbol,
      side: str(f.side),
      quantity: num(f.quantity),
      price: num(f.price),
      commission: num(f.commission),
      tax: num(f.tax),
      sleeve: str(f.sleeve),
    }))
    .sort(byDateDesc);

  const riskEvents = arr(root.risk_events)
    .map(obj)
    .filter((e) => e && str(e.kind))
    .map((e) => ({ date: str(e.date), kind: e.kind, message: str(e.message), symbol: strOrNull(e.symbol) }))
    .sort(byDateDesc);

  const backtestRaw = obj(root.backtest);
  const backtest = backtestRaw
    ? {
        report_dir: str(backtestRaw.report_dir),
        generated: str(backtestRaw.generated),
        rows: arr(backtestRaw.rows)
          .map(obj)
          .filter(Boolean)
          .map((r) => ({
            variant: str(r.variant),
            label: str(r.label) || str(r.variant),
            period: str(r.period),
            cagr: num(r.cagr),
            mdd: num(r.mdd),
            sharpe: num(r.sharpe),
            win_rate: num(r.win_rate),
            round_trips: num(r.round_trips),
            pass_mdd: boolOrNull(r.pass_mdd),
          })),
      }
    : null;

  const settingsRaw = obj(root.settings) ?? {};
  const readonlyRaw = obj(settingsRaw.readonly) ?? {};
  const settings = {
    editable: arr(settingsRaw.editable).map(parseFieldSpec).filter(Boolean),
    readonly: {
      mode: str(readonlyRaw.mode),
      real_trading_enabled: bool(readonlyRaw.real_trading_enabled),
      max_order_value: num(readonlyRaw.max_order_value),
      mdd_limit: num(readonlyRaw.mdd_limit),
      initial_capital: num(readonlyRaw.initial_capital),
    },
  };

  const requests = arr(root.requests)
    .map(parseRequest)
    .filter(Boolean)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  return {
    schema: SNAPSHOT_SCHEMA,
    generated_at: str(root.generated_at),
    mode: str(root.mode),
    status,
    account,
    equity_history: dateSeries(root.equity_history, "equity", ["cash"]),
    benchmark_history: dateSeries(root.benchmark_history, "close"),
    sleeves,
    recent_orders: recentOrders,
    recent_fills: recentFills,
    risk_events: riskEvents,
    backtest,
    settings,
    requests,
  };
}

/** 요약 화면 수치. 낙폭은 스냅샷 값을 우선하고 없으면 자산·고점으로 계산. */
export function summaryMetrics(snapshot) {
  const { account, status, settings } = snapshot;
  const initial = settings.readonly.initial_capital;
  const equity = account.equity;
  return {
    equity,
    cash: account.cash,
    investedRatio: account.invested_ratio,
    initialCapital: initial,
    totalReturn: cumulativeReturn(equity, initial),
    totalPnl: isFiniteNumber(equity) && isFiniteNumber(initial) ? equity - initial : null,
    drawdown: status.drawdown ?? drawdownFrom(equity, status.peak_equity),
    cumulativeDrawdown: status.cumulative_drawdown ?? drawdownFrom(equity, status.all_time_peak),
  };
}

export function riskLimits(snapshot) {
  const values = effectiveValues(snapshot?.settings?.editable ?? [], {});
  return {
    derisk: num(values[RISK_KEYS.derisk]),
    halt: num(values[RISK_KEYS.halt]),
    cumulativeStop: num(values[RISK_KEYS.cumulativeStop]) ?? DEFAULT_CUMULATIVE_STOP,
    mddLimit: num(snapshot?.settings?.readonly?.mdd_limit) ?? DEFAULT_MDD_LIMIT,
  };
}

/** 슬리브별 보유 묶음 (+ 슬리브에 없는 종목은 "기타"). 평가액 큰 순. */
export function groupPositions(snapshot) {
  const groups = snapshot.sleeves.map((sleeve) => ({ sleeve, positions: [] }));
  const byName = new Map(groups.map((g) => [g.sleeve.name, g]));
  let other = null;
  for (const position of snapshot.account.positions) {
    let group = byName.get(position.sleeve);
    if (!group) {
      if (!other) {
        other = { sleeve: { name: "", label: "기타 (슬리브 밖)", strategy: "", allocation: null, value: null, weight: null }, positions: [] };
      }
      group = other;
    }
    group.positions.push(position);
  }
  if (other) groups.push(other);
  for (const group of groups) {
    group.positions.sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0));
    let marketValue = 0;
    let cost = 0;
    for (const p of group.positions) {
      marketValue += p.market_value ?? 0;
      if (isFiniteNumber(p.avg_price)) cost += p.quantity * p.avg_price;
    }
    group.marketValue = marketValue;
    group.unrealized = group.positions.length ? marketValue - cost : 0;
    group.unrealizedReturn = cost > 0 ? marketValue / cost - 1 : null;
  }
  return groups;
}

// ================================================================ 설정 폼 (FieldSpec)

/** 0~1 범위 float 는 % 로 보여주고 입력받는다 (배분·낙폭 임계값). */
export function isRatioField(spec) {
  return spec.type === "float" && isFiniteNumber(spec.min) && isFiniteNumber(spec.max) && spec.min >= 0 && spec.max <= 1;
}

function trimZeros(text) {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** 0.125 → "12.5", 0.15 → "15". */
export function ratioToPercentText(ratio) {
  return isFiniteNumber(ratio) ? trimZeros((ratio * 100).toFixed(2)) : "";
}

export function choiceLabel(value) {
  return CHOICE_LABELS[value] ?? String(value);
}

/** 화면 표시용 값 문자열. */
export function fieldDisplay(spec, value) {
  if (value === undefined || value === null) return EMPTY;
  switch (spec.type) {
    case "bool": {
      const labels = BOOL_LABELS[spec.key] ?? ["끔", "켬"];
      return value === true ? labels[1] : value === false ? labels[0] : String(value);
    }
    case "float":
      if (!isFiniteNumber(value)) return String(value);
      return isRatioField(spec) ? `${ratioToPercentText(value)}%` : String(value);
    case "int":
      return String(value);
    case "choice":
      return choiceLabel(value);
    default:
      return String(value);
  }
}

export function fieldRangeText(spec) {
  if (spec.type === "choice") return spec.options.map(choiceLabel).join(" · ");
  if (spec.type === "bool") return "";
  const lo = spec.min !== null ? fieldDisplay(spec, spec.min) : "";
  const hi = spec.max !== null ? fieldDisplay(spec, spec.max) : "";
  if (lo && hi) return `범위 ${lo} ~ ${hi}`;
  if (lo) return `${lo} 이상`;
  if (hi) return `${hi} 이하`;
  return "";
}

/** 입력칸 초기 문자열 (비율은 % 숫자). */
export function fieldInputText(spec, value) {
  if (value === undefined || value === null) return "";
  if (spec.type === "float" && isRatioField(spec)) return ratioToPercentText(value);
  return String(value);
}

/** FieldSpec 범위·타입 검사. 오류 문장 또는 null. */
export function validateFieldValue(spec, value) {
  const label = spec.label;
  switch (spec.type) {
    case "bool":
      return typeof value === "boolean" ? null : `${label}: 켬/끔 값이어야 합니다.`;
    case "choice":
      return spec.options.includes(value) ? null : `${label}: ${spec.options.map(choiceLabel).join(", ")} 중 하나여야 합니다.`;
    case "int":
      if (!Number.isInteger(value)) return `${label}: 정수여야 합니다.`;
      break;
    case "float":
      if (!isFiniteNumber(value)) return `${label}: 숫자여야 합니다.`;
      break;
    default:
      return `${label}: 알 수 없는 형식입니다.`;
  }
  const belowMin = spec.min !== null && value < spec.min - FLOAT_EPS;
  const aboveMax = spec.max !== null && value > spec.max + FLOAT_EPS;
  if (belowMin || aboveMax) {
    const range = fieldRangeText(spec).replace(/^범위 /, "");
    return `${label}: ${range} 범위여야 합니다.`;
  }
  return null;
}

/** 입력 문자열 → {value} 또는 {value?, error}. 비율 필드는 % 숫자를 소수로 바꾼다. */
export function parseFieldInput(spec, raw) {
  let value;
  if (spec.type === "bool") {
    if (typeof raw !== "boolean") return { error: `${spec.label}: 켬/끔 값이어야 합니다.` };
    value = raw;
  } else if (spec.type === "choice") {
    value = raw;
  } else if (spec.type === "int") {
    const text = String(raw ?? "").trim();
    if (!/^[-+]?\d+$/.test(text)) return { error: `${spec.label}: 정수를 입력하세요.` };
    value = Number(text);
  } else if (spec.type === "float") {
    const text = String(raw ?? "").trim().replace(/%$/, "").trim();
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { error: `${spec.label}: 숫자를 입력하세요.` };
    const number = Number(text);
    value = isRatioField(spec) ? Number((number / 100).toFixed(RATIO_DIGITS)) : number;
  } else {
    return { error: `${spec.label}: 알 수 없는 형식입니다.` };
  }
  const error = validateFieldValue(spec, value);
  return error ? { value, error } : { value };
}

/** 현재 값 + 변경분 → {key: value}. */
export function effectiveValues(editable, changes = {}) {
  const values = {};
  for (const spec of editable) values[spec.key] = spec.value;
  for (const [key, value] of Object.entries(changes)) values[key] = value;
  return values;
}

function sameValue(spec, a, b) {
  if (spec.type === "float") return isFiniteNumber(a) && isFiniteNumber(b) && Math.abs(a - b) <= FLOAT_EPS;
  return a === b;
}

/** 폼 값 중 현재 값과 다른 것만. */
export function diffChanges(editable, values) {
  const changes = {};
  for (const spec of editable) {
    if (!Object.prototype.hasOwnProperty.call(values, spec.key)) continue;
    const next = values[spec.key];
    if (next === undefined) continue;
    if (!sameValue(spec, next, spec.value)) changes[spec.key] = next;
  }
  return changes;
}

function pctText(ratio) {
  return isFiniteNumber(ratio) ? `${ratioToPercentText(ratio)}%` : EMPTY;
}

/** 교차 제약 (적용 후 값 기준): 배분 합 ≤ 100%, 증액축소 < 매매중지 < 누적중지 ≤ MDD 한도. */
export function crossFieldErrors(values, readonly = {}) {
  const errors = [];
  const allocationKeys = Object.keys(values).filter((key) => ALLOCATION_KEY_RE.test(key));
  if (allocationKeys.length > 0) {
    const total = allocationKeys.reduce((sum, key) => sum + (isFiniteNumber(values[key]) ? values[key] : 0), 0);
    if (total > 1 + FLOAT_EPS) errors.push(`슬리브 배분 합계가 ${pctText(total)}로 100%를 넘습니다.`);
  }
  const derisk = num(values[RISK_KEYS.derisk]);
  const halt = num(values[RISK_KEYS.halt]);
  const stop = num(values[RISK_KEYS.cumulativeStop]);
  const mdd = num(readonly.mdd_limit);
  if (derisk !== null && halt !== null && !(derisk < halt - FLOAT_EPS)) {
    errors.push(`증액 축소 낙폭(${pctText(derisk)})은 매매 중지 낙폭(${pctText(halt)})보다 작아야 합니다.`);
  }
  if (halt !== null && stop !== null && !(halt < stop - FLOAT_EPS)) {
    errors.push(`매매 중지 낙폭(${pctText(halt)})은 누적 완전중지 낙폭(${pctText(stop)})보다 작아야 합니다.`);
  }
  if (stop !== null && mdd !== null && stop > mdd + FLOAT_EPS) {
    errors.push(`누적 완전중지 낙폭(${pctText(stop)})은 MDD 한도(${pctText(mdd)}) 이하여야 합니다.`);
  }
  return errors;
}

/** 변경 요청 전체 검사: 편집 가능 항목인지 + 항목별 범위 + 교차 제약. 빈 목록이면 OK (최종 판단은 PC). */
export function validateChanges(changes, editable, readonly = {}) {
  const specs = new Map(editable.map((spec) => [spec.key, spec]));
  const errors = [];
  for (const [key, value] of Object.entries(changes)) {
    const spec = specs.get(key);
    if (!spec) {
      errors.push(`편집할 수 없는 항목입니다: ${key}`);
      continue;
    }
    const error = validateFieldValue(spec, value);
    if (error) errors.push(error);
  }
  errors.push(...crossFieldErrors(effectiveValues(editable, changes), readonly));
  return errors;
}

/** 확인 대화상자용 변경 전후. */
export function describeChanges(changes, editable) {
  const specs = new Map(editable.map((spec) => [spec.key, spec]));
  return Object.keys(changes)
    .sort()
    .map((key) => {
      const spec = specs.get(key) ?? { key, label: key, type: "unknown", min: null, max: null, options: [] };
      return { key, label: spec.label, before: fieldDisplay(spec, spec.value), after: fieldDisplay(spec, changes[key]) };
    });
}

// ================================================================ 요청 기록

/** 스냅샷의 요청 + 이 기기에서 보낸 대기 요청 (스냅샷 쪽이 우선). 최신 순. */
export function mergeRequests(snapshotRequests = [], pending = []) {
  const map = new Map();
  for (const p of pending) {
    if (!p || !REQUEST_ID_PATTERN.test(String(p.id))) continue;   // 손상된 로컬 기록은 무시
    map.set(p.id, {
      id: p.id,
      submitted_at: p.created_at ?? null,
      status: "submitted",
      message: "",
      changes: p.changes ?? {},
      commands: p.commands ?? [],
      processed_at: null,
      local: true,
    });
  }
  for (const r of snapshotRequests) if (r && typeof r.id === "string") map.set(r.id, { ...r, local: false });
  return [...map.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 처리 완료(적용/거부)됐거나 오래된 로컬 대기 요청 제거. */
export function prunePending(pending, snapshotRequests, nowMs, maxAgeDays = PENDING_MAX_AGE_DAYS) {
  const done = new Set(
    snapshotRequests.filter((r) => r.status === "applied" || r.status === "rejected").map((r) => r.id),
  );
  const maxAgeMs = maxAgeDays * MS_PER_DAY;
  return arr(pending)
    .filter((p) => p && REQUEST_ID_PATTERN.test(String(p.id)) && !done.has(p.id))
    .filter((p) => {
      const created = parseTime(p.created_at);
      return created !== null && nowMs - created <= maxAgeMs;
    })
    .slice(-PENDING_MAX_COUNT);
}

/** 아직 처리 안 된 요청이 건드리는 항목 (폼 옆 "대기 중" 표시용). 명령은 "cmd:이름". */
export function openRequestKeys(merged) {
  const keys = new Set();
  for (const r of merged) {
    if (r.status !== "pending" && r.status !== "submitted") continue;
    for (const key of Object.keys(r.changes ?? {})) keys.add(key);
    for (const command of r.commands ?? []) keys.add(`cmd:${command}`);
  }
  return keys;
}

/** 요청 한 줄 요약: "스윙 최대 보유 수 → 4 · 중지 해제". */
export function summarizeRequest(request, editable) {
  const specs = new Map(editable.map((spec) => [spec.key, spec]));
  const parts = Object.keys(request.changes ?? {})
    .sort()
    .map((key) => {
      const spec = specs.get(key) ?? { key, label: key, type: "unknown", options: [] };
      return `${spec.label} → ${fieldDisplay(spec, request.changes[key])}`;
    });
  for (const command of request.commands ?? []) parts.push(COMMAND_LABELS[command] ?? command);
  return parts.join(" · ") || EMPTY;
}

// ================================================================ 실행 인자 (URL)

export const TABS = Object.freeze(["summary", "charts", "holdings", "activity", "backtest", "settings"]);

/** location.search → {sample, tab}. 샘플 모드는 정확히 ?sample=1 일 때만, tab 은 샘플 모드에서만 받는다. */
export function parseLaunchParams(search) {
  let params;
  try {
    params = new URLSearchParams(typeof search === "string" ? search : "");
  } catch {
    params = new URLSearchParams();
  }
  const sample = params.get(SAMPLE_PARAM) === "1";
  const tab = params.get(SAMPLE_TAB_PARAM);
  return { sample, tab: sample && TABS.includes(tab) ? tab : null };
}

// ================================================================ DOM (브라우저 전용)

const ACTIVITY_VIEWS = ["orders", "fills", "risk"];
const PULL_TRIGGER_PX = 64;
const PULL_MAX_PX = 96;
const PULL_RESISTANCE = 0.5;
const RESIZE_DEBOUNCE_MS = 150;
const TABLE_ROWS = 20;

const ICONS = {
  refresh: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg>',
};
const LEVEL_ICONS = { ok: "ok", paused: "pause", halted: "stop", killed: "stop", unknown: "alert" };
const REQUEST_ICONS = { applied: "ok", rejected: "x", pending: "clock", submitted: "clock" };

const state = {
  snapshot: null,
  fetchedAt: null,        // ms — 마지막으로 스냅샷을 받은(또는 캐시에 저장된) 시각
  source: "none",         // none | cache | network
  offline: false,
  loading: false,
  sending: false,
  error: null,
  tab: "summary",
  activity: "orders",
  pending: [],
  form: {},               // key → {raw, value, error}
  formBase: null,         // 폼을 만든 스냅샷의 generated_at
  swUpdated: false,
  sample: false,          // ?sample=1 — 합성 예시 스냅샷 (토큰·GitHub·요청 전송·localStorage 쓰기 없음)
};
let toastTimer = null;
let resizeTimer = null;

function $(id) {
  return document.getElementById(id);
}

/** 요소 생성 도우미. 텍스트는 항상 textContent (외부 데이터 안전). style 속성은 CSP 때문에 금지. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "style") throw new Error("style 속성 금지 (CSP)");
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function icon(name, extraClass = "") {
  const span = document.createElement("span");
  span.className = `icon ${extraClass}`.trim();
  span.innerHTML = ICONS[name] ?? "";   // 고정 문자열만 (외부 데이터 아님)
  return span;
}

function setVar(el, name, value) {
  el.style.setProperty(name, String(value));   // CSSOM — CSP style-src 와 무관
}

// ---------------------------------------------------------------- 저장소 (localStorage)

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // 저장소 접근 불가 — 무시
  }
}

function readJson(key, fallback) {
  const text = storageGet(key);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function loadConnection() {
  const saved = obj(readJson(STORAGE_KEYS.connection, null)) ?? {};
  return { owner: str(saved.owner) || DEFAULT_OWNER, repo: str(saved.repo) || DEFAULT_REPO };
}

function hasToken() {
  return Boolean(storageGet(STORAGE_KEYS.token));
}

function makeClient() {
  const { owner, repo } = loadConnection();
  return new GitHubClient({ owner, repo, token: storageGet(STORAGE_KEYS.token) ?? "" });
}

function loadCache() {
  const cache = obj(readJson(STORAGE_KEYS.cache, null));
  if (!cache || typeof cache.text !== "string") return null;
  const { owner, repo } = loadConnection();
  if (cache.owner !== owner || cache.repo !== repo) return null;
  try {
    return { snapshot: parseSnapshot(cache.text), fetchedAt: num(cache.fetched_at) };
  } catch {
    return null;
  }
}

function saveCache(text, fetchedAt) {
  const { owner, repo } = loadConnection();
  storageSet(STORAGE_KEYS.cache, JSON.stringify({ owner, repo, fetched_at: fetchedAt, text }));
}

function savePending() {
  storageSet(STORAGE_KEYS.pending, JSON.stringify(state.pending));
}

function userMessage(error) {
  if (error instanceof GitHubError || error instanceof SnapshotError) return error.message;
  return "예상하지 못한 오류가 발생했습니다. 다시 시도하세요.";
}

// ---------------------------------------------------------------- 데이터 갱신

/** 샘플 모드: 같은 출처의 sample/snapshot.json (HTTP 캐시 없이). 캐시·대기 요청 기록은 건드리지 않는다. */
async function loadSample({ manual = false } = {}) {
  state.loading = true;
  renderChrome();
  try {
    const response = await fetch(SAMPLE_URL, { cache: "no-store" });
    if (!response.ok) throw new SnapshotError(`샘플 스냅샷을 불러오지 못했습니다 (HTTP ${response.status}).`);
    state.snapshot = parseSnapshot(await response.text());
    state.fetchedAt = Date.now();
    state.source = "sample";
    state.error = null;
    syncForm();
    if (manual) toast("샘플 스냅샷을 다시 불러왔습니다.");
  } catch (error) {
    state.error = error instanceof SnapshotError ? error.message : "샘플 스냅샷을 불러오지 못했습니다.";
    console.warn("sample load failed:", error?.name ?? "error");
  } finally {
    state.loading = false;
    renderAll();
  }
}

async function refresh({ manual = false } = {}) {
  if (state.loading) return;
  if (state.sample) {
    await loadSample({ manual });
    return;
  }
  if (!hasToken()) {
    if (manual) toast("먼저 설정에서 GitHub 토큰을 저장하세요.");
    renderAll();
    return;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    state.offline = true;
    if (manual) toast("오프라인입니다. 저장된 스냅샷을 보여줍니다.");
    renderChrome();
    return;
  }
  state.loading = true;
  renderChrome();
  try {
    const text = await makeClient().fetchSnapshotText();
    const snapshot = parseSnapshot(text);
    const now = Date.now();
    state.snapshot = snapshot;
    state.fetchedAt = now;
    state.source = "network";
    state.offline = false;
    state.error = null;
    saveCache(text, now);
    state.pending = prunePending(state.pending, snapshot.requests, now);
    savePending();
    syncForm();
    if (manual) toast("최신 스냅샷을 불러왔습니다.");
  } catch (error) {
    if (error instanceof GitHubError && error.kind === "network") state.offline = true;
    state.error = userMessage(error);
    console.warn("snapshot refresh failed:", error?.kind ?? error?.name ?? "error");   // 토큰·응답 본문은 기록하지 않음
  } finally {
    state.loading = false;
    renderAll();
  }
}

async function sendRequest({ changes = {}, commands = [] }) {
  if (state.sending) return false;
  if (state.sample) {
    toast("샘플 모드에서는 요청을 보내지 않습니다 (화면 확인용).");
    return false;
  }
  if (!hasToken()) {
    toast("먼저 설정에서 GitHub 토큰을 저장하세요.");
    switchTab("settings");
    return false;
  }
  if (navigator.onLine === false) {
    toast("오프라인이라 요청을 보낼 수 없습니다.");
    return false;
  }
  state.sending = true;
  renderAll();
  try {
    const request = buildRequest({ changes, commands });
    await makeClient().putRequest(request);
    state.pending = [...state.pending, { id: request.id, created_at: request.created_at, changes: request.changes, commands: request.commands }];
    savePending();
    if (Object.keys(request.changes).some((key) => key !== PAUSE_KEY)) initForm();
    toast("요청을 보냈습니다. PC가 다음 동기화 때 검증 후 반영합니다.");
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.kind === "network") state.offline = true;
    toast(userMessage(error), "error");
    console.warn("request submit failed:", error?.kind ?? error?.name ?? "error");
    return false;
  } finally {
    state.sending = false;
    renderAll();
  }
}

// ---------------------------------------------------------------- 공통 UI

function toast(message, kind = "info") {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), TOAST_MS);
}

/** 확인 대화상자. body: Node | Node[]. 확인이면 true. */
function confirmDialog({ title, body, okLabel = "확인", cancelLabel = "취소", danger = false }) {
  const dialog = $("confirm-dialog");
  const nodes = [].concat(body ?? []);
  if (dialog?.open) return Promise.resolve(false);   // 이미 열린 확인창 위에 겹쳐 열지 않음
  if (!dialog || typeof dialog.showModal !== "function") {
    const text = [title, ...nodes.map((n) => n.textContent ?? "")].join("\n\n");
    return Promise.resolve(window.confirm(text));
  }
  $("confirm-title").textContent = title;
  $("confirm-body").replaceChildren(...nodes);
  const ok = $("confirm-ok");
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  $("confirm-cancel").textContent = cancelLabel;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
    (danger ? $("confirm-cancel") : ok).focus();
  });
}

function changesTable(rows) {
  return h(
    "table",
    { class: "diff-table" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "항목" }), h("th", { scope: "col", text: "지금" }), h("th", { scope: "col", text: "변경" }))),
    h(
      "tbody",
      {},
      rows.map((row) =>
        h("tr", {}, h("th", { scope: "row", text: row.label }), h("td", { text: row.before }), h("td", { class: "after", text: row.after })),
      ),
    ),
  );
}

function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h2", { class: "card-title", text: title }) : null, ...children);
}

function emptyState(message, action = null) {
  return h("div", { class: "empty" }, h("p", { text: message }), action);
}

function valueClass(value) {
  return `num ${signClass(value)}`;
}

function signedSpan(text, value) {
  return h("span", { class: valueClass(value), text });
}

function badge(text, kind, iconName = null) {
  return h("span", { class: `badge badge-${kind}` }, iconName ? icon(iconName) : null, h("span", { text }));
}

function noSnapshotPanel() {
  if (state.sample) {
    return card(null, h("p", { class: "muted", text: state.loading ? "샘플 스냅샷을 불러오는 중…" : state.error ?? "샘플 스냅샷이 없습니다." }));
  }
  if (!hasToken()) {
    return card(
      "GitHub 연결이 필요합니다",
      h("p", { class: "muted", text: "설정 탭에서 stock-data 저장소 전용 토큰을 저장하면 PC가 올린 최신 스냅샷을 볼 수 있습니다." }),
      h("button", { class: "btn primary", type: "button", text: "연결 설정으로", onclick: () => switchTab("settings") }),
    );
  }
  if (state.loading) return card(null, h("p", { class: "muted", text: "스냅샷을 불러오는 중…" }));
  return card(
    "스냅샷이 없습니다",
    h("p", { class: "muted", text: state.error ?? "아직 불러온 스냅샷이 없습니다. 새로고침하세요." }),
    h("button", { class: "btn", type: "button", text: "다시 불러오기", onclick: () => refresh({ manual: true }) }),
  );
}

// ---------------------------------------------------------------- 상단·배너·탭

function renderChrome() {
  const snapshot = state.snapshot;
  const modeChip = $("mode-chip");
  const mode = snapshot?.settings.readonly.mode || snapshot?.mode || "";
  modeChip.hidden = !mode;
  modeChip.textContent = MODE_CHIP_LABELS[mode] ?? mode;
  modeChip.title = MODE_LABELS[mode] ?? mode;
  modeChip.classList.toggle("chip-real", mode === "real");

  $("offline-chip").hidden = !state.offline;
  const refreshBtn = $("refresh-btn");
  refreshBtn.disabled = state.loading;
  refreshBtn.classList.toggle("spinning", state.loading);
  refreshBtn.setAttribute("aria-busy", state.loading ? "true" : "false");

  renderUpdatedText();

  const banner = $("banner");
  const messages = [];
  if (state.swUpdated) messages.push({ kind: "info", text: "새 버전이 설치되었습니다.", action: { label: "다시 열기", run: () => location.reload() } });
  if (state.sample) messages.push({ kind: "info", text: "샘플 데이터 화면입니다 (합성 예시 · 실제 계좌 아님). 요청은 보내지 않습니다." });
  if (state.error) messages.push({ kind: "error", text: state.error, action: { label: "다시 시도", run: () => refresh({ manual: true }) } });
  if (snapshot && !state.sample) {
    const age = snapshotAgeHours(snapshot.generated_at, Date.now());
    if (isSnapshotStale(snapshot.generated_at, Date.now())) {
      messages.push({ kind: "warn", text: `스냅샷이 ${Math.floor(age)}시간 전에 만들어졌습니다. PC 동기화가 멈췄는지 확인하세요.` });
    }
  }
  banner.replaceChildren(
    ...messages.map((m) =>
      h(
        "div",
        { class: `banner-item banner-${m.kind}`, role: m.kind === "error" ? "alert" : "status" },
        icon(m.kind === "error" ? "alert" : m.kind === "warn" ? "clock" : "ok"),
        h("span", { class: "banner-text", text: m.text }),
        m.action ? h("button", { class: "btn small", type: "button", text: m.action.label, onclick: m.action.run }) : null,
      ),
    ),
  );
  banner.hidden = messages.length === 0;

  for (const name of TABS) {
    const tab = $(`tab-${name}`);
    const panel = $(`panel-${name}`);
    const selected = state.tab === name;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function renderUpdatedText() {
  const updated = $("updated-text");
  if (state.loading) updated.textContent = "불러오는 중…";
  else if (state.sample) updated.textContent = "샘플 데이터 · 실제 계좌 아님";
  else if (state.fetchedAt) {
    const where = state.source === "cache" ? " · 저장된 스냅샷" : "";
    updated.textContent = `갱신 ${formatRelativeTime(state.fetchedAt, Date.now())}${where}`;
  } else updated.textContent = hasToken() ? "아직 불러오지 않음" : "연결 설정 필요";
}

function switchTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) return;
  const changed = state.tab !== name;
  state.tab = name;
  if (!state.sample) storageSet(STORAGE_KEYS.tab, name);
  renderChrome();
  if (name === "charts") renderCharts();
  if (changed) window.scrollTo({ top: 0 });
  if (focus) $(`tab-${name}`).focus();
}

// ---------------------------------------------------------------- ① 요약

function meter({ label, value, scaleMax, marks, severity, caption }) {
  const fill = h("div", { class: `meter-fill sev-${severity}` });
  setVar(fill, "--fill", gaugeFraction(value, scaleMax));
  const track = h("div", { class: "meter-track" }, fill);
  for (const mark of marks) {
    if (!isFiniteNumber(mark.value)) continue;
    const el = h("div", { class: `meter-mark mark-${mark.kind}`, title: mark.label }, h("span", { class: "meter-mark-label", text: mark.label }));
    setVar(el, "--at", gaugeFraction(mark.value, scaleMax));
    track.append(el);
  }
  return h(
    "div",
    { class: "meter", role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": String(Math.round(scaleMax * 1000) / 10), "aria-valuenow": String(Math.round((value ?? 0) * 1000) / 10), "aria-valuetext": `${formatPercent(value, 1)} (${caption})` },
    h("div", { class: "meter-head" }, h("span", { class: "meter-label", text: label }), h("strong", { class: `meter-value sev-text-${severity}`, text: formatPercent(value, 1) })),
    track,
    h("p", { class: "meter-caption", text: caption }),
  );
}

function renderSummary() {
  const panel = $("panel-summary");
  const snapshot = state.snapshot;
  if (!snapshot) {
    panel.replaceChildren(noSnapshotPanel());
    return;
  }
  const metrics = summaryMetrics(snapshot);
  const limits = riskLimits(snapshot);
  const trade = tradingState(snapshot.status);
  const merged = mergeRequests(snapshot.requests, state.pending);
  const open = openRequestKeys(merged);
  const pausedNow = currentPaused(snapshot);

  // 상태
  const actions = h("div", { class: "actions" });
  if (hasPauseControl(snapshot) && !snapshot.status.killed) {
    actions.append(
      h("button", {
        class: "btn",
        type: "button",
        disabled: state.sending || open.has(PAUSE_KEY) ? true : null,
        text: open.has(PAUSE_KEY) ? "요청 대기 중" : pausedNow ? "매매 재개 요청" : "일시정지 요청",
        onclick: () => onTogglePause(!pausedNow),
      }),
    );
  }
  if (canResetHalt(snapshot.status)) {
    actions.append(
      h("button", {
        class: "btn danger-outline",
        type: "button",
        disabled: state.sending || open.has("cmd:reset_halt") ? true : null,
        text: open.has("cmd:reset_halt") ? "해제 요청 대기 중" : "중지 해제…",
        onclick: onResetHalt,
      }),
    );
  }
  const statusCard = h(
    "section",
    { class: `card status-card level-${trade.level}` },
    h("div", { class: "status-head" }, badge(trade.label, trade.level, LEVEL_ICONS[trade.level])),
    h("p", { class: "status-detail", text: trade.detail }),
    snapshot.status.next_action ? h("p", { class: "next-action" }, icon("clock"), h("span", { text: snapshot.status.next_action })) : null,
    actions.childElementCount ? actions : null,
  );

  // 자산
  const heroCard = h(
    "section",
    { class: "card hero-card" },
    h("p", { class: "label", text: "총자산" }),
    h("p", { class: "hero", text: formatWon(metrics.equity) }),
    h(
      "p",
      { class: "hero-sub" },
      h("span", { class: "muted", text: "원금 대비 " }),
      signedSpan(formatSignedPercent(metrics.totalReturn), metrics.totalReturn),
      " ",
      signedSpan(`(${formatSignedWon(metrics.totalPnl)})`, metrics.totalPnl),
    ),
    h(
      "dl",
      { class: "kv" },
      h("div", {}, h("dt", { text: "현금" }), h("dd", { class: "num", text: `${formatWon(metrics.cash)} · ${formatPercent(isFiniteNumber(metrics.investedRatio) ? 1 - metrics.investedRatio : null)}` })),
      h("div", {}, h("dt", { text: "투자 비중" }), h("dd", { class: "num", text: formatPercent(metrics.investedRatio) })),
      h("div", {}, h("dt", { text: "운용 원금" }), h("dd", { class: "num", text: formatWon(metrics.initialCapital) })),
    ),
  );

  // 낙폭 게이지 (눈금 0 ~ MDD 한도)
  const scaleMax = Math.max(limits.mddLimit, limits.cumulativeStop, metrics.cumulativeDrawdown ?? 0, metrics.drawdown ?? 0);
  const riskCard = card(
    "낙폭",
    meter({
      label: "고점 대비 낙폭",
      value: metrics.drawdown,
      scaleMax,
      severity: drawdownSeverity(metrics.drawdown, { ...limits, cumulativeStop: null }),
      marks: [
        { value: limits.derisk, label: `축소 ${pctText(limits.derisk)}`, kind: "caution" },
        { value: limits.halt, label: `중지 ${pctText(limits.halt)}`, kind: "warning" },
      ],
      caption: `고점 ${formatWon(snapshot.status.peak_equity)} · ${pctText(limits.derisk)}부터 증액 축소, ${pctText(limits.halt)}에서 매매 중지`,
    }),
    meter({
      label: "누적 낙폭 (역대 고점 대비)",
      value: metrics.cumulativeDrawdown,
      scaleMax,
      severity: drawdownSeverity(metrics.cumulativeDrawdown, { derisk: limits.derisk, halt: limits.halt, cumulativeStop: limits.cumulativeStop }),
      marks: [{ value: limits.cumulativeStop, label: `한도 ${pctText(limits.cumulativeStop)}`, kind: "critical" }],
      caption: `역대 고점 ${formatWon(snapshot.status.all_time_peak)} · ${pctText(limits.cumulativeStop)} 도달 시 전량 청산 후 완전중지 (고점 재설정 없음)`,
    }),
  );

  // 마지막 실행
  const lastRun = snapshot.status.last_run;
  const runCard = card(
    "마지막 실행",
    lastRun
      ? h(
          "div",
          { class: "run" },
          h(
            "p",
            { class: "run-head" },
            h("strong", { text: `${formatShortDate(lastRun.date)} ${PHASE_LABELS[lastRun.phase] ?? lastRun.phase}` }),
            badge(RUN_STATUS_LABELS[lastRun.status] ?? lastRun.status, runStatusKind(lastRun.status)),
          ),
          lastRun.message ? h("p", { class: "muted", text: lastRun.message }) : null,
          h("p", { class: "muted small", text: `실행 ID ${lastRun.run_id || EMPTY}` }),
        )
      : h("p", { class: "muted", text: "아직 실행 기록이 없습니다." }),
    h(
      "dl",
      { class: "kv" },
      h("div", {}, h("dt", { text: "계좌 기준일" }), h("dd", { text: snapshot.account.asof ?? EMPTY })),
      h("div", {}, h("dt", { text: "스냅샷 생성" }), h("dd", { text: `${formatKstDateTime(snapshot.generated_at)} (${formatRelativeTime(parseTime(snapshot.generated_at), Date.now())})` })),
    ),
  );

  panel.replaceChildren(h("div", { class: "grid" }, statusCard, heroCard, riskCard, runCard));
}

function runStatusKind(status) {
  if (status === "OK") return "ok";
  if (status === "SKIPPED") return "neutral";
  if (status === "STALE" || status === "HALTED" || status === "SENDING") return "warn";
  return "error";
}

function hasPauseControl(snapshot) {
  return Boolean(snapshot?.settings.editable.some((spec) => spec.key === PAUSE_KEY && spec.type === "bool"));
}

function currentPaused(snapshot) {
  const spec = snapshot?.settings.editable.find((s) => s.key === PAUSE_KEY);
  return typeof spec?.value === "boolean" ? spec.value : Boolean(snapshot?.status.paused);
}

// ---------------------------------------------------------------- ② 차트

function legend(items) {
  return h(
    "ul",
    { class: "legend", "aria-label": "범례" },
    items.map((item) => h("li", {}, h("span", { class: `key key-${item.id}`, "aria-hidden": "true" }), h("span", { text: item.label }))),
  );
}

function chartBox(id) {
  return h("div", { class: "chart-box", id, tabindex: "0" });
}

function renderCharts() {
  const panel = $("panel-charts");
  const snapshot = state.snapshot;
  if (!snapshot) {
    panel.replaceChildren(noSnapshotPanel());
    return;
  }
  const comparison = prepareComparison(snapshot.equity_history, snapshot.benchmark_history);
  const limits = riskLimits(snapshot);

  const equityReadout = h("p", { class: "readout", "aria-live": "polite" });
  const ddReadout = h("p", { class: "readout", "aria-live": "polite" });
  const equityBox = chartBox("chart-equity");
  const ddBox = chartBox("chart-drawdown");
  const n = comparison.dates.length;
  const period = n ? `${comparison.dates[0]} ~ ${comparison.dates[n - 1]} · ${n}거래일` : "";

  panel.replaceChildren(
    card(
      "자산 vs KODEX 200",
      h("p", { class: "muted small", text: `기간 첫날 = 0% 로 맞춘 수익률 비교. ${period}` }),
      legend([{ id: "equity", label: "내 자산" }, { id: "benchmark", label: "KODEX 200 (069500)" }]),
      equityReadout,
      equityBox,
      dataTable(comparison),
    ),
    card(
      "고점 대비 낙폭",
      h("p", { class: "muted small", text: "이 기간 안의 고점 기준. 역대 고점 기준 누적 낙폭은 요약 탭 게이지를 보세요." }),
      ddReadout,
      ddBox,
    ),
  );

  const width = Math.floor(equityBox.clientWidth || panel.clientWidth || 320);
  const equityChart = buildComparisonChart({ width, comparison });
  equityBox.innerHTML = equityChart.svg;   // charts.js 가 모든 텍스트를 escape 함
  bindChart(equityBox, equityChart, {
    series: [
      { id: "equity", values: comparison.equityReturn },
      { id: "benchmark", values: comparison.benchmarkReturn },
    ],
    readout: equityReadout,
    describe: (i) => [
      h("span", { class: "readout-date", text: comparison.dates[i] }),
      readoutItem("equity", "내 자산", comparison.equityReturn[i], formatWon(comparison.equity[i])),
      readoutItem("benchmark", "KODEX 200", comparison.benchmarkReturn[i]),
    ],
  });

  const ddChart = buildDrawdownChart({
    width,
    comparison,
    thresholds: [
      { value: limits.halt, label: `중지 ${pctText(limits.halt)}`, id: "halt" },
      { value: limits.cumulativeStop, label: `누적 한도 ${pctText(limits.cumulativeStop)}`, id: "stop" },
    ],
  });
  ddBox.innerHTML = ddChart.svg;
  const ddNegative = comparison.drawdown.map((v) => (isFiniteNumber(v) ? -v : null));
  bindChart(ddBox, ddChart, {
    series: [{ id: "drawdown", values: ddNegative }],
    readout: ddReadout,
    describe: (i) => [
      h("span", { class: "readout-date", text: comparison.dates[i] }),
      h("span", { class: "readout-item" }, h("strong", { class: "num", text: formatPercent(comparison.drawdown[i], 1) }), h("span", { class: "muted", text: " 낙폭" })),
    ],
  });
}

function readoutItem(id, label, value, extra = "") {
  return h(
    "span",
    { class: "readout-item" },
    h("span", { class: `key key-${id}`, "aria-hidden": "true" }),
    h("strong", { class: valueClass(value), text: formatSignedPercent(value, 1) }),
    h("span", { class: "muted", text: ` ${label}${extra ? ` · ${extra}` : ""}` }),
  );
}

function dataTable(comparison) {
  const start = Math.max(0, comparison.dates.length - TABLE_ROWS);
  const rows = [];
  for (let i = comparison.dates.length - 1; i >= start; i -= 1) {
    rows.push(
      h(
        "tr",
        {},
        h("th", { scope: "row", text: comparison.dates[i] }),
        h("td", { class: "num", text: formatWon(comparison.equity[i]) }),
        h("td", { class: valueClass(comparison.equityReturn[i]), text: formatSignedPercent(comparison.equityReturn[i], 1) }),
        h("td", { class: valueClass(comparison.benchmarkReturn[i]), text: formatSignedPercent(comparison.benchmarkReturn[i], 1) }),
        h("td", { class: "num", text: formatPercent(comparison.drawdown[i], 1) }),
      ),
    );
  }
  return h(
    "details",
    { class: "table-details" },
    h("summary", { text: `표로 보기 (최근 ${Math.min(TABLE_ROWS, comparison.dates.length)}거래일)` }),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "data-table" },
        h("thead", {}, h("tr", {}, ["날짜", "자산", "내 수익률", "KODEX 200", "낙폭"].map((t) => h("th", { scope: "col", text: t })))),
        h("tbody", {}, rows),
      ),
    ),
  );
}

/** 십자선: 포인터·키보드로 가장 가까운 날짜에 맞춘다. */
function bindChart(box, chart, { series, readout, describe }) {
  const svg = box.querySelector("svg");
  if (!svg || chart.xs.length === 0) {
    readout.replaceChildren();
    return;
  }
  const info = { index: chart.xs.length - 1 };
  const group = svg.querySelector(".crosshair");
  const line = svg.querySelector(".crosshair-line");
  const dots = new Map([...svg.querySelectorAll(".crosshair-dot")].map((dot) => [dot.dataset.series, dot]));

  const show = (index, visible) => {
    info.index = index;
    readout.replaceChildren(...describe(index));
    if (!visible) {
      group.setAttribute("visibility", "hidden");
      return;
    }
    const x = chart.xs[index];
    group.setAttribute("visibility", "visible");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
    for (const s of series) {
      const dot = dots.get(s.id);
      if (!dot) continue;
      const v = s.values[index];
      if (isFiniteNumber(v)) {
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(chart.yOf(v)));
        dot.setAttribute("visibility", "visible");
      } else dot.setAttribute("visibility", "hidden");
    }
  };
  const fromPointer = (event) => {
    const rect = svg.getBoundingClientRect();
    const viewWidth = svg.viewBox.baseVal?.width || rect.width;
    const x = ((event.clientX - rect.left) * viewWidth) / (rect.width || 1);
    show(nearestIndex(chart.xs, x), true);
  };
  box.addEventListener("pointermove", fromPointer);
  box.addEventListener("pointerdown", fromPointer);
  box.addEventListener("pointerleave", () => show(chart.xs.length - 1, false));
  box.addEventListener("keydown", (event) => {
    const last = chart.xs.length - 1;
    const step = event.shiftKey ? 20 : 1;
    let next = info.index;
    if (event.key === "ArrowLeft") next = Math.max(0, info.index - step);
    else if (event.key === "ArrowRight") next = Math.min(last, info.index + step);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    show(next, true);
  });
  box.addEventListener("blur", () => show(chart.xs.length - 1, false));
  show(chart.xs.length - 1, false);
}

// ---------------------------------------------------------------- ③ 보유 종목

function renderHoldings() {
  const panel = $("panel-holdings");
  const snapshot = state.snapshot;
  if (!snapshot) {
    panel.replaceChildren(noSnapshotPanel());
    return;
  }
  const groups = groupPositions(snapshot);
  const equity = snapshot.account.equity;
  const cards = groups.map((group) => {
    const s = group.sleeve;
    const weight = s.weight ?? (isFiniteNumber(equity) && equity > 0 ? group.marketValue / equity : null);
    return h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "sleeve-head" },
        h("div", {}, h("h2", { class: "card-title", text: s.label }), s.strategy ? h("p", { class: "muted small", text: choiceLabel(s.strategy) }) : null),
        h("div", { class: "right" }, h("p", { class: "num strong", text: formatWon(s.value ?? group.marketValue) }), signedSpan(formatSignedPercent(group.unrealizedReturn), group.unrealizedReturn)),
      ),
      h(
        "p",
        { class: "sleeve-alloc muted small" },
        `목표 ${formatPercent(s.allocation, 0)} · 현재 ${formatPercent(weight, 1)} · 평가손익 `,
        signedSpan(formatSignedWon(group.unrealized), group.unrealized),
      ),
      group.positions.length
        ? h("ul", { class: "positions" }, group.positions.map(positionRow))
        : h("p", { class: "muted", text: "보유 종목 없음" }),
    );
  });
  const cashRatio = isFiniteNumber(equity) && equity > 0 && isFiniteNumber(snapshot.account.cash) ? snapshot.account.cash / equity : null;
  cards.push(
    h(
      "section",
      { class: "card cash-card" },
      h("div", { class: "sleeve-head" }, h("h2", { class: "card-title", text: "현금" }), h("p", { class: "num strong", text: formatWon(snapshot.account.cash) })),
      h("p", { class: "muted small", text: `총자산의 ${formatPercent(cashRatio, 1)} · 기준일 ${snapshot.account.asof ?? EMPTY}` }),
    ),
  );
  panel.replaceChildren(...cards);
}

function positionRow(p) {
  const pnl = isFiniteNumber(p.avg_price) && isFiniteNumber(p.last_price) ? (p.last_price - p.avg_price) * p.quantity : null;
  return h(
    "li",
    { class: "position" },
    h(
      "div",
      { class: "row" },
      h("p", { class: "pos-name" }, h("strong", { text: p.name }), h("span", { class: "muted small", text: ` ${p.symbol}` })),
      h("p", { class: "num strong", text: formatWon(p.market_value) }),
    ),
    h(
      "div",
      { class: "row" },
      h("p", { class: "muted small num", text: `${formatNumber(p.quantity)}주 · 평균 ${formatNumber(p.avg_price)} → 현재 ${formatNumber(p.last_price)}` }),
      h("p", { class: "small" }, signedSpan(formatSignedPercent(p.unrealized_return), p.unrealized_return), " ", signedSpan(`(${formatSignedWon(pnl)})`, pnl)),
    ),
    h("p", { class: "muted small", text: `비중 ${formatPercent(p.weight, 1)} · 진입 ${p.entry_date ? formatShortDate(p.entry_date) : EMPTY}` }),
  );
}

// ---------------------------------------------------------------- ④ 주문·체결·리스크

function renderActivity() {
  const panel = $("panel-activity");
  const snapshot = state.snapshot;
  if (!snapshot) {
    panel.replaceChildren(noSnapshotPanel());
    return;
  }
  const counts = { orders: snapshot.recent_orders.length, fills: snapshot.recent_fills.length, risk: snapshot.risk_events.length };
  const labels = { orders: "주문", fills: "체결", risk: "리스크" };
  const segmented = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "내역 종류" },
    ACTIVITY_VIEWS.map((view) =>
      h("button", {
        type: "button",
        "aria-pressed": state.activity === view ? "true" : "false",
        class: state.activity === view ? "active" : null,
        text: `${labels[view]} ${counts[view]}`,
        onclick: () => {
          state.activity = view;
          renderActivity();
        },
      }),
    ),
  );
  let list;
  if (state.activity === "orders") {
    list = snapshot.recent_orders.length
      ? h("ul", { class: "events" }, snapshot.recent_orders.map(orderRow))
      : emptyState("최근 주문이 없습니다.");
  } else if (state.activity === "fills") {
    list = snapshot.recent_fills.length
      ? h("ul", { class: "events" }, snapshot.recent_fills.map(fillRow))
      : emptyState("체결 기록이 없습니다 (KIS 체결 또는 로컬 원장이 있을 때 표시).");
  } else {
    list = snapshot.risk_events.length
      ? h("ul", { class: "events" }, snapshot.risk_events.map(riskRow))
      : emptyState("리스크 이벤트가 없습니다.");
  }
  panel.replaceChildren(segmented, card(null, list));
}

function sideBadge(side) {
  const kind = side === "BUY" ? "buy" : side === "SELL" ? "sell" : "neutral";
  return badge(SIDE_LABELS[side] ?? side, kind);
}

function sleeveLabel(name) {
  return state.snapshot?.sleeves.find((s) => s.name === name)?.label ?? name;
}

function orderRow(o) {
  return h(
    "li",
    { class: "event" },
    h("div", { class: "row" }, h("p", {}, sideBadge(o.side), " ", h("strong", { text: o.name }), h("span", { class: "muted small", text: ` ${o.symbol}` })), h("p", { class: "num", text: `${formatNumber(o.quantity)}주 × ${formatNumber(o.ref_price)}` })),
    h(
      "div",
      { class: "row" },
      h("p", { class: "muted small", text: [formatShortDate(o.date), PHASE_LABELS[o.phase] ?? o.phase, sleeveLabel(o.sleeve)].filter(Boolean).join(" · ") }),
      o.accepted ? badge("접수", "ok", "ok") : badge("거부", "error", "x"),
    ),
    o.message && o.message !== (o.accepted ? "접수" : "거부") ? h("p", { class: `small ${o.accepted ? "muted" : "error-text"}`, text: o.message }) : null,
  );
}

function fillRow(f) {
  const costs = (f.commission ?? 0) + (f.tax ?? 0);
  return h(
    "li",
    { class: "event" },
    h("div", { class: "row" }, h("p", {}, sideBadge(f.side), " ", h("strong", { text: f.name }), h("span", { class: "muted small", text: ` ${f.symbol}` })), h("p", { class: "num", text: `${formatNumber(f.quantity)}주 @ ${formatNumber(f.price)}` })),
    h(
      "div",
      { class: "row" },
      h("p", { class: "muted small", text: [formatShortDate(f.date), sleeveLabel(f.sleeve)].filter(Boolean).join(" · ") }),
      h("p", { class: "muted small num", text: `수수료 ${formatNumber(f.commission)} · 세금 ${formatNumber(f.tax)} (계 ${formatWon(costs)})` }),
    ),
  );
}

function riskKind(kind) {
  if (kind === "KILL" || kind === "HALT") return "error";
  if (kind === "RESUME" || kind === "RESET") return "ok";
  return "warn";
}

function riskRow(e) {
  return h(
    "li",
    { class: "event" },
    h("div", { class: "row" }, badge(RISK_KIND_LABELS[e.kind] ?? e.kind, riskKind(e.kind)), h("p", { class: "muted small", text: [formatShortDate(e.date), e.symbol].filter(Boolean).join(" · ") })),
    h("p", { class: "small", text: e.message }),
  );
}

// ---------------------------------------------------------------- ⑤ 백테스트

function renderBacktest() {
  const panel = $("panel-backtest");
  const snapshot = state.snapshot;
  if (!snapshot) {
    panel.replaceChildren(noSnapshotPanel());
    return;
  }
  const bt = snapshot.backtest;
  if (!bt || bt.rows.length === 0) {
    panel.replaceChildren(card("백테스트 비교", emptyState("PC가 아직 백테스트 결과를 올리지 않았습니다.")));
    return;
  }
  const mdd = snapshot.settings.readonly.mdd_limit;
  const metric = (label, text, cls = "num") => h("div", {}, h("dt", { text: label }), h("dd", { class: cls, text }));
  const items = bt.rows.map((r) => {
    const overLimit = isFiniteNumber(r.mdd) && isFiniteNumber(mdd) && r.mdd > mdd + FLOAT_EPS;
    return h(
      "li",
      { class: "bt-item" },
      h(
        "div",
        { class: "row" },
        h("p", { class: "bt-name" }, h("strong", { text: r.variant }), " ", h("span", { text: r.label })),
        r.pass_mdd === null ? null : r.pass_mdd ? badge(`MDD ${formatPercent(mdd, 0)} 이내`, "ok", "ok") : badge(`MDD ${formatPercent(mdd, 0)} 초과`, "error", "x"),
      ),
      h("p", { class: "muted small", text: r.period }),
      h(
        "dl",
        { class: "bt-metrics" },
        metric("CAGR", formatSignedPercent(r.cagr, 1), valueClass(r.cagr)),
        metric("MDD", formatPercent(r.mdd, 1), overLimit ? "num error-text" : "num"),
        metric("Sharpe", formatNumber(r.sharpe, 2)),
        metric("승률", formatPercent(r.win_rate, 0)),
        metric("왕복", formatNumber(r.round_trips)),
      ),
    );
  });
  panel.replaceChildren(
    card(
      "백테스트 비교",
      h("p", { class: "muted small", text: `${bt.report_dir || EMPTY} · 생성 ${bt.generated ? formatKstDateTime(bt.generated) : EMPTY}` }),
      h("ul", { class: "bt-list" }, items),
      h("p", { class: "muted small", text: "과거 결과이며 미래 수익을 보장하지 않습니다. MDD 는 전체 기간 자산곡선 기준입니다." }),
    ),
  );
}

// ---------------------------------------------------------------- ⑥ 설정

function initForm() {
  const snapshot = state.snapshot;
  state.form = {};
  state.formBase = snapshot?.generated_at ?? null;
  if (!snapshot) return;
  for (const spec of snapshot.settings.editable) {
    if (spec.key === PAUSE_KEY) continue;
    state.form[spec.key] = { raw: spec.type === "bool" || spec.type === "choice" ? spec.value : fieldInputText(spec, spec.value), value: spec.value, error: null };
  }
}

function formDirty() {
  const snapshot = state.snapshot;
  if (!snapshot) return false;
  return Object.keys(collectForm().changes).length > 0 || Object.values(state.form).some((entry) => entry.error);
}

/** 새 스냅샷이 오면 폼을 맞춘다 (사용자가 고치던 중이면 유지). */
function syncForm() {
  if (state.formBase === null || !formDirty()) initForm();
}

function collectForm() {
  const snapshot = state.snapshot;
  const editable = snapshot?.settings.editable ?? [];
  const values = {};
  const fieldErrors = [];
  for (const spec of editable) {
    if (spec.key === PAUSE_KEY) continue;
    const entry = state.form[spec.key];
    if (!entry) continue;
    if (entry.error) fieldErrors.push(entry.error);
    else values[spec.key] = entry.value;
  }
  const changes = diffChanges(editable, values);
  const errors = [...fieldErrors, ...validateChanges(changes, editable, snapshot?.settings.readonly ?? {})];
  return { changes, errors: [...new Set(errors)] };
}

function setFieldRaw(spec, raw) {
  const parsed = parseFieldInput(spec, raw);
  state.form[spec.key] = { raw, value: parsed.value, error: parsed.error ?? null };
  updateFormFeedback();
}

function fieldControl(spec, entry) {
  const id = `field-${spec.key.replace(/[^a-z0-9]/gi, "-")}`;
  if (spec.type === "bool") {
    return h("button", {
      type: "button",
      class: "switch",
      role: "switch",
      id,
      "aria-checked": entry.raw === true ? "true" : "false",
      onclick: (event) => {
        const next = event.currentTarget.getAttribute("aria-checked") !== "true";
        event.currentTarget.setAttribute("aria-checked", next ? "true" : "false");
        setFieldRaw(spec, next);
      },
    }, h("span", { class: "switch-thumb" }));
  }
  if (spec.type === "choice") {
    const group = h("div", { class: "segmented choice", role: "radiogroup", id, "aria-labelledby": `${id}-label` });
    for (const option of spec.options) {
      group.append(
        h("button", {
          type: "button",
          role: "radio",
          "aria-checked": entry.raw === option ? "true" : "false",
          class: entry.raw === option ? "active" : null,
          text: choiceLabel(option),
          dataset: { value: option },
          onclick: () => {
            for (const btn of group.children) {
              const on = btn.dataset.value === option;
              btn.setAttribute("aria-checked", on ? "true" : "false");
              btn.classList.toggle("active", on);
            }
            setFieldRaw(spec, option);
          },
        }),
      );
    }
    return group;
  }
  const input = h("input", {
    id,
    type: "text",
    inputmode: spec.type === "int" ? "numeric" : "decimal",
    autocomplete: "off",
    spellcheck: "false",
    value: entry.raw ?? "",
    "aria-describedby": `${id}-help ${id}-error`,
    oninput: (event) => setFieldRaw(spec, event.currentTarget.value),
  });
  if (spec.type === "int") {
    const stepBy = (delta) => {
      const current = Number.isInteger(state.form[spec.key]?.value) ? state.form[spec.key].value : spec.value;
      let next = current + delta;
      if (spec.min !== null) next = Math.max(spec.min, next);
      if (spec.max !== null) next = Math.min(spec.max, next);
      input.value = String(next);
      setFieldRaw(spec, input.value);
    };
    return h(
      "div",
      { class: "stepper" },
      h("button", { type: "button", class: "icon-btn", "aria-label": `${spec.label} 줄이기`, onclick: () => stepBy(-1) }, icon("minus")),
      input,
      h("button", { type: "button", class: "icon-btn", "aria-label": `${spec.label} 늘리기`, onclick: () => stepBy(1) }, icon("plus")),
    );
  }
  return h("div", { class: "affix" }, input, isRatioField(spec) ? h("span", { class: "affix-unit", text: "%" }) : null);
}

function fieldBlock(spec, open) {
  const entry = state.form[spec.key];
  const id = `field-${spec.key.replace(/[^a-z0-9]/gi, "-")}`;
  return h(
    "div",
    { class: "field", dataset: { key: spec.key } },
    h(
      "div",
      { class: "field-head" },
      h("label", { for: id, id: `${id}-label`, text: spec.label }),
      open.has(spec.key) ? badge("요청 대기", "neutral", "clock") : null,
    ),
    fieldControl(spec, entry),
    h(
      "p",
      { class: "field-help muted small", id: `${id}-help` },
      [`지금 ${fieldDisplay(spec, spec.value)}`, spec.type === "choice" ? "" : fieldRangeText(spec), spec.help].filter(Boolean).join(" · "),
    ),
    h("p", { class: "field-change small", hidden: true }),
    h("p", { class: "field-error small", id: `${id}-error`, role: "alert", hidden: true }),
  );
}

function fieldGroupName(key) {
  if (ALLOCATION_KEY_RE.test(key)) return "슬리브 배분";
  if (key.startsWith("risk.")) return "리스크 한도";
  if (key.startsWith("sleeves.")) return "전략";
  return "기타";
}

/** 입력할 때마다 오류·변경 표시·버튼 상태만 갱신 (폼 재생성 없음 → 포커스 유지). */
function updateFormFeedback() {
  const snapshot = state.snapshot;
  const form = $("settings-form");
  if (!snapshot || !form) return;
  for (const block of form.querySelectorAll(".field")) {
    const key = block.dataset.key;
    const spec = snapshot.settings.editable.find((s) => s.key === key);
    const entry = state.form[key];
    if (!spec || !entry) continue;
    const errorEl = block.querySelector(".field-error");
    errorEl.textContent = entry.error ?? "";
    errorEl.hidden = !entry.error;
    const changed = !entry.error && entry.value !== undefined && !sameValue(spec, entry.value, spec.value);
    const changeEl = block.querySelector(".field-change");
    changeEl.textContent = changed ? `변경: ${fieldDisplay(spec, spec.value)} → ${fieldDisplay(spec, entry.value)}` : "";
    changeEl.hidden = !changed;
    block.classList.toggle("changed", changed);
    block.classList.toggle("invalid", Boolean(entry.error));
  }
  const { changes, errors } = collectForm();
  const values = effectiveValues(snapshot.settings.editable, changes);
  const allocationKeys = Object.keys(values).filter((key) => ALLOCATION_KEY_RE.test(key));
  const sumEl = $("allocation-sum");
  if (sumEl) {
    const total = allocationKeys.reduce((sum, key) => sum + (isFiniteNumber(values[key]) ? values[key] : 0), 0);
    sumEl.textContent = `배분 합계 ${pctText(total)} · 현금 ${pctText(Math.max(0, 1 - total))}`;
    sumEl.classList.toggle("error-text", total > 1 + FLOAT_EPS);
  }
  const errorBox = $("form-errors");
  const crossErrors = errors.filter((e) => !Object.values(state.form).some((entry) => entry.error === e));
  errorBox.replaceChildren(...crossErrors.map((e) => h("li", { text: e })));
  errorBox.hidden = crossErrors.length === 0;
  const count = Object.keys(changes).length;
  const submit = $("settings-submit");
  submit.disabled = state.sending || count === 0 || errors.length > 0;
  submit.textContent = count ? `요청 보내기 (${count}건)` : "요청 보내기";
  $("settings-reset").disabled = !formDirty();
}

function renderSettings() {
  const panel = $("panel-settings");
  const snapshot = state.snapshot;
  const sections = [];
  const connected = state.sample || hasToken();
  if (state.sample) {
    sections.push(card("샘플 모드", h("p", { class: "muted small", text: "합성 예시 데이터로 화면만 보여줍니다. 토큰을 쓰지 않고 GitHub 에 요청을 보내지 않습니다. 실제 계좌를 보려면 주소에서 ?sample=1 을 지우세요." })));
  }
  if (!connected) sections.push(connectionCard());
  if (snapshot) {
    const merged = mergeRequests(snapshot.requests, state.pending);
    const open = openRequestKeys(merged);
    sections.push(controlCard(snapshot, open));
    sections.push(settingsFormCard(snapshot, open));
    sections.push(requestsCard(snapshot, merged));
    sections.push(readonlyCard(snapshot));
  } else if (connected) {
    sections.push(card("설정 변경", h("p", { class: "muted", text: "스냅샷을 불러온 뒤 설정을 바꿀 수 있습니다." })));
  }
  if (connected && !state.sample) sections.push(connectionCard());
  sections.push(h("p", { class: "muted small center", text: `앱 버전 ${APP_VERSION}` }));
  panel.replaceChildren(...sections);
  if (snapshot) updateFormFeedback();
}

function controlCard(snapshot, open) {
  const paused = currentPaused(snapshot);
  const pauseAvailable = hasPauseControl(snapshot);
  const pausePending = open.has(PAUSE_KEY);
  const resetPending = open.has("cmd:reset_halt");
  const trade = tradingState(snapshot.status);
  const resetAllowed = canResetHalt(snapshot.status);
  return h(
    "section",
    { class: "card control-card" },
    h("h2", { class: "card-title", text: "매매 제어" }),
    h(
      "div",
      { class: "big-switch-row" },
      h(
        "div",
        {},
        h("p", { class: "big-switch-label", id: "pause-label", text: "자동매매" }),
        h("p", { class: `big-switch-state ${paused ? "is-paused" : "is-on"}`, text: paused ? "일시정지 중" : "켜짐" }),
        h("p", { class: "muted small", text: pausePending ? "요청 대기 — PC 다음 동기화 때 반영" : paused ? "켜면 다음 실행부터 주문을 냅니다." : "끄면 다음 실행부터 주문을 내지 않습니다." }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "switch big",
          role: "switch",
          "aria-checked": paused ? "false" : "true",
          "aria-labelledby": "pause-label",
          disabled: !pauseAvailable || pausePending || state.sending ? true : null,
          onclick: () => onTogglePause(!paused),
        },
        h("span", { class: "switch-thumb" }),
      ),
    ),
    pauseAvailable ? null : h("p", { class: "muted small", text: "스냅샷에 일시정지 항목이 없어 바꿀 수 없습니다." }),
    h("hr", {}),
    h(
      "div",
      { class: "reset-row" },
      h("div", {}, h("p", { class: "strong", text: "중지 해제 (reset_halt)" }), h("p", { class: "muted small", text: resetAllowed ? `현재 ${trade.label}. 일시중지·완전중지를 모두 풀고 고점을 현재 자산으로 다시 잡습니다.` : "중지·완전중지 상태일 때만 쓸 수 있습니다." })),
      h("button", {
        type: "button",
        class: "btn danger-outline",
        disabled: !resetAllowed || resetPending || state.sending ? true : null,
        text: resetPending ? "요청 대기" : "중지 해제…",
        onclick: onResetHalt,
      }),
    ),
  );
}

function settingsFormCard(snapshot, open) {
  const specs = snapshot.settings.editable.filter((spec) => spec.key !== PAUSE_KEY);
  const groups = new Map();
  for (const spec of specs) {
    const name = fieldGroupName(spec.key);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(spec);
  }
  const fieldsets = [...groups.entries()].map(([name, list]) =>
    h(
      "fieldset",
      { class: "fieldset" },
      h("legend", { text: name }),
      list.map((spec) => fieldBlock(spec, open)),
      name === "슬리브 배분" ? h("p", { class: "small strong", id: "allocation-sum", "aria-live": "polite" }) : null,
    ),
  );
  const form = h(
    "form",
    {
      id: "settings-form",
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        onSubmitSettings();
      },
    },
    fieldsets,
    h("ul", { class: "form-errors", id: "form-errors", role: "alert", hidden: true }),
    h(
      "div",
      { class: "actions sticky-actions" },
      h("button", {
        type: "button",
        class: "btn",
        id: "settings-reset",
        text: "되돌리기",
        onclick: () => {
          initForm();
          renderSettings();
        },
      }),
      h("button", { type: "submit", class: "btn primary", id: "settings-submit", text: "요청 보내기" }),
    ),
  );
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "card-title", text: "설정 변경 요청" }),
    h("p", { class: "note", text: "바꾼 값은 요청 파일로 저장소에 올라가고, PC가 다음 동기화 때 검증한 뒤 반영합니다. 이 화면의 검사는 안내용이며 최종 판단은 PC가 합니다." }),
    specs.length ? form : h("p", { class: "muted", text: "바꿀 수 있는 항목이 없습니다." }),
  );
}

function requestsCard(snapshot, merged) {
  const editable = snapshot.settings.editable;
  return card(
    "요청 기록",
    merged.length
      ? h(
          "ul",
          { class: "events" },
          merged.slice(0, PENDING_MAX_COUNT).map((r) =>
            h(
              "li",
              { class: "event" },
              h(
                "div",
                { class: "row" },
                badge(REQUEST_STATUS_LABELS[r.status] ?? r.status, r.status === "applied" ? "ok" : r.status === "rejected" ? "error" : "neutral", REQUEST_ICONS[r.status]),
                h("p", { class: "muted small", text: formatKstShort(r.submitted_at) }),
              ),
              h("p", { class: "small", text: summarizeRequest(r, editable) }),
              r.message && r.message !== REQUEST_STATUS_LABELS[r.status]
                ? h("p", { class: `small ${r.status === "rejected" ? "error-text" : "muted"}`, text: r.message })
                : null,
              h("p", { class: "muted tiny", text: r.id }),
            ),
          ),
        )
      : emptyState("아직 보낸 요청이 없습니다."),
  );
}

function readonlyCard(snapshot) {
  const ro = snapshot.settings.readonly;
  const rows = [
    ["모드", MODE_LABELS[ro.mode] ?? (ro.mode || EMPTY)],
    ["실전 주문 허용", ro.real_trading_enabled ? "허용" : "차단"],
    ["1회 주문 상한", formatWon(ro.max_order_value)],
    ["MDD 한도", formatPercent(ro.mdd_limit, 0)],
    ["운용 원금", formatWon(ro.initial_capital)],
  ];
  return card(
    "잠긴 설정",
    h("p", { class: "muted small", text: "증권사 연결·주문 상한·비용·종목·계좌 관련 값은 폰에서 바꿀 수 없습니다 (PC에서만)." }),
    h(
      "dl",
      { class: "kv locked" },
      rows.map(([k, v]) => h("div", {}, h("dt", {}, icon("lock"), h("span", { text: k })), h("dd", { class: "num", text: v }))),
    ),
  );
}

function connectionCard() {
  const conn = loadConnection();
  const tokenSaved = hasToken();
  const ownerInput = h("input", { id: "conn-owner", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: conn.owner });
  const repoInput = h("input", { id: "conn-repo", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: conn.repo });
  const tokenInput = h("input", {
    id: "conn-token",
    type: "password",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: tokenSaved ? "저장됨 — 바꾸려면 새 토큰 입력" : "github_pat_…",
  });
  const errors = h("ul", { class: "form-errors", role: "alert", hidden: true });
  const onSave = async (event) => {
    event.preventDefault();
    const owner = ownerInput.value.trim();
    const repo = repoInput.value.trim();
    const newToken = tokenInput.value.trim();
    const token = newToken || storageGet(STORAGE_KEYS.token) || "";
    const result = validateConnection({ owner, repo, token });
    errors.replaceChildren(...result.errors.map((e) => h("li", { text: e })));
    errors.hidden = result.errors.length === 0;
    if (result.errors.length) return;
    const before = loadConnection();
    const targetChanged = before.owner !== owner || before.repo !== repo;
    if (!storageSet(STORAGE_KEYS.connection, JSON.stringify({ owner, repo })) || (newToken && !storageSet(STORAGE_KEYS.token, newToken))) {
      toast("이 브라우저에 저장할 수 없습니다 (개인정보 보호 모드인지 확인).", "error");
      return;
    }
    tokenInput.value = "";
    if (targetChanged) clearData();
    if (result.warnings.length) toast(result.warnings[0]);
    else toast("연결 정보를 저장했습니다.");
    state.error = null;
    renderAll();
    await refresh();
    if (state.snapshot) switchTab("summary");
  };
  const onDelete = async () => {
    const ok = await confirmDialog({
      title: "토큰 삭제",
      body: [h("p", { text: "이 기기에 저장된 토큰과 스냅샷·요청 기록을 지웁니다. GitHub 쪽 토큰은 그대로이므로, 폰을 잃어버렸다면 GitHub 설정에서 토큰을 폐기(Revoke)하세요." })],
      okLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    storageRemove(STORAGE_KEYS.token);
    clearData();
    toast("토큰을 삭제했습니다.");
    renderAll();
  };
  return h(
    "section",
    { class: "card connection-card" },
    h("h2", { class: "card-title", text: "GitHub 연결" }),
    h("p", { class: "small" }, tokenSaved ? badge("토큰 저장됨", "ok", "ok") : badge("토큰 없음", "warn", "alert")),
    h(
      "form",
      { onsubmit: onSave, novalidate: true },
      h("div", { class: "field" }, h("label", { for: "conn-owner", text: "소유자" }), ownerInput),
      h("div", { class: "field" }, h("label", { for: "conn-repo", text: "데이터 저장소 (비공개)" }), repoInput),
      h("div", { class: "field" }, h("label", { for: "conn-token", text: "fine-grained 토큰" }), tokenInput, h("p", { class: "muted small", text: "토큰은 이 기기 브라우저(localStorage)에만 저장되고 api.github.com 외에는 보내지 않습니다. 저장 후에는 화면에 다시 표시하지 않습니다." })),
      errors,
      h(
        "div",
        { class: "actions" },
        tokenSaved ? h("button", { type: "button", class: "btn danger-outline", text: "토큰 삭제", onclick: onDelete }) : null,
        h("button", { type: "submit", class: "btn primary", text: tokenSaved ? "저장하고 다시 불러오기" : "저장하고 불러오기" }),
      ),
    ),
    tokenGuide(!tokenSaved),
  );
}

function tokenGuide(open) {
  const steps = [
    "GitHub 웹 → 오른쪽 위 프로필 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token",
    "Token name: 예) 폰 대시보드 · Expiration: 만료일 지정 (예: 90일)",
    "Resource owner: JaehweePark",
    "Repository access: Only select repositories → stock-data 하나만 선택",
    "Permissions → Repository permissions → Contents: Read and write (Metadata 읽기는 자동). 다른 권한은 주지 않습니다.",
    "생성된 github_pat_… 값을 복사해 위 칸에 붙여넣고 저장",
  ];
  return h(
    "details",
    { class: "guide", open: open ? true : null },
    h("summary", { text: "토큰 만드는 법" }),
    h("ol", {}, steps.map((s) => h("li", { text: s }))),
    h("p", { class: "muted small", text: "토큰이 유출되면 GitHub에서 즉시 폐기(Revoke)하고 새로 만드세요. 이 토큰으로는 stock-data 저장소 파일만 읽고 쓸 수 있습니다." }),
  );
}

function clearData() {
  storageRemove(STORAGE_KEYS.cache);
  storageRemove(STORAGE_KEYS.pending);
  state.snapshot = null;
  state.fetchedAt = null;
  state.source = "none";
  state.pending = [];
  state.error = null;
  initForm();
}

// ---------------------------------------------------------------- 요청 흐름

async function onSubmitSettings() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const { changes, errors } = collectForm();
  if (errors.length) {
    updateFormFeedback();
    toast("입력값을 확인하세요.", "error");
    return;
  }
  if (!Object.keys(changes).length) {
    toast("바뀐 값이 없습니다.");
    return;
  }
  const ok = await confirmDialog({
    title: "설정 변경 요청",
    body: [
      changesTable(describeChanges(changes, snapshot.settings.editable)),
      h("p", { class: "muted small", text: "PC가 다음 동기화 때 검증 후 반영합니다. 거부되면 요청 기록에 사유가 표시됩니다." }),
    ],
    okLabel: "요청 보내기",
  });
  if (ok) await sendRequest({ changes });
}

async function onTogglePause(nextPaused) {
  const snapshot = state.snapshot;
  if (!snapshot || !hasPauseControl(snapshot)) return;
  const spec = snapshot.settings.editable.find((s) => s.key === PAUSE_KEY);
  const ok = await confirmDialog({
    title: nextPaused ? "매매 일시정지 요청" : "매매 재개 요청",
    body: [
      changesTable(describeChanges({ [PAUSE_KEY]: nextPaused }, [{ ...spec, value: currentPaused(snapshot) }])),
      h("p", { class: "muted small", text: nextPaused ? "다음 실행부터 주문을 내지 않습니다. 보유 종목은 팔지 않습니다." : "다음 실행부터 다시 주문을 냅니다." }),
      h("p", { class: "muted small", text: "PC 다음 동기화 때 반영됩니다." }),
    ],
    okLabel: nextPaused ? "일시정지 요청" : "재개 요청",
  });
  if (ok) await sendRequest({ changes: { [PAUSE_KEY]: nextPaused } });
}

async function onResetHalt() {
  const snapshot = state.snapshot;
  if (!snapshot || !canResetHalt(snapshot.status)) return;
  const trade = tradingState(snapshot.status);
  const metrics = summaryMetrics(snapshot);
  const first = await confirmDialog({
    title: "중지 해제 (1/2)",
    body: [
      h("p", { text: `현재 상태: ${trade.label}. 고점 대비 낙폭 ${formatPercent(metrics.drawdown, 1)}, 누적 낙폭 ${formatPercent(metrics.cumulativeDrawdown, 1)}.` }),
      h("p", { text: "해제하면 일시중지·완전중지가 모두 풀리고, 고점과 역대 고점이 현재 자산으로 다시 잡힙니다. 다음 실행부터 매매가 재개됩니다." }),
    ],
    okLabel: "계속",
    danger: true,
  });
  if (!first) return;
  const second = await confirmDialog({
    title: "정말 중지를 해제할까요? (2/2)",
    body: [
      h("p", { class: "strong", text: "누적 낙폭 기준점이 초기화되어 손실 한도가 현재 자산 기준으로 새로 시작합니다." }),
      h("p", { class: "muted small", text: "다시 멈추려면 일시정지를 요청하세요. PC 다음 동기화 때 반영됩니다." }),
    ],
    okLabel: "중지 해제 요청 보내기",
    danger: true,
  });
  if (second) await sendRequest({ commands: ["reset_halt"] });
}

// ---------------------------------------------------------------- 렌더·이벤트

function renderAll() {
  renderChrome();
  renderSummary();
  renderHoldings();
  renderActivity();
  renderBacktest();
  renderSettings();
  if (state.tab === "charts") renderCharts();
}

function setupTabs() {
  for (const name of TABS) {
    const tab = $(`tab-${name}`);
    tab.addEventListener("click", () => switchTab(name));
    tab.addEventListener("keydown", (event) => {
      const index = TABS.indexOf(name);
      let next = null;
      if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
      else if (event.key === "ArrowLeft") next = TABS[(index - 1 + TABS.length) % TABS.length];
      else if (event.key === "Home") next = TABS[0];
      else if (event.key === "End") next = TABS[TABS.length - 1];
      if (next) {
        event.preventDefault();
        switchTab(next, { focus: true });
      }
    });
  }
}

function setupPullToRefresh() {
  const root = document.documentElement;
  const indicator = $("pull-indicator");
  const text = $("pull-text");
  let startY = null;
  let shown = 0;
  window.addEventListener("touchstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const blocked = target?.closest(".chart-box, input, select, textarea, dialog, .table-scroll");
    startY = window.scrollY <= 0 && event.touches.length === 1 && !state.loading && !blocked ? event.touches[0].clientY : null;
    shown = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (event) => {
    if (startY === null) return;
    shown = Math.min(PULL_MAX_PX, Math.max(0, event.touches[0].clientY - startY) * PULL_RESISTANCE);
    setVar(root, "--pull", `${shown}px`);
    const ready = shown >= PULL_TRIGGER_PX;
    indicator.classList.toggle("ready", ready);
    indicator.classList.toggle("active", shown > 0);
    text.textContent = ready ? "놓으면 새로고침" : "당겨서 새로고침";
  }, { passive: true });
  const finish = () => {
    if (startY === null) return;
    const trigger = shown >= PULL_TRIGGER_PX;
    startY = null;
    shown = 0;
    setVar(root, "--pull", "0px");
    indicator.classList.remove("ready", "active");
    if (trigger) refresh({ manual: true });
  };
  window.addEventListener("touchend", finish);
  window.addEventListener("touchcancel", finish);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register("./sw.js").catch(() => {
    console.warn("service worker registration failed");
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    state.swUpdated = true;
    renderChrome();
  });
}

function boot() {
  if (window.top !== window.self) {
    // 다른 사이트의 iframe 안에서 실행 거부 (클릭재킹 방지 — 정적 호스팅이라 frame-ancestors 헤더를 못 씀)
    document.body.textContent = "보안을 위해 다른 페이지 안에서는 열 수 없습니다.";
    return;
  }
  const launch = parseLaunchParams(location.search);
  state.sample = launch.sample;
  state.offline = navigator.onLine === false;
  if (state.sample) {
    // 샘플 모드: 이 기기의 캐시·대기 요청·탭 기록을 읽지도 쓰지도 않는다
    state.tab = launch.tab ?? "summary";
  } else {
    state.pending = arr(readJson(STORAGE_KEYS.pending, [])).filter((p) => p && REQUEST_ID_PATTERN.test(String(p.id)));
    const savedTab = storageGet(STORAGE_KEYS.tab);
    state.tab = TABS.includes(savedTab) ? savedTab : "summary";
    const cached = loadCache();
    if (cached) {
      state.snapshot = cached.snapshot;
      state.fetchedAt = cached.fetchedAt;
      state.source = "cache";
    }
  }
  initForm();
  if (!state.sample && !hasToken()) state.tab = "settings";

  setupTabs();
  setupPullToRefresh();
  $("refresh-btn").addEventListener("click", () => refresh({ manual: true }));
  window.addEventListener("online", () => {
    state.offline = false;
    refresh();
  });
  window.addEventListener("offline", () => {
    state.offline = true;
    renderChrome();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const stale = !state.fetchedAt || Date.now() - state.fetchedAt > AUTO_REFRESH_MINUTES * MS_PER_MINUTE;
    if (stale && hasToken() && !state.sample) refresh();
    else renderChrome();
  });
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.tab === "charts") renderCharts();
    }, RESIZE_DEBOUNCE_MS);
  });

  renderAll();
  registerServiceWorker();
  setInterval(renderUpdatedText, MS_PER_MINUTE);
  if (state.sample) loadSample();
  else if (hasToken()) refresh();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
