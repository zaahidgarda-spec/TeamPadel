const CACHE_NAME = "padel-league-shell-v3";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.json",
  "/images/logo-dark.png",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/icon-192-maskable.png",
  "/images/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Real Web Push — a payload the server sent via web-push, delivered even
// when no tab is open. Falls back to a plain title if the payload isn't
// there or isn't JSON (a push service is allowed to redeliver without a
// body in some retry scenarios), so a malformed payload never means no
// notification shows at all.
self.addEventListener("push", (event) => {
  let data = { title: "Team Padel", body: "You have a new notification." };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) { /* keep the fallback above */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/images/icon-192.png",
      badge: "/images/icon-192.png",
      tag: data.type || "general",
    })
  );
});

// Focuses an already-open tab rather than always opening a new one — most
// people already have the app open in a background tab when this fires.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — league data, scores, and login state must
  // always come from the network, never a stale cached response.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;

  // Network-first: always try to fetch the latest version. The cache is
  // purely a fallback for when the network is unavailable (offline / flaky
  // connection), not a source of truth to prefer over it. The old
  // stale-while-revalidate approach here served last visit's cached copy
  // instantly and only refreshed the cache in the background — meaning
  // installed/PWA users could sit a full deploy behind indefinitely
  // without ever seeing what actually changed.
  //
  // cache:"no-store" also matters here — without it this fetch() still
  // consults the browser's own HTTP cache first, so a previous response's
  // Cache-Control (a long max-age from before this fix, or from a CDN in
  // front of the app) could keep serving stale bytes even though this
  // handler is "network-first" in intent.
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
