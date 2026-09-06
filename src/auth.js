const bcrypt = require("bcryptjs");
const store = require("./store");

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function verifyPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

// The site owner (see routes.js) is admin of every league automatically —
// no separate per-league login needed once you're logged in as owner.
function isOwnerSession(req) {
  return !!req.session.isOwner;
}
function isAdminSession(req, leagueId) {
  if (isOwnerSession(req)) return true;
  const u = req.session.user;
  return !!(u && u.leagueId === leagueId && u.role === "admin");
}

// Captain identity for a given league — the real captain-code session if
// there is one, or (when there isn't) a live check of a signed-in player
// account's own captaincies. Deliberately recomputed fresh on every call,
// never cached or written back to the session: a captaincy removed on My
// Profile takes effect on that person's very next request this way, with
// no separate revoke step needed anywhere. Every place that used to read
// req.session.user directly to check "is this the team's captain" should
// read through this instead, so a player account already recognized as a
// team's captain can act on it without first separately re-entering that
// team's code on this device too.
function resolveLeagueSession(req, leagueId) {
  const u = req.session.user;
  if (u && u.leagueId === leagueId) return u;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    const cap = account && (account.captaincies || []).find((c) => c.leagueId === leagueId);
    if (cap) return { leagueId, role: "captain", teamId: cap.teamId };
  }
  return null;
}
// A logged-in session is scoped to exactly one league at a time.
function requireLeagueSession(req, res, next) {
  if (isOwnerSession(req)) return next();
  if (!resolveLeagueSession(req, req.params.leagueId)) {
    return res.status(401).json({ error: "Not logged in to this league." });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdminSession(req, req.params.leagueId)) {
    return res.status(403).json({ error: "Admin login required." });
  }
  next();
}
// Admin (or the site owner), or the captain of the given team id (read from
// req.params.teamId or a resolver function for routes where the team id
// isn't a direct param).
function requireAdminOrCaptain(resolveTeamId) {
  return (req, res, next) => {
    if (isAdminSession(req, req.params.leagueId)) return next();
    const u = resolveLeagueSession(req, req.params.leagueId);
    if (!u) return res.status(401).json({ error: "Not logged in." });
    const teamId = resolveTeamId ? resolveTeamId(req) : req.params.teamId;
    if (u.role === "captain" && u.teamId === teamId) return next();
    return res.status(403).json({ error: "Not allowed for your account." });
  };
}

module.exports = { hashPassword, verifyPassword, requireLeagueSession, requireAdmin, requireAdminOrCaptain, resolveLeagueSession, isAdminSession, isOwnerSession };
