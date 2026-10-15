// 서비스 워커: 앱 셸(정적 파일)만 캐시한다. GitHub API 응답(스냅샷·요청)은 절대 캐시하지 않는다.
// 앱 파일을 바꾸면 CACHE_VERSION 을 올린다 → 새 캐시 설치, 옛 캐시 삭제.

const CACHE_VERSION = "v1.0.2";
const CACHE_PREFIX = "stockdash-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./github.js",
  "./charts.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function shellKey(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  const relative = `./${url.pathname.slice(scope.pathname.length)}`;
  if (relative === "./") return "./index.html";
  return SHELL_FILES.includes(relative) ? relative : null;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // GitHub API 등 외부 출처 요청은 관여하지 않음 (캐시 없음)

  const key = request.mode === "navigate" ? "./index.html" : shellKey(url);
  if (!key) return;                                   // 셸 밖 파일은 네트워크 그대로

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(key);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") cache.put(key, response.clone());
      return response;
    }),
  );
});
