const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const logic = require("./logic");
const { hashPassword, verifyPassword, requireAdmin, requireAdminOrCaptain, requireLeagueSession, isAdminSession, isOwnerSession } = require("./auth");
const { sendMail } = require("./mailer");
const payfast = require("./payfast");

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

// Who's making this change, for the audit log below — resolved the same
// way isAdminSession does, just rendered as a readable label instead of
// a boolean.
function auditActor(req, league) {
  if (isOwnerSession(req)) return "Owner";
  const u = req.session.user;
  if (u && u.leagueId === league.id) {
    if (u.role === "admin") return "League admin";
    if (u.role === "captain") {
      const team = league.teams.find((t) => t.id === u.teamId);
      return "Captain — " + (team ? team.name : "unknown team");
    }
  }
  return "Unknown";
}
// A view-only history of score edits, finalize/unlock, and substitutions —
// so a dispute like "this result changed and nobody knows who did it" can
// actually be traced. Deliberately not revertible: this just records what
// happened, restoring an old value is a manual re-entry same as any other
// edit. Capped so a very active league's log can't grow unbounded.
const AUDIT_LOG_MAX = 1000;
function logAudit(league, req, f, action, detail) {
  if (!league.auditLog) league.auditLog = [];
  league.auditLog.push({
    id: logic.uid(),
    ts: Date.now(),
    actor: auditActor(req, league),
    action,
    round: f ? f.round : null,
    fixtureId: f ? f.id : null,
    fixtureLabel: f ? fixtureLabel(league, f) : null,
    ...detail,
  });
  if (league.auditLog.length > AUDIT_LOG_MAX) {
    league.auditLog.splice(0, league.auditLog.length - AUDIT_LOG_MAX);
  }
}
// Creates (or, if one already exists for this round, refreshes) the
// auto-generated round wrap-up in News Room. Refreshing rather than
// reposting matters because Pair of the Week voting only opens once the
// round is fully finalized — so the post made at that moment almost
// never has a POTW winner yet; a later vote calls this again and the
// existing post picks it up instead of a second post appearing.
// Returns true only when a brand-new post was created, so the caller
// knows whether this is the moment to notify captains.
function postOrUpdateRoundRecap(league, round) {
  const recap = logic.buildRoundRecap(league, round);
  if (!recap) return false;
  if (!league.news) league.news = [];
  const existing = league.news.find((p) => p.auto && p.round === round);
  const fields = { title: recap.title, body: recap.body, potw: recap.potw, highlights: recap.highlights, inForm: recap.inForm };
  if (existing) {
    Object.assign(existing, fields);
    return false;
  }
  league.news.push({ id: logic.uid(), createdAt: Date.now(), auto: true, round, ...fields });
  return true;
}
// Catches up any round that finished before the auto-recap feature existed
// (or before a league even had it wired in) — walks every non-hidden
// league's already-finalized regular rounds and posts whichever ones don't
// already have an auto recap. Also doubles as a repair pass: it re-runs
// postOrUpdateRoundRecap against every round with a post, not just missing
// ones, so a correction to the recap logic reaches posts that were already
// created under older behavior — e.g. "in form" originally read the
// shared cross-league rating engine's form, which could flag a
// multi-league player as in-form off wins earned in a different league
// entirely (or even while they were actually on a losing run in this
// league), while a genuinely hot player confined to just this league
// never showed up at all. Always saves (not just when a brand-new post
// appears) so a correction like that actually persists. Deliberately
// silent either way — no captain notifications for old news, no console
// noise on the common case.
function backfillRoundRecaps() {
  store.getIndex().forEach((entry) => {
    if (entry.hidden) return;
    const league = store.getLeague(entry.id);
    if (!league || !league.fixtures) return;
    const rounds = [...new Set(league.fixtures.filter((f) => f.stage === "regular").map((f) => f.round))];
    if (rounds.length === 0) return;
    rounds.forEach((round) => postOrUpdateRoundRecap(league, round));
    store.saveLeague(league.id, league);
  });
}
// News Room order: round-based posts read newest-round-first, same as the
// season itself unfolds — sorting by createdAt alone breaks this the moment
// a round gets backfilled (every round caught up in the same boot lands
// within the same millisecond or two, so raw timestamp order stops meaning
// anything). A post with no round (a free-standing admin announcement)
// always sorts above every round post, on the assumption it's about
// something current, not a historical result.
function sortNewsPosts(posts) {
  return posts.slice().sort((a, b) => {
    const ra = a.round === undefined || a.round === null ? Infinity : a.round;
    const rb = b.round === undefined || b.round === null ? Infinity : b.round;
    if (ra !== rb) return rb - ra;
    return b.createdAt - a.createdAt;
  });
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
// A league can be flagged `hidden` on its index entry — data imported
// purely to feed the shared Elo rating engine (see the Elo Padel Ratings
// site, which reads this same database), not a real Team Padel league
// with captains to manage here. It still counts for ratings/predictions
// (those read the full, unfiltered index), it just never appears in any
// list, search, or login lookup on this site.
function visibleIndexEntries() {
  return store.getIndex().filter((entry) => !entry.hidden);
}
function genTeamCode(league) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (codeInUse(code));
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
    // A pay-link token stands in for auth on its own public route — never
    // ships in the general league payload, only ever handed out via the
    // dedicated pay-link fetch route to someone already allowed to see it.
    const players = rest.players.map(({ payLinkToken, ...p }) => p);
    return { ...rest, players, code: viewerIsThisTeam ? code : undefined, notifyEmail: viewerIsThisTeam ? notifyEmail : undefined };
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
  rounds.forEach((r) => { potwByRound[r] = logic.potwTallyForRound(league, r); });
  const potwVoterKey = isAdmin ? "admin" : teamId;
  const myPotwVote = {};
  if (potwVoterKey) {
    rounds.forEach((r) => {
      const v = league.potwVotes && league.potwVotes[r] && league.potwVotes[r][potwVoterKey];
      if (v) myPotwVote[r] = v;
    });
  }

  // Past seasons have their own dedicated routes (/season-history) so the
  // main league payload doesn't balloon with every archived fixture/rubber
  // every time anyone just loads the league.
  const { adminPasswordHash, potwVotes, potwNotified, auditLog, seasonHistory, ...leagueRest } = league;
  return { ...leagueRest, teams, fixtures, playoffs, adminRegistered: !!adminPasswordHash, potwByRound, myPotwVote, seasonHistoryCount: (seasonHistory || []).length };
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
// A round normally only opens once every fixture in the previous round is
// finalized. With allowRoundsByDate on, an admin can let the calendar
// override that — teams can start submitting selections once this round's
// own scheduled date is within ROUND_OPEN_LEAD_DAYS, not just on the day
// itself, since a captain needs a few days' notice to actually organize a
// line-up. This still doesn't touch whether the round's own matches can be
// SCORED — that always needs both teams' fixture to actually exist and
// selections in, regardless of the previous round. One postponed/
// outstanding match doesn't freeze every other team's season. Any match
// left unfinalized behind an already-open later round is what the
// "outstanding" labeling elsewhere (Fixtures) is watching for.
const ROUND_OPEN_LEAD_DAYS = 5;
function isRoundOpen(league, fixture) {
  if (fixture.stage === "regular") {
    if (fixture.round === 1) return true;
    const prev = league.fixtures.filter((f) => f.round === fixture.round - 1);
    if (prev.length > 0 && prev.every((f) => f.finalized)) return true;
    if (league.allowRoundsByDate) {
      const sched = league.schedule && league.schedule["r" + fixture.round];
      if (sched && sched.date) {
        const opensOn = new Date(sched.date + "T00:00:00Z");
        opensOn.setUTCDate(opensOn.getUTCDate() - ROUND_OPEN_LEAD_DAYS);
        if (opensOn.toISOString().slice(0, 10) <= new Date().toISOString().slice(0, 10)) return true;
      }
    }
    return false;
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

// A handful of leagues (Premier League among them) built their semis+final
// before the playoffs.semis_final model existed — those matches are just
// sitting in league.fixtures as regular-looking rounds, tagged stage:"semi"
// /"final" by whatever older flow created them. That leaves two problems:
// the table wrongly counts them as extra round-robin rounds (no roundMeta
// toggle can exclude them either, since that route only recognizes
// stage:"regular" rounds), and the knockout bracket view never shows them
// (it only reads from league.playoffs). This migrates that exact legacy
// shape — precisely 2 "semi" fixtures and 1 "final" fixture, only when the
// league hasn't already been set up with playoffs the current way — into a
// real playoffs.semis_final object, moving (not duplicating) those fixtures
// out of league.fixtures so the regular-season table and the bracket both
// pick them up correctly from here on.
function migrateLegacyKnockoutRounds(league) {
  if (league.playoffs || (league.playoffFormat && league.playoffFormat !== "none")) return false;
  const semis = league.fixtures.filter((f) => f.stage === "semi");
  const finals = league.fixtures.filter((f) => f.stage === "final");
  if (semis.length !== 2 || finals.length !== 1) return false;
  league.fixtures = league.fixtures.filter((f) => f.stage !== "semi" && f.stage !== "final");
  league.playoffs = { format: "semis_final", semis, final: finals[0] };
  league.playoffFormat = "semis_final";
  return true;
}

// Read once at boot, before the hub or any league renders — lets the exact
// same codebase run two ways from one env var: ratings hidden on this
// site, shown on another deployment (a second site sharing this same
// backend/database) without anything else differing between them.
router.get("/config", (req, res) => {
  res.json({ ratingsEnabled: process.env.RATINGS_ENABLED === "true", payfastSandbox: payfast.config().sandbox });
});

/* ---------- Leagues ---------- */

router.get("/leagues", (req, res) => {
  const index = visibleIndexEntries();
  const enriched = index.map((entry) => {
    const league = store.getLeague(entry.id);
    return {
      ...entry,
      status: league ? leagueStatus(league) : "setup",
      teamCount: league ? league.teams.length : 0,
      strength: league ? (league.strength || 0) : 0,
      format: league ? (league.format || "teams") : "teams",
      courtPhoto: league ? (league.courtPhoto || "") : "",
      // Every round/stage's {date,time,venue} — small enough to ship whole,
      // and the hub card needs it to work out "is a match live right now"
      // against the viewer's own clock (see leagueIsLiveNow client-side).
      schedule: league ? (league.schedule || {}) : {},
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
// One rating per linked player identity, replayed across every league in
// the store (not just one) — this is what lets a claimed player's rating
// travel between leagues, including leagues that live on a different site
// once that site points at this same backend/database. `identityOf`
// resolves a raw (leagueId, playerId) pair to the claiming account's id,
// or falls back to a per-league id for anyone who's never claimed a
// record (their rating simply doesn't travel anywhere).
function buildClaimsIndex() {
  const map = new Map(); // `${leagueId}:${playerId}` -> claiming userId
  store.getUsersIndex().forEach(({ id }) => {
    const user = store.getUser(id);
    if (!user) return;
    (user.claims || []).forEach((c) => map.set(`${c.leagueId}:${c.playerId}`, user.id));
  });
  return map;
}
function loadGlobalRatings() {
  const leagues = store.getIndex().map((e) => store.getLeague(e.id)).filter(Boolean);
  const claimsIndex = buildClaimsIndex();
  const identityOf = (leagueId, playerId) => claimsIndex.get(`${leagueId}:${playerId}`) || `${leagueId}:${playerId}`;
  return { ratingsData: logic.computeGlobalRatings(leagues, identityOf), identityOf };
}
// (nothing to scope to), sees the full cross-league feed instead.
// Shared by the site-wide Next Matches carousel and the signed-in player's
// personal "Tonight's matches" strip — both need the same "soonest shared
// night, interleaved fairly across leagues" grouping, just over a
// different set of leagues (every active league vs. just the ones this
// player is in).
function buildNextMatchesPairings(leagues, ratingsData, identityOf) {
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

  // The card's title ("Matches Tonight"/"Tomorrow") is set once from the
  // very first match and applies to the whole carousel — so every fixture
  // shown here has to share that same date, or a later night's match
  // (from a league with nothing on sooner) would ride along under the
  // wrong heading. Anything past the soonest scheduled date is left for
  // its own night's carousel instead.
  //
  // "Soonest" prefers today-or-later — a fixture whose scores never got
  // finished (a captain left one seed unscored, so the whole fixture never
  // got marked finalized) would otherwise permanently block every later
  // night's matches from ever showing, since its now-past date always
  // sorts first. Only fall back to an overdue date when nothing
  // today-or-later exists yet, so a league that's fallen behind entirely
  // still shows something rather than an empty carousel.
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const upcoming = fixtures.find((x) => x.sched.date && x.sched.date >= todayStr);
  const referenceDate = upcoming ? upcoming.sched.date : (fixtures.length ? fixtures[0].sched.date || "" : "");
  const sameNight = fixtures.filter((x) => (x.sched.date || "") === referenceDate);

  // Flatten to one entry per seed pairing (up to 4 per fixture), grouped
  // by league — this is what actually gets featured, not the fixture
  // itself.
  const byLeague = new Map();
  sameNight.forEach(({ league, f, teamA, teamB, sched }) => {
    f.selectionA.pairs.forEach((pairA, i) => {
      const pairB = f.selectionB.pairs[i];
      const namesA = [playerName(teamA, pairA[0]), playerName(teamA, pairA[1])].filter(Boolean);
      const namesB = [playerName(teamB, pairB[0]), playerName(teamB, pairB[1])].filter(Boolean);
      if (namesA.length !== 2 || namesB.length !== 2) return;
      // A seed can already be decided while the rest of the night's
      // fixture is still open (captains score them one at a time) — once
      // it is, the card shows that result instead of a bare "vs".
      const rubber = f.rubbers[i];
      const winner = rubber ? logic.rubberWinner(rubber) : null;
      // No point predicting a seed that's already been played.
      const prediction = winner ? null : logic.predictSeed(league, pairA, pairB, ratingsData, identityOf);
      if (!byLeague.has(league.id)) byLeague.set(league.id, []);
      byLeague.get(league.id).push({
        leagueName: league.name,
        teamAName: teamA.name,
        teamBName: teamB.name,
        teamALogo: teamA.logo || "",
        teamBLogo: teamB.logo || "",
        seed: i + 1,
        pairA: namesA,
        pairB: namesB,
        date: sched.date || "",
        time: sched.time || "",
        venue: sched.venue || league.defaultVenue || "",
        winner,
        score: winner ? logic.rubberScoreText(rubber) : null,
        prediction,
      });
    });
  });

  // Round-robin across leagues (in the order their soonest fixture sorted
  // to above) rather than draining one league's queue before moving to
  // the next — every match already belongs to the same night (scoped
  // above), so all of them are shown, just interleaved fairly across
  // leagues instead of one busy league's matches running back to back.
  const queues = Array.from(byLeague.values());
  const pairings = [];
  let tookOne = true;
  while (tookOne) {
    tookOne = false;
    for (const q of queues) {
      if (!q.length) continue;
      pairings.push(q.shift());
      tookOne = true;
    }
  }
  return pairings;
}

// Public, unauthenticated — every visitor pings this (public/app.js), not
// just logged-in ones, since "how many are on the app right now" should
// count guests browsing fixtures/results too, not just accounts.
router.post("/presence/ping", async (req, res) => {
  const visitorId = ((req.body && req.body.visitorId) || "").slice(0, 100);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(visitorId)) return res.status(400).json({ error: "Invalid visitor id." });
  await store.touchPresence(visitorId);
  res.json({ ok: true });
});
router.get("/admin/live-count", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  res.json({ count: await store.getLiveVisitorCount() });
});

router.get("/next-matches", (req, res) => {
  const myLeagueId = req.session.user && req.session.user.leagueId;
  const index = visibleIndexEntries();
  let leagues = index
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && leagueStatus(l) === "active" && l.format !== "pairs");

  let scopedTo = null;
  if (myLeagueId) {
    const mine = leagues.find((l) => l.id === myLeagueId);
    if (mine) { leagues = [mine]; scopedTo = { id: mine.id, name: mine.name }; }
  }

  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ scopedTo, matches: buildNextMatchesPairings(leagues, ratingsData, identityOf) });
});

// A signed-in player's own "Tonight's matches" — same grouping as the
// site-wide carousel, but scoped to only the leagues they've claimed a
// record in, not every active league on the site.
router.get("/players/tonight-matches", (req, res) => {
  if (!req.session.playerUser) return res.json({ matches: [] });
  const user = store.getUser(req.session.playerUser.id);
  if (!user) return res.json({ matches: [] });
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  const leagueIds = new Set((user.claims || []).map((c) => c.leagueId).filter((id) => !hiddenLeagueIds.has(id)));
  const leagues = Array.from(leagueIds)
    .map((id) => store.getLeague(id))
    .filter((l) => l && leagueStatus(l) === "active" && l.format !== "pairs");
  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ matches: buildNextMatchesPairings(leagues, ratingsData, identityOf) });
});

// The in-league Predictions tab — every seed in the given round (team
// leagues, round-scoped) or every not-yet-finalized seed across the whole
// league (pairs leagues, which have no weekly round to browse — same
// "Fixtures collapses into Results" reasoning as elsewhere). An already-
// decided seed carries its actual score instead of a prediction, so a
// partially-played round still shows something useful for what's left.
router.get("/leagues/:leagueId/predictions", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const round = req.query.round !== undefined ? Number(req.query.round) : null;
  const fixtures = (round !== null ? league.fixtures.filter((f) => f.round === round) : league.fixtures.filter((f) => !f.finalized));
  const { ratingsData, identityOf } = loadGlobalRatings();

  const out = fixtures.map((f) => {
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    if (!teamA || !teamB) return null;
    const revealed = f.selectionA.submitted && f.selectionB.submitted;
    const seeds = [];
    if (revealed) {
      f.selectionA.pairs.forEach((pairA, i) => {
        const pairB = (f.selectionB.pairs || [])[i];
        if (!pairA || !pairB || pairA.some((x) => !x) || pairB.some((x) => !x)) return;
        const rubber = f.rubbers[i];
        const winner = rubber ? logic.rubberWinner(rubber) : null;
        seeds.push({
          seed: i + 1,
          pairA: pairA.map((id) => (teamA.players.find((p) => p.id === id) || {}).name).filter(Boolean),
          pairB: pairB.map((id) => (teamB.players.find((p) => p.id === id) || {}).name).filter(Boolean),
          winner,
          score: winner ? logic.rubberScoreText(rubber) : null,
          prediction: winner ? null : logic.predictSeed(league, pairA, pairB, ratingsData, identityOf),
        });
      });
    }
    return {
      fixtureId: f.id, round: f.round, finalized: f.finalized, groupId: f.groupId || null,
      teamAId: teamA.id, teamBId: teamB.id, teamAName: teamA.name, teamBName: teamB.name,
      teamALogo: teamA.logo || "", teamBLogo: teamB.logo || "",
      revealed, seeds,
    };
  }).filter(Boolean);

  res.json({ round, fixtures: out });
});

// Homepage teasers, public and site-wide (not scoped to one league or one
// signed-in player) — reuses the same structured data the round-recap news
// post already carries, rather than recomputing anything. For each visible
// league, its most recently posted round recap supplies that league's
// current Pair of the Week (if any) and a few non-"quiet" highlights.
// Hall of Fame entries live inside each league's own page (Admin to edit,
// a public "Hall of Fame" tab to view) — this surfaces them on the
// homepage too, so a visitor sees a league's champions without having to
// find and open that specific league first. Every visible league is
// included regardless of current status (active/setup/offseason) — a past
// champion is a historical fact, not tied to whether the league happens to
// be running a season right now.
router.get("/homepage/hall-of-fame", (req, res) => {
  const leagues = visibleIndexEntries()
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && (l.hallOfFame || []).length > 0);
  const result = leagues.map((league) => ({
    leagueId: league.id,
    leagueName: league.name,
    entries: league.hallOfFame.slice().sort((a, b) => b.season - a.season),
  }));
  res.json(result);
});
router.get("/homepage/highlights", (req, res) => {
  const leagues = visibleIndexEntries()
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && leagueStatus(l) === "active");
  const extras = store.getHomepageExtras();
  const dismissed = new Set(extras.dismissed || []);

  const potw = [];
  const autoHighlights = [];
  leagues.forEach((league) => {
    // Computed straight off the votes for the league's own most recent
    // decided round, not off the latest auto-recap News post — a pairs-
    // format league never gets an auto-recap (round wrap-ups are a
    // team-league-only concept), so reading through the post silently
    // dropped every pairs league from this strip even when it had a real
    // Pair of the Week winner. Scanning rounds newest-first and taking the
    // first one with an actual winner means a round nobody voted in just
    // gets skipped rather than leaving the whole league off the homepage.
    const rounds = [...new Set(league.fixtures.map((f) => f.round))].sort((a, b) => b - a);
    for (const round of rounds) {
      const tally = logic.potwTallyForRound(league, round);
      if (!tally.winners.length) continue;
      tally.winners.forEach((p) => {
        const team = p.teamId ? league.teams.find((t) => t.id === p.teamId) : null;
        potw.push({
          names: p.playerAName + " & " + p.playerBName,
          team: p.teamName,
          leagueId: league.id,
          leagueName: league.name,
          teamLogo: team ? team.logo || "" : "",
        });
      });
      break;
    }

    const latest = (league.news || [])
      .filter((p) => p.auto)
      .sort((a, b) => b.round - a.round)[0];
    if (!latest) return;
    (latest.highlights || []).forEach((h) => {
      if (h.type === "quiet") return;
      const dismissKey = league.id + ":" + latest.round + ":" + h.type;
      if (dismissed.has(dismissKey)) return;
      // `short` is a recent addition — a post saved before it existed won't
      // have one, so fall back to the (longer) News Room text rather than
      // showing a blank card.
      const team = h.teamId ? league.teams.find((t) => t.id === h.teamId) : null;
      autoHighlights.push({ type: h.type, label: h.label, short: h.short || h.text, leagueId: league.id, leagueName: league.name, round: latest.round, createdAt: latest.createdAt, teamLogo: team ? team.logo || "" : "" });
    });
  });
  autoHighlights.sort((a, b) => b.createdAt - a.createdAt);
  // Admin-authored cards always show, on top of (never counted against) the
  // cap on auto-generated ones — they were deliberately added, not just
  // whatever happened to be most recent.
  const manualHighlights = (extras.manual || []).slice().sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => ({ type: "manual", label: "News", short: m.short, leagueId: null, leagueName: m.leagueName || "", createdAt: m.createdAt, manualId: m.id }));
  res.json({ potw, highlights: manualHighlights.concat(autoHighlights.slice(0, 9)) });
});

// Owner-only curation of the auto-generated strip — hide a card that's
// technically true but not worth surfacing (dismiss), or undo that.
router.post("/admin/interesting/dismiss", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { leagueId, round, type } = req.body || {};
  if (!leagueId || round === undefined || !type) return res.status(400).json({ error: "Missing leagueId, round, or type." });
  const extras = store.getHomepageExtras();
  const key = leagueId + ":" + round + ":" + type;
  if (!extras.dismissed.includes(key)) extras.dismissed.push(key);
  store.saveHomepageExtras(extras);
  res.json({ ok: true });
});
router.post("/admin/interesting/restore", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { leagueId, round, type } = req.body || {};
  const extras = store.getHomepageExtras();
  const key = leagueId + ":" + round + ":" + type;
  extras.dismissed = (extras.dismissed || []).filter((k) => k !== key);
  store.saveHomepageExtras(extras);
  res.json({ ok: true });
});
// A free-standing card the admin writes themselves — a season announcement,
// a shoutout that doesn't fit any of the auto categories, whatever's
// actually interesting that the recap engine has no way to know about.
router.post("/admin/interesting/manual", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { short, leagueName } = req.body || {};
  if (!short || !short.trim()) return res.status(400).json({ error: "Enter something to show." });
  const extras = store.getHomepageExtras();
  if (!extras.manual) extras.manual = [];
  extras.manual.push({ id: logic.uid(), short: short.trim(), leagueName: (leagueName || "").trim(), createdAt: Date.now() });
  store.saveHomepageExtras(extras);
  res.json({ ok: true });
});
router.delete("/admin/interesting/manual/:id", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const extras = store.getHomepageExtras();
  extras.manual = (extras.manual || []).filter((m) => m.id !== req.params.id);
  store.saveHomepageExtras(extras);
  res.json({ ok: true });
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

/* ---------- Player accounts ----------
   A third, independent auth axis from the site owner and per-league
   captain/admin sessions above — one real person can sign up once and hold
   several claimed player records across different leagues/teams. Claiming
   a record grants no write permissions of its own (can't edit lineups or
   scores); it's a read-only "this is me" identity layer over the existing
   per-league data, so req.session.playerUser is checked independently of
   req.session.user/isOwner and never substitutes for them. */

function normalizeEmail(email) {
  return ((email || "") + "").trim().toLowerCase();
}
function findUserIdByEmail(email) {
  const entry = store.getUsersIndex().find((u) => u.email === email);
  return entry ? entry.id : null;
}
function requirePlayerUser(req, res, next) {
  if (!req.session.playerUser) return res.status(401).json({ error: "Log in to your player account first." });
  next();
}

router.post("/players/signup", loginLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const existingId = findUserIdByEmail(normalized);
  if (existingId) {
    const existing = store.getUser(existingId);
    // An admin can link a player's records to their email before that
    // person has ever signed up themselves (see /admin/players/combine) —
    // that account exists purely to hold the claims, with no password set,
    // so login deliberately can't succeed on it yet (verifyPassword(pw,
    // null) always fails). Don't block the real person from ever signing
    // up with their own email just because it's already "taken" by their
    // own placeholder — set the password on that same account instead of
    // creating a duplicate, so they land on the records already linked to
    // them rather than an empty new profile.
    if (existing && !existing.passwordHash) {
      existing.passwordHash = await hashPassword(password);
      existing.name = name.trim();
      try {
        await store.saveUserDurable(existing.id, existing);
      } catch (e) {
        return res.status(503).json({ error: "Couldn't save your account just now — try again in a moment." });
      }
      req.session.playerUser = { id: existing.id };
      return res.json({ id: existing.id, name: existing.name, email: existing.email });
    }
    return res.status(400).json({ error: "An account with that email already exists." });
  }
  const id = logic.uid();
  const user = { id, email: normalized, passwordHash: await hashPassword(password), name: name.trim(), createdAt: Date.now(), claims: [] };
  const index = store.getUsersIndex();
  index.push({ id, email: normalized });
  // Both writes must actually land before this signup counts as real —
  // otherwise a request that 200s right before a restart (or a transient
  // Redis hiccup) can leave someone logged in (sessions are always
  // durable, see sessionStore.js) with an account that silently never
  // existed anywhere an admin — or their own next login — could find it.
  try {
    await store.saveUserDurable(id, user);
    await store.saveUsersIndexDurable(index);
  } catch (e) {
    return res.status(503).json({ error: "Couldn't save your account just now — try again in a moment." });
  }
  req.session.playerUser = { id };
  res.json({ id, name: user.name, email: user.email });
});
router.post("/players/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const id = findUserIdByEmail(normalizeEmail(email));
  const user = id ? store.getUser(id) : null;
  const ok = user && (await verifyPassword(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: "Incorrect email or password." });
  req.session.playerUser = { id: user.id };
  res.json({ id: user.id, name: user.name, email: user.email });
});
// Always responds the same way whether or not the email has an account —
// otherwise this endpoint would let anyone probe which emails are signed up.
router.post("/players/forgot-password", loginLimiter, (req, res) => {
  const normalized = normalizeEmail(req.body && req.body.email);
  const id = findUserIdByEmail(normalized);
  if (id) {
    const user = store.getUser(id);
    user.resetToken = crypto.randomBytes(32).toString("hex");
    user.resetTokenExpiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
    store.saveUser(user.id, user);
    const link = `${req.protocol}://${req.get("host")}/?resetToken=${user.resetToken}`;
    sendMail({
      to: user.email,
      subject: "Reset your Team Padel password",
      text: `Hi ${user.name},\n\nClick the link below to set a new password. It expires in 1 hour.\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    }).catch(() => {});
  }
  res.json({ ok: true });
});
router.post("/players/reset-password", loginLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing reset token." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const entry = store.getUsersIndex().map((e) => store.getUser(e.id)).find((u) => u && u.resetToken === token);
  if (!entry || !entry.resetTokenExpiresAt || entry.resetTokenExpiresAt < Date.now()) {
    return res.status(400).json({ error: "That reset link is invalid or has expired — request a new one." });
  }
  entry.passwordHash = await hashPassword(password);
  entry.resetToken = null;
  entry.resetTokenExpiresAt = null;
  store.saveUser(entry.id, entry);
  res.json({ ok: true });
});
router.post("/players/logout", (req, res) => {
  req.session.playerUser = null;
  res.json({ ok: true });
});
router.get("/players/me", (req, res) => {
  const pu = req.session.playerUser;
  const user = pu && store.getUser(pu.id);
  if (!user) return res.json(null);
  // Persisted per-account (see persistCaptaincy above), not the current
  // device's session — so this is the same on every device the account
  // signs into, not just whichever one most recently entered a code.
  const captaincies = [];
  let changed = false;
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  (user.captaincies || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    const team = league && league.teams.find((t) => t.id === c.teamId);
    if (!league || !team) { changed = true; return; } // team/league deleted since — drop quietly
    if (hiddenLeagueIds.has(c.leagueId)) return; // hidden league — data-only, never shown (captaincy itself stays intact)
    captaincies.push({ leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name, teamLogo: team.logo || "" });
  });
  if (changed) {
    user.captaincies = captaincies.map((c) => ({ leagueId: c.leagueId, teamId: c.teamId }));
    store.saveUser(user.id, user);
  }
  res.json({ id: user.id, name: user.name, email: user.email, captaincies });
});

// Every player record in the store, flat — any league, any format, any
// status, since a player record's existence is what matters here, not the
// league's phase. The shared base both the cross-league name search and
// the combine-suggestions scan build on.
function allPlayersFlat() {
  const results = [];
  visibleIndexEntries().forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    league.teams.forEach((team) => {
      team.players.forEach((p) => {
        results.push({
          leagueId: league.id, leagueName: league.name,
          teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
          playerId: p.id, playerName: p.name,
          claimedByUserId: p.claimedByUserId || null,
        });
      });
    });
  });
  return results;
}
// Shared by the player-facing search (below) and the owner-only admin
// search used to combine profiles on someone's behalf.
function searchPlayersAcrossLeagues(q) {
  return allPlayersFlat()
    .filter((p) => p.playerName.toLowerCase().includes(q))
    .map((p) => ({
      leagueId: p.leagueId, leagueName: p.leagueName, teamId: p.teamId, teamName: p.teamName, teamLogo: p.teamLogo,
      playerId: p.playerId, playerName: p.playerName, claimed: !!p.claimedByUserId,
    }))
    .slice(0, 30);
}
// Groups player records across every league whose names look like the
// same real person, so the admin combine tool can suggest candidates
// instead of relying on the admin to think to search a specific name.
// Purely a suggestion — two different people sharing (or nearly sharing)
// a name is completely normal in a league, so nothing here links anyone;
// it only surfaces groups worth a human's second look.
function findPlayerNameSuggestions() {
  const all = allPlayersFlat();
  const n = all.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(i, j) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Same team's own roster never has the same person twice — a name
      // match there is coincidence, not a cross-league duplicate.
      if (all[i].teamId === all[j].teamId) continue;
      if (logic.namesSimilar(all[i].playerName, all[j].playerName)) union(i, j);
    }
  }
  const groups = {};
  for (let i = 0; i < n; i++) {
    const root = find(i);
    (groups[root] = groups[root] || []).push(all[i]);
  }
  return Object.values(groups)
    .filter((players) => players.length >= 2)
    // Nothing left to suggest once every record in the group is already
    // combined under the same account.
    .filter((players) => {
      const owners = new Set(players.map((p) => p.claimedByUserId));
      return !(owners.size === 1 && players[0].claimedByUserId);
    })
    .map((players) => {
      let confidence = "close";
      outer: for (let a = 0; a < players.length; a++) {
        for (let b = a + 1; b < players.length; b++) {
          if (logic.namesSimilar(players[a].playerName, players[b].playerName) === "exact") { confidence = "exact"; break outer; }
        }
      }
      return {
        confidence,
        players: players.map((p) => ({
          leagueId: p.leagueId, leagueName: p.leagueName, teamId: p.teamId, teamName: p.teamName,
          playerId: p.playerId, playerName: p.playerName, claimed: !!p.claimedByUserId,
        })),
      };
    })
    .sort((a, b) => (b.confidence === "exact") - (a.confidence === "exact"));
}
router.get("/players/search", requirePlayerUser, (req, res) => {
  const q = ((req.query.q || "") + "").trim().toLowerCase();
  res.json(q ? searchPlayersAcrossLeagues(q) : []);
});

// Links one player record to one user account — used both by a player
// claiming themselves and by the owner combining records on someone's
// behalf. Throws (message is the user-facing error) rather than returning
// a response directly, so both callers can handle the failure their own
// way (one record failing shouldn't half-apply an admin combine).
function claimPlayerRecord(user, leagueId, teamId, playerId) {
  const league = store.getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) throw new Error("Team not found.");
  const player = team.players.find((p) => p.id === playerId);
  if (!player) throw new Error("Player not found.");
  if (player.claimedByUserId && player.claimedByUserId !== user.id) {
    // Already claimed by someone else is only a hard conflict if that
    // "someone else" could actually be a real person logged in as them.
    // A passwordHash of null means nobody can log into that account —
    // it only exists because an admin combined this record with others on
    // this player's behalf before they'd ever signed up themselves. The
    // real player showing up now to claim it absorbs everything already
    // linked there instead of hitting a wall.
    const other = store.getUser(player.claimedByUserId);
    if (other && !other.passwordHash) {
      absorbPlaceholderAccount(user, other);
    } else {
      throw new Error(`${player.name} (${team.name}, ${league.name}) has already been claimed by another profile.`);
    }
  }
  if (!player.claimedByUserId) {
    player.claimedByUserId = user.id;
    store.saveLeague(league.id, league);
  }
  if (!user.claims.some((c) => c.leagueId === leagueId && c.teamId === teamId && c.playerId === playerId)) {
    user.claims.push({ leagueId, teamId, playerId });
  }
}
// Pulls every claim off a passwordless placeholder account onto `user`
// (re-pointing each already-claimed player record along the way) and
// removes the now-empty placeholder — the other half of the merge above.
function absorbPlaceholderAccount(user, placeholder) {
  (placeholder.claims || []).forEach((c) => {
    const otherLeague = store.getLeague(c.leagueId);
    const otherTeam = otherLeague && otherLeague.teams.find((t) => t.id === c.teamId);
    const otherPlayer = otherTeam && otherTeam.players.find((p) => p.id === c.playerId);
    if (!otherLeague || !otherTeam || !otherPlayer) return;
    otherPlayer.claimedByUserId = user.id;
    store.saveLeague(otherLeague.id, otherLeague);
    if (!user.claims.some((x) => x.leagueId === c.leagueId && x.teamId === c.teamId && x.playerId === c.playerId)) {
      user.claims.push({ leagueId: c.leagueId, teamId: c.teamId, playerId: c.playerId });
    }
  });
  const index = store.getUsersIndex();
  store.saveUsersIndex(index.filter((e) => e.id !== placeholder.id));
  store.deleteUser(placeholder.id);
}
router.post("/players/claims", requirePlayerUser, async (req, res) => {
  const { leagueId, teamId, playerId } = req.body || {};
  const user = store.getUser(req.session.playerUser.id);
  try {
    claimPlayerRecord(user, leagueId, teamId, playerId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // A claim is as much "the real signup" as the account itself — same
  // durability reasoning as /players/signup, so it doesn't silently fail
  // to save while still telling the player "this is me" worked.
  try {
    await store.saveUserDurable(user.id, user);
  } catch (e) {
    return res.status(503).json({ error: "Couldn't save just now — try again in a moment." });
  }
  res.json({ ok: true });
});
router.delete("/players/claims/:leagueId/:teamId/:playerId", requirePlayerUser, (req, res) => {
  const { leagueId, teamId, playerId } = req.params;
  const user = store.getUser(req.session.playerUser.id);
  user.claims = user.claims.filter((c) => !(c.leagueId === leagueId && c.teamId === teamId && c.playerId === playerId));
  store.saveUser(user.id, user);
  const league = store.getLeague(leagueId);
  const team = league && league.teams.find((t) => t.id === teamId);
  const player = team && team.players.find((p) => p.id === playerId);
  if (player && player.claimedByUserId === user.id) {
    player.claimedByUserId = null;
    store.saveLeague(league.id, league);
  }
  res.json({ ok: true });
});

/* ---------- Admin: combine a player's records across leagues on their
   behalf ---------- */
// Same cross-league search self-serve claiming uses above, just gated to
// the site owner instead of a logged-in player — for when a captain
// reports "this is the same person in two leagues" and that person may
// never have signed up themselves.
router.get("/admin/players/search", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const q = ((req.query.q || "") + "").trim().toLowerCase();
  res.json(q ? searchPlayersAcrossLeagues(q) : []);
});
// Groups of records across every league whose names look like the same
// real person — surfaced so the admin doesn't have to already suspect a
// specific name is duplicated before searching for it.
router.get("/admin/players/suggestions", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  res.json(findPlayerNameSuggestions());
});
router.post("/admin/players/combine", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { name, email, records } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  if (!Array.isArray(records) || records.length < 2) return res.status(400).json({ error: "Select at least two records to combine." });
  let userId = findUserIdByEmail(normalized);
  let user;
  if (userId) {
    user = store.getUser(userId);
  } else {
    userId = logic.uid();
    // No password — this profile exists so its records show up combined,
    // but nobody can log into it until the real player sets one up
    // themselves. /players/signup, if it sees this exact email with no
    // password set, adopts this account (setting the password on it)
    // instead of blocking them or creating a duplicate.
    user = { id: userId, email: normalized, passwordHash: null, name: name.trim(), createdAt: Date.now(), claims: [] };
    const index = store.getUsersIndex();
    index.push({ id: userId, email: normalized });
    try {
      await store.saveUsersIndexDurable(index);
    } catch (e) {
      return res.status(503).json({ error: "Couldn't save just now — try again in a moment." });
    }
  }
  // All-or-nothing: if any one record is already claimed by a different
  // profile, reject the whole combine rather than silently applying half
  // of it — the admin can go unclaim the conflicting one first.
  try {
    records.forEach((r) => claimPlayerRecord(user, r.leagueId, r.teamId, r.playerId));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    await store.saveUserDurable(user.id, user);
  } catch (e) {
    return res.status(503).json({ error: "Couldn't save just now — try again in a moment." });
  }
  res.json({ ok: true, userId: user.id });
});
// A simple read-back of every player account and what it's linked to —
// so combining someone isn't a write-only black box for the admin.
router.get("/admin/players/accounts", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const activeIds = new Set(await store.getActivePlayerUserIds());
  // An index entry with no matching user record (the account write never
  // landed, or landed and was later deleted without cleaning up the
  // index) shouldn't crash the whole list — skip it instead.
  const accounts = store.getUsersIndex().map((entry) => {
    const user = store.getUser(entry.id);
    if (!user) return null;
    const claims = (user.claims || [])
      .map((c) => {
        const league = store.getLeague(c.leagueId);
        const team = league && league.teams.find((t) => t.id === c.teamId);
        const player = team && team.players.find((p) => p.id === c.playerId);
        if (!league || !team || !player) return null;
        return { leagueId: c.leagueId, teamId: c.teamId, playerId: c.playerId, leagueName: league.name, teamName: team.name, playerName: player.name };
      })
      .filter(Boolean);
    return { id: user.id, name: user.name, email: user.email, claims, online: activeIds.has(user.id) };
  }).filter(Boolean);
  res.json(accounts);
});
// Undo one link from an admin combine (or a self-claim) — lets the owner
// fix a mis-combine without needing to log in as that player.
router.delete("/admin/players/:userId/claims/:leagueId/:teamId/:playerId", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { userId, leagueId, teamId, playerId } = req.params;
  const user = store.getUser(userId);
  if (!user) return res.status(404).json({ error: "Account not found." });
  user.claims = (user.claims || []).filter((c) => !(c.leagueId === leagueId && c.teamId === teamId && c.playerId === playerId));
  store.saveUser(user.id, user);
  const league = store.getLeague(leagueId);
  const team = league && league.teams.find((t) => t.id === teamId);
  const player = team && team.players.find((p) => p.id === playerId);
  if (player && player.claimedByUserId === user.id) {
    player.claimedByUserId = null;
    store.saveLeague(league.id, league);
  }
  res.json({ ok: true });
});

router.get("/players/profile", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const cards = [];
  let changed = false;
  // Computed once for this whole request, not once per claimed card — every
  // card belonging to this account resolves to the SAME rating entry below
  // (that's the point: one linked identity, one number, wherever it's shown).
  const { ratingsData, identityOf } = loadGlobalRatings();
  // `hidden` lives on the leagues-index entry, not the league document
  // itself — same source visibleIndexEntries() reads, just a Set for O(1)
  // lookup per claim below instead of scanning the index each time.
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  // A league/team/player claimed earlier can later be deleted by its
  // admin/captain — drop the now-dangling claim quietly rather than error.
  user.claims = user.claims.filter((claim) => {
    const league = store.getLeague(claim.leagueId);
    const team = league && league.teams.find((t) => t.id === claim.teamId);
    const player = team && team.players.find((p) => p.id === claim.playerId);
    if (!league || !team || !player) { changed = true; return false; }
    // A hidden league (data imported purely to feed ratings, not a real
    // league to manage here) never surfaces in any list on this site — the
    // claim still counts for rating purposes, it just gets no card here.
    if (hiddenLeagueIds.has(claim.leagueId)) return true;
    const rounds = [...new Set(league.fixtures.map((f) => f.round))];
    const awards = rounds
      .flatMap((r) => logic.potwTallyForRound(league, r).winners)
      .filter((w) => w.playerAId === claim.playerId || w.playerBId === claim.playerId);
    const ratingEntry = ratingsData.players.get(identityOf(league.id, claim.playerId));
    cards.push({
      leagueId: league.id, leagueName: league.name,
      teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
      playerId: player.id, playerName: player.name, photo: player.photo || "",
      upcoming: logic.findPlayerUpcoming(league, claim.playerId, ratingsData, identityOf),
      results: logic.playerMatchHistory(league, claim.playerId, ratingsData),
      awards,
      rating: ratingEntry ? ratingEntry.rating : null,
      ratingPlayed: ratingEntry ? ratingEntry.played : 0,
      ratingProvisional: ratingEntry ? ratingEntry.played < logic.ELO_PROVISIONAL_GAMES : null,
    });
    return true;
  });
  if (changed) store.saveUser(user.id, user);
  res.json({ name: user.name, cards });
});

// News Room, aggregated across every league this account has a claimed
// record in — same "one profile, every league" idea as /players/profile,
// just for news posts instead of match history. A hidden league (data-only,
// feeds ratings, never shown anywhere else on the site) is skipped here too.
router.get("/players/news", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  const leagueIds = [...new Set((user.claims || []).map((c) => c.leagueId).filter((id) => !hiddenLeagueIds.has(id)))];
  const posts = [];
  leagueIds.forEach((leagueId) => {
    const league = store.getLeague(leagueId);
    if (!league) return;
    (league.news || []).forEach((p) => posts.push({ ...p, leagueId: league.id, leagueName: league.name }));
  });
  res.json(sortNewsPosts(posts));
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
  if (league.courtPhoto === undefined) league.courtPhoto = "";
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
  if (league.allowRoundsByDate === undefined) league.allowRoundsByDate = false;
  if (league.strength === undefined) league.strength = 0;
  if (!league.format) league.format = "teams";
  if (!league.groups) league.groups = [];
  if (!league.hallOfFame) league.hallOfFame = [];
  if (!league.registrationFeeCents) league.registrationFeeCents = 0;
  // Lives on the leagues-index entry, not this document — surfaced here
  // (harmless either way) so the owner-only "hide from lists" toggle in
  // Admin knows its current state without a separate lookup.
  const indexEntry = store.getIndex().find((e) => e.id === league.id);
  league.hidden = !!(indexEntry && indexEntry.hidden);
  let migrated = syncPlayoffs(league);
  if (migrateLegacyKnockoutRounds(league)) migrated = true;
  // Teams created before per-team access codes existed won't have one —
  // give them one automatically so every captain can log in.
  league.teams.forEach((t) => {
    if (!t.code) { t.code = genTeamCode(league); migrated = true; }
    if (!t.paymentStatus) { t.paymentStatus = "unpaid"; migrated = true; }
    if (t.paymentMode === undefined) { t.paymentMode = null; migrated = true; }
    t.players.forEach((p) => {
      if (!p.paymentStatus) { p.paymentStatus = "unpaid"; migrated = true; }
    });
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

// The site owner's own view of every league that exists, hidden ones
// included — visibleIndexEntries() (used everywhere else) deliberately
// drops hidden leagues, which makes them hard to find again once hidden,
// especially several leagues sharing the same name. This is the one place
// that intentionally shows all of them.
router.get("/admin/leagues", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const leagues = store.getIndex().map((entry) => {
    const league = store.getLeague(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      hidden: !!entry.hidden,
      createdAt: entry.createdAt,
      teamCount: league ? league.teams.length : 0,
    };
  });
  res.json(leagues);
});

// Owner-only, not per-league admin: hiding a league affects site-wide
// lists (search, login lookup, every player's "Your leagues"), not just
// this one league's own management — same bar as creating/deleting a
// league itself.
router.put("/leagues/:leagueId/hidden", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const index = store.getIndex();
  const entry = index.find((l) => l.id === req.params.leagueId);
  if (!entry) return res.status(404).json({ error: "Not found." });
  entry.hidden = !!req.body.hidden;
  store.saveIndex(index);
  res.json({ ok: true, hidden: entry.hidden });
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

// If a signed-in player just logged in as captain, persist it on their
// account too — like a claimed player record, so "Captain" reflects a fact
// about the person, not just whichever device most recently entered the
// code. Without this, the same person's phone and laptop could disagree
// about which team they captain, which looked exactly like a data bug.
// Deliberately display-only: it does NOT grant write access by itself —
// managing a team from a new device still requires that team's code there,
// same as always, so this doesn't change who can actually edit lineups/scores.
function persistCaptaincy(req, leagueId, teamId) {
  if (!req.session.playerUser) return;
  const user = store.getUser(req.session.playerUser.id);
  if (!user) return;
  if (!user.captaincies) user.captaincies = [];
  if (!user.captaincies.some((c) => c.leagueId === leagueId && c.teamId === teamId)) {
    user.captaincies.push({ leagueId, teamId });
    store.saveUser(user.id, user);
  }
}
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
  persistCaptaincy(req, league.id, team.id);
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
  for (const entry of visibleIndexEntries()) {
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
  persistCaptaincy(req, league.id, team.id);
  res.json({ role: "captain", leagueId: league.id, teamId: team.id });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Ends only the captain session, same scoping as /players/logout — a
// player removing their own captaincy shouldn't also sign them out of
// their player account. Also drops the persisted captaincy (if a specific
// leagueId/teamId is given) — otherwise it would just reappear next time
// the account is checked from any device, since that's the source of truth.
router.post("/captain-logout", (req, res) => {
  const { leagueId, teamId } = req.body || {};
  if (!leagueId || !teamId || (req.session.user && req.session.user.leagueId === leagueId && req.session.user.teamId === teamId)) {
    req.session.user = null;
  }
  if (leagueId && teamId && req.session.playerUser) {
    const user = store.getUser(req.session.playerUser.id);
    if (user && user.captaincies) {
      user.captaincies = user.captaincies.filter((c) => !(c.leagueId === leagueId && c.teamId === teamId));
      store.saveUser(user.id, user);
    }
  }
  res.json({ ok: true });
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

// A profile photo — set by an admin/captain on behalf of anyone on the
// roster (same trust level that already lets them add/rename/remove
// players), or by the player themselves once they've claimed this exact
// record. Neither of the existing helpers (requireAdmin,
// requireAdminOrCaptain) know about player-account claims, so this checks
// all three paths inline rather than bolting a claims lookup onto those
// shared middlewares.
router.put("/leagues/:leagueId/teams/:teamId/players/:playerId/photo", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const player = team.players.find((p) => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: "Player not found." });

  const isAdmin = isAdminSession(req, league.id);
  const u = req.session.user;
  const isCaptain = u && u.leagueId === league.id && u.role === "captain" && u.teamId === team.id;
  let isOwnProfile = false;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    isOwnProfile = !!(account && (account.claims || []).some((c) => c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
  }
  if (!isAdmin && !isCaptain && !isOwnProfile) return res.status(403).json({ error: "Not allowed." });

  player.photo = req.body.photo || "";
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

/* ---------- Toss: a fair, server-decided coin flip between the two
   teams in a specific fixture. The winner picks whether their line-up
   goes in first or forces the opponent to declare first — that ordering
   then gates the existing /selection route below, so the toss feeds
   straight into picking pairs live instead of being a separate ritual.
   Selection Room's blind submit-then-reveal keeps working unchanged for
   any fixture that skips the toss entirely. ---------- */
// Resolves which side (A/B) the current session is allowed to act as for
// this fixture — admin/owner may act as either (via req.body.side), a
// captain only as their own team. Null means "not part of this fixture."
function fixtureSide(league, f, req, bodySide) {
  const ownerHere = isOwnerSession(req);
  const u = req.session.user;
  if (ownerHere || (u && u.leagueId === league.id && u.role === "admin")) {
    return bodySide === "A" || bodySide === "B" ? bodySide : null;
  }
  if (!u || u.leagueId !== league.id) return null;
  return u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null;
}
router.get("/leagues/:leagueId/fixtures/:fixtureId/toss/public", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Not found." });
  const teamA = league.teams.find((t) => t.id === f.teamA) || null;
  const teamB = league.teams.find((t) => t.id === f.teamB) || null;
  // Read-only, no login: only what a spectator needs to follow along —
  // never contact details, codes, or anything from other fixtures.
  const publicTeam = (t) => (t ? { name: t.name, logo: t.logo || "", players: t.players.map((p) => ({ id: p.id, name: p.name })) } : null);
  res.json({
    league: { name: league.name },
    label: fixtureLabel(league, f),
    teamA: publicTeam(teamA),
    teamB: publicTeam(teamB),
    toss: f.toss || null,
    tieringEnabled: !!league.tieringEnabled,
    pairToss: f.pairToss || null,
    selectionA: { submitted: f.selectionA.submitted, pairs: f.selectionA.submitted ? f.selectionA.pairs : [] },
    selectionB: { submitted: f.selectionB.submitted, pairs: f.selectionB.submitted ? f.selectionB.pairs : [] },
    videoRoom: "TeamPadel-" + f.id,
  });
});
// Toss is turned off — every route that would start or advance a new toss
// (fixture-level or per-pairing) refuses outright, on top of the tab being
// gone client-side, so a direct API call can't bypass it either. Reading
// what's already there (/toss/public, pair-toss GET) and resetting
// (admin-only) still work — nothing here deletes past toss data, it just
// stops new tosses from mattering.
const TOSS_DISABLED_ERROR = { error: "The toss feature is currently turned off." };
router.put("/leagues/:leagueId/fixtures/:fixtureId/toss/schedule", requireLeagueSession, (req, res) => {
  res.status(400).json(TOSS_DISABLED_ERROR);
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/toss/call", requireLeagueSession, (req, res) => {
  res.status(400).json(TOSS_DISABLED_ERROR);
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/toss/choice", requireLeagueSession, (req, res) => {
  res.status(400).json(TOSS_DISABLED_ERROR);
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/toss/reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  f.toss = {};
  store.saveLeague(league.id, league);
  res.json({ toss: f.toss });
});

/* ---------- Pair toss: for a gold-tier league, one toss PER pairing
   instead of one toss for the whole line-up. Winner of each round's flip
   picks the tier (gold/silver, whichever isn't already full) for that
   round, then the same self-first/opponent-first choice as the regular
   toss — so the two gold pairings and two silver pairings each get their
   own moment instead of being buried inside one big reveal. Rounds are
   strictly sequential: round 2 can't start until both sides have
   declared their round-1 pair. ---------- */
function pairToss(f) {
  if (!f.pairToss || f.pairToss.length !== 4) f.pairToss = [{}, {}, {}, {}];
  return f.pairToss;
}
function roundFilled(f, side, roundIdx) {
  const sel = side === "A" ? f.selectionA : f.selectionB;
  const pair = sel.pairs[roundIdx];
  return !!(pair && pair[0] && pair[1]);
}
function roundUnlocked(f, roundIdx) {
  if (roundIdx === 0) return true;
  return roundFilled(f, "A", roundIdx - 1) && roundFilled(f, "B", roundIdx - 1);
}
// Kept fully live, unlike the fixture-level toss above — Balwin Ladies
// Social and Balwin Men's Social both have gold-tier seeding on, and
// pair-toss/:round/pair (below) refuses to accept a declared pairing at
// all until its round has a decided firstSide, which only /call + /choice
// here can produce. Disabling this would have permanently locked both
// leagues out of ever selecting a line-up again — a materially different
// situation from the fixture-level toss, which nothing depends on.
router.post("/leagues/:leagueId/fixtures/:fixtureId/pair-toss/:round/call", requireLeagueSession, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!league.tieringEnabled) return res.status(400).json({ error: "Gold-tier seeding isn't on for this league." });
  if (!f.teamA || !f.teamB) return res.status(400).json({ error: "Teams for this fixture aren't decided yet." });
  const roundIdx = Number(req.params.round) - 1;
  if (!(roundIdx >= 0 && roundIdx < 4)) return res.status(400).json({ error: "Invalid pairing round." });
  if (!roundUnlocked(f, roundIdx)) return res.status(400).json({ error: "Decide the previous pairing first." });
  const side = fixtureSide(league, f, req, req.body.side);
  if (!side) return res.status(403).json({ error: "You're not in this fixture." });
  const call = req.body.call;
  if (call !== "heads" && call !== "tails") return res.status(400).json({ error: "Call heads or tails first." });
  const rounds = pairToss(f);
  if (rounds[roundIdx].firstSide) return res.status(400).json({ error: "This pairing's toss is already decided — ask the admin to reset it to redo the flip." });
  const result = Math.random() < 0.5 ? "heads" : "tails";
  const winnerSide = call === result ? side : side === "A" ? "B" : "A";
  rounds[roundIdx] = { call, result, callerSide: side, winnerSide, tier: null, firstSide: null };
  store.saveLeague(league.id, league);
  res.json({ pairToss: rounds });
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/pair-toss/:round/choice", requireLeagueSession, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const roundIdx = Number(req.params.round) - 1;
  if (!(roundIdx >= 0 && roundIdx < 4)) return res.status(400).json({ error: "Invalid pairing round." });
  const rounds = pairToss(f);
  const round = rounds[roundIdx];
  if (!round || !round.result) return res.status(400).json({ error: "Flip the coin first." });
  if (round.firstSide) return res.status(400).json({ error: "This pairing is already decided." });
  const side = fixtureSide(league, f, req, round.winnerSide);
  if (side !== round.winnerSide) return res.status(403).json({ error: "Only the team that won this pairing's toss can make this choice." });
  const goldSlots = Math.max(0, Math.min(4, league.goldTierCount || 0));
  const silverSlots = 4 - goldSlots;
  let goldUsed = 0, silverUsed = 0;
  rounds.forEach((r, i) => { if (i !== roundIdx && r.tier === "gold") goldUsed++; if (i !== roundIdx && r.tier === "silver") silverUsed++; });
  const goldAvailable = goldUsed < goldSlots, silverAvailable = silverUsed < silverSlots;
  let tier = req.body.tier;
  if (goldAvailable && !silverAvailable) tier = "gold";
  else if (silverAvailable && !goldAvailable) tier = "silver";
  else if (tier !== "gold" && tier !== "silver") return res.status(400).json({ error: "Choose gold or silver for this pairing." });
  if (tier === "gold" && !goldAvailable) return res.status(400).json({ error: "Both gold pairings are already spoken for." });
  if (tier === "silver" && !silverAvailable) return res.status(400).json({ error: "Both silver pairings are already spoken for." });
  const orderChoice = req.body.orderChoice;
  if (orderChoice !== "self" && orderChoice !== "opponent") return res.status(400).json({ error: "Choose who declares first." });
  round.tier = tier;
  round.firstSide = orderChoice === "self" ? round.winnerSide : round.winnerSide === "A" ? "B" : "A";
  store.saveLeague(league.id, league);
  res.json({ pairToss: rounds });
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/pair-toss/:round/pair", requireLeagueSession, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const roundIdx = Number(req.params.round) - 1;
  if (!(roundIdx >= 0 && roundIdx < 4)) return res.status(400).json({ error: "Invalid pairing round." });
  const rounds = pairToss(f);
  const round = rounds[roundIdx];
  if (!round || !round.firstSide) return res.status(400).json({ error: "This pairing's toss hasn't decided who goes first yet." });
  const side = fixtureSide(league, f, req, req.body.side);
  if (!side) return res.status(403).json({ error: "You're not in this fixture." });
  const oppSide = side === "A" ? "B" : "A";
  if (roundFilled(f, "A", roundIdx) && roundFilled(f, "B", roundIdx)) {
    return res.status(400).json({ error: "Both sides have already declared this pairing." });
  }
  if (round.firstSide !== side && !roundFilled(f, oppSide, roundIdx)) {
    const firstTeamId = round.firstSide === "A" ? f.teamA : f.teamB;
    const firstTeam = league.teams.find((t) => t.id === firstTeamId);
    return res.status(400).json({ error: (firstTeam ? firstTeam.name : "The other team") + " goes first on this pairing — wait for their pick before submitting yours." });
  }
  const selKey = side === "A" ? "selectionA" : "selectionB";
  const pair = req.body.pair;
  if (!Array.isArray(pair) || pair.length !== 2) return res.status(400).json({ error: "Pick two players for this pairing." });
  const result = logic.validateRoundPair(f[selKey].pairs, roundIdx, pair, !!req.body.confirmDoubleUp);
  if (result) return res.status(400).json({ error: result.error, needsConfirm: !!result.needsConfirm });
  f[selKey].pairs[roundIdx] = pair;
  if (f[selKey].pairs.every((p) => p[0] && p[1])) f[selKey].submitted = true;
  store.saveLeague(league.id, league);
  res.json({ ok: true, pairToss: rounds, selection: f[selKey] });
});
router.post("/leagues/:leagueId/fixtures/:fixtureId/pair-toss/:round/reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const roundIdx = Number(req.params.round) - 1;
  if (!(roundIdx >= 0 && roundIdx < 4)) return res.status(400).json({ error: "Invalid pairing round." });
  const rounds = pairToss(f);
  rounds[roundIdx] = {};
  store.saveLeague(league.id, league);
  res.json({ pairToss: rounds });
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

router.put("/leagues/:leagueId/allow-rounds-by-date", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.allowRoundsByDate = !!req.body.enabled;
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
  // Reset always archives first — there's no separate "remember to save
  // before you wipe" step to forget. A season with no fixtures yet (still
  // in setup) has nothing worth keeping, so it's skipped rather than
  // saving an empty snapshot.
  if (league.fixtures.length > 0) {
    if (!league.seasonHistory) league.seasonHistory = [];
    const label = (req.body && req.body.seasonLabel && req.body.seasonLabel.trim()) || `Season ending ${new Date().toISOString().slice(0, 10)}`;
    // Same season numbering Hall of Fame entries already use (a plain
    // integer, 1 for the first season ever archived) — this is what lets
    // the archive view cross-reference "who was MVP that season" instead
    // of the two features living totally unlinked.
    const season = league.seasonHistory.length + 1;
    league.seasonHistory.unshift({
      id: logic.uid(),
      season,
      label,
      archivedAt: Date.now(),
      name: league.name,
      format: league.format,
      teams: league.teams,
      fixtures: league.fixtures,
      playoffs: league.playoffs,
      playoffFormat: league.playoffFormat,
      roundMeta: league.roundMeta,
      schedule: league.schedule,
      defaultVenue: league.defaultVenue,
    });
  }
  league.fixtures = [];
  league.byes = [];
  league.playoffs = null;
  league.roundMeta = {};
  league.status = "setup";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

function archivedSeasonChampion(snapshot) {
  if (!snapshot.playoffs) return null;
  const fin = snapshot.playoffs.format === "position" ? null : snapshot.playoffs.final;
  if (!fin || !fin.finalized) return null;
  const { winsA, winsB } = logic.fixtureScore(fin);
  const winnerId = winsA > winsB ? fin.teamA : fin.teamB;
  const team = snapshot.teams.find((t) => t.id === winnerId);
  return team ? team.name : null;
}
// Every past season this league has archived (via season/reset above) —
// summaries only, so browsing the list doesn't ship every fixture/rubber
// for every past season at once.
// Entries archived before the season-number field existed have no `season`
// — same fallback in both routes below: position from the end of the
// (newest-first) list, so "the very first one ever archived" is still 1.
function seasonNumberOf(history, s) {
  return s.season || history.length - history.indexOf(s);
}
router.get("/leagues/:leagueId/season-history", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const history = league.seasonHistory || [];
  const summaries = history.map((s) => ({
    id: s.id, season: seasonNumberOf(history, s), label: s.label, archivedAt: s.archivedAt, teamCount: s.teams.length, champion: archivedSeasonChampion(s),
  }));
  res.json(summaries);
});
router.get("/leagues/:leagueId/season-history/:seasonId", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const history = league.seasonHistory || [];
  const snapshot = history.find((s) => s.id === req.params.seasonId);
  if (!snapshot) return res.status(404).json({ error: "That season isn't archived here." });
  const standings = logic.computeStandings(snapshot);
  const season = seasonNumberOf(history, snapshot);
  const hallOfFame = (league.hallOfFame || []).filter((e) => e.season === season);
  res.json({ ...snapshot, season, standings, hallOfFame });
});

// Same lookup as findFixture(), just scoped to one archived snapshot
// instead of the live league — a past season's fixtures/playoffs are a
// frozen copy with the identical shape, so this only differs in what it
// searches.
function findArchivedFixture(snapshot, fixtureId) {
  let f = snapshot.fixtures.find((x) => x.id === fixtureId);
  if (f) return f;
  if (snapshot.playoffs) {
    if (snapshot.playoffs.format === "position") {
      f = (snapshot.playoffs.matches || []).find((x) => x.id === fixtureId);
      if (f) return f;
    } else {
      if (snapshot.playoffs.final && snapshot.playoffs.final.id === fixtureId) return snapshot.playoffs.final;
      f = (snapshot.playoffs.semis || []).find((x) => x.id === fixtureId);
      if (f) return f;
    }
  }
  return null;
}
// Lets an admin correct a score after the fact — a past season is archived,
// not frozen. Standings and the bracket are always recomputed fresh from
// the snapshot on read (see the route above), so editing a rubber here is
// the only write needed for the correction to show up everywhere.
router.put("/leagues/:leagueId/season-history/:seasonId/fixtures/:fixtureId/rubbers/:idx", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const snapshot = (league.seasonHistory || []).find((s) => s.id === req.params.seasonId);
  if (!snapshot) return res.status(404).json({ error: "That season isn't archived here." });
  const f = findArchivedFixture(snapshot, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Match not found in that season." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  if (req.body.sets) f.rubbers[idx].sets = req.body.sets;
  if (req.body.tb) f.rubbers[idx].tb = req.body.tb;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// For the rare case where a whole match got attributed to the wrong two
// teams (not just a wrong score) — swaps only teamA/teamB, leaving the
// rubbers exactly as recorded, so whichever side already won the match
// keeps that result under the correct team. Deliberately does NOT touch
// selectionA/selectionB: each team's roster has its own player records
// (never shared between teams, even for a same-named player), so the old
// selections would no longer resolve to real names under the new team —
// that half of the fix needs an admin to re-pick the real line-up
// themselves, with a human's knowledge of who actually played.
router.put("/leagues/:leagueId/season-history/:seasonId/fixtures/:fixtureId/swap-teams", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const snapshot = (league.seasonHistory || []).find((s) => s.id === req.params.seasonId);
  if (!snapshot) return res.status(404).json({ error: "That season isn't archived here." });
  const f = findArchivedFixture(snapshot, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Match not found in that season." });
  const teamA = f.teamA, teamB = f.teamB;
  f.teamA = teamB; f.teamB = teamA;
  f.selectionA = { submitted: false, pairs: f.selectionA.pairs.map(() => [null, null]) };
  f.selectionB = { submitted: false, pairs: f.selectionB.pairs.map(() => [null, null]) };
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Pauses an already-started league between seasons — unlike season/reset,
// nothing gets wiped (fixtures, playoffs, results all stay exactly as they
// are); this just flips the hub card to "Off season" and unclickable for
// everyone but the owner (see leagueCardHtml's `locked` check), same
// treatment a not-yet-started "setup" league already gets, just for a
// different reason.
router.put("/leagues/:leagueId/season-status", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const status = req.body.status;
  if (status !== "active" && status !== "offseason") return res.status(400).json({ error: "Invalid status." });
  if (leagueStatus(league) === "setup") return res.status(400).json({ error: "Start the season before setting an off-season status." });
  league.status = status;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/default-venue", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.defaultVenue = (req.body.venue || "").trim();
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// A background photo for this league's card on the home hub — same
// data-URL-on-the-object approach as a team's logo, just a bigger image.
router.put("/leagues/:leagueId/court-photo", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.courtPhoto = req.body.photo || "";
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

/* ---------- Payments (PayFast) ----------
   One flat registration fee per league. Each team's captain (or admin)
   picks how it gets paid — one lump sum for the whole team, or split
   evenly and paid per-player — and that choice locks in the moment
   anyone's actually paid, so a mid-collection mode switch can never
   orphan a payment already made under the old one.

   PayFast needs a real browser form POST to its own hosted checkout (not
   an API call), so the server's job is just: hand the client a signed set
   of form fields to submit, then trust nothing until PayFast's own
   server-to-server ITN webhook confirms the payment (see /payfast/notify
   below) — landing back on the site is never itself proof of payment. */

function playerShareCents(league, team) {
  const n = team.players.length || 1;
  return Math.round((league.registrationFeeCents || 0) / n);
}
// True once switching modes would orphan a payment already made — a lump
// payment already taken, or any one player already paid their share.
function paymentModeLocked(team) {
  if (team.paymentMode === "team") return team.paymentStatus === "paid";
  if (team.paymentMode === "split") return team.players.some((p) => p.paymentStatus === "paid");
  return false;
}
function findTeamAndPlayer(league, teamId, playerId) {
  const team = league.teams.find((t) => t.id === teamId);
  const player = team && team.players.find((p) => p.id === playerId);
  return { team, player };
}

router.put("/leagues/:leagueId/registration-fee", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const amountRands = Number(req.body.amountRands);
  if (!Number.isFinite(amountRands) || amountRands < 0 || amountRands > 100000) {
    return res.status(400).json({ error: "Enter a fee between R0 and R100,000." });
  }
  league.registrationFeeCents = Math.round(amountRands * 100);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/teams/:teamId/payment-mode", requireAdminOrCaptain(), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const mode = req.body.mode;
  if (mode !== "team" && mode !== "split") return res.status(400).json({ error: "Invalid payment mode." });
  if (team.paymentMode && team.paymentMode !== mode && paymentModeLocked(team)) {
    return res.status(400).json({ error: "Can't change how this team pays — someone's already paid under the current mode." });
  }
  team.paymentMode = mode;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.get("/leagues/:leagueId/teams/:teamId/pay/checkout", requireAdminOrCaptain(), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (!league.registrationFeeCents) return res.status(400).json({ error: "This league has no registration fee set." });
  if (team.paymentMode !== "team") return res.status(400).json({ error: "This team is set to pay per-player, not as one lump sum." });
  if (team.paymentStatus === "paid") return res.status(400).json({ error: "This team is already marked as paid." });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: league.registrationFeeCents / 100,
    itemName: `${league.name} registration — ${team.name}`.slice(0, 100),
    returnUrl: `${base}/#league/${league.id}`,
    cancelUrl: `${base}/#league/${league.id}`,
    notifyUrl: `${base}/api/payfast/notify`,
    customStr1: league.id,
    customStr2: team.id,
  });
  res.json(checkout);
});

// Cash/EFT collected outside PayFast still needs to be reflected here —
// very much the norm for a local sports league treasurer, not an edge case.
router.put("/leagues/:leagueId/teams/:teamId/payment-status", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const paid = !!req.body.paid;
  team.paymentStatus = paid ? "paid" : "unpaid";
  team.paymentMethod = paid ? "manual" : null;
  team.paymentRef = paid ? null : team.paymentRef;
  team.paidAt = paid ? Date.now() : null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// A claimed player pays their own share from their own player account —
// req.session.playerUser, a completely separate auth axis from the
// team/admin session above (see the player-accounts section further up).
router.get("/leagues/:leagueId/teams/:teamId/players/:playerId/pay/checkout", requirePlayerUser, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  if (player.claimedByUserId !== req.session.playerUser.id) return res.status(403).json({ error: "This isn't your record." });
  if (!league.registrationFeeCents) return res.status(400).json({ error: "This league has no registration fee set." });
  if (team.paymentMode !== "split") return res.status(400).json({ error: "This team isn't set to pay per-player." });
  if (player.paymentStatus === "paid") return res.status(400).json({ error: "You're already marked as paid." });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: playerShareCents(league, team) / 100,
    itemName: `${league.name} registration — ${player.name}`.slice(0, 100),
    returnUrl: `${base}/#league/${league.id}`,
    cancelUrl: `${base}/#league/${league.id}`,
    notifyUrl: `${base}/api/payfast/notify`,
    customStr1: league.id,
    customStr2: team.id,
    customStr3: player.id,
  });
  res.json(checkout);
});

// A no-login link for a player who hasn't (or won't) sign up for an
// account — the token is the only thing standing in for auth here, so it's
// random and only ever handed out to someone who's already allowed to see
// it (the captain/admin fetching it below).
router.get("/leagues/:leagueId/teams/:teamId/players/:playerId/pay-link", requireAdminOrCaptain(), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  if (!player.payLinkToken) {
    player.payLinkToken = crypto.randomBytes(16).toString("hex");
    store.saveLeague(league.id, league);
  }
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/#pay-link/${league.id}/${team.id}/${player.id}/${player.payLinkToken}` });
});

// Public read (no session) — the page behind a pay-link needs to show the
// player's name/amount/status before anyone commits to paying.
router.get("/leagues/:leagueId/teams/:teamId/players/:playerId/pay-link/:token", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Link not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player || !player.payLinkToken || player.payLinkToken !== req.params.token) {
    return res.status(404).json({ error: "This payment link is invalid." });
  }
  res.json({
    leagueName: league.name, teamName: team.name, playerName: player.name,
    amountCents: playerShareCents(league, team), paid: player.paymentStatus === "paid",
  });
});

router.get("/leagues/:leagueId/teams/:teamId/players/:playerId/pay-link/:token/checkout", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player || !player.payLinkToken || player.payLinkToken !== req.params.token) {
    return res.status(404).json({ error: "This payment link is invalid." });
  }
  if (!league.registrationFeeCents) return res.status(400).json({ error: "This league has no registration fee set." });
  if (team.paymentMode !== "split") return res.status(400).json({ error: "This team isn't set to pay per-player." });
  if (player.paymentStatus === "paid") return res.status(400).json({ error: "This player is already marked as paid." });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: playerShareCents(league, team) / 100,
    itemName: `${league.name} registration — ${player.name}`.slice(0, 100),
    returnUrl: `${base}/#pay-link/${league.id}/${team.id}/${player.id}/${player.payLinkToken}`,
    cancelUrl: `${base}/#pay-link/${league.id}/${team.id}/${player.id}/${player.payLinkToken}`,
    notifyUrl: `${base}/api/payfast/notify`,
    customStr1: league.id,
    customStr2: team.id,
    customStr3: player.id,
  });
  res.json(checkout);
});

router.put("/leagues/:leagueId/teams/:teamId/players/:playerId/payment-status", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const paid = !!req.body.paid;
  player.paymentStatus = paid ? "paid" : "unpaid";
  player.paymentMethod = paid ? "manual" : null;
  player.paymentRef = paid ? null : player.paymentRef;
  player.paidAt = paid ? Date.now() : null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Every league a signed-in player has a claimed record in, where that
// team is paying per-player and this specific player hasn't paid yet —
// the "what you owe" list shown on My Profile.
router.get("/players/dues", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const dues = [];
  (user.claims || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    if (!league || !league.registrationFeeCents) return;
    const { team, player } = findTeamAndPlayer(league, c.teamId, c.playerId);
    if (!team || !player || team.paymentMode !== "split" || player.paymentStatus === "paid") return;
    dues.push({
      leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name,
      playerId: player.id, playerName: player.name, amountCents: playerShareCents(league, team),
    });
  });
  res.json(dues);
});

// PayFast calls this directly — never a browser, no session, and the body
// is application/x-www-form-urlencoded (not JSON), hence the dedicated
// raw-body middleware just on this one route.
router.post("/payfast/notify", express.raw({ type: "application/x-www-form-urlencoded" }), async (req, res) => {
  const rawBody = req.body;
  res.status(200).end(); // PayFast only needs a 200 — everything else happens after
  try {
    const fields = payfast.parseItnBody(rawBody);
    if (!payfast.verifySignature(fields)) return console.error("PayFast ITN: signature mismatch", fields);
    const validated = await payfast.validateWithPayfast(rawBody.toString("utf8"));
    if (!validated) return console.error("PayFast ITN: failed server-to-server validation", fields);
    if (fields.payment_status !== "COMPLETE") return; // PENDING/FAILED etc. — nothing to record yet
    const leagueId = fields.custom_str1, teamId = fields.custom_str2, playerId = fields.custom_str3 || null;
    const league = store.getLeague(leagueId);
    const team = league && league.teams.find((t) => t.id === teamId);
    if (!league || !team) return console.error("PayFast ITN: unknown league/team", leagueId, teamId);
    const paidRands = Number(fields.amount_gross);
    if (playerId) {
      const player = team.players.find((p) => p.id === playerId);
      if (!player) return console.error("PayFast ITN: unknown player", playerId);
      const expectedRands = playerShareCents(league, team) / 100;
      if (Math.abs(paidRands - expectedRands) > 0.01) {
        return console.error(`PayFast ITN: amount mismatch for player ${playerId} — expected ${expectedRands}, got ${paidRands}`);
      }
      player.paymentStatus = "paid";
      player.paymentMethod = "payfast";
      player.paymentRef = fields.pf_payment_id || null;
      player.paidAt = Date.now();
    } else {
      const expectedRands = (league.registrationFeeCents || 0) / 100;
      if (Math.abs(paidRands - expectedRands) > 0.01) {
        return console.error(`PayFast ITN: amount mismatch for team ${teamId} — expected ${expectedRands}, got ${paidRands}`);
      }
      team.paymentStatus = "paid";
      team.paymentMethod = "payfast";
      team.paymentRef = fields.pf_payment_id || null;
      team.paidAt = Date.now();
    }
    store.saveLeague(league.id, league);
  } catch (e) {
    console.error("PayFast ITN handling failed:", e.message);
  }
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

// Unlike the route above (which only ever sets type for a brand-new
// admin-added round), this retroactively flips whether an EXISTING round —
// including one from the auto-generated round robin — counts toward the
// table. For a round with no roundMeta entry yet (the normal case for an
// auto-generated round), this creates one; existing label is preserved.
router.put("/leagues/:leagueId/rounds/:round/table-count", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const round = Number(req.params.round);
  if (!Number.isInteger(round) || round < 1) return res.status(400).json({ error: "Invalid round." });
  if (!league.fixtures.some((f) => f.round === round && f.stage === "regular")) {
    return res.status(404).json({ error: "That round doesn't exist." });
  }
  const counts = !!req.body.counts;
  if (!league.roundMeta) league.roundMeta = {};
  const existing = league.roundMeta[round];
  league.roundMeta[round] = { label: (existing && existing.label) || "Round " + round, type: counts ? "table" : "knockout" };
  store.saveLeague(league.id, league);
  res.json({ ok: true });
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
  // Toss is turned off — a fixture that already has a decided firstSide
  // from before (the feature was briefly reachable through the admin Toss
  // tab) no longer blocks submission order on it.

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
  logAudit(league, req, f, "selection_unlock", { side });
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
  logAudit(league, req, f, "selection_unlock", { side: by, approvedByOpponent: true });
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

  // Flat list of every player who came in as a substitute on THIS side's
  // line-up tonight — the client uses it to show a sub's name in a
  // different colour wherever this selection gets rendered, without
  // needing to reconstruct who-replaced-whom from the audit log.
  if (!sel.subs) sel.subs = [];
  if (!sel.subs.includes(incomingId)) sel.subs.push(incomingId);

  const outName = (team.players.find((p) => p.id === outPlayerId) || {}).name || "A player";
  const inName = (team.players.find((p) => p.id === incomingId) || {}).name || "Substitute";
  const label = fixtureLabel(league, f);
  const oppTeamId = side === "A" ? f.teamB : f.teamA;
  notify(league, oppTeamId, "selection", `${team.name} made a substitution for ${label}: ${inName} is in for ${outName}.`);
  logAudit(league, req, f, "substitute", { side, seedIdx: idx, teamName: team.name, outName, inName });

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

  const before = { sets: f.rubbers[idx].sets, tb: f.rubbers[idx].tb };
  if (req.body.sets) f.rubbers[idx].sets = req.body.sets;
  if (req.body.tb) f.rubbers[idx].tb = req.body.tb;
  const after = { sets: f.rubbers[idx].sets, tb: f.rubbers[idx].tb };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    logAudit(league, req, f, "score_edit", { seedIdx: idx, before, after, wasFinalized: f.finalized });
  }
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
  logAudit(league, req, f, "finalize", {});
  syncPlayoffs(league);

  // Once every regular-round fixture for this round is in, Pair of the Week
  // voting for that week becomes meaningful — let every captain know, once,
  // per round. `roundComplete` also goes back in the response itself, not
  // just as a notification, so whoever just finalized the last fixture gets
  // an immediate on-screen prompt to go vote rather than relying on them to
  // notice the notification bell.
  let roundComplete = false;
  if (f.stage === "regular" && league.format !== "pairs") {
    const roundFixtures = league.fixtures.filter((x) => x.round === f.round);
    roundComplete = roundFixtures.length > 0 && roundFixtures.every((x) => x.finalized);
    if (roundComplete) {
      if (!league.potwNotified) league.potwNotified = {};
      if (!league.potwNotified[f.round]) {
        league.potwNotified[f.round] = true;
        league.teams.forEach((t) => {
          notify(league, t.id, "potw", "Results are in for Round " + f.round + " — vote now for Pair of the Week on the Awards page!", { round: f.round });
        });
      }
      // Auto round wrap-up in News Room — big wins, close matches, any
      // team that had a rough night. Only notify on the post's first
      // appearance, not every time a later POTW vote refreshes it.
      if (postOrUpdateRoundRecap(league, f.round)) {
        league.teams.forEach((t) => {
          notify(league, t.id, "news", "Round " + f.round + " wrap-up is posted in News Room.", { round: f.round });
        });
      }
    }
  }

  store.saveLeague(league.id, league);
  res.json({ ok: true, roundComplete, round: f.round });
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
  const eligible = logic.potwEligiblePairs(league, round);
  if (!eligible.some((p) => p.key === pairKey)) return res.status(400).json({ error: "That pair didn't play this round." });
  if (!league.potwVotes) league.potwVotes = {};
  if (!league.potwVotes[round]) league.potwVotes[round] = {};
  league.potwVotes[round][voterKey] = pairKey;
  // The round's auto wrap-up almost never has a Pair of the Week winner
  // yet at the moment it's first posted (voting only just opened) — a
  // vote landing is exactly when that section becomes worth adding, so
  // refresh the existing post rather than waiting for someone to notice.
  postOrUpdateRoundRecap(league, round);
  store.saveLeague(league.id, league);
  res.json({ ok: true, tally: logic.potwTallyForRound(league, round) });
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
  logAudit(league, req, f, "unlock", {});
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.get("/leagues/:leagueId/audit-log", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const round = req.query.round ? Number(req.query.round) : null;
  let entries = league.auditLog || [];
  if (round) entries = entries.filter((e) => e.round === round);
  entries = entries.slice().sort((a, b) => b.ts - a.ts).slice(0, 300);
  res.json({ entries });
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
  res.json(sortNewsPosts(league.news || []));
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
// Read-only, same as Stats/Table — no login needed to see the leaderboard.
router.get("/leagues/:leagueId/rankings", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ rankings: logic.leagueRankings(league, ratingsData, identityOf) });
});
// Admin-only preview of what ratings/predictions could look like for this
// league — the backend runs regardless of whether RATINGS_ENABLED shows
// any of it to everyone else, so this is a way for an admin to see the
// real thing without turning it on for players yet. Four self-contained
// pieces, each built from data the engine already computes — nothing new
// is stored to produce any of them.
router.get("/leagues/:leagueId/admin/ratings-preview", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  const rankings = logic.leagueRankings(league, ratingsData, identityOf);

  // 1. Tale of the tape — the soonest seed with both line-ups in and no
  // result yet.
  const matchup = buildNextMatchesPairings([league], ratingsData, identityOf).find((m) => m.prediction) || null;

  // 2. Season trend — the #1 ranked player's rating after each finalized
  // match, reconstructed by walking their own already-stored per-match
  // deltas forward from the base rating (no separate history is kept).
  let trend = null;
  if (rankings.length) {
    const top = rankings[0];
    const rows = logic.playerMatchHistory(league, top.playerId, ratingsData).filter((r) => r.ratingDelta != null);
    let running = logic.ELO_BASE;
    const points = [running];
    rows.forEach((r) => { running += r.ratingDelta; points.push(running); });
    trend = { playerName: top.playerName, teamName: top.teamName, points, current: top.rating };
  }

  // 3. Leaderboard with movement — top 5, each with the delta from their
  // own most recent result.
  const leaderboard = rankings.slice(0, 5).map((r) => ({
    playerName: r.playerName, teamName: r.teamName, rating: r.rating, lastDelta: r.lastDelta, provisional: r.provisional,
  }));

  // 4. Recap — the most recent decided seeds, with a *retroactive*
  // prediction: each player's rating going INTO that specific match is
  // already on record (deltas' ratingBefore), so "what the model would
  // have said beforehand" costs nothing new to compute after the fact.
  const recapAll = [];
  logic.allRatableFixtures([league]).forEach(({ f }) => {
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    if (!teamA || !teamB) return;
    (f.selectionA.pairs || []).forEach((pairA, i) => {
      const pairB = (f.selectionB.pairs || [])[i];
      if (!pairA || !pairB || pairA.some((x) => !x) || pairB.some((x) => !x)) return;
      const rubber = f.rubbers[i];
      const winner = rubber && logic.rubberWinner(rubber);
      if (!winner) return; // keeps the recap's "did the favorite win" framing simple — no draws
      const parts = [pairA[0], pairA[1], pairB[0], pairB[1]].map((id) => ratingsData.deltas.get(`${f.id}:${i}:${id}`));
      if (parts.some((x) => !x)) return;
      const ratingA = (parts[0].ratingBefore + parts[1].ratingBefore) / 2;
      const ratingB = (parts[2].ratingBefore + parts[3].ratingBefore) / 2;
      const winPctA = Math.round(logic.expectedScore(ratingA, ratingB) * 100);
      const favoriteSide = winPctA >= 50 ? "A" : "B";
      recapAll.push({
        pairA: pairA.map((id) => (teamA.players.find((p) => p.id === id) || {}).name).filter(Boolean),
        pairB: pairB.map((id) => (teamB.players.find((p) => p.id === id) || {}).name).filter(Boolean),
        winPct: favoriteSide === "A" ? winPctA : 100 - winPctA,
        favoriteSide, hit: favoriteSide === winner,
      });
    });
  });
  const recap = recapAll.slice(-4).reverse();

  res.json({ matchup, trend, leaderboard, recap });
});
// Fully self-contained — every field the player-history modal needs to
// render, computed server-side, so the client never has to have this
// league's full object loaded to show it (that's what makes the "Also
// plays in" tabs able to switch leagues without navigating away: each
// tab is just another call to this same route with a different
// leagueId/playerId, re-rendered from scratch).
router.get("/leagues/:leagueId/players/:playerId/history", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const team = league.teams.find((t) => t.players.some((p) => p.id === req.params.playerId));
  const player = team && team.players.find((p) => p.id === req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const { ratingsData } = loadGlobalRatings();
  const rows = logic.playerMatchHistory(league, req.params.playerId, ratingsData);
  const rounds = [...new Set(league.fixtures.map((f) => f.round))];
  const potwWins = rounds
    .flatMap((r) => logic.potwTallyForRound(league, r).winners)
    .filter((w) => w.playerAId === player.id || w.playerBId === player.id).length;
  // Hall of Fame winners are free text (season history can predate this
  // app's own data), so matching is just "does their name appear in the
  // winner string" — a plain substring check, not tied to any player id.
  const hallOfFameTitles = (league.hallOfFame || [])
    .filter((e) => e.winner.toLowerCase().includes(player.name.toLowerCase()))
    .sort((a, b) => b.season - a.season)
    .map((e) => ({ season: e.season, label: e.label }));
  // If this player record has been claimed (see the player-accounts
  // feature), surface which other leagues that same real person plays
  // in — so a captain/admin browsing one league's roster can see this
  // isn't the only team this player is on, and can switch straight to
  // that league's record for the same player without leaving the modal.
  let otherLeagues = [];
  if (player.claimedByUserId) {
    const user = store.getUser(player.claimedByUserId);
    if (user) {
      // Same rule as everywhere else: a hidden league (data-only, feeds
      // ratings but isn't a real league to browse) never surfaces as a tab
      // here either.
      const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
      otherLeagues = user.claims
        .filter((c) => c.leagueId !== league.id && !hiddenLeagueIds.has(c.leagueId))
        .map((c) => {
          const otherLeague = store.getLeague(c.leagueId);
          const otherTeam = otherLeague && otherLeague.teams.find((t) => t.id === c.teamId);
          const otherPlayer = otherTeam && otherTeam.players.find((p) => p.id === c.playerId);
          if (!otherLeague || !otherTeam || !otherPlayer) return null;
          return { leagueId: otherLeague.id, leagueName: otherLeague.name, teamName: otherTeam.name, playerId: otherPlayer.id, playerName: otherPlayer.name };
        })
        .filter(Boolean);
    }
  }
  const isAdmin = isAdminSession(req, league.id);
  const u = req.session.user;
  const isCaptain = u && u.leagueId === league.id && u.role === "captain" && u.teamId === team.id;
  let isOwnProfile = false;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    isOwnProfile = !!(account && (account.claims || []).some((c) => c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
  }
  res.json({
    leagueId: league.id,
    leagueName: league.name,
    teamId: team.id,
    teamName: team.name,
    playerId: player.id,
    playerName: player.name,
    photo: player.photo || "",
    isPairs: league.format === "pairs",
    rows,
    potwWins,
    hallOfFameTitles,
    otherLeagues,
    claimed: !!player.claimedByUserId,
    canEditPhoto: isAdmin || isCaptain || isOwnProfile,
  });
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

router.backfillRoundRecaps = backfillRoundRecaps;
module.exports = router;
