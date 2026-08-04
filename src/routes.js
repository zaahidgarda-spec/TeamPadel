const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const logic = require("./logic");
const { hashPassword, verifyPassword, requireAdmin, requireAdminOrCaptain, isAdminSession, isOwnerSession } = require("./auth");
const { sendMail } = require("./mailer");

const router = express.Router();

// The site owner account. Baked in here so it works with zero setup —
// still overridable via environment variables if you ever want to change
// it without touching code (env vars, if set, always win).
//
// Named OWNER_PASSCODE rather than OWNER_PIN: on GoDaddy Airo hosting,
// purely-numeric secret values silently failed to reach the running
// process (confirmed by testing) while alphanumeric ones worked fine.
// Keep this value's PIN non-numeric-only if you're hosting there.
const OWNER_USERNAME = (process.env.OWNER_USERNAME || "TYC").trim().toLowerCase();
const OWNER_PIN = process.env.OWNER_PASSCODE || "1969";
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function newLeagueObj(name, adminEmail) {
  return {
    id: logic.uid(),
    name,
    adminEmail: (adminEmail || "").trim(),
    adminPasswordHash: null,
    status: "setup",
    teams: [],
    fixtures: [],
    byes: [],
    playoffs: null,
    news: [],
    sponsors: [],
    defaultVenue: "",
    schedule: {}, // keyed by "r1","r2",...,"semis","final" -> { date, venue, time }
    notifications: [],
    playoffFormat: "none", // "none" | "semis_final" | "position" — chosen by the admin before the season starts
    roundMeta: {}, // keyed by round number -> { label, type: "table" | "knockout" } for admin-added rounds
    createdAt: Date.now(),
  };
}
function fixtureLabel(league, f) {
  if (f.stage === "semi") return "Semi finals";
  if (f.stage === "final") return "Final";
  if (f.stage === "position") return "Final spot playoff";
  const meta = league.roundMeta && league.roundMeta[f.round];
  return (meta && meta.label) || "Round " + f.round;
}
function notify(league, teamId, type, message) {
  if (!league.notifications) league.notifications = [];
  league.notifications.push({ id: logic.uid(), teamId, type, message, read: false, createdAt: Date.now() });
  const team = league.teams.find((t) => t.id === teamId);
  if (team && team.notifyEmail) {
    sendMail({ to: team.notifyEmail, subject: league.name + ": " + type, text: message }).catch(() => {});
  }
}
// No 0/O/1/I — avoids characters that look alike when a captain is reading
// a code off a phone screen or someone's handwriting.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genTeamCode(league) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (league.teams.some((t) => t.code === code));
  return code;
}

// Strip anything a given viewer shouldn't see: password hashes always,
// and any not-yet-submitted seed selection that isn't theirs (this is
// the real, server-enforced version of "blind" selection).
function sanitize(league, req) {
  const user = req.session.user;
  const isAdmin = isAdminSession(req, league.id);
  const teamId = user && user.leagueId === league.id ? user.teamId : null;

  const teams = league.teams.map((t) => {
    const { code, notifyEmail, ...rest } = t;
    const viewerIsThisTeam = isAdmin || (teamId && teamId === t.id);
    return { ...rest, code: viewerIsThisTeam ? code : undefined, notifyEmail: viewerIsThisTeam ? notifyEmail : undefined };
  });

  const fixtures = league.fixtures.map((f) => {
    const copy = JSON.parse(JSON.stringify(f));
    ["selectionA", "selectionB"].forEach((key, idx) => {
      const side = key === "selectionA" ? "A" : "B";
      const ownerTeamId = side === "A" ? f.teamA : f.teamB;
      const viewerIsOwner = isAdmin || (teamId && teamId === ownerTeamId);
      if (!copy[key].submitted && !viewerIsOwner) {
        copy[key] = { submitted: false, pairs: [[null, null], [null, null], [null, null], [null, null]] };
      }
    });
    return copy;
  });

  let playoffs = null;
  if (league.playoffs) {
    if (league.playoffs.format === "position") {
      playoffs = { format: "position", matches: (league.playoffs.matches || []).map((f) => sanitizeOne(f, isAdmin, teamId)) };
    } else {
      playoffs = {
        format: "semis_final",
        semis: league.playoffs.semis.map((f) => sanitizeOne(f, isAdmin, teamId)),
        final: sanitizeOne(league.playoffs.final, isAdmin, teamId),
      };
    }
  }

  const { adminPasswordHash, ...leagueRest } = league;
  return { ...leagueRest, teams, fixtures, playoffs, adminRegistered: !!adminPasswordHash };
}
function sanitizeOne(f, isAdmin, teamId) {
  const copy = JSON.parse(JSON.stringify(f));
  ["selectionA", "selectionB"].forEach((key) => {
    const side = key === "selectionA" ? "A" : "B";
    const ownerTeamId = side === "A" ? f.teamA : f.teamB;
    const viewerIsOwner = isAdmin || (teamId && teamId === ownerTeamId);
    if (!copy[key].submitted && !viewerIsOwner) {
      copy[key] = { submitted: false, pairs: [[null, null], [null, null], [null, null], [null, null]] };
    }
  });
  return copy;
}

function leagueStatus(l) {
  return l.status || (l.fixtures.length > 0 ? "active" : "setup");
}
function isRoundOpen(league, fixture) {
  if (fixture.stage === "regular") {
    if (fixture.round === 1) return true;
    const prev = league.fixtures.filter((f) => f.round === fixture.round - 1);
    return prev.length > 0 && prev.every((f) => f.finalized);
  }
  if (fixture.stage === "semi") return true;
  if (fixture.stage === "final") return !!(fixture.teamA && fixture.teamB);
  return false;
}
function findFixture(league, fixtureId) {
  let f = league.fixtures.find((x) => x.id === fixtureId);
  if (f) return f;
  if (league.playoffs) {
    if (league.playoffs.format === "position") {
      f = (league.playoffs.matches || []).find((x) => x.id === fixtureId);
      if (f) return f;
    } else {
      if (league.playoffs.final.id === fixtureId) return league.playoffs.final;
      f = league.playoffs.semis.find((x) => x.id === fixtureId);
      if (f) return f;
    }
  }
  return null;
}
function syncPlayoffs(league) {
  if (!league.playoffs || league.playoffs.format !== "semis_final") return false;
  let changed = false;
  const f = league.playoffs.final;
  const [s0, s1] = league.playoffs.semis;
  if (!f.teamA && s0.finalized) {
    const w = logic.matchWinner(s0);
    if (w) { f.teamA = w === "A" ? s0.teamA : s0.teamB; changed = true; }
  }
  if (!f.teamB && s1.finalized) {
    const w = logic.matchWinner(s1);
    if (w) { f.teamB = w === "A" ? s1.teamA : s1.teamB; changed = true; }
  }
  return changed;
}

/* ---------- Leagues ---------- */

router.get("/leagues", (req, res) => {
  const index = store.getIndex();
  const enriched = index.map((entry) => {
    const league = store.getLeague(entry.id);
    return {
      ...entry,
      status: league ? leagueStatus(league) : "setup",
      teamCount: league ? league.teams.length : 0,
      // Just enough for a logo strip on the league card — never codes/emails.
      teams: league ? league.teams.map((t) => ({ name: t.name, logo: t.logo })) : [],
    };
  });
  res.json(enriched);
});

router.post("/owner/login", (req, res) => {
  if (!OWNER_USERNAME || !OWNER_PIN) return res.status(500).json({ error: "Admin login isn't configured on this server yet — set OWNER_USERNAME and OWNER_PASSCODE." });
  const { username, pin } = req.body || {};
  const usernameOk = (username || "").trim().toLowerCase() === OWNER_USERNAME;
  const pinOk = safeEqual(pin, OWNER_PIN);
  if (!usernameOk || !pinOk) return res.status(401).json({ error: "Incorrect username or PIN." });
  req.session.isOwner = true;
  res.json({ ok: true });
});
router.post("/owner/logout", (req, res) => {
  req.session.isOwner = false;
  res.json({ ok: true });
});
router.get("/owner/me", (req, res) => {
  res.json({ isOwner: !!req.session.isOwner });
});

router.post("/leagues", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Only the site admin can create leagues. Log in first." });
  const { name, adminEmail } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "League name is required." });
  if (!adminEmail || !adminEmail.includes("@")) return res.status(400).json({ error: "A valid admin email is required." });
  const league = newLeagueObj(name.trim(), adminEmail);
  store.saveLeague(league.id, league);
  const index = store.getIndex();
  index.push({ id: league.id, name: league.name, createdAt: league.createdAt });
  store.saveIndex(index);
  res.json({ id: league.id });
});

router.get("/leagues/:leagueId", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (!league.sponsors) league.sponsors = [];
  if (league.defaultVenue === undefined) league.defaultVenue = "";
  if (!league.schedule) league.schedule = {};
  if (!league.notifications) league.notifications = [];
  if (!league.playoffFormat) league.playoffFormat = league.playoffs ? "semis_final" : "none";
  if (!league.roundMeta) league.roundMeta = {};
  let migrated = syncPlayoffs(league);
  // Teams created before per-team access codes existed won't have one —
  // give them one automatically so every captain can log in.
  league.teams.forEach((t) => {
    if (!t.code) { t.code = genTeamCode(league); migrated = true; }
  });
  if (migrated) store.saveLeague(league.id, league);
  res.json(sanitize(league, req));
});

// Full, unsanitized backup — admin only, since it includes password hashes
// (not reversible, but still only for the person who owns this data).
router.get("/leagues/:leagueId/export", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  res.json(league);
});

router.put("/leagues/:leagueId/name", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  league.name = (req.body.name || league.name).trim();
  store.saveLeague(league.id, league);
  const index = store.getIndex();
  const entry = index.find((l) => l.id === league.id);
  if (entry) { entry.name = league.name; store.saveIndex(index); }
  res.json({ ok: true });
});

router.delete("/leagues/:leagueId", requireAdmin, (req, res) => {
  store.deleteLeague(req.params.leagueId);
  const index = store.getIndex().filter((l) => l.id !== req.params.leagueId);
  store.saveIndex(index);
  req.session.destroy(() => {});
  res.json({ ok: true });
});

/* ---------- Auth ---------- */

router.get("/leagues/:leagueId/me", (req, res) => {
  if (isOwnerSession(req)) return res.json({ role: "admin", teamId: null });
  const u = req.session.user;
  if (!u || u.leagueId !== req.params.leagueId) return res.json({ role: "guest" });
  res.json({ role: u.role, teamId: u.teamId || null });
});

router.post("/leagues/:leagueId/register", async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { email, password } = req.body || {};
  if (!email) return res.status(400).json({ error: "Enter an email." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Choose a password of at least 6 characters." });
  const val = email.trim().toLowerCase();

  if (!league.adminEmail || val !== league.adminEmail.toLowerCase())
    return res.status(404).json({ error: "No league admin account found for that email." });
  if (league.adminPasswordHash) return res.status(400).json({ error: "Already registered — log in instead." });
  league.adminPasswordHash = await hashPassword(password);
  store.saveLeague(league.id, league);
  req.session.user = { leagueId: league.id, role: "admin" };
  res.json({ role: "admin" });
});

router.post("/leagues/:leagueId/login", async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });
  const val = email.trim().toLowerCase();

  if (!league.adminEmail || val !== league.adminEmail.toLowerCase())
    return res.status(404).json({ error: "No league admin account found for that email." });
  if (!league.adminPasswordHash) return res.status(400).json({ error: "Not registered yet — use Register instead." });
  const ok = await verifyPassword(password, league.adminPasswordHash);
  if (!ok) return res.status(401).json({ error: "Incorrect password." });
  req.session.user = { leagueId: league.id, role: "admin" };
  res.json({ role: "admin" });
});

router.post("/leagues/:leagueId/captain-login", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { code, email } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: "Enter your team code." });
  const val = code.trim().toUpperCase();
  const team = league.teams.find((t) => t.code === val);
  if (!team) return res.status(401).json({ error: "Invalid team code." });
  if (email !== undefined && email.trim()) {
    if (!email.includes("@")) return res.status(400).json({ error: "Enter a valid email, or leave it blank." });
    team.notifyEmail = email.trim();
    store.saveLeague(league.id, league);
  }
  req.session.user = { leagueId: league.id, role: "captain", teamId: team.id };
  res.json({ role: "captain", teamId: team.id });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ---------- Teams & players (admin-managed) ---------- */

router.post("/leagues/:leagueId/teams", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Team name is required." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams are locked once the season has started." });
  if (league.teams.some((t) => t.name.toLowerCase() === name.trim().toLowerCase()))
    return res.status(400).json({ error: "A team with that name already exists." });
  const code = genTeamCode(league);
  const team = { id: logic.uid(), name: name.trim(), code, logo: "", notifyEmail: "", players: [] };
  league.teams.push(team);
  store.saveLeague(league.id, league);
  res.json({ id: team.id, code: team.code });
});

router.post("/leagues/:leagueId/teams/bulk", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams are locked once the season has started." });
  const lines = String(req.body.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const newTeams = [];
  lines.forEach((line) => {
    const name = line.split(",")[0].trim();
    if (!name) return;
    if (league.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    const code = genTeamCode(league);
    const team = { id: logic.uid(), name, code, logo: "", notifyEmail: "", players: [] };
    league.teams.push(team);
    newTeams.push(team);
  });
  store.saveLeague(league.id, league);
  res.json({ added: newTeams.length, teams: newTeams.map((t) => ({ id: t.id, name: t.name, code: t.code })) });
});

router.put("/leagues/:leagueId/teams/:teamId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (req.body.logo !== undefined) team.logo = req.body.logo;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put(
  "/leagues/:leagueId/teams/:teamId/notify-email",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const email = (req.body.email || "").trim();
    if (email && !email.includes("@")) return res.status(400).json({ error: "Enter a valid email, or leave it blank to turn notifications off." });
    team.notifyEmail = email;
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

router.post("/leagues/:leagueId/teams/:teamId/reset-code", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  team.code = genTeamCode(league);
  store.saveLeague(league.id, league);
  res.json({ ok: true, code: team.code });
});

router.delete("/leagues/:leagueId/teams/:teamId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams are locked once the season has started." });
  league.teams = league.teams.filter((t) => t.id !== req.params.teamId);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post(
  "/leagues/:leagueId/teams/:teamId/players",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Player name is required." });
    team.players.push({ id: logic.uid(), name: name.trim() });
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

router.post(
  "/leagues/:leagueId/teams/:teamId/players/bulk",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const names = String(req.body.text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let added = 0;
    names.forEach((name) => {
      if (team.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
      team.players.push({ id: logic.uid(), name });
      added++;
    });
    store.saveLeague(league.id, league);
    res.json({ ok: true, added });
  }
);

router.delete(
  "/leagues/:leagueId/teams/:teamId/players/:playerId",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    team.players = team.players.filter((p) => p.id !== req.params.playerId);
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

/* ---------- Season & fixtures ---------- */

router.post("/leagues/:leagueId/season/start", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (league.teams.length < 3) return res.status(400).json({ error: "Add at least 3 teams first." });
  const format = req.body.playoffFormat;
  if (format && !["none", "semis_final", "position"].includes(format)) return res.status(400).json({ error: "Unknown playoff format." });
  const { fixtures, byes } = logic.generateRoundRobin(league.teams, !!req.body.doubleRound);
  league.fixtures = fixtures;
  league.byes = byes;
  league.playoffFormat = format || "none";
  league.status = "active";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/season/reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.fixtures = [];
  league.byes = [];
  league.playoffs = null;
  league.roundMeta = {};
  league.status = "setup";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/default-venue", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.defaultVenue = (req.body.venue || "").trim();
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// key is "r1","r2",... for regular rounds, or "semis"/"final" for playoffs —
// one date/venue for every match in that round, since a whole night is
// played on the same date at (usually) the same venue.
router.put("/leagues/:leagueId/schedule/:key", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league.schedule) league.schedule = {};
  const entry = league.schedule[req.params.key] || { date: "", venue: "", time: "" };
  if (req.body.date !== undefined) entry.date = req.body.date;
  if (req.body.venue !== undefined) entry.venue = req.body.venue;
  if (req.body.time !== undefined) entry.time = req.body.time;
  league.schedule[req.params.key] = entry;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Admin-added extra round, beyond the auto-generated round robin. "table"
// rounds count toward standings like any other round; "knockout" rounds
// (e.g. a one-off decider) are excluded from computeStandings but still
// show up in fixtures/results using the normal round machinery.
router.post("/leagues/:leagueId/rounds", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (leagueStatus(league) === "setup") return res.status(400).json({ error: "Start the season before adding rounds." });
  const { name, type, matches } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Give the round a name." });
  if (!["table", "knockout"].includes(type)) return res.status(400).json({ error: "Choose whether this round counts toward the league table or is a knockout round." });
  if (!Array.isArray(matches) || matches.length === 0) return res.status(400).json({ error: "Add at least one match." });
  for (const m of matches) {
    if (!m || !m.teamA || !m.teamB) return res.status(400).json({ error: "Every fixture needs two teams." });
    if (m.teamA === m.teamB) return res.status(400).json({ error: "A team can't play itself." });
    if (!league.teams.some((t) => t.id === m.teamA) || !league.teams.some((t) => t.id === m.teamB))
      return res.status(400).json({ error: "Unknown team." });
  }
  const nextRound = (league.fixtures.reduce((max, f) => Math.max(max, f.round), 0) || 0) + 1;
  const newFixtures = matches.map((m) =>
    Object.assign({ id: logic.uid(), round: nextRound, stage: "regular", teamA: m.teamA, teamB: m.teamB }, logic.emptyFixtureExtras())
  );
  league.fixtures.push(...newFixtures);
  if (!league.roundMeta) league.roundMeta = {};
  league.roundMeta[nextRound] = { label: name.trim(), type };
  store.saveLeague(league.id, league);
  res.json({ ok: true, round: nextRound });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/selection", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.teamA || !f.teamB) return res.status(400).json({ error: "Teams for this fixture aren't decided yet." });

  const u = req.session.user;
  const ownerHere = isOwnerSession(req);
  if (!ownerHere && (!u || u.leagueId !== league.id)) return res.status(401).json({ error: "Not logged in." });
  const side = ownerHere || u.role === "admin" ? req.body.side : u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
  if (!side) return res.status(403).json({ error: "You're not in this fixture." });
  if (!isRoundOpen(league, f)) return res.status(400).json({ error: "This round isn't open yet." });

  const selKey = side === "A" ? "selectionA" : "selectionB";
  if (f[selKey].submitted) return res.status(400).json({ error: "Already submitted for this fixture." });

  const pairs = req.body.pairs;
  if (!Array.isArray(pairs) || pairs.length !== 4) return res.status(400).json({ error: "Send exactly 4 seed pairs." });
  const result = logic.validateSelection(pairs, !!req.body.confirmDoubleUp);
  if (result) return res.status(400).json({ error: result.error, needsConfirm: !!result.needsConfirm });

  f[selKey] = { submitted: true, pairs };
  const label = fixtureLabel(league, f);
  const teamA = league.teams.find((t) => t.id === f.teamA);
  const teamB = league.teams.find((t) => t.id === f.teamB);
  const myTeam = side === "A" ? teamA : teamB;
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  if (f.selectionA.submitted && f.selectionB.submitted) {
    notify(league, f.teamA, "selection", `Line-ups revealed for ${label}: ${teamA ? teamA.name : "?"} vs ${teamB ? teamB.name : "?"}.`);
    notify(league, f.teamB, "selection", `Line-ups revealed for ${label}: ${teamA ? teamA.name : "?"} vs ${teamB ? teamB.name : "?"}.`);
  } else {
    notify(league, oppTeamId, "selection", `${myTeam ? myTeam.name : "Your opponent"} submitted their line-up for ${label} — you're up.`);
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/selection/unlock", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const side = req.body.side;
  const selKey = side === "A" ? "selectionA" : "selectionB";
  f[selKey].submitted = false;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });

  const u = req.session.user;
  const isAdmin = isAdminSession(req, league.id);
  const isPlayer = u && u.leagueId === league.id && u.role === "captain" && (u.teamId === f.teamA || u.teamId === f.teamB);
  if (!isAdmin && !isPlayer) return res.status(403).json({ error: "Not allowed." });
  if (f.finalized && !isAdmin) return res.status(400).json({ error: "This fixture is finalized — ask the admin to unlock it." });
  if (!f.selectionA.submitted || !f.selectionB.submitted) return res.status(400).json({ error: "Both line-ups must be submitted first." });

  if (req.body.sets) f.rubbers[idx].sets = req.body.sets;
  if (req.body.tb) f.rubbers[idx].tb = req.body.tb;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/finalize", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const u = req.session.user;
  const isAdmin = isAdminSession(req, league.id);
  const isPlayer = u && u.leagueId === league.id && u.role === "captain" && (u.teamId === f.teamA || u.teamId === f.teamB);
  if (!isAdmin && !isPlayer) return res.status(403).json({ error: "Not allowed." });
  if (!logic.requiredRubbersOk(f)) return res.status(400).json({ error: "All matches need a decided winner first." });
  f.finalized = true;
  syncPlayoffs(league);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Time slots (play order for the night) ---------- */

router.post("/leagues/:leagueId/fixtures/:fixtureId/timeslot/propose", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!(f.selectionA.submitted && f.selectionB.submitted)) return res.status(400).json({ error: "Both line-ups need to be revealed first." });
  const u = req.session.user;
  if (!u || u.leagueId !== league.id || u.role !== "captain") return res.status(403).json({ error: "Only a team captain can propose a time slot order." });
  const side = u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
  if (!side) return res.status(403).json({ error: "You're not in this fixture." });
  if (f.slotOrder) return res.status(400).json({ error: "The order is already agreed. Ask the admin to reset it first." });
  const order = req.body.order;
  if (!logic.isValidSlotOrder(order)) return res.status(400).json({ error: "Each seed needs exactly one slot." });
  f.slotProposal = { by: side, order };
  const label = fixtureLabel(league, f);
  const proposerTeam = league.teams.find((t) => t.id === (side === "A" ? f.teamA : f.teamB));
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  notify(league, oppTeamId, "timeslot", `${proposerTeam ? proposerTeam.name : "Your opponent"} proposed a playing order for ${label} — review it.`);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/timeslot/confirm", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.slotProposal) return res.status(400).json({ error: "There's no proposal to confirm." });
  const u = req.session.user;
  const isAdmin = isAdminSession(req, league.id);
  const side = u && u.role === "captain" ? (u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null) : null;
  if (!isAdmin && (!side || side === f.slotProposal.by)) return res.status(403).json({ error: "Only the other captain can confirm this proposal." });
  f.slotOrder = f.slotProposal.order;
  const proposerSide = f.slotProposal.by;
  const proposerTeamId = proposerSide === "A" ? f.teamA : f.teamB;
  notify(league, proposerTeamId, "timeslot", `Your proposed playing order for ${fixtureLabel(league, f)} was confirmed.`);
  f.slotProposal = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/timeslot/reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  f.slotOrder = null;
  f.slotProposal = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/unlock", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  f.finalized = false;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/knockout/generate", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!["semis_final", "position"].includes(league.playoffFormat)) return res.status(400).json({ error: "This league wasn't set up with playoffs." });
  const allDone = league.fixtures.length > 0 && league.fixtures.every((f) => f.finalized);
  if (!allDone) return res.status(400).json({ error: "Every regular-season fixture must be finalized first." });
  const standings = logic.computeStandings(league);
  if (league.playoffFormat === "semis_final") {
    if (league.teams.length < 4) return res.status(400).json({ error: "Need at least 4 teams for a knockout stage." });
    const semi1 = logic.makeKnockoutFixture("semi", standings[0].id, standings[3].id);
    const semi2 = logic.makeKnockoutFixture("semi", standings[1].id, standings[2].id);
    const final = logic.makeKnockoutFixture("final", null, null);
    league.playoffs = { format: "semis_final", semis: [semi1, semi2], final };
  } else {
    if (league.teams.length < 2) return res.status(400).json({ error: "Need at least 2 teams for final spot playoffs." });
    const matches = [];
    for (let i = 0; i < standings.length; i += 2) {
      if (!standings[i + 1]) break; // odd team out keeps their table position, no match
      matches.push(logic.makeKnockoutFixture("position", standings[i].id, standings[i + 1].id));
    }
    league.playoffs = { format: "position", matches };
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- News ---------- */

router.get("/leagues/:leagueId/news", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  res.json((league.news || []).slice().sort((a, b) => b.createdAt - a.createdAt));
});
router.post("/leagues/:leagueId/news", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { title, body } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Title is required." });
  if (!league.news) league.news = [];
  league.news.push({ id: logic.uid(), title: title.trim(), body: (body || "").trim(), createdAt: Date.now() });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.delete("/leagues/:leagueId/news/:postId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.news = (league.news || []).filter((p) => p.id !== req.params.postId);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Stats ---------- */

router.get("/leagues/:leagueId/stats", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  res.json(logic.computeLeagueStats(league));
});
router.get("/leagues/:leagueId/players/:playerId/history", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  res.json(logic.playerMatchHistory(league, req.params.playerId));
});

/* ---------- Notifications ---------- */

router.get("/leagues/:leagueId/notifications", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const u = req.session.user;
  const admin = isAdminSession(req, league.id);
  if (!admin && (!u || u.leagueId !== league.id)) return res.json([]);
  const all = league.notifications || [];
  const mine = admin ? all : all.filter((n) => n.teamId === u.teamId);
  res.json(mine.slice().sort((a, b) => b.createdAt - a.createdAt));
});
router.post("/leagues/:leagueId/notifications/:notifId/read", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const u = req.session.user;
  const admin = isAdminSession(req, league.id);
  if (!admin && (!u || u.leagueId !== league.id)) return res.status(401).json({ error: "Not logged in." });
  const n = (league.notifications || []).find((x) => x.id === req.params.notifId);
  if (!n) return res.status(404).json({ error: "Not found." });
  if (!admin && n.teamId !== u.teamId) return res.status(403).json({ error: "Not yours." });
  n.read = true;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.post("/leagues/:leagueId/notifications/read-all", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const u = req.session.user;
  if (!u || u.leagueId !== league.id || u.role !== "captain") return res.status(401).json({ error: "Not logged in." });
  (league.notifications || []).forEach((n) => { if (n.teamId === u.teamId) n.read = true; });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Sponsors ---------- */

router.post("/leagues/:leagueId/sponsors", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { name, link, image } = req.body || {};
  if (!image) return res.status(400).json({ error: "An image is required." });
  if (!league.sponsors) league.sponsors = [];
  league.sponsors.push({ id: logic.uid(), name: (name || "").trim(), link: (link || "").trim(), image });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.delete("/leagues/:leagueId/sponsors/:sponsorId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.sponsors = (league.sponsors || []).filter((s) => s.id !== req.params.sponsorId);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

module.exports = router;
