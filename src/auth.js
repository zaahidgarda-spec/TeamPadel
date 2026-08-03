const bcrypt = require("bcryptjs");

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

// A logged-in session is scoped to exactly one league at a time.
function requireLeagueSession(req, res, next) {
  if (isOwnerSession(req)) return next();
  if (!req.session.user || req.session.user.leagueId !== req.params.leagueId) {
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
    const u = req.session.user;
    if (!u || u.leagueId !== req.params.leagueId) return res.status(401).json({ error: "Not logged in." });
    const teamId = resolveTeamId ? resolveTeamId(req) : req.params.teamId;
    if (u.role === "captain" && u.teamId === teamId) return next();
    return res.status(403).json({ error: "Not allowed for your account." });
  };
}

module.exports = { hashPassword, verifyPassword, requireLeagueSession, requireAdmin, requireAdminOrCaptain, isAdminSession, isOwnerSession };
