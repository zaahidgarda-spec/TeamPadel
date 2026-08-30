require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const routes = require("./src/routes");
const store = require("./src/store");
const { createSessionStore } = require("./src/sessionStore");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET is not set in this environment — falling back to a public, hardcoded value. Set SESSION_SECRET in your host's environment variables so sessions can't be forged.");
}

// GoDaddy (like most hosts) terminates HTTPS at a proxy in front of this
// app, so Express itself only ever sees plain HTTP. Without this, it thinks
// every request is insecure and silently refuses to set the session cookie
// (cookie.secure below is true in production), which breaks login entirely.
app.set("trust proxy", 1);
// Stop announcing the framework — not a real barrier on its own, but no
// reason to make a scanner's job easier for free.
app.disable("x-powered-by");

// Baseline hardening headers on every response. Deliberately NOT including
// Content-Security-Policy here — this app embeds a Jitsi video iframe,
// loads Google Fonts, and the spectator page (toss.html) runs an inline
// <script>, so a CSP needs to be built and tested against all of that
// deliberately rather than bolted on and risk silently breaking one of
// them in production.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); // stops the browser guessing a file's type into something more dangerous than it is
  res.setHeader("X-Frame-Options", "SAMEORIGIN"); // this site can't be iframed elsewhere — no clickjacking wrapper
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); // don't leak full URLs (which can carry league/fixture ids) to other sites we link out to
  // Camera/mic explicitly allowed for meet.jit.si too — that's the video
  // call embed's own origin, and a Permissions-Policy of just camera=(self)
  // would silently block it from ever getting camera/mic, no matter what
  // the iframe's own allow="camera; microphone" attribute asks for.
  res.setHeader("Permissions-Policy", 'camera=(self "https://meet.jit.si"), microphone=(self "https://meet.jit.si"), geolocation=()');
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains"); // once a browser's seen us over HTTPS, never let it silently fall back to plain HTTP
  }
  next();
});

// A general ceiling on the whole API, separate from (and much looser
// than) loginLimiter above — that one guards specific login endpoints
// against brute-forcing; this one just stops a script from hammering
// ordinary read endpoints (league data, player search) fast enough to
// either scrape the whole site in bulk or degrade the service for real
// users. Keyed by IP, same hand-rolled approach as loginLimiter and for
// the same reason — no new dependency for a host to fail to install.
const API_WINDOW_MS = 60 * 1000;
const API_MAX_REQUESTS = 180; // generous for a real user clicking around; well below what a scraping loop would want
const apiRequestCounts = new Map(); // ip -> { count, resetAt }
function apiRateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let entry = apiRequestCounts.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + API_WINDOW_MS };
    apiRequestCounts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > API_MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  }
  next();
}
// Bounded so a flood of distinct IPs (or IPv6 addresses, which are
// effectively unlimited) can't grow this map forever between restarts.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of apiRequestCounts) {
    if (entry.resetAt <= now) apiRequestCounts.delete(ip);
  }
}, API_WINDOW_MS).unref();

app.use(express.json({ limit: "6mb" })); // generous enough for a resized team logo
const sessionStore = createSessionStore();
if (!sessionStore) {
  console.log("UPSTASH_REDIS_REST_URL/TOKEN not set — sessions are in-memory (fine locally, not for production).");
}
app.use(
  session({
    store: sessionStore || undefined, // undefined lets express-session fall back to MemoryStore
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // requires HTTPS in production
      sameSite: "lax", // sent on normal navigation/same-site fetches, blocked cross-site — basic CSRF hardening
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

app.use("/api", apiRateLimiter, routes);
// Without this, a body over the 6mb limit above (or a host-imposed cap in
// front of this app) trips express.json's own error handler, which returns
// an HTML error page — res.json() in the client can't parse that, so the
// real cause gets lost behind a generic "Something went wrong."
app.use("/api", (err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "That file is too large — try a smaller photo." });
  }
  next(err);
});
// no-cache (not no-store) still lets the browser cache these, but forces a
// revalidation request on every load — so a stale service worker or CDN
// layer can't be the only thing standing between a deploy and what users
// actually see. Revalidation is a cheap 304 when nothing changed.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

store
  .init()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Padel league app running on http://localhost:" + PORT);
    });
  })
  .catch((e) => {
    console.error("Failed to initialize data store:", e.message);
    process.exit(1);
  });

async function shutdown() {
  await store.flush();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
