require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const routes = require("./src/routes");
const store = require("./src/store");
const { createSessionStore } = require("./src/sessionStore");

// An async route handler (router.get(path, async (req, res) => {...})) that
// throws or rejects doesn't get caught by Express 4's own error handling —
// it becomes an unhandled promise rejection, and Node treats those as fatal
// by default (crashes the whole process, taking every other request down
// with it, not just the one that hit the bug — this is what actually
// happened on 2026-09-02: one bad record in /admin/players/accounts crash-
// looped the entire site for hours). Log it and let the one request that
// caused it fail/hang instead of killing the process for everyone else.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (request may have failed, server stays up):", err);
});

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
// index.html's own no-cache header was meant to guarantee every visit sees
// the latest app.js/styles.css — but that only holds if whatever's in front
// of this server (GoDaddy's CDN, in production) actually honors "no-cache"
// for those files too. It doesn't: JS/CSS come back with a month-long
// max-age regardless of what this server sends, so a browser or edge node
// that cached an old app.js before a deploy can keep serving it for weeks,
// no matter how fresh index.html itself is. A version query string fixes
// this at the one layer that's reliably honored (this server) — the exact
// URL changes on every deploy, so there's no stale copy to have cached
// under that URL in the first place. Computed once at boot (this process
// restarts on every deploy) and baked into index.html here, since the
// static middleware below would otherwise hand back the unversioned file
// verbatim for "/" and "/index.html" before this ever runs.
const ASSET_VERSION = Date.now();
const indexHtmlPath = path.join(__dirname, "public", "index.html");
const versionedIndexHtml = fs
  .readFileSync(indexHtmlPath, "utf8")
  .replace('src="/app.js"', `src="/app.js?v=${ASSET_VERSION}"`)
  .replace('href="/styles.css"', `href="/styles.css?v=${ASSET_VERSION}"`);
function sendVersionedIndex(req, res) {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(versionedIndexHtml);
}
app.get(["/", "/index.html"], sendVersionedIndex);
// no-cache (not no-store) still lets the browser cache these, but forces a
// revalidation request on every load — belt-and-suspenders alongside the
// version query string above, for anything (an image, a direct /app.js
// hit with no query) that isn't going through index.html.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// A pay link shared over WhatsApp/iMessage/etc. used to be a bare
// #pay-link/... hash — but a hash fragment never reaches the server at
// all, so the link-preview crawler those apps run had nothing to read
// except index.html's own static <head>, showing generic "Team Padel"
// branding on every shared link regardless of what it actually was.
// These two routes are real paths instead: each hands the crawler its own
// <head> (a "Payment link" title, the amount/who it's for, and a
// dedicated payment-themed image instead of the site logo), then sends a
// real visitor straight on into the exact same #pay-link/... page the
// app has always used — nothing about the actual payment flow changes.
// Mirrors possessive() in public/app.js — "Dons'" not "Dons's".
function possessive(name) {
  return (name || "") + (/s$/i.test(name || "") ? "'" : "'s");
}
function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function payLinkLandingHtml({ title, description, base, redirectHash }) {
  const image = `${base}/images/payment-link-og.png`;
  const url = `${base}${redirectHash}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtmlAttr(title)}</title>
<meta name="description" content="${escapeHtmlAttr(description)}">
<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(description)}">
<meta property="og:image" content="${image}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="noindex">
<script>window.location.replace(${JSON.stringify(redirectHash)});</script>
</head>
<body>
<p>Opening your payment page… if nothing happens, <a href="${escapeHtmlAttr(redirectHash)}">tap here</a>.</p>
</body>
</html>`;
}
app.get("/pay/:leagueId/:teamId/:playerId/:token", (req, res) => {
  const { leagueId, teamId, playerId, token } = req.params;
  const base = `${req.protocol}://${req.get("host")}`;
  const redirectHash = `/#pay-link/${leagueId}/${teamId}/${playerId}/${token}`;
  let title = "Payment link — Team Padel", description = "Tap to pay securely via PayFast.";
  try {
    const league = store.getLeague(leagueId);
    const { team, player } = league ? routes.findTeamAndPlayer(league, teamId, playerId) : {};
    if (league && team && player && player.payLinkToken === token) {
      const amountRands = (routes.playerShareCents(league, team) / 100).toFixed(2);
      title = `Payment link — R${amountRands}`;
      description = `${possessive(player.name)} share for ${team.name} · ${league.name} — tap to pay securely via PayFast.`;
    }
  } catch (e) {
    console.error("Building pay-link preview failed (redirect still proceeds):", e.message);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.send(payLinkLandingHtml({ title, description, base, redirectHash }));
});
app.get("/pay-team/:leagueId/:teamId/:token", (req, res) => {
  const { leagueId, teamId, token } = req.params;
  const base = `${req.protocol}://${req.get("host")}`;
  const redirectHash = `/#pay-link-team/${leagueId}/${teamId}/${token}`;
  let title = "Payment link — Team Padel", description = "Tap to pay securely via PayFast.";
  try {
    const league = store.getLeague(leagueId);
    const team = league && league.teams.find((t) => t.id === teamId);
    if (league && team && team.payLinkToken === token) {
      const amountRands = ((league.registrationFeeCents || 0) / 100).toFixed(2);
      title = `Payment link — R${amountRands}`;
      description = `${possessive(team.name)} season fee · ${league.name} — tap to pay securely via PayFast.`;
    }
  } catch (e) {
    console.error("Building team pay-link preview failed (redirect still proceeds):", e.message);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.send(payLinkLandingHtml({ title, description, base, redirectHash }));
});

app.get("*", sendVersionedIndex);

store
  .init()
  .then(() => {
    routes.backfillRoundRecaps();
    // 36-hours-before-kickoff line-up reminders — run once immediately
    // (so a redeploy doesn't leave captains waiting up to LINEUP_CHECK_MS
    // for the first check) and then on the same interval forever.
    routes.checkLineupReminders();
    const LINEUP_CHECK_MS = 15 * 60 * 1000;
    setInterval(routes.checkLineupReminders, LINEUP_CHECK_MS).unref();
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
