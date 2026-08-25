const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const logic = require("./logic");
const { hashPassword, verifyPassword, requireAdmin, requireAdminOrCaptain, isAdminSession, isOwnerSession } = require("./auth");
const { sendMail } = require("./mailer");

const router = express.Router();

// Hand-rolled rather than a library (e.g. express-rate-limit) — deliberately
// zero-dependency, so it never breaks on a host that reuses a stale
// node_modules and won't pick up a newly-added package.
//
// Shared across every login-type endpoint (site owner, league admin, team
// code) and keyed by IP — brute-forcing one doesn't reset the count against
// the others. Only failed attempts count (checked via res.on("finish")), so
// a captain who gets their code right first try never sees this, no matter
// how often they log in.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many login attempts from this network. Please wait 15 minutes and try again." });
  }
  res.on("finish", () => { if (res.statusCode >= 400) entry.count++; });
  next();
}

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

function newLeagueObj(name, adminEmail, format) {
  return {
    id: logic.uid(),
    name,
    // "teams" (the original format: rosters of many players, a weekly
    // blind pair-selection, 4 sub-matches a night) or "pairs" (a Vibora
    // League: each entrant is a fixed 2-player pair, one match a night, no
    // weekly selection at all since the pair already is the line-up).
    format: format === "pairs" ? "pairs" : "teams",
    adminEmail: (adminEmail || "").trim(),
    adminPasswordHash: null,
    status: "setup",
    teams: [],
    // Vibora-only: optional groups a pair can be assigned to (e.g. "Wimbledon"
    // within "Division 1"), each running its own independent round-robin.
    // Empty means the league is one flat group, same as before this existed.
    groups: [], // [{ id, name, division }]
    // Past-season champions, admin-entered — free text, not tied to any
    // current pair/player record (the app's own season history may not
    // reach back that far, and a name here doesn't have to match one
    // exactly). Grouped and displayed by season on the Hall of Fame tab.
    hallOfFame: [], // [{ id, season, label, winner }]
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
    potwVotes: {}, // keyed by round number -> { [voterTeamId]: pairKey } — one vote per team per round
    potwNotified: {}, // keyed by round number -> true once captains have been notified voting is open
    courtCount: 4,
    slotCount: 3,
    courtNames: [], // keyed by court index -> custom label; falls back to "Court N" when blank
    tieringEnabled: false, // gold-tier seeding — off by default, admin opts in
    goldTierCount: 0, // how many players per team must be tagged "gold" once enabled
    strength: 0, // 0-5 rating admin sets to describe how competitive the league is; 0 = not rated, hidden on the league card
    // keyed by round number -> 2D array [slotIdx][courtIdx] of { fixtureId, seed } | null —
    // which match (a specific seed within a fixture) is assigned to that court at that time.
    courtSchedule: {},
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
// `extra` is optional structured data a notification can carry alongside
// its message — e.g. { round } so the frontend can jump straight to the
// relevant page on click instead of the reader having to go find it.
function notify(league, teamId, type, message, extra) {
  if (!league.notifications) league.notifications = [];
  league.notifications.push({ id: logic.uid(), teamId, type, message, read: false, createdAt: Date.now(), ...extra });
  const team = league.teams.find((t) => t.id === teamId);
  if (team && team.notifyEmail) {
    sendMail({ to: team.notifyEmail, subject: league.name + ": " + type, text: message }).catch(() => {});
  }
}
// No 0/O/1/I — avoids characters that look alike when a captain is reading
// a code off a phone screen or someone's handwriting.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Checked against every league's teams, not just this one — codes need to
// be globally unique so a captain can log in from the home page with just
// their code, with no need to say which league they're in first.
function codeInUse(code) {
  return store.getIndex().some((entry) => {
    const other = store.getLeague(entry.id);
    return other && other.teams.some((t) => t.code === code);
  });
}
function genTeamCode(league) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (codeInUse(code));
  return code;
}

// Pair of the week: every specific partnership that actually took the court
// that round — one per seed per side — is eligible, identified by fixture +
// side + seed (not just the two player IDs, since in theory the same two
// names could be paired up more than once across seeds/fixtures).
function potwEligiblePairs(league, round) {
  const pairs = [];
  league.fixtures.filter((f) => f.round === round).forEach((f) => {
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    [["A", teamA, f.selectionA], ["B", teamB, f.selectionB]].forEach(([side, team, selection]) => {
      if (!team || !selection || !selection.submitted) return;
      selection.pairs.forEach((pair, seed) => {
        const [p1id, p2id] = pair || [];
        const p1 = team.players.find((p) => p.id === p1id);
        const p2 = team.players.find((p) => p.id === p2id);
        if (!p1 || !p2) return;
        pairs.push({
          key: `${f.id}:${side}:${seed}`,
          fixtureId: f.id,
          side,
          seed,
          teamId: team.id,
          teamName: team.name,
          playerAId: p1.id,
          playerAName: p1.name,
          playerBId: p2.id,
          playerBName: p2.name,
        });
      });
    });
  });
  return pairs;
}
// Public tally + winner for a round — vote counts and the winner are shared
// with everyone (so the crown can show), but who voted for whom stays
// server-side only, to keep captains from feeling pressured either way.
function potwTallyForRound(league, round) {
  const votes = (league.potwVotes && league.potwVotes[round]) || {};
  const counts = {};
  Object.values(votes).forEach((key) => { counts[key] = (counts[key] || 0) + 1; });
  const eligible = potwEligiblePairs(league, round);
  const tally = Object.keys(counts)
    .map((key) => {
      const p = eligible.find((x) => x.key === key);
      return p ? { ...p, votes: counts[key] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.votes - a.votes);
  // A tie at the top goes to everyone tied, not just whichever pair
  // happened to sort first — no votes means no winners at all.
  const topVotes = tally.length ? tally[0].votes : 0;
  const winners = topVotes > 0 ? tally.filter((p) => p.votes === topVotes) : [];
  return { tally, winners };
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

  // Public per-round Pair of the Week tally/winner (for the crown), plus
  // this viewer's own vote if they're a captain or the admin — raw
  // per-voter ballots never leave here.
  const rounds = [...new Set(league.fixtures.map((f) => f.round))];
  const potwByRound = {};
  rounds.forEach((r) => { potwByRound[r] = potwTallyForRound(league, r); });
  const potwVoterKey = isAdmin ? "admin" : teamId;
  const myPotwVote = {};
  if (potwVoterKey) {
    rounds.forEach((r) => {
      const v = league.potwVotes && league.potwVotes[r] && league.potwVotes[r][potwVoterKey];
      if (v) myPotwVote[r] = v;
    });
  }

  const { adminPasswordHash, potwVotes, potwNotified, ...leagueRest } = league;
  return { ...leagueRest, teams, fixtures, playoffs, adminRegistered: !!adminPasswordHash, potwByRound, myPotwVote };
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
      strength: league ? (league.strength || 0) : 0,
      format: league ? (league.format || "teams") : "teams",
      // Just enough for a logo strip on the league card — never codes/emails.
      teams: league ? league.teams.map((t) => ({ name: t.name, logo: t.logo })) : [],
    };
  });
  res.json(enriched);
});

// Home-page teaser: the actual pairs playing, across every active team
// league — not just "Team A vs Team B". Only fixtures with both lineups
// already submitted are eligible (before that, who's actually playing isn't
// decided yet), and Vibora (pairs) leagues are excluded entirely — a pair
// plays any opponent on any night, so there's no fixed "next match" to
// feature. A signed-in captain or admin narrows this to just their own
// league; a guest, or a captain whose own league is a Vibora league
// (nothing to scope to), sees the full cross-league feed instead.
router.get("/next-matches", (req, res) => {
  const myLeagueId = req.session.user && req.session.user.leagueId;
  const index = store.getIndex();
  let leagues = index
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && leagueStatus(l) === "active" && l.format !== "pairs");

  let scopedTo = null;
  if (myLeagueId) {
    const mine = leagues.find((l) => l.id === myLeagueId);
    if (mine) { leagues = [mine]; scopedTo = { id: mine.id, name: mine.name }; }
  }

  const playerName = (team, id) => {
    const p = team && team.players.find((pl) => pl.id === id);
    return p ? p.name : null;
  };

  const fixtures = [];
  leagues.forEach((league) => {
    logic.allFixturesOf(league).forEach((f) => {
      if (f.finalized || !f.teamA || !f.teamB) return;
      if (!(f.selectionA.submitted && f.selectionB.submitted)) return;
      const teamA = league.teams.find((t) => t.id === f.teamA);
      const teamB = league.teams.find((t) => t.id === f.teamB);
      if (!teamA || !teamB) return;
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      fixtures.push({ league, f, teamA, teamB, sched });
    });
  });

  // Soonest scheduled first; anything without a date sinks to the bottom
  // rather than sorting arbitrarily.
  fixtures.sort((a, b) => {
    if (a.sched.date && b.sched.date) return (a.sched.date + " " + a.sched.time).localeCompare(b.sched.date + " " + b.sched.time);
    if (a.sched.date) return -1;
    if (b.sched.date) return 1;
    return 0;
  });

  // Flatten to one entry per seed pairing (up to 4 per fixture) — this is
  // what actually gets featured, not the fixture itself.
  const pairings = [];
  fixtures.forEach(({ league, f, teamA, teamB, sched }) => {
    f.selectionA.pairs.forEach((pairA, i) => {
      const pairB = f.selectionB.pairs[i];
      const namesA = [playerName(teamA, pairA[0]), playerName(teamA, pairA[1])].filter(Boolean);
      const namesB = [playerName(teamB, pairB[0]), playerName(teamB, pairB[1])].filter(Boolean);
      if (namesA.length !== 2 || namesB.length !== 2) return;
      pairings.push({
        leagueName: league.name,
        teamAName: teamA.name,
        teamBName: teamB.name,
        seed: i + 1,
        pairA: namesA,
        pairB: namesB,
        date: sched.date || "",
        time: sched.time || "",
        venue: sched.venue || league.defaultVenue || "",
      });
    });
  });

  res.json({ scopedTo, matches: pairings.slice(0, 10) });
});

/* ---------- "Interested to join a league" signups ---------- */

router.post("/interest", (req, res) => {
  const { name, contactNumber, email, playtomicLevel, league, joinAs } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  if (!contactNumber || !contactNumber.trim()) return res.status(400).json({ error: "Contact number is required." });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  if (joinAs !== "team" && joinAs !== "individual") return res.status(400).json({ error: "Choose team or individual player." });
  const signups = store.getSignups();
  signups.unshift({
    id: logic.uid(),
    name: name.trim(),
    contactNumber: contactNumber.trim(),
    email: email.trim(),
    playtomicLevel: (playtomicLevel || "").trim(),
    league: (league || "").trim(),
    joinAs,
    createdAt: Date.now(),
  });
  store.saveSignups(signups);
  res.json({ ok: true });
});
router.get("/interest", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  res.json(store.getSignups());
});
router.delete("/interest/:id", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  store.saveSignups(store.getSignups().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

router.post("/owner/login", loginLimiter, (req, res) => {
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
  const { name, adminEmail, format } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "League name is required." });
  if (!adminEmail || !adminEmail.includes("@")) return res.status(400).json({ error: "A valid admin email is required." });
  if (format && !["teams", "pairs"].includes(format)) return res.status(400).json({ error: "Unknown league format." });
  const league = newLeagueObj(name.trim(), adminEmail, format);
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
  if (!league.potwVotes) league.potwVotes = {};
  if (!league.potwNotified) league.potwNotified = {};
  if (!league.courtCount) league.courtCount = 4;
  if (!league.slotCount) league.slotCount = 3;
  if (!league.courtNames) league.courtNames = [];
  if (!league.courtSchedule) league.courtSchedule = {};
  if (league.tieringEnabled === undefined) league.tieringEnabled = false;
  if (!league.goldTierCount) league.goldTierCount = 0;
  if (league.strength === undefined) league.strength = 0;
  if (!league.format) league.format = "teams";
  if (!league.groups) league.groups = [];
  if (!league.hallOfFame) league.hallOfFame = [];
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

// Restore this league from one of its own backup files — overwrites
// everything (teams, fixtures, results, settings). Only accepts a backup
// that was exported from this same league (matching id), so it can't be
// used to accidentally clobber one league's data with another's. Any
// fields missing from an older backup get their defaults applied the next
// time the league is loaded, same as any other lazy migration.
router.post("/leagues/:leagueId/import", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return res.status(400).json({ error: "That doesn't look like a league backup file." });
  if (!Array.isArray(data.teams) || !Array.isArray(data.fixtures) || !data.name || typeof data.name !== "string")
    return res.status(400).json({ error: "That doesn't look like a league backup file." });
  if (data.id !== league.id)
    return res.status(400).json({ error: "That backup is from a different league — it can only be restored into the league it came from." });
  store.saveLeague(league.id, data);
  const index = store.getIndex();
  const entry = index.find((l) => l.id === league.id);
  if (entry) { entry.name = data.name; store.saveIndex(index); }
  res.json({ ok: true });
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

router.post("/leagues/:leagueId/login", loginLimiter, async (req, res) => {
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

router.post("/leagues/:leagueId/captain-login", loginLimiter, (req, res) => {
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

// Same idea as the per-league captain login above, but for the home page —
// a captain shouldn't have to find their league first just to log in. Codes
// are generated globally unique (see genTeamCode) so a bare code is enough
// to find the right team; a collision with an older, pre-existing code is
// vanishingly unlikely but handled safely rather than guessed at.
router.post("/captain-login", loginLimiter, (req, res) => {
  const { code, email } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: "Enter your team code." });
  const val = code.trim().toUpperCase();
  if (email !== undefined && email.trim() && !email.includes("@"))
    return res.status(400).json({ error: "Enter a valid email, or leave it blank." });

  const matches = [];
  for (const entry of store.getIndex()) {
    const league = store.getLeague(entry.id);
    if (!league) continue;
    const team = league.teams.find((t) => t.code === val);
    if (team) matches.push({ league, team });
  }
  if (matches.length === 0) return res.status(401).json({ error: "Invalid team code." });
  if (matches.length > 1) return res.status(409).json({ error: "That code matches more than one league — please log in from your league's own page instead." });

  const { league, team } = matches[0];
  if (email !== undefined && email.trim()) {
    team.notifyEmail = email.trim();
    store.saveLeague(league.id, league);
  }
  req.session.user = { leagueId: league.id, role: "captain", teamId: team.id };
  res.json({ role: "captain", leagueId: league.id, teamId: team.id });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ---------- Teams & players (admin-managed) ---------- */

router.post("/leagues/:leagueId/teams", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { name, groupId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Team name is required." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams are locked once the season has started." });
  if (league.teams.some((t) => t.name.toLowerCase() === name.trim().toLowerCase()))
    return res.status(400).json({ error: "A team with that name already exists." });
  if (groupId && !(league.groups || []).some((g) => g.id === groupId)) return res.status(400).json({ error: "Group not found." });
  const code = genTeamCode(league);
  const team = { id: logic.uid(), name: name.trim(), code, logo: "", notifyEmail: "", players: [], groupId: groupId || null };
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
  if (req.body.name !== undefined) {
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: "Name is required." });
    if (league.teams.some((t) => t.id !== team.id && t.name.toLowerCase() === name.toLowerCase()))
      return res.status(400).json({ error: "A team with that name already exists." });
    team.name = name;
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Fixes a typo in a player's name after the fact — add/delete already cover
// swapping who's on a team, this just corrects the name of someone already
// there without disturbing their match history (same player id throughout).
router.put(
  "/leagues/:leagueId/teams/:teamId/players/:playerId",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const player = team.players.find((p) => p.id === req.params.playerId);
    if (!player) return res.status(404).json({ error: "Player not found." });
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Player name is required." });
    player.name = name;
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

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

/* ---------- Groups (Vibora only): each runs its own independent round-robin,
   tagged with a division so several groups can later feed one cross-group
   knockout bracket per division. Team leagues don't use this. */

router.post("/leagues/:leagueId/groups", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (league.format !== "pairs") return res.status(400).json({ error: "Groups are only available for a Vibora League." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Groups are locked once the season has started." });
  const name = (req.body.name || "").trim();
  const division = (req.body.division || "").trim();
  if (!name) return res.status(400).json({ error: "Group name is required." });
  if (!division) return res.status(400).json({ error: "Division is required." });
  if (!league.groups) league.groups = [];
  if (league.groups.some((g) => g.name.toLowerCase() === name.toLowerCase() && g.division.toLowerCase() === division.toLowerCase()))
    return res.status(400).json({ error: "A group with that name already exists in this division." });
  const group = { id: logic.uid(), name, division };
  league.groups.push(group);
  store.saveLeague(league.id, league);
  res.json({ id: group.id });
});

router.put("/leagues/:leagueId/groups/:groupId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const group = (league.groups || []).find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Groups are locked once the season has started." });
  if (req.body.name !== undefined) {
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: "Group name is required." });
    group.name = name;
  }
  if (req.body.division !== undefined) {
    const division = req.body.division.trim();
    if (!division) return res.status(400).json({ error: "Division is required." });
    group.division = division;
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.delete("/leagues/:leagueId/groups/:groupId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const group = (league.groups || []).find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: "Group not found." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Groups are locked once the season has started." });
  if (league.teams.some((t) => t.groupId === group.id)) return res.status(400).json({ error: "Move or remove this group's pairs first." });
  league.groups = league.groups.filter((g) => g.id !== group.id);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/teams/:teamId/group", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Groups are locked once the season has started." });
  const { groupId } = req.body || {};
  if (groupId && !(league.groups || []).some((g) => g.id === groupId)) return res.status(400).json({ error: "Group not found." });
  team.groupId = groupId || null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Hall of Fame: past-season champions, admin-entered free text —
   not tied to any current pair/player record. ---------- */

router.post("/leagues/:leagueId/hall-of-fame", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const season = Number(req.body.season);
  const label = (req.body.label || "").trim();
  const winner = (req.body.winner || "").trim();
  if (!Number.isInteger(season) || season < 1) return res.status(400).json({ error: "Enter a valid season number." });
  if (!label) return res.status(400).json({ error: "Title is required." });
  if (!winner) return res.status(400).json({ error: "Winner is required." });
  if (!league.hallOfFame) league.hallOfFame = [];
  const entry = { id: logic.uid(), season, label, winner };
  league.hallOfFame.push(entry);
  store.saveLeague(league.id, league);
  res.json({ id: entry.id });
});

router.put("/leagues/:leagueId/hall-of-fame/:entryId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const entry = (league.hallOfFame || []).find((e) => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  if (req.body.season !== undefined) {
    const season = Number(req.body.season);
    if (!Number.isInteger(season) || season < 1) return res.status(400).json({ error: "Enter a valid season number." });
    entry.season = season;
  }
  if (req.body.label !== undefined) {
    const label = req.body.label.trim();
    if (!label) return res.status(400).json({ error: "Title is required." });
    entry.label = label;
  }
  if (req.body.winner !== undefined) {
    const winner = req.body.winner.trim();
    if (!winner) return res.status(400).json({ error: "Winner is required." });
    entry.winner = winner;
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.delete("/leagues/:leagueId/hall-of-fame/:entryId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.hallOfFame = (league.hallOfFame || []).filter((e) => e.id !== req.params.entryId);
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

router.put("/leagues/:leagueId/tiering", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const enabled = !!req.body.enabled;
  if (enabled) {
    const goldTierCount = Number(req.body.goldTierCount);
    if (!Number.isInteger(goldTierCount) || goldTierCount < 1 || goldTierCount > 20)
      return res.status(400).json({ error: "Gold-tier count must be between 1 and 20." });
    league.goldTierCount = goldTierCount;
  }
  league.tieringEnabled = enabled;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Tags/untags one player as gold tier — capped per team at league.goldTierCount
// so the "how many gold players" quota the admin set is actually enforced,
// not just advisory.
router.put(
  "/leagues/:leagueId/teams/:teamId/players/:playerId/tier",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    if (!league.tieringEnabled) return res.status(400).json({ error: "Turn on gold-tier seeding for this league first." });
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const player = team.players.find((p) => p.id === req.params.playerId);
    if (!player) return res.status(404).json({ error: "Player not found." });
    const gold = !!req.body.gold;
    if (gold && !player.gold) {
      const currentGoldCount = team.players.filter((p) => p.gold).length;
      if (currentGoldCount >= league.goldTierCount) {
        return res.status(400).json({
          error: `${team.name} already has its ${league.goldTierCount} gold-tier player${league.goldTierCount === 1 ? "" : "s"}. Untag one first.`,
        });
      }
    }
    player.gold = gold;
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

/* ---------- Season & fixtures ---------- */

router.post("/leagues/:leagueId/season/start", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const isPairs = league.format === "pairs";
  const groups = league.groups || [];
  const hasGroups = isPairs && groups.length > 0;
  const playoffFormat = req.body.playoffFormat;
  if (playoffFormat && !["none", "semis_final", "position"].includes(playoffFormat)) return res.status(400).json({ error: "Unknown playoff format." });
  if (isPairs && league.teams.some((t) => t.players.length !== 2)) {
    return res.status(400).json({ error: "Every pair needs exactly 2 players before starting the season." });
  }

  let fixtures = [], byes = [];
  if (hasGroups) {
    // Every group runs its own independent round-robin — round numbers
    // start fresh at 1 within each group, same as a standalone league would.
    if (league.teams.some((t) => !t.groupId)) return res.status(400).json({ error: "Every pair needs a group before starting the season." });
    for (const group of groups) {
      const groupTeams = league.teams.filter((t) => t.groupId === group.id);
      if (groupTeams.length < 3) return res.status(400).json({ error: `"${group.name}" needs at least 3 pairs before starting.` });
      const gen = logic.generateRoundRobin(groupTeams, !!req.body.doubleRound, 1);
      gen.fixtures.forEach((f) => { f.groupId = group.id; });
      gen.byes.forEach((b) => { b.groupId = group.id; });
      fixtures = fixtures.concat(gen.fixtures);
      byes = byes.concat(gen.byes);
    }
  } else {
    if (league.teams.length < 3) return res.status(400).json({ error: "Add at least 3 teams first." });
    const gen = logic.generateRoundRobin(league.teams, !!req.body.doubleRound, isPairs ? 1 : 4);
    fixtures = gen.fixtures;
    byes = gen.byes;
  }

  if (isPairs) {
    // A pair IS the line-up — there's nothing to pick weekly, so both sides
    // are pre-filled and locked the moment the fixture exists, skipping the
    // whole blind-selection dance the team format needs.
    const teamsById = {};
    league.teams.forEach((t) => { teamsById[t.id] = t; });
    fixtures.forEach((f) => {
      const teamA = teamsById[f.teamA], teamB = teamsById[f.teamB];
      if (teamA) f.selectionA = { submitted: true, pairs: [[teamA.players[0].id, teamA.players[1].id]] };
      if (teamB) f.selectionB = { submitted: true, pairs: [[teamB.players[0].id, teamB.players[1].id]] };
    });
  }
  league.fixtures = fixtures;
  league.byes = byes;
  league.playoffFormat = isPairs ? "none" : (playoffFormat || "none");
  league.status = "active";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Free to change any time the knockout bracket hasn't actually been played
// yet — it's just a preference read once, when the admin later clicks
// "Generate playoffs" after the regular season finishes. Only blocked once
// a playoff match has a real result recorded, since switching format at
// that point would orphan an in-progress bracket.
router.put("/leagues/:leagueId/playoff-format", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const format = req.body.format;
  if (!["none", "semis_final", "position"].includes(format)) return res.status(400).json({ error: "Unknown playoff format." });
  if (league.format === "pairs" && format !== "none") return res.status(400).json({ error: "Playoffs aren't available for a Vibora League yet." });
  if (league.playoffs) {
    const hasResults =
      league.playoffs.format === "position"
        ? (league.playoffs.matches || []).some((m) => m.finalized)
        : league.playoffs.semis.some((m) => m.finalized) || league.playoffs.final.finalized;
    if (hasResults) return res.status(400).json({ error: "Playoff results have already been entered — reset the season if you need to change the format now." });
    league.playoffs = null; // bracket was built for the old format and hasn't been played — clear it so it regenerates correctly
  }
  league.playoffFormat = format;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// A 0-5 rating admin sets to describe how competitive the league is —
// purely descriptive, shown as a bar rating on the league's card on the
// homepage. 0 means "not rated" and hides the bars there.
router.put("/leagues/:leagueId/strength", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const strength = Number(req.body.strength);
  if (!Number.isInteger(strength) || strength < 0 || strength > 5) return res.status(400).json({ error: "Strength must be between 0 and 5." });
  league.strength = strength;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// League admin login is a single email+password slot (Register/Log in on the
// league page) — this changes who that is. Not required to look like a real
// email (register/login below never validated that either, only creation
// did), just a unique login. Resets the password, since a new identity
// shouldn't inherit whatever hash was set for the old one.
router.put("/leagues/:leagueId/admin-email", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const email = (req.body.email || "").trim();
  if (!email) return res.status(400).json({ error: "Enter an admin login." });
  league.adminEmail = email;
  league.adminPasswordHash = null;
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

/* ---------- Court schedule (which match plays on which court, when) ---------- */

function emptyCourtGrid(slots, courts) {
  return Array.from({ length: slots }, () => Array.from({ length: courts }, () => null));
}
// Reads the saved grid for a round, resized to the league's current court/slot
// counts (padded or trimmed) so a later change to those counts doesn't crash
// on old data — cells that fall outside the new size are just dropped.
function getCourtGrid(league, round) {
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  const saved = (league.courtSchedule && league.courtSchedule[round]) || [];
  const grid = [];
  for (let s = 0; s < slots; s++) {
    const row = [];
    for (let c = 0; c < courts; c++) {
      row.push((saved[s] && saved[s][c]) || null);
    }
    grid.push(row);
  }
  return grid;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const res = [];
  arr.forEach((x, i) => {
    permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((p) => res.push([x].concat(p)));
  });
  return res;
}

// Auto-fills the court/slot grid for every regular-season round that hasn't
// finished yet. When there are at least 4 slots, every match gets its own
// dedicated court across sequential turns — all 4 seeds fit as separate
// turns, so no two of a match's rubbers ever need to share a slot. When
// there are fewer than 4 slots, every match needs exactly one "double" slot
// (two of its rubbers on two different courts at the same time) — which
// slot that lands in is chosen, round by round, to keep each team's count
// of doubles-per-slot as even as possible across the whole season. Already
// -finalized rounds are left untouched, but their existing court schedule
// (if any) still counts toward the running fairness tally.
function generateSeasonCourtRotation(league) {
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  const byRound = {};
  league.fixtures.forEach((f) => { (byRound[f.round] || (byRound[f.round] = [])).push(f); });
  const roundNums = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  const tally = {};
  const teamTally = (id) => tally[id] || (tally[id] = Array(slots).fill(0));
  const doublePerms = slots < 4 ? permutations(Array.from({ length: slots }, (_, i) => i)) : null;

  if (!league.courtSchedule) league.courtSchedule = {};

  roundNums.forEach((round) => {
    const fixtures = byRound[round];
    if (fixtures.every((f) => f.finalized)) {
      getCourtGrid(league, round).forEach((row, s) => row.forEach((cell) => {
        if (!cell) return;
        const f = fixtures.find((x) => x.id === cell.fixtureId);
        if (f) { teamTally(f.teamA)[s]++; teamTally(f.teamB)[s]++; }
      }));
      return;
    }

    const grid = emptyCourtGrid(slots, courts);
    const courtPtr = Array(slots).fill(0);
    const place = (slot, fixtureId, seed) => { if (courtPtr[slot] < courts) grid[slot][courtPtr[slot]++] = { fixtureId, seed }; };

    if (!doublePerms) {
      fixtures.forEach((f, i) => {
        const court = i % courts;
        for (let seed = 0; seed < 4 && seed < slots; seed++) grid[seed][court] = { fixtureId: f.id, seed };
        teamTally(f.teamA); teamTally(f.teamB);
      });
    } else {
      let best = null;
      doublePerms.forEach((perm) => {
        let maxAfter = 0, sumSq = 0;
        fixtures.forEach((f, i) => {
          if (i >= perm.length) return;
          const slot = perm[i];
          [f.teamA, f.teamB].forEach((teamId) => {
            const projected = teamTally(teamId)[slot] + 1;
            sumSq += projected * projected;
            maxAfter = Math.max(maxAfter, projected);
          });
        });
        if (!best || maxAfter < best.maxAfter || (maxAfter === best.maxAfter && sumSq < best.sumSq)) best = { perm, maxAfter, sumSq };
      });
      fixtures.forEach((f, i) => {
        const doubleSlot = i < best.perm.length ? best.perm[i] : null;
        if (doubleSlot === null) {
          // More matches this round than slots to double into — spread its
          // seeds across whatever courts are free, best effort only.
          for (let seed = 0; seed < 4; seed++) {
            const slot = seed % slots;
            place(slot, f.id, seed);
          }
          return;
        }
        place(doubleSlot, f.id, 0);
        place(doubleSlot, f.id, 1);
        const others = Array.from({ length: slots }, (_, s) => s).filter((s) => s !== doubleSlot);
        [2, 3].forEach((seed, idx) => { if (others.length) place(others[idx % others.length], f.id, seed); });
        teamTally(f.teamA)[doubleSlot]++; teamTally(f.teamB)[doubleSlot]++;
      });
    }

    league.courtSchedule[round] = grid;
  });
}

router.put("/leagues/:leagueId/court-settings", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const courtCount = Number(req.body.courtCount);
  const slotCount = Number(req.body.slotCount);
  if (!Number.isInteger(courtCount) || courtCount < 1 || courtCount > 12) return res.status(400).json({ error: "Courts must be between 1 and 12." });
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 10) return res.status(400).json({ error: "Time slots must be between 1 and 10." });
  league.courtCount = courtCount;
  league.slotCount = slotCount;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/court-names", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const names = req.body.names;
  if (!Array.isArray(names)) return res.status(400).json({ error: "Invalid names." });
  league.courtNames = names.slice(0, 12).map((n) => String(n || "").trim().slice(0, 30));
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/court-schedule/:round/assign", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const round = Number(req.params.round);
  if (!Number.isInteger(round)) return res.status(400).json({ error: "Invalid round." });

  // Admins can rearrange any block; a captain can tap-swap blocks too, but
  // only ones that are already theirs — enforced below, not just hidden
  // client-side, since this is the same endpoint either role calls.
  const isAdmin = isAdminSession(req, league.id);
  const u = req.session.user;
  const isCaptain = !isAdmin && !!u && u.leagueId === league.id && u.role === "captain";
  if (!isAdmin && !isCaptain) return res.status(403).json({ error: "Not allowed." });

  const { slot, court, fixtureId, seed } = req.body || {};
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) return res.status(400).json({ error: "Invalid slot." });
  if (!Number.isInteger(court) || court < 0 || court >= courts) return res.status(400).json({ error: "Invalid court." });

  const grid = getCourtGrid(league, round);

  if (isCaptain) {
    const ownsFixture = (fxId) => {
      if (!fxId) return true;
      const f = league.fixtures.find((x) => x.id === fxId && x.round === round);
      return !!f && (f.teamA === u.teamId || f.teamB === u.teamId);
    };
    const existing = grid[slot] && grid[slot][court];
    if (!ownsFixture(fixtureId) || (existing && !ownsFixture(existing.fixtureId))) {
      return res.status(403).json({ error: "You can only rearrange your own team's matches." });
    }
  }

  if (fixtureId) {
    const f = league.fixtures.find((x) => x.id === fixtureId && x.round === round);
    if (!f) return res.status(400).json({ error: "That match isn't in this round." });
    if (!Number.isInteger(seed) || seed < 0 || seed > 3) return res.status(400).json({ error: "Invalid seed." });
    // A given fixture+seed can only be scheduled once — clear it from
    // wherever it was before, so moving it never leaves a duplicate behind.
    grid.forEach((row) => row.forEach((cell, c) => {
      if (cell && cell.fixtureId === fixtureId && cell.seed === seed) row[c] = null;
    }));
    grid[slot][court] = { fixtureId, seed };
  } else {
    grid[slot][court] = null;
  }

  if (!league.courtSchedule) league.courtSchedule = {};
  league.courtSchedule[round] = grid;
  store.saveLeague(league.id, league);
  res.json({ ok: true, grid });
});

router.post("/leagues/:leagueId/court-schedule/generate", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  generateSeasonCourtRotation(league);
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
  const oppKey = selKey === "selectionA" ? "selectionB" : "selectionA";
  // Blind selection means neither side can see the other's pairs until
  // both are in, so a team is free to keep revising their own pick right
  // up until the opponent submits — it only locks once both sides have
  // gone (a real reveal happened), after which only admin can reopen it.
  if (f[selKey].submitted && f[oppKey].submitted) {
    return res.status(400).json({ error: "Both line-ups are already in — ask the admin to unlock it, or request it in Selection Room (needs the other captain's approval)." });
  }

  const pairs = req.body.pairs;
  // Expected count comes from the fixture's own seed slots (4 for a team
  // fixture, 1 for a Vibora/pairs fixture) rather than a hardcoded number —
  // though in practice a pairs fixture's selection is pre-filled at season
  // start and never goes through this route at all.
  const expectedSeeds = f[selKey].pairs.length;
  if (!Array.isArray(pairs) || pairs.length !== expectedSeeds) return res.status(400).json({ error: `Send exactly ${expectedSeeds} seed pair${expectedSeeds === 1 ? "" : "s"}.` });
  const result = logic.validateSelection(pairs, !!req.body.confirmDoubleUp);
  if (result) return res.status(400).json({ error: result.error, needsConfirm: !!result.needsConfirm });

  const isFirstSubmit = !f[selKey].submitted;
  f[selKey] = { submitted: true, pairs };
  const label = fixtureLabel(league, f);
  const teamA = league.teams.find((t) => t.id === f.teamA);
  const teamB = league.teams.find((t) => t.id === f.teamB);
  const myTeam = side === "A" ? teamA : teamB;
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  if (f.selectionA.submitted && f.selectionB.submitted) {
    notify(league, f.teamA, "selection", `Line-ups revealed for ${label}: ${teamA ? teamA.name : "?"} vs ${teamB ? teamB.name : "?"}.`);
    notify(league, f.teamB, "selection", `Line-ups revealed for ${label}: ${teamA ? teamA.name : "?"} vs ${teamB ? teamB.name : "?"}.`);
  } else if (isFirstSubmit) {
    // Only announce the first time — otherwise every tweak a team makes
    // while waiting on their opponent would re-notify them.
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

// A captain can also get their own line-up reopened without going through
// admin — but only with the other captain's consent, same propose/confirm
// shape as the court-order negotiation above. A team can't just unilaterally
// reopen after seeing the reveal.
router.post("/leagues/:leagueId/fixtures/:fixtureId/selection/unlock/propose", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const u = req.session.user;
  if (!u || u.leagueId !== league.id || u.role !== "captain") return res.status(403).json({ error: "Only a team captain can request this." });
  const side = u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
  if (!side) return res.status(403).json({ error: "You're not in this match." });
  if (!(f.selectionA.submitted && f.selectionB.submitted)) return res.status(400).json({ error: "Both line-ups need to be in before either can be reopened." });
  if (f.selectionUnlockRequest) return res.status(400).json({ error: "There's already a pending request for this match." });

  f.selectionUnlockRequest = { by: side };
  const label = fixtureLabel(league, f);
  const myTeam = league.teams.find((t) => t.id === u.teamId);
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  notify(league, oppTeamId, "selection_unlock", `${myTeam ? myTeam.name : "Your opponent"} wants to revise their line-up for ${label} — approve or decline in Selection Room.`, { round: f.round });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/selection/unlock/confirm", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.selectionUnlockRequest) return res.status(400).json({ error: "There's no request to approve." });
  const admin = isAdminSession(req, league.id);
  const u = req.session.user;
  const side = u && u.role === "captain" ? (u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null) : null;
  if (!admin && (!side || side === f.selectionUnlockRequest.by)) return res.status(403).json({ error: "Only the other captain can approve this." });

  const { by } = f.selectionUnlockRequest;
  const selKey = by === "A" ? "selectionA" : "selectionB";
  f[selKey].submitted = false;
  f.selectionUnlockRequest = null;
  const requesterTeamId = by === "A" ? f.teamA : f.teamB;
  notify(league, requesterTeamId, "selection_unlock", `Your request to revise your line-up for ${fixtureLabel(league, f)} was approved — you can resubmit now.`, { round: f.round });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/selection/unlock/decline", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.selectionUnlockRequest) return res.status(400).json({ error: "There's no request to decline." });
  const admin = isAdminSession(req, league.id);
  const u = req.session.user;
  const side = u && u.role === "captain" ? (u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null) : null;
  if (!admin && (!side || side === f.selectionUnlockRequest.by)) return res.status(403).json({ error: "Only the other captain can decline this." });

  const { by } = f.selectionUnlockRequest;
  f.selectionUnlockRequest = null;
  const requesterTeamId = by === "A" ? f.teamA : f.teamB;
  notify(league, requesterTeamId, "selection_unlock", `Your request to revise your line-up for ${fixtureLabel(league, f)} was declined.`, { round: f.round });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Swaps one player out of an already-submitted line-up without reopening
// the whole selection — for when someone drops out after the team's
// pairs are locked in (real padel: an injury or a no-show the same
// night). The incoming player can be anyone else already on the team's
// roster, or a brand-new name, which also permanently adds them to the
// roster the same way the admin's "add player" flow does.
router.post("/leagues/:leagueId/fixtures/:fixtureId/selection/substitute", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.teamA || !f.teamB) return res.status(400).json({ error: "Teams for this fixture aren't decided yet." });

  const u = req.session.user;
  const ownerHere = isOwnerSession(req);
  if (!ownerHere && (!u || u.leagueId !== league.id)) return res.status(401).json({ error: "Not logged in." });
  const side = ownerHere || u.role === "admin" ? req.body.side : u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
  if (!side) return res.status(403).json({ error: "You're not in this fixture." });
  if (f.finalized) return res.status(400).json({ error: "This fixture is finalized — ask the admin to unlock it first." });

  const selKey = side === "A" ? "selectionA" : "selectionB";
  const sel = f[selKey];
  if (!sel.submitted) return res.status(400).json({ error: "Submit your line-up before substituting a player." });

  const teamId = side === "A" ? f.teamA : f.teamB;
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });

  const { outPlayerId, inPlayerId, newPlayerName, seedIdx } = req.body || {};
  const usedIds = new Set(sel.pairs.flat().filter(Boolean));
  if (!outPlayerId || !usedIds.has(outPlayerId)) return res.status(400).json({ error: "Choose who's coming out." });

  // A double-booked player can hold a seat in more than one seed tonight —
  // seedIdx pins down exactly which seat this substitution replaces, so
  // subbing them out of one match doesn't also pull them out of the other.
  // Falls back to the first (only, for anyone not double-booked) match if
  // an older client doesn't send it.
  const idx = Number.isInteger(seedIdx) ? seedIdx : sel.pairs.findIndex((pair) => pair.includes(outPlayerId));
  if (idx < 0 || idx >= sel.pairs.length || !sel.pairs[idx].includes(outPlayerId)) {
    return res.status(400).json({ error: "Couldn't find that player in the selected match." });
  }

  let incomingId = inPlayerId;
  if (!incomingId) {
    const name = (newPlayerName || "").trim();
    if (!name) return res.status(400).json({ error: "Enter the substitute's name, or choose an existing player." });
    incomingId = logic.uid();
    team.players.push({ id: incomingId, name });
  } else {
    if (!team.players.some((p) => p.id === incomingId)) return res.status(400).json({ error: "Unknown player." });
    if (incomingId === outPlayerId) return res.status(400).json({ error: "Choose someone other than who's coming out." });
    // Someone already playing tonight is allowed in — a deliberate
    // double-up, same as the main selection form supports — so this
    // isn't rejected, just surfaced clearly in the UI's option label.
    // But if they're already the outgoing player's partner in THIS seed,
    // swapping would pair them with themselves — that's never valid.
    if (sel.pairs[idx].includes(incomingId)) {
      return res.status(400).json({ error: "That player already partners the outgoing player — pick someone else, or a different seed." });
    }
  }

  // Only the targeted seed's pair is touched — a double-booked player's
  // other seat (a different pair, elsewhere in sel.pairs) is untouched.
  sel.pairs = sel.pairs.map((pair, i) => (i === idx ? pair.map((pid) => (pid === outPlayerId ? incomingId : pid)) : pair));

  const outName = (team.players.find((p) => p.id === outPlayerId) || {}).name || "A player";
  const inName = (team.players.find((p) => p.id === incomingId) || {}).name || "Substitute";
  const label = fixtureLabel(league, f);
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  notify(league, oppTeamId, "selection", `${team.name} made a substitution for ${label}: ${inName} is in for ${outName}.`);

  store.saveLeague(league.id, league);
  res.json({ ok: true, pairs: sel.pairs });
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
  if (!logic.requiredRubbersOk(f, league.format === "pairs")) return res.status(400).json({ error: "Enter a full score before finalizing." });
  f.finalized = true;
  syncPlayoffs(league);

  // Once every regular-round fixture for this round is in, Pair of the Week
  // voting for that week becomes meaningful — let every captain know, once,
  // per round.
  if (f.stage === "regular" && league.format !== "pairs") {
    const roundFixtures = league.fixtures.filter((x) => x.round === f.round);
    const roundComplete = roundFixtures.length > 0 && roundFixtures.every((x) => x.finalized);
    if (roundComplete) {
      if (!league.potwNotified) league.potwNotified = {};
      if (!league.potwNotified[f.round]) {
        league.potwNotified[f.round] = true;
        league.teams.forEach((t) => {
          notify(league, t.id, "potw", "Results are in for Round " + f.round + " — vote now for Pair of the Week on the Awards page!", { round: f.round });
        });
      }
    }
  }

  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Pair of the week ---------- */

router.post("/leagues/:leagueId/pair-of-week/:round/vote", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const round = Number(req.params.round);
  if (!Number.isInteger(round)) return res.status(400).json({ error: "Invalid round." });
  const u = req.session.user;
  const isAdmin = isAdminSession(req, league.id);
  const isCaptain = !!(u && u.leagueId === league.id && u.role === "captain");
  if (!isAdmin && !isCaptain) return res.status(403).json({ error: "Only team captains or the admin can vote." });
  // Admin gets one vote too, same as a team captain, just not tied to any
  // specific team — stored under a fixed "admin" key rather than a teamId.
  const voterKey = isAdmin ? "admin" : u.teamId;
  const roundFixtures = league.fixtures.filter((f) => f.round === round);
  if (roundFixtures.length === 0) return res.status(404).json({ error: "No fixtures in that round." });
  if (!roundFixtures.every((f) => f.finalized)) return res.status(400).json({ error: "Voting opens once every match in the round is finalized." });
  const { pairKey } = req.body || {};
  const eligible = potwEligiblePairs(league, round);
  if (!eligible.some((p) => p.key === pairKey)) return res.status(400).json({ error: "That pair didn't play this round." });
  if (!league.potwVotes) league.potwVotes = {};
  if (!league.potwVotes[round]) league.potwVotes[round] = {};
  league.potwVotes[round][voterKey] = pairKey;
  store.saveLeague(league.id, league);
  res.json({ ok: true, tally: potwTallyForRound(league, round) });
});

/* ---------- Court/playing order (which of a match's pairs plays where) ---------- */

// Shared by the admin's direct apply and the captains' propose/confirm
// below — every cell being touched must already belong to this fixture
// (never invent a new placement or grab another match's spot), and the
// full set of the fixture's reserved spots must be assigned exactly once.
function validateCourtOrderAssignments(league, f, assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) return { error: "Nothing to save." };
  const grid = getCourtGrid(league, f.round);
  const ownedCells = new Set();
  grid.forEach((row, s) => row.forEach((cell, c) => { if (cell && cell.fixtureId === f.id) ownedCells.add(s + ":" + c); }));

  const seenSeeds = new Set(), seenCells = new Set();
  for (const a of assignments) {
    if (!a || !Number.isInteger(a.slot) || !Number.isInteger(a.court) || !Number.isInteger(a.seed) || a.seed < 0 || a.seed > 3) {
      return { error: "Invalid assignment." };
    }
    const key = a.slot + ":" + a.court;
    if (!ownedCells.has(key)) return { error: "That spot isn't part of your match." };
    if (seenSeeds.has(a.seed) || seenCells.has(key)) return { error: "Each pair needs exactly one spot." };
    seenSeeds.add(a.seed); seenCells.add(key);
  }
  if (assignments.length !== ownedCells.size) return { error: "Assign every one of your match's spots." };
  return { grid };
}
function applyCourtOrderAssignments(league, f, assignments, grid) {
  assignments.forEach((a) => { grid[a.slot][a.court] = { fixtureId: f.id, seed: a.seed }; });
  if (!league.courtSchedule) league.courtSchedule = {};
  league.courtSchedule[f.round] = grid;
  f.slotOrder = assignments.slice().sort((x, y) => x.slot - y.slot || x.court - y.court).map((a) => a.seed);
}

// Admin can apply a court/order change directly — they already have full,
// unilateral control over the court schedule from the Fixtures tab, so
// routing them through the captains' propose/confirm dance below would
// just be a detour.
router.post("/leagues/:leagueId/fixtures/:fixtureId/court-order", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const result = validateCourtOrderAssignments(league, f, req.body.assignments);
  if (result.error) return res.status(result.error === "That spot isn't part of your match." ? 403 : 400).json({ error: result.error });
  applyCourtOrderAssignments(league, f, req.body.assignments, result.grid);
  f.courtOrderProposal = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Captains negotiate a change instead of applying it straight away — one
// proposes, the other has to confirm (or counter-propose) before it takes
// effect on the shared court schedule.
router.post("/leagues/:leagueId/fixtures/:fixtureId/court-order/propose", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const u = req.session.user;
  if (!u || u.leagueId !== league.id || u.role !== "captain") return res.status(403).json({ error: "Only a team captain can propose this." });
  const side = u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
  if (!side) return res.status(403).json({ error: "You're not in this match." });

  const result = validateCourtOrderAssignments(league, f, req.body.assignments);
  if (result.error) return res.status(result.error === "That spot isn't part of your match." ? 403 : 400).json({ error: result.error });

  f.courtOrderProposal = { by: side, assignments: req.body.assignments };
  const label = fixtureLabel(league, f);
  const proposerTeam = league.teams.find((t) => t.id === (side === "A" ? f.teamA : f.teamB));
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  notify(league, oppTeamId, "timeslot", `${proposerTeam ? proposerTeam.name : "Your opponent"} proposed a court/playing order change for ${label} — review it.`);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/court-order/confirm", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.courtOrderProposal) return res.status(400).json({ error: "There's no proposal to confirm." });
  const admin = isAdminSession(req, league.id);
  const u = req.session.user;
  const side = u && u.role === "captain" ? (u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null) : null;
  if (!admin && (!side || side === f.courtOrderProposal.by)) return res.status(403).json({ error: "Only the other captain can confirm this." });

  const { assignments, by } = f.courtOrderProposal;
  // Re-validate — the reserved spots could have changed (e.g. admin
  // re-ran the rotation) since this was proposed.
  const result = validateCourtOrderAssignments(league, f, assignments);
  if (result.error) {
    f.courtOrderProposal = null;
    store.saveLeague(league.id, league);
    return res.status(400).json({ error: "The court schedule changed since this was proposed — ask them to propose again." });
  }
  applyCourtOrderAssignments(league, f, assignments, result.grid);
  const proposerTeamId = by === "A" ? f.teamA : f.teamB;
  notify(league, proposerTeamId, "timeslot", `Your proposed court/playing order for ${fixtureLabel(league, f)} was confirmed.`);
  f.courtOrderProposal = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/unlock", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const isAdmin = isAdminSession(req, league.id);
  const u = req.session.user;
  // A pairs match has no captain hierarchy to mediate a re-open through —
  // either pair that actually played it can unlock their own result. Team
  // leagues keep this admin-only, since a "night" involves several pairs.
  const isPlayer = league.format === "pairs" && u && u.leagueId === league.id && u.role === "captain" && (u.teamId === f.teamA || u.teamId === f.teamB);
  if (!isAdmin && !isPlayer) return res.status(403).json({ error: "Not allowed." });
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
  const scoped = logic.restrictToGroup(league, req.query.groupId);
  res.json(logic.computeLeagueStats(scoped));
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
