// 의존성 없는 인라인 SVG 차트. 전부 순수 함수 (문자열 생성) → node --test 대상.
// 색은 CSS 클래스로만 지정한다 (CSP style-src 'self' — style 속성 금지, 라이트/다크는 styles.css 토큰).

export const CHART_HEIGHT = 220;
export const CHART_MIN_WIDTH = 240;
export const CHART_PADDING = Object.freeze({ top: 14, right: 52, bottom: 26, left: 46 });
export const Y_TICK_COUNT = 4;
export const X_TICK_COUNT = 4;
export const END_LABEL_MIN_GAP = 14;          // 끝값 라벨 두 개가 이보다 가까우면 라벨 생략 (범례·읽기값이 대신)
export const COORD_DIGITS = 1;
const NICE_STEPS = [1, 2, 2.5, 5, 10];
const MINUS = "−";

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function round(value, digits = COORD_DIGITS) {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// ---------------------------------------------------------------- 시계열 가공

/**
 * 기준 날짜 배열에 다른 시계열 값을 맞춘다. 같은 날짜가 없으면 직전 값(전일 종가)을 쓰고,
 * 첫 값 이전은 null. history: [{date, [key]}] (날짜 오름차순 아니어도 됨).
 */
export function alignByDate(baseDates, history, key = "close") {
  const points = (history ?? [])
    .filter((row) => row && typeof row.date === "string" && isFiniteNumber(row[key]))
    .map((row) => [row.date, row[key]])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  let cursor = 0;
  let last = null;
  for (const date of baseDates) {
    while (cursor < points.length && points[cursor][0] <= date) {
      last = points[cursor][1];
      cursor += 1;
    }
    out.push(last);
  }
  return out;
}

/** 첫 유효값 대비 수익률 (0.05 = +5%). 정규화 비교용 — 두 선을 같은 축에 올린다. */
export function toReturnSeries(values) {
  const base = values.find((v) => isFiniteNumber(v) && v > 0);
  if (base === undefined) return values.map(() => null);
  return values.map((v) => (isFiniteNumber(v) ? v / base - 1 : null));
}

/** 구간 고점 대비 낙폭 (양수 비율, 0.12 = 고점 대비 -12%). */
export function drawdownSeries(values) {
  let peak = null;
  return values.map((v) => {
    if (!isFiniteNumber(v)) return null;
    if (peak === null || v > peak) peak = v;
    return peak > 0 ? Math.max(0, 1 - v / peak) : 0;
  });
}

export function maxDrawdown(values) {
  return drawdownSeries(values).reduce((acc, v) => (isFiniteNumber(v) && v > acc ? v : acc), 0);
}

/** 스냅샷 → 자산 vs 벤치마크 비교 데이터 (같은 날짜축, 첫날 기준 수익률). */
export function prepareComparison(equityHistory, benchmarkHistory) {
  const rows = (equityHistory ?? []).filter((row) => row && typeof row.date === "string" && isFiniteNumber(row.equity));
  const dates = rows.map((row) => row.date);
  const equity = rows.map((row) => row.equity);
  const benchmarkClose = alignByDate(dates, benchmarkHistory, "close");
  return {
    dates,
    equity,
    equityReturn: toReturnSeries(equity),
    benchmarkReturn: toReturnSeries(benchmarkClose),
    drawdown: drawdownSeries(equity),
  };
}

// ---------------------------------------------------------------- 축·스케일

export function linearScale(d0, d1, r0, r1) {
  const span = d1 - d0;
  if (span === 0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function niceStep(span, count = Y_TICK_COUNT) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = NICE_STEPS.find((s) => s >= normalized - 1e-12) ?? 10;
  return step * magnitude;
}

/** 깔끔한 눈금. min/max 를 눈금 단위로 넓힌 도메인과 눈금 목록. */
export function niceTicks(min, max, count = Y_TICK_COUNT) {
  let lo = min;
  let hi = max;
  if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (lo === hi) {
    const pad = lo === 0 ? 0.01 : Math.abs(lo) * 0.05;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo, count);
  const niceMin = Math.floor(lo / step + 1e-9) * step;
  const niceMax = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 1e-6; v += step) ticks.push(round(v, 10));
  return { min: round(niceMin, 10), max: round(niceMax, 10), ticks };
}

/** 균등 간격 x 눈금 인덱스 (처음·끝 포함, 중복 없음). */
export function xTickIndices(length, count = X_TICK_COUNT) {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const n = Math.min(count, length);
  const out = new Set();
  for (let i = 0; i < n; i += 1) out.add(Math.round((i * (length - 1)) / (n - 1)));
  return [...out];
}

/** 정렬된 xs 에서 x 에 가장 가까운 인덱스 (이진 탐색). */
export function nearestIndex(xs, x) {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

// ---------------------------------------------------------------- 경로

/** [[x, y|null], ...] → SVG path. null 은 선을 끊는다. */
export function linePath(points) {
  let d = "";
  let pen = false;
  for (const [x, y] of points) {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${round(x)} ${round(y)}`;
    pen = true;
  }
  return d;
}

/** 선과 baseY 사이를 채우는 영역 경로 (연속 구간마다 닫음). */
export function areaPath(points, baseY) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (isFiniteNumber(point[0]) && isFiniteNumber(point[1])) current.push(point);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const first = seg[0];
      const last = seg[seg.length - 1];
      return `M${round(first[0])} ${round(baseY)}${seg.map(([x, y]) => `L${round(x)} ${round(y)}`).join("")}L${round(last[0])} ${round(baseY)}Z`;
    })
    .join("");
}

// ---------------------------------------------------------------- 라벨

export function formatPercentTick(ratio, { signed = true, digits = null } = {}) {
  if (!isFiniteNumber(ratio)) return "";
  const pct = ratio * 100;
  const places = digits ?? (Math.abs(pct) >= 10 || Number.isInteger(round(pct, 6)) ? 0 : 1);
  const text = Math.abs(pct).toFixed(places);
  if (Number(text) === 0) return `0%`;
  const sign = pct < 0 ? MINUS : signed ? "+" : "";
  return `${sign}${text}%`;
}

/** "2026-10-15" → 기간이 길면 "26.10", 짧으면 "10/15". */
export function formatDateTick(date, spanDays) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date));
  if (!match) return String(date);
  const [, y, m, d] = match;
  return spanDays > 120 ? `${y.slice(2)}.${m}` : `${Number(m)}/${Number(d)}`;
}

function daysBetween(a, b) {
  const t0 = Date.parse(`${a}T00:00:00Z`);
  const t1 = Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.abs(t1 - t0) / 86400000 : 0;
}

// ---------------------------------------------------------------- 차트 조립

/**
 * 선 차트 SVG 생성.
 * spec = {
 *   width, height, dates: string[], ariaLabel,
 *   series: [{id, label, values: (number|null)[], area?: boolean}],
 *   refLines?: [{value, label, id}],         // 가로 기준선 (예: 낙폭 한도)
 *   includeValues?: number[],                // y 도메인에 반드시 넣을 값 (0, 한도선 등)
 *   yFormat?: (v) => string, endFormat?: (v) => string,
 * }
 * 반환: { svg, xs, plot: {left, right, top, bottom}, yOf(v) }
 */
export function buildLineChart(spec) {
  const width = Math.max(CHART_MIN_WIDTH, Math.round(spec.width ?? CHART_MIN_WIDTH));
  const height = Math.round(spec.height ?? CHART_HEIGHT);
  const pad = { ...CHART_PADDING, ...(spec.padding ?? {}) };
  const dates = spec.dates ?? [];
  const series = spec.series ?? [];
  const yFormat = spec.yFormat ?? ((v) => formatPercentTick(v));
  const endFormat = spec.endFormat ?? yFormat;
  const plot = { left: pad.left, right: width - pad.right, top: pad.top, bottom: height - pad.bottom };

  const values = [];
  for (const s of series) for (const v of s.values) if (isFiniteNumber(v)) values.push(v);
  for (const v of spec.includeValues ?? []) if (isFiniteNumber(v)) values.push(v);
  for (const ref of spec.refLines ?? []) if (isFiniteNumber(ref.value)) values.push(ref.value);

  const aria = escapeXml(spec.ariaLabel ?? "차트");
  if (dates.length === 0 || values.length === 0) {
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${aria}"><text class="chart-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">표시할 데이터가 없습니다</text></svg>`,
      xs: [],
      plot,
      yOf: () => plot.bottom,
    };
  }

  const domain = niceTicks(Math.min(...values), Math.max(...values), Y_TICK_COUNT);
  const yOf = linearScale(domain.min, domain.max, plot.bottom, plot.top);
  const xOf = dates.length === 1
    ? () => (plot.left + plot.right) / 2
    : linearScale(0, dates.length - 1, plot.left, plot.right);
  const xs = dates.map((_, i) => round(xOf(i)));
  const spanDays = daysBetween(dates[0], dates[dates.length - 1]);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${aria}">`);

  // 가로 격자 + y 눈금
  parts.push(`<g class="grid">`);
  for (const tick of domain.ticks) {
    const y = round(yOf(tick));
    const cls = tick === 0 ? "gridline zero" : "gridline";
    parts.push(`<line class="${cls}" x1="${plot.left}" x2="${plot.right}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="tick tick-y" x="${plot.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeXml(yFormat(tick))}</text>`);
  }
  parts.push(`</g>`);

  // x 눈금 (날짜)
  parts.push(`<g class="x-axis">`);
  const ticks = xTickIndices(dates.length, X_TICK_COUNT);
  ticks.forEach((index, n) => {
    const anchor = ticks.length === 1 ? "middle" : n === 0 ? "start" : n === ticks.length - 1 ? "end" : "middle";
    parts.push(`<text class="tick tick-x" x="${xs[index]}" y="${height - 8}" text-anchor="${anchor}">${escapeXml(formatDateTick(dates[index], spanDays))}</text>`);
  });
  parts.push(`</g>`);

  // 기준선 (한도)
  for (const ref of spec.refLines ?? []) {
    if (!isFiniteNumber(ref.value)) continue;
    const y = round(yOf(ref.value));
    const id = escapeXml(ref.id ?? "ref");
    parts.push(`<line class="ref ref-${id}" x1="${plot.left}" x2="${plot.right}" y1="${y}" y2="${y}"/>`);
    // 라벨은 왼쪽 안쪽 (최근 구간 선과 겹치지 않게) + 표면색 테두리(halo)
    parts.push(`<text class="ref-label ref-label-${id}" x="${plot.left + 4}" y="${round(y - 4)}" text-anchor="start">${escapeXml(ref.label ?? "")}</text>`);
  }

  // 시리즈 (영역 → 선)
  const pointsById = new Map();
  for (const s of series) {
    const id = escapeXml(s.id);
    const points = s.values.map((v, i) => [xs[i], isFiniteNumber(v) ? yOf(v) : null]);
    pointsById.set(s.id, points);
    if (s.area) {
      const baseY = round(yOf(Math.min(Math.max(0, domain.min), domain.max)));
      parts.push(`<path class="area area-${id}" d="${areaPath(points, baseY)}"/>`);
    }
    parts.push(`<path class="line line-${id}" d="${linePath(points)}" fill="none"/>`);
  }

  // 끝점 마커 + 끝값 라벨 (서로 가까우면 라벨 생략)
  const ends = [];
  for (const s of series) {
    let index = -1;
    for (let i = s.values.length - 1; i >= 0; i -= 1) {
      if (isFiniteNumber(s.values[i])) {
        index = i;
        break;
      }
    }
    if (index < 0) continue;
    ends.push({ id: escapeXml(s.id), x: xs[index], y: round(yOf(s.values[index])), value: s.values[index] });
  }
  const labelsCollide = ends.some((a, i) => ends.some((b, j) => j > i && Math.abs(a.y - b.y) < END_LABEL_MIN_GAP));
  for (const end of ends) {
    parts.push(`<circle class="dot dot-${end.id}" cx="${end.x}" cy="${end.y}" r="4"/>`);
    const label = labelsCollide ? "" : endFormat(end.value);
    if (label) {
      parts.push(`<text class="end-label" x="${round(end.x + 8)}" y="${end.y}" dominant-baseline="middle">${escapeXml(label)}</text>`);
    }
  }

  // 십자선 (app.js 가 속성만 갱신)
  parts.push(`<g class="crosshair" visibility="hidden">`);
  parts.push(`<line class="crosshair-line" x1="0" x2="0" y1="${plot.top}" y2="${plot.bottom}"/>`);
  for (const s of series) {
    parts.push(`<circle class="crosshair-dot dot-${escapeXml(s.id)}" data-series="${escapeXml(s.id)}" cx="0" cy="0" r="4"/>`);
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);

  return { svg: parts.join(""), xs, plot, yOf, domain };
}

/** 자산 vs 벤치마크 (첫날 기준 수익률, 한 축). */
export function buildComparisonChart({ width, height = CHART_HEIGHT, comparison, equityLabel = "내 자산", benchmarkLabel = "KODEX 200" }) {
  return buildLineChart({
    width,
    height,
    dates: comparison.dates,
    ariaLabel: `${equityLabel}과 ${benchmarkLabel}의 기간 수익률 비교`,
    includeValues: [0],
    series: [
      { id: "benchmark", label: benchmarkLabel, values: comparison.benchmarkReturn },
      { id: "equity", label: equityLabel, values: comparison.equityReturn },
    ],
  });
}

/** 낙폭 (0 위, 아래로 음수) + 한도 기준선. thresholds: [{value(양수 비율), label, id}] */
export function buildDrawdownChart({ width, height = CHART_HEIGHT, comparison, thresholds = [] }) {
  const negative = comparison.drawdown.map((v) => (isFiniteNumber(v) ? -v : null));
  return buildLineChart({
    width,
    height,
    dates: comparison.dates,
    ariaLabel: "기간 고점 대비 낙폭",
    includeValues: [0],
    padding: { right: 16 },
    refLines: thresholds
      .filter((t) => isFiniteNumber(t.value))
      .map((t) => ({ value: -t.value, label: t.label, id: t.id })),
    series: [{ id: "drawdown", label: "낙폭", values: negative, area: true }],
    yFormat: (v) => formatPercentTick(v, { signed: true }),
    endFormat: () => "",
  });
}

/** 게이지(미터) 채움 비율 0~1. scaleMax 이상은 1. */
export function gaugeFraction(value, scaleMax) {
  if (!isFiniteNumber(value) || !(scaleMax > 0)) return 0;
  return Math.min(1, Math.max(0, value / scaleMax));
}
