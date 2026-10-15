// GitHub REST API 클라이언트와 변경 요청(C9) 생성.
// DOM 을 쓰지 않는다 → node --test 로 검증. fetch 는 주입 가능 (테스트는 가짜 fetch).
// 토큰은 private 필드에만 두고 오류 메시지·로그에 절대 넣지 않는다.

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const ACCEPT_RAW = "application/vnd.github.raw+json";
export const ACCEPT_JSON = "application/vnd.github+json";

export const DEFAULT_OWNER = "JaehweePark";
export const DEFAULT_REPO = "stock-data";

export const SNAPSHOT_PATH = "data/snapshot.json";
export const REQUEST_DIR = "control/requests";
export const REQUEST_CLIENT = "pwa";
export const ALLOWED_COMMANDS = Object.freeze(["reset_halt"]);

export const REQUEST_ID_RANDOM_LENGTH = 6;
export const REQUEST_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const REQUEST_ID_PATTERN = /^\d{8}T\d{6}-[a-z0-9]{6}$/;
const RANDOM_BYTE_LIMIT = 252;            // 36 × 7 — 이 값 이상 바이트는 버려 나머지 편향 제거
const RANDOM_MAX_ROUNDS = 64;

export const KST_OFFSET_MINUTES = 9 * 60;
export const FETCH_TIMEOUT_MS = 15000;
const BASE64_CHUNK = 0x8000;

export const FINE_GRAINED_PREFIX = "github_pat_";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

/** GitHub 호출 실패. kind 로 화면 처리를 나눈다 (message 는 사람이 읽는 한국어). */
export class GitHubError extends Error {
  /**
   * @param {"config"|"network"|"timeout"|"auth"|"forbidden"|"rate_limit"|"not_found"|"conflict"|"invalid"|"server"|"http"} kind
   * @param {number} status HTTP 상태 (네트워크 오류는 0)
   * @param {string} message
   */
  constructor(kind, status, message) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------- 연결 설정 검증

/**
 * 소유자·저장소·토큰 형식 검사. 토큰 값 자체는 메시지에 넣지 않는다.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConnection({ owner, repo, token }, { requireToken = true } = {}) {
  const errors = [];
  const warnings = [];
  const ownerText = String(owner ?? "").trim();
  const repoText = String(repo ?? "").trim();
  const tokenText = String(token ?? "").trim();

  if (!ownerText) errors.push("소유자(GitHub 계정 이름)를 입력하세요.");
  else if (!OWNER_PATTERN.test(ownerText)) errors.push("소유자 이름 형식이 올바르지 않습니다 (영문·숫자·하이픈).");

  if (!repoText) errors.push("저장소 이름을 입력하세요.");
  else if (!REPO_PATTERN.test(repoText)) errors.push("저장소 이름 형식이 올바르지 않습니다.");

  if (requireToken || tokenText) {
    if (!tokenText) errors.push("토큰을 입력하세요.");
    else if (!tokenText.startsWith(FINE_GRAINED_PREFIX)) {
      errors.push("fine-grained 토큰(github_pat_ 로 시작)만 사용할 수 있습니다. 클래식 토큰은 모든 저장소에 접근할 수 있어 쓰지 않습니다.");
    } else if (!TOKEN_PATTERN.test(tokenText)) {
      errors.push("토큰 형식이 올바르지 않습니다 (공백이나 줄바꿈이 섞였는지 확인).");
    }
  }
  if (repoText && repoText !== DEFAULT_REPO) {
    warnings.push(`기본 데이터 저장소(${DEFAULT_REPO})가 아닌 저장소입니다.`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- 시각·요청 ID

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

/** Date → KST 달력 성분 (서머타임 없음 → 고정 +9h). */
export function kstParts(date) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(ms)) throw new TypeError("유효하지 않은 시각");
  const shifted = new Date(ms + KST_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** ISO 8601, +09:00 오프셋, 초 단위. 예: 2026-10-15T09:30:12+09:00 */
export function formatKstIso(date) {
  const p = kstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

export function secureRandomBytes(count) {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** 소문자 영숫자 무작위 문자열 (기본 6자리). randomBytes 주입으로 테스트 고정. */
export function randomSuffix(randomBytes = secureRandomBytes, length = REQUEST_ID_RANDOM_LENGTH) {
  let out = "";
  for (let round = 0; round < RANDOM_MAX_ROUNDS && out.length < length; round += 1) {
    for (const byte of randomBytes(length * 2)) {
      if (out.length >= length) break;
      if (byte < RANDOM_BYTE_LIMIT) out += REQUEST_ID_ALPHABET[byte % REQUEST_ID_ALPHABET.length];
    }
  }
  if (out.length < length) throw new Error("난수 생성 실패");
  return out;
}

/** C9 요청 ID: {YYYYMMDDTHHMMSS}-{6자리 소문자영숫자} (KST). */
export function makeRequestId(now = new Date(), randomBytes = secureRandomBytes) {
  const p = kstParts(now);
  const stamp = `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
  return `${stamp}-${randomSuffix(randomBytes)}`;
}

export function requestPath(id) {
  if (!REQUEST_ID_PATTERN.test(String(id))) throw new GitHubError("invalid", 0, "요청 ID 형식이 올바르지 않습니다.");
  return `${REQUEST_DIR}/${id}.json`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonScalar(value) {
  return typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * C9 변경 요청 본문 생성. 화이트리스트 판정은 화면(폼)과 PC 가 하고, 여기서는 형식만 지킨다.
 * @returns {{id: string, created_at: string, client: string, changes: Record<string, unknown>, commands: string[]}}
 */
export function buildRequest({ changes = {}, commands = [], now = new Date(), randomBytes = secureRandomBytes } = {}) {
  if (!isPlainObject(changes)) throw new GitHubError("invalid", 0, "changes 는 객체여야 합니다.");
  if (!Array.isArray(commands)) throw new GitHubError("invalid", 0, "commands 는 배열이어야 합니다.");
  const sortedChanges = {};
  for (const key of Object.keys(changes).sort()) {
    if (!/^[a-z_]+(\.[a-z0-9_]+)+$/.test(key)) throw new GitHubError("invalid", 0, `변경 항목 이름 형식 오류: ${key}`);
    if (!isJsonScalar(changes[key])) throw new GitHubError("invalid", 0, `변경 값 형식 오류: ${key}`);
    sortedChanges[key] = changes[key];
  }
  const uniqueCommands = [...new Set(commands)];
  for (const command of uniqueCommands) {
    if (!ALLOWED_COMMANDS.includes(command)) throw new GitHubError("invalid", 0, `허용되지 않은 명령: ${String(command)}`);
  }
  if (Object.keys(sortedChanges).length === 0 && uniqueCommands.length === 0) {
    throw new GitHubError("invalid", 0, "보낼 변경 내용이 없습니다.");
  }
  return {
    id: makeRequestId(now, randomBytes),
    created_at: formatKstIso(now),
    client: REQUEST_CLIENT,
    changes: sortedChanges,
    commands: uniqueCommands,
  };
}

// ---------------------------------------------------------------- base64 (UTF-8)

export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(encoded) {
  const binary = atob(String(encoded).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** PUT /contents 본문: 커밋 메시지 + base64 JSON. */
export function requestPutBody(request) {
  requestPath(request.id);
  return {
    message: `pwa: settings request ${request.id}`,
    content: encodeBase64Utf8(`${JSON.stringify(request, null, 2)}\n`),
  };
}

// ---------------------------------------------------------------- URL·오류 메시지

export function contentsUrl(owner, repo, path) {
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

/**
 * HTTP 상태 → 사람이 이해할 메시지. operation: "read"(스냅샷) | "write"(요청 생성).
 * @returns {{kind: string, message: string}}
 */
export function describeHttpError(status, { operation = "read", rateLimited = false, repoLabel = "" } = {}) {
  const repoText = repoLabel ? ` (${repoLabel})` : "";
  if (rateLimited || status === HTTP_TOO_MANY) {
    return { kind: "rate_limit", message: "GitHub 호출 한도를 넘었습니다. 몇 분 뒤 다시 시도하세요." };
  }
  if (status === HTTP_UNAUTHORIZED) {
    return { kind: "auth", message: "토큰이 올바르지 않거나 만료되었습니다. 설정에서 새 토큰을 입력하세요." };
  }
  if (status === HTTP_FORBIDDEN) {
    return operation === "write"
      ? { kind: "forbidden", message: `이 토큰에는 쓰기 권한이 없습니다${repoText}. 토큰의 Contents 권한을 '읽기 및 쓰기(Read and write)'로 바꾸세요.` }
      : { kind: "forbidden", message: `이 토큰으로 저장소를 읽을 수 없습니다${repoText}. 토큰의 저장소 선택과 Contents 권한을 확인하세요.` };
  }
  if (status === HTTP_NOT_FOUND) {
    return operation === "write"
      ? { kind: "not_found", message: `저장소를 찾지 못했습니다${repoText}. 소유자·저장소 이름과 토큰의 저장소 접근 범위를 확인하세요.` }
      : {
          kind: "not_found",
          message: `스냅샷(data/snapshot.json)을 찾지 못했습니다${repoText}. 소유자·저장소 이름과 토큰의 저장소 접근 범위를 확인하세요 (권한이 없는 비공개 저장소도 404로 보입니다). PC가 아직 첫 동기화를 하지 않았을 수도 있습니다.`,
        };
  }
  if (status === HTTP_CONFLICT) {
    return { kind: "conflict", message: "저장소에서 충돌이 났습니다. 잠시 후 다시 보내세요." };
  }
  if (status === HTTP_UNPROCESSABLE) {
    return { kind: "invalid", message: "요청 파일을 만들 수 없습니다 (같은 이름이 있거나 형식 오류). 다시 보내세요." };
  }
  if (status >= HTTP_SERVER_ERROR) {
    return { kind: "server", message: `GitHub 서버 오류입니다 (HTTP ${status}). 잠시 후 다시 시도하세요.` };
  }
  return { kind: "http", message: `GitHub 요청이 실패했습니다 (HTTP ${status}).` };
}

export const NETWORK_ERROR_MESSAGE = "GitHub에 연결할 수 없습니다. 인터넷 연결을 확인하세요.";
export const TIMEOUT_ERROR_MESSAGE = `GitHub 응답이 ${FETCH_TIMEOUT_MS / 1000}초 안에 오지 않아 중단했습니다. 잠시 후 다시 시도하세요.`;

function isRateLimited(response) {
  const remaining = response.headers?.get?.("x-ratelimit-remaining");
  const retryAfter = response.headers?.get?.("retry-after");
  return remaining === "0" || (response.status === HTTP_FORBIDDEN && retryAfter !== null && retryAfter !== undefined);
}

// ---------------------------------------------------------------- 클라이언트

export class GitHubClient {
  #token;

  /**
   * @param {{owner: string, repo: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
   */
  constructor({ owner, repo, token, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS }) {
    const { errors } = validateConnection({ owner, repo, token });
    if (errors.length > 0) throw new GitHubError("config", 0, errors[0]);
    this.owner = String(owner).trim();
    this.repo = String(repo).trim();
    this.#token = String(token).trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  }

  get repoLabel() {
    return `${this.owner}/${this.repo}`;
  }

  #headers(accept) {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.#token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }

  async #send(url, init, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        cache: "no-store",          // 스냅샷은 항상 최신으로 (HTTP 캐시 미사용)
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new GitHubError("timeout", 0, TIMEOUT_ERROR_MESSAGE);
      throw new GitHubError("network", 0, NETWORK_ERROR_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const { kind, message } = describeHttpError(response.status, {
        operation,
        rateLimited: isRateLimited(response),
        repoLabel: this.repoLabel,
      });
      throw new GitHubError(kind, response.status, message);
    }
    return response;
  }

  /** data/snapshot.json 원문 (raw 미디어 타입). 파싱은 호출자가 한다. */
  async fetchSnapshotText() {
    const response = await this.#send(
      contentsUrl(this.owner, this.repo, SNAPSHOT_PATH),
      { method: "GET", headers: this.#headers(ACCEPT_RAW) },
      "read",
    );
    return await response.text();
  }

  /** control/requests/{id}.json 생성 (C9). 같은 이름이 있으면 422 → 오류. */
  async putRequest(request) {
    const path = requestPath(request.id);
    const response = await this.#send(
      contentsUrl(this.owner, this.repo, path),
      {
        method: "PUT",
        headers: { ...this.#headers(ACCEPT_JSON), "Content-Type": "application/json" },
        body: JSON.stringify(requestPutBody(request)),
      },
      "write",
    );
    let saved = path;
    try {
      const data = await response.json();
      if (typeof data?.content?.path === "string") saved = data.content.path;
    } catch {
      // 본문이 비어도 2xx 면 생성된 것으로 본다
    }
    return { path: saved };
  }

  toJSON() {
    return { owner: this.owner, repo: this.repo };   // 토큰 제외
  }
}
