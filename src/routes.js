const express = require("express");
const crypto = require("crypto");
const store = require("./store");
const james = require("./james");
const logic = require("./logic");
const { hashPassword, verifyPassword, requireAdmin, requireAdminOrCaptain, requireLeagueSession, resolveLeagueSession, isAdminSession, isOwnerSession } = require("./auth");
const { sendMail, isConfigured: mailConfigured, buildNotificationEmail, buildRatingEmail, explainSendFailure } = require("./mailer");
const oauth = require("./oauth");
const accuracy = require("./accuracy");
const testdata = require("./testdata");
const auction = require("./auction");
const { sendPushToSubscriptions, getVapidPublicKey } = require("./push");
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

// A court schedule's date+time is always real-world South African time —
// every league this app runs plays there. Parsing "2026-09-11T18:30:00"
// with no offset makes Node read it in *this process's own* timezone,
// which on most hosts (confirmed on the one this app actually runs on) is
// UTC, not SAST — silently shifting every kickoff two hours later than
// what was actually typed in. South Africa doesn't observe DST, so a
// fixed +02:00 is correct year-round; the client-side equivalent
// (isWithinLiveWindow in app.js) needs no such fix since it parses in the
// viewer's own browser, which for a real South African user already is
// SAST.
function kickoffMsOf(date, time) {
  if (!date || !time) return null;
  const ms = new Date(date + "T" + time + ":00+02:00").getTime();
  return Number.isNaN(ms) ? null : ms;
}

// How many gold-tier players may also play a league's first silver seed.
function goldInSilverMax(league) {
  const n = Number(league.goldInFirstSilverSeed);
  return Number.isInteger(n) ? Math.max(0, Math.min(2, n)) : 0;
}
function newLeagueObj(name, adminEmail, format, singlesDecider) {
  return {
    id: logic.uid(),
    name,
    // "teams" (the original format: rosters of many players, a weekly
    // blind pair-selection, 4 sub-matches a night) or "pairs" (a Vibora
    // League: each entrant is a fixed 2-player pair, one match a night, no
    // weekly selection at all since the pair already is the line-up).
    format: format === "pairs" ? "pairs" : "teams",
    // "Ormonde rules": a team-format-only opt-in adding a 5th, always-played
    // singles rubber to every night alongside the usual 4 pairs rubbers —
    // pairs rubbers are worth 2 points each, the singles rubber 1 (see
    // computeStandings). Never available on a Vibora (pairs) league, which
    // has no seeded rubbers to add a 5th to.
    singlesDecider: format === "pairs" ? false : !!singlesDecider,
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
    goldInFirstSilverSeed: 0, // how many gold players may also play the first silver seed (Balwin rules: 1)
    goldMatchCount: 0, // how many of the 4 seeds are gold-eligible once enabled — independent of goldTierCount: a team can have 3 gold players but still only 2 gold-flagged matches to fit them into
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
// Everyone who should get a team's notifications by email: the address the
// team itself registered (if any) plus the account email of every signed-up
// captain of that team — so a captain hears about their team without having
// to type an address in anywhere — minus anyone who switched emails off in
// My Profile. Lowercased and de-duplicated so nobody gets it twice.
function emailRecipientsForTeam(league, team) {
  const out = new Map();
  const optedOut = new Set();
  const add = (addr) => { const a = String(addr || "").trim(); if (a.includes("@")) out.set(a.toLowerCase(), a); };
  add(team.notifyEmail);
  store.getUsersIndex().forEach(({ id }) => {
    const user = store.getUser(id);
    if (!user || !user.email) return;
    // The off switch covers the address itself, not just the account
    // route — signing in as captain also files the account email as the
    // team's notifyEmail, and that must stop too.
    if (user.emailNotifications === false) { optedOut.add(user.email.trim().toLowerCase()); return; }
    if ((user.captaincies || []).some((c) => c.leagueId === league.id && c.teamId === team.id)) add(user.email);
  });
  return [...out.entries()].filter(([key]) => !optedOut.has(key)).map(([, addr]) => addr);
}
// Fire-and-forget, deferred a tick so looking up recipients never slows the
// request that triggered the notification, and a mail failure can never
// break it.
function emailTeamNotification(league, team, type, message) {
  setImmediate(() => {
    try {
      const to = emailRecipientsForTeam(league, team);
      if (!to.length) return;
      const mail = buildNotificationEmail({ leagueName: league.name, leagueId: league.id, type, message, teamName: team.name });
      to.forEach((addr) => sendMail({ to: addr, ...mail }).catch(() => {}));
    } catch (e) {
      console.error("Notification email failed:", e.message);
    }
  });
}
// `extra` is optional structured data a notification can carry alongside
// its message — e.g. { round } so the frontend can jump straight to the
// relevant page on click instead of the reader having to go find it.
function notify(league, teamId, type, message, extra) {
  if (!league.notifications) league.notifications = [];
  league.notifications.push({ id: logic.uid(), teamId, type, message, read: false, createdAt: Date.now(), ...extra });
  const team = league.teams.find((t) => t.id === teamId);
  if (team) emailTeamNotification(league, team, type, message);
  // Fire-and-forget, same as the email above — every existing call site
  // (selection reveal, substitution, round complete, timeslot proposals,
  // lineup reminders, ...) starts reaching a subscribed device for free,
  // with no new trigger logic anywhere. A dead/expired subscription (the
  // browser unsubscribed on its own end) is pruned from this same team
  // object and re-saved once the send settles — consistent with how the
  // rest of this app has no stronger write-concurrency guarantee than that.
  if (team && team.pushSubscriptions && team.pushSubscriptions.length) {
    sendPushToSubscriptions(team.pushSubscriptions, { title: league.name, body: message, type, ...extra }).then(({ deadEndpoints }) => {
      if (!deadEndpoints.length) return;
      team.pushSubscriptions = team.pushSubscriptions.filter((s) => !deadEndpoints.includes(s.endpoint));
      store.saveLeague(league.id, league);
    });
  }
}

// Who's making this change, for the audit log below — resolved the same
// way isAdminSession does, just rendered as a readable label instead of
// a boolean.
function auditActor(req, league) {
  if (isOwnerSession(req)) return "Owner";
  const u = resolveLeagueSession(req, league.id);
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
// Same idea as postOrUpdateRoundRecap, for a semi-final or final instead of
// a regular round — see logic.buildPlayoffRecap for why it needs its own
// builder. Keyed by stageKey ("semis"/"final") in the same `round` field a
// regular recap keys by round number; a string can never collide with a
// real round number, so both kinds of post share one lookup with no extra
// field needed.
function postOrUpdatePlayoffRecap(league, stageKey) {
  const recap = logic.buildPlayoffRecap(league, stageKey);
  if (!recap) return false;
  if (!league.news) league.news = [];
  const existing = league.news.find((p) => p.auto && p.round === stageKey);
  const fields = { title: recap.title, body: recap.body, potw: recap.potw, highlights: recap.highlights, inForm: recap.inForm };
  if (existing) {
    Object.assign(existing, fields);
    return false;
  }
  league.news.push({ id: logic.uid(), createdAt: Date.now(), auto: true, round: stageKey, ...fields });
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
// The only genuinely time-triggered notification in the app — everything
// else notify() sends fires off some action a captain/admin just took;
// this one fires because a kickoff is approaching whether or not anyone's
// looking. Run periodically (see server.js), not computed on request,
// since the whole point is a captain who ISN'T in the app right now still
// gets pinged (in-league notification + email, same as any other
// notify() call). Fires once per side per fixture — f.lineupReminders.A/B
// is the same once-only guard league.potwNotified uses for the round-
// complete notification — the first check that lands inside the window
// sends it; if the server was down for the whole window, it still fires
// (late) next time it comes back up rather than never firing.
const LINEUP_REMINDER_WINDOW_MS = 36 * 60 * 60 * 1000;
function checkLineupReminders() {
  const now = Date.now();
  store.getIndex().forEach((entry) => {
    if (entry.hidden) return;
    const league = store.getLeague(entry.id);
    // Pairs leagues have no line-up step at all — a pair IS the entry, so
    // there's nothing here for a "captain" to submit.
    if (!league || league.format === "pairs" || leagueStatus(league) !== "active") return;
    let changed = false;
    logic.allFixturesOf(league).forEach((f) => {
      if (f.finalized || !f.teamA || !f.teamB) return;
      // A future round's fixtures exist from the season's first day, but
      // nobody can submit a line-up for one that hasn't opened yet (still
      // waiting on the previous round, or its date-based lead time) — skip
      // it here too, same reasoning as /players/lineups-due below.
      if (!isRoundOpen(league, f)) return;
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      if (!sched.date) return; // nothing scheduled yet — no kickoff to count down to
      const kickoffMs = kickoffMsOf(sched.date, sched.time || "00:00");
      if (kickoffMs === null || kickoffMs - now > LINEUP_REMINDER_WINDOW_MS) return;
      if (!f.lineupReminders) f.lineupReminders = {};
      const teamA = league.teams.find((t) => t.id === f.teamA);
      const teamB = league.teams.find((t) => t.id === f.teamB);
      const when = sched.date + (sched.time ? " at " + sched.time : "");
      const label = fixtureLabel(league, f);
      [
        { side: "A", sel: f.selectionA, teamId: f.teamA, oppName: teamB ? teamB.name : "your opponent" },
        { side: "B", sel: f.selectionB, teamId: f.teamB, oppName: teamA ? teamA.name : "your opponent" },
      ].forEach(({ side, sel, teamId, oppName }) => {
        if (sel.submitted || f.lineupReminders[side]) return;
        notify(league, teamId, "lineup_reminder", `Line-up due — submit your line-up for ${label} vs ${oppName} before kickoff (${when}).`, { round: f.round, fixtureId: f.id });
        f.lineupReminders[side] = true;
        changed = true;
      });
    });
    if (changed) store.saveLeague(league.id, league);
  });
}

function backfillRoundRecaps() {
  store.getIndex().forEach((entry) => {
    if (entry.hidden) return;
    const league = store.getLeague(entry.id);
    if (!league || !league.fixtures) return;
    const rounds = [...new Set(league.fixtures.filter((f) => f.stage === "regular").map((f) => f.round))];
    rounds.forEach((round) => postOrUpdateRoundRecap(league, round));
    // Same catch-up, for whichever playoff stages are already finalized —
    // covers a league whose semis/final finished before this stage got
    // its own recap builder (see postOrUpdatePlayoffRecap).
    if (league.playoffs) {
      postOrUpdatePlayoffRecap(league, "semis");
      postOrUpdatePlayoffRecap(league, "final");
    }
    if (rounds.length || league.playoffs) store.saveLeague(league.id, league);
  });
}
// News Room order: round-based posts read newest-round-first, same as the
// season itself unfolds — sorting by createdAt alone breaks this the moment
// a round gets backfilled (every round caught up in the same boot lands
// within the same millisecond or two, so raw timestamp order stops meaning
// anything). A post with no round (a free-standing admin announcement)
// always sorts above every round post, on the assumption it's about
// something current, not a historical result.
// A post's own uploaded photo wins; failing that, the league's court photo
// stands in — the one real photo we always have for a league, and how an
// existing round-recap post (which has no upload UI of its own) gets a
// photo at all. Computed at response time, never written back to the post.
function newsPostPhoto(post, league) {
  return post.photo || (league && league.courtPhoto) || "";
}
// An auto round-recap's own title/body is the whole multi-paragraph
// wrap-up — fine for the News Room, way too much text for a hero card.
// This reduces it to one headline: the most notable highlight's short
// line (the same text "Interesting this week" already uses), or just the
// round label if the round was quiet. A manual admin post is already
// short (they wrote it themselves), so it's used as-is.
function newsPostHeadline(post) {
  if (!post.auto) return { headline: post.title || "", body: post.body || "" };
  const usable = (post.highlights || []).find((h) => h.type !== "quiet" && (h.short || h.text));
  if (!usable) return { headline: post.title || `Round ${post.round} wrap-up`, body: "" };
  // `.text` reads as a real sentence ("X (Team) 6-0 beat Y.") for every
  // type except "table", where it's just a bare team name — `.short`
  // ("X — top of the table") is the only one of the two that reads as
  // one there. When a round had several of the same highlight, `.text`
  // joins each into its own sentence — only the first is used here, so
  // the hero states one thing plainly instead of running them all on.
  if (usable.type === "table") return { headline: usable.short || usable.text, body: "" };
  const full = usable.text || usable.short;
  const cut = full.indexOf(". ");
  return { headline: cut === -1 ? full : full.slice(0, cut + 1), body: "" };
}
// A regular round's post carries a real round number; a playoff post
// carries "semis"/"final" instead (see postOrUpdatePlayoffRecap) — neither
// is a number, so `b.round - a.round` would silently NaN out the moment
// one side is a playoff post. This maps both kinds onto one ordering:
// playoffs always come after every regular round (the final after the
// semis after however many rounds the season had), same "later in the
// season sorts first" idea sortNewsPosts already applies.
function newsRoundRank(round) {
  if (typeof round === "number") return round;
  if (round === "semis") return 1e6;
  if (round === "final") return 1e6 + 1;
  return null;
}
function sortNewsPosts(posts) {
  return posts.slice().sort((a, b) => {
    // An admin's pin beats everything below — the whole point of pinning
    // a post is not having to out-rank the auto sort by round or recency.
    if (a.pinnedAt && !b.pinnedAt) return -1;
    if (b.pinnedAt && !a.pinnedAt) return 1;
    // Round-based ordering only makes sense between two posts that both
    // actually belong to a round — a manually-typed admin post has none.
    // Treating a missing round as an implicit "higher than any real round"
    // (the old behavior, via `?? Infinity`) pinned that post above every
    // round's recap forever, no matter how old it actually was. Anything
    // without a round on either side just compares by when it was posted.
    const ra = newsRoundRank(a.round), rb = newsRoundRank(b.round);
    if (ra != null && rb != null && ra !== rb) return rb - ra;
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
// Two different reasons a league is kept off public browsing (the Leagues
// list, cross-league homepage teasers, the "Join a league" dropdown) —
// both filtered out here identically, but NOT everywhere else in this
// file, on purpose:
// - hidden: import-only. Historical/external data brought in purely to
//   feed the ratings engine, never a real league to browse, claim into,
//   or show on anyone's account. Every hidden-league check outside this
//   function only tests `entry.hidden` for exactly that reason.
// - incognito: a real, actively-run league (real captains, real players,
//   real fixtures) that the admin has just chosen to keep off public
//   discovery — e.g. a second city's leagues not ready to advertise
//   site-wide yet. Unlike hidden, an incognito league still needs to work
//   completely normally for anyone who actually reaches it: search
//   (allPlayersFlat), a claimed player's own profile/tonight-matches/news,
//   and a captain's own session-scoped view. Those call sites deliberately
//   do NOT go through this function.
function visibleIndexEntries() {
  return store.getIndex().filter((entry) => !entry.hidden && !entry.incognito);
}
function genTeamCode(league) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (codeInUse(code));
  return code;
}

// A freshly-defaulted kit — every field empty until a captain uploads
// something. Positions are percent coordinates (0-100) relative to
// whichever photo they sit on, pre-seeded to sensible starting spots so a
// badge appears somewhere reasonable the moment its logo is uploaded,
// ready to be dragged onto the exact spot for that specific photo. A
// front-of-kit photo faces the camera, so it's mirrored left-right versus
// the person wearing it — "left chest" (the wearer's true left) sits on
// the *right* side of the photo, which is why the team logo's default x
// (70) looks screen-right even though it's the garment's left chest; the
// league's secondary sponsor (screen-left, x:30) is the wearer's right
// chest for the same reason. The league's own badges — the main sponsor
// (front-centre) and the Team Padel logo (top-centre, under the neck) —
// aren't part of a team's kit at all; see kitMainSponsor*/
// kitSecondarySponsor*/kitTeamPadelLogoPos on the league itself,
// admin-controlled and shared by every team.
function defaultKit() {
  return {
    front: "", back: "", logo: "",
    positions: {
      logo: { x: 70, y: 22 },
      sleeveLeft: { x: 10, y: 34 },
      sleeveRight: { x: 90, y: 34 },
      backSponsor1: { x: 50, y: 48 },
      backSponsor2: { x: 50, y: 66 },
      backSponsor3: { x: 50, y: 84 },
    },
    sponsors: { sleeveLeft: "", sleeveRight: "", backSponsor1: "", backSponsor2: "", backSponsor3: "" },
    orders: [], // [{ id, name, size }] — who wants a kit and what size
    notes: "", // free text for the kit supplier — fabric, fit, deadline, whatever doesn't fit a badge or a size
  };
}
// A kit photo field is dual-shaped, for backward compatibility with every
// kit photo saved before this split existed — a non-empty STRING is the
// old format (the actual photo, still sitting inline in this league's own
// record exactly as it always has, until whoever owns it re-uploads);
// `true` is the new format, meaning the real bytes live in their own
// Redis key instead (store.saveKitPhoto/getKitPhoto). Reading either shape
// transparently means nothing needs a one-time migration pass against
// production data this app has no direct access to.
function resolveKitPhotoField(leagueId, teamId, raw, field) {
  if (typeof raw === "string" && raw) return Promise.resolve(raw); // old inline format
  if (!raw) return Promise.resolve("");
  return store.getKitPhoto(leagueId, teamId, field); // new format
}
// The kit's own logo badge defaults to the team's real logo — a captain
// who's already uploaded one for the league card/next-matches/etc. never
// had a reason to expect their kit mockup to still be blank. Computed at
// read time (never written back), so it also stays in sync if the team's
// logo changes later, and an explicit kit-logo upload still overrides it.
// null (as opposed to "", which just means "never touched") means a
// captain deliberately removed it — that one case does NOT fall back, or
// the remove button would look broken (the badge just reappearing) — see
// resolvedKit below, which applies that fallback once the raw logo field
// (string, true, or null) has been resolved to actual bytes or null.
// Full kit, real photo bytes resolved — for the Kit Designer's own lazy
// fetch (GET .../kit/full) and the kit-share supplier link, the two
// places that actually need the pixels. Everywhere else (the general
// team payload) uses kitSummary below instead, so opening an unrelated
// page never pays for every team's kit photos riding along unasked.
async function resolvedKit(league, team) {
  const kit = team.kit || defaultKit();
  const sponsors = kit.sponsors || {};
  const [front, back, rawLogo, sleeveLeft, sleeveRight, backSponsor1, backSponsor2, backSponsor3] = await Promise.all([
    resolveKitPhotoField(league.id, team.id, kit.front, "front"),
    resolveKitPhotoField(league.id, team.id, kit.back, "back"),
    kit.logo === null ? Promise.resolve(null) : resolveKitPhotoField(league.id, team.id, kit.logo, "logo"),
    resolveKitPhotoField(league.id, team.id, sponsors.sleeveLeft, "sleeveLeft"),
    resolveKitPhotoField(league.id, team.id, sponsors.sleeveRight, "sleeveRight"),
    resolveKitPhotoField(league.id, team.id, sponsors.backSponsor1, "backSponsor1"),
    resolveKitPhotoField(league.id, team.id, sponsors.backSponsor2, "backSponsor2"),
    resolveKitPhotoField(league.id, team.id, sponsors.backSponsor3, "backSponsor3"),
  ]);
  return {
    ...kit,
    front, back,
    logo: rawLogo === null ? "" : (rawLogo || team.logo || ""),
    sponsors: { sleeveLeft, sleeveRight, backSponsor1, backSponsor2, backSponsor3 },
  };
}
// Lightweight kit info for the general per-team payload — presence flags
// and the small non-photo fields (positions/orders/notes), never the
// actual photo bytes. A page that isn't the Kit Designer (fixtures,
// standings, anything) has no reason to pay for every team's kit photos
// riding along on every load — that was the whole reason this league's
// record kept growing toward Upstash's 10MB per-request limit.
function kitSummary(team) {
  const kit = team.kit || defaultKit();
  const sponsors = kit.sponsors || {};
  const has = (raw) => !!raw; // truthy for both the old (non-empty string) and new (true) shapes
  return {
    hasFront: has(kit.front), hasBack: has(kit.back),
    logoState: kit.logo === null ? "removed" : (has(kit.logo) ? "custom" : "unset"),
    sponsors: {
      sleeveLeft: has(sponsors.sleeveLeft), sleeveRight: has(sponsors.sleeveRight),
      backSponsor1: has(sponsors.backSponsor1), backSponsor2: has(sponsors.backSponsor2), backSponsor3: has(sponsors.backSponsor3),
    },
    positions: kit.positions,
    orders: kit.orders,
    notes: kit.notes,
    setup: kit.setup || null,
  };
}
// Whether a team's captain still has the kit to set up: no recorded finish, and
// nothing in the kit yet if they never started the guided steps. Mirrors
// kitSetupState on the client.
function kitNeedsSetup(team) {
  const kit = team.kit;
  if (kit && kit.setup) return !kit.setup.done;
  if (!kit) return true;
  const sp = kit.sponsors || {};
  const hasContent = !!(kit.front || kit.back || (kit.notes || "").trim() || (kit.orders && kit.orders.length)
    || sp.sleeveLeft || sp.sleeveRight || sp.backSponsor1 || sp.backSponsor2 || sp.backSponsor3);
  return !hasContent;
}
// Every photo/logo upload in the app used to land inside its league's own
// single stored record (one JSON blob per league — teams, kit photos, news
// posts, everything), so a big enough image didn't just cost that one
// upload — it made EVERY future read and write of that whole league
// bigger, until a save tripped Upstash's 10MB per-request limit and
// started failing silently (store.saveLeague's Redis write is fire-and-
// forget; nothing here would otherwise know it didn't actually save). Kit
// photos (the main driver — several high-res images per team) now live in
// their own keys (see store.saveKitPhoto) instead. Client-side resize
// already keeps normal uploads well under this, but nothing enforced it
// server-side — this is the backstop for whatever gets here anyway
// (resize skipped, bypassed, or a future upload path that forgets it).
const MAX_IMAGE_DATA_URL_LENGTH = 2_800_000; // ~2MB of actual image data, base64-inflated
function imageTooLarge(res, dataUrl) {
  if (dataUrl && dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    res.status(413).json({ error: "That image is too large — try a smaller photo." });
    return true;
  }
  return false;
}

// Strip anything a given viewer shouldn't see: password hashes always,
// and any not-yet-submitted seed selection that isn't theirs (this is
// the real, server-enforced version of "blind" selection).
// Payment details on a team or player record (see sanitize).
const PAYMENT_FIELDS = ["paymentMode", "paymentStatus", "paymentMethod", "paymentRef", "paidAt", "payLinkToken", "paidCents", "payments", "discountCents", "discountNote", "shareCents", "owedCents", "feeCents", "coveredByTeam", "lumpCents", "overpaidCents", "paidSoFarCents", "balanceCents"];
function sanitize(league, req) {
  const user = resolveLeagueSession(req, league.id);
  const isAdmin = isAdminSession(req, league.id);
  const teamId = user ? user.teamId : null;

  const teams = league.teams.map((t) => {
    const { code, notifyEmail, kit: _kit, pushSubscriptions, payLinkToken: _teamPayToken, ...restAll } = t;
    const viewerIsThisTeam = isAdmin || (teamId && teamId === t.id);
    // Who has paid, how, and when is between the league admin and that
    // team's own captain — not something to hand to anyone who opens the
    // league (the tabs hide it, but the data would still be readable). The
    // pay-link token never ships here at all, for anyone: it's fetched
    // through the dedicated pay-link route only.
    const rest = viewerIsThisTeam ? restAll : Object.fromEntries(Object.entries(restAll).filter(([k]) => !PAYMENT_FIELDS.includes(k)));
    // A pay-link token stands in for auth on its own public route — never
    // ships in the general league payload, only ever handed out via the
    // dedicated pay-link fetch route to someone already allowed to see it.
    // claimRequest names who's contesting a record — only this league's
    // own admin has any business seeing that.
    const players = rest.players.map(({ payLinkToken, claimRequest, ...p }) => {
      const visible = viewerIsThisTeam
        ? (league.registrationFeeCents ? { ...p, shareCents: playerShareCents(league, t, p) } : p)
        : Object.fromEntries(Object.entries(p).filter(([k]) => !PAYMENT_FIELDS.includes(k)));
      return isAdmin ? { ...visible, claimRequest } : visible;
    });
    return {
      ...rest, players,
      // What's been paid toward the team's fee and what's left, whoever paid it
      // (the players or the team); the payment fields above are already stripped
      // for anyone who isn't this team's captain or the admin.
      ...(viewerIsThisTeam && league.registrationFeeCents ? { feeCents: teamFeeCents(league, t), paidSoFarCents: teamPaidCents(league, t), balanceCents: teamBalanceCents(league, t) } : {}),
      code: viewerIsThisTeam ? code : undefined,
      notifyEmail: viewerIsThisTeam ? notifyEmail : undefined,
      // Kit design (photos, sponsor placement, who's ordering) is as
      // private as the team's own login code — nobody outside that team's
      // captain/admin has any reason to see it. Flags only, not the actual
      // photo bytes — the Kit Designer fetches those lazily on its own
      // (GET .../kit/full) only when it's actually opened.
      kit: viewerIsThisTeam ? kitSummary(t) : undefined,
      // A push subscription's endpoint+keys are sensitive in the same way a
      // login code is (anyone holding one could push-spam that device) —
      // never belonged in the general public league payload.
      pushSubscriptions: viewerIsThisTeam ? pushSubscriptions : undefined,
    };
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
  // this viewer's own vote if they're a captain, the admin, or have
  // claimed a player record in this league — raw per-voter ballots never
  // leave here.
  const rounds = [...new Set(league.fixtures.map((f) => f.round))];
  const potwByRound = {};
  rounds.forEach((r) => { potwByRound[r] = logic.potwTallyForRound(league, r); });
  const potwVoterKey = isAdmin ? "admin" : teamId;
  let claimedPlayerPotwKey = null;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    const claim = account && (account.claims || []).find((c) => c.leagueId === league.id);
    if (claim) claimedPlayerPotwKey = `player:${claim.playerId}`;
  }
  const myPotwVote = {};
  rounds.forEach((r) => {
    const votes = league.potwVotes && league.potwVotes[r];
    if (!votes) return;
    const v = (potwVoterKey && votes[potwVoterKey]) || (claimedPlayerPotwKey && votes[claimedPlayerPotwKey]);
    if (v) myPotwVote[r] = v;
  });

  // Past seasons have their own dedicated routes (/season-history) so the
  // main league payload doesn't balloon with every archived fixture/rubber
  // every time anyone just loads the league.
  // kitShareToken is the only thing standing in for auth on the public kit-
  // share page (below) — same reasoning as payLinkToken, never ships in the
  // general league payload, only ever handed out via the dedicated
  // get-link route to an admin who's already allowed to see it.
  // customCharges (each with its own payLinkToken, standing in for auth on
  // its public route) is fetched exclusively through the dedicated
  // admin-gated /custom-charges endpoint below — never through this
  // general payload, same reasoning as kitShareToken/payLinkToken above.
  const { adminPasswordHash, potwVotes, potwNotified, auditLog, seasonHistory, kitShareToken, customCharges, adminNotes: _adminNotes, paymentsBackup: _paymentsBackup, ...leagueRest } = league;
  // Players between teams: their names and photos only — payment details and
  // pay-link tokens are never part of this public payload.
  const freeAgents = (league.freeAgents || []).map(({ payLinkToken, claimRequest, paymentMode, paymentStatus, paymentMethod, paymentRef, paidAt, paidCents, payments, coveredByTeam, overpaidCents, ...p }) => p);
  return { ...leagueRest, freeAgents, teams, fixtures, playoffs, adminRegistered: !!adminPasswordHash, potwByRound, myPotwVote, seasonHistoryCount: (seasonHistory || []).length, kitShareLinkActive: !!kitShareToken };
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
  if (fixture.stage === "semi" || fixture.stage === "position") return true;
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
// The guest sign-up wall (see public/app.js): off unless the owner turns it
// on, either for the Leagues page, for particular leagues, or both. Just
// switches and league ids — nothing private.
function guestWallSettings() {
  const g = store.getSiteSettings().guestWall || {};
  return { hub: !!g.hub, leagues: Array.isArray(g.leagues) ? g.leagues : [] };
}
router.get("/config", (req, res) => {
  res.json({ ratingsEnabled: process.env.RATINGS_ENABLED === "true", payfastSandbox: payfast.config().sandbox, guestWall: guestWallSettings() });
});
// What kind of login this browser holds, so the guest wall never stops
// someone who logged in with a team code (or as admin) but has no account.
router.get("/me/role", (req, res) => {
  res.json({ role: req.session.user ? req.session.user.role : null, owner: !!req.session.isOwner });
});
// ---- The guest wall, enforced on the server ----
// A "guest" holds no login of any kind: no player account, no team-code or
// admin session, not the owner. For a league the owner has walled, a guest
// gets only a small preview (its name and the top three of the table) and
// every other league-scoped request is refused; anyone with a login is
// unaffected. Leagues that aren't switched on behave exactly as before.
function isGuestRequest(req) {
  return !req.session.playerUser && !req.session.user && !req.session.isOwner;
}
function guestWalledFor(req, leagueId) {
  return isGuestRequest(req) && guestWallSettings().leagues.includes(leagueId);
}
function walledPreview(league) {
  const isPairs = league.format === "pairs";
  // A pairs league's rows are people's names (each a link to a profile), so
  // it previews with no rows and just the sign-up card.
  const rows = isPairs ? [] : logic.computeStandings(league).slice(0, 3).map((r) => ({
    id: r.id, name: r.name, logo: r.logo || "", played: r.played, rubbersWon: r.rubbersWon, rubbersLost: r.rubbersLost,
    nightsDrawn: r.nightsDrawn || 0, diff: r.diff, points: r.points,
  }));
  return { walled: true, id: league.id, name: league.name, status: leagueStatus(league), format: league.format || "teams", playoffFormat: league.playoffFormat || "none", teamCount: league.teams.length, preview: { rows }, teams: [], fixtures: [], groups: [], sponsors: [], schedule: {} };
}
// League-scoped paths a guest can still reach on a walled league: branding,
// and the private-link pages (each guarded by its own token) that must keep
// working for someone who was simply sent a link.
const WALL_OPEN_PATHS = [/^\/court-photo$/, /^\/me$/, /^\/kit-share\//, /^\/push\/vapid-public-key$/, /\/pay-link\//, /^\/fixtures\/[^/]+\/toss\/public$/];
router.use("/leagues/:leagueId", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!guestWalledFor(req, req.params.leagueId)) return next();
  if (req.path === "/" || req.path === "") return next(); // the league itself is answered with a preview below
  if (WALL_OPEN_PATHS.some((re) => re.test(req.path))) return next();
  res.status(401).json({ error: "Sign up free to see this.", signupRequired: true });
});
// A short rolling record of the things the owner changes from the Admin tab
// (newest first, capped), shown under Site > Recent admin actions.
function logAdminAction(text) {
  try {
    const settings = store.getSiteSettings();
    settings.adminActions = [{ at: Date.now(), text }, ...(settings.adminActions || [])].slice(0, 40);
    store.saveSiteSettings(settings);
  } catch { /* the log is a convenience, never worth failing the change itself */ }
}
router.put("/admin/guest-wall", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { hub, leagues } = req.body || {};
  const known = new Set(store.getIndex().map((e) => e.id));
  const settings = store.getSiteSettings();
  settings.guestWall = { hub: !!hub, leagues: (Array.isArray(leagues) ? leagues : []).filter((id) => known.has(id)) };
  store.saveSiteSettings(settings);
  logAdminAction("Updated the guest sign-up wall");
  res.json({ ok: true, guestWall: guestWallSettings() });
});

// The in-league "Score not entered yet" banner only reaches a captain once
// they've already clicked into their league — this is the homepage's own
// version of it, gated to a round's actual kickoff time (not just its
// date) so it doesn't show all day before matches even start. A captain
// is logged into exactly one league at a time, so this reads that same
// session the league page already uses; nothing new to log in to.
router.get("/me/pending-score", (req, res) => {
  const u = req.session.user;
  if (!u || u.role !== "captain") return res.json({});
  const league = store.getLeague(u.leagueId);
  if (!league || league.format === "pairs") return res.json({});
  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const candidates = league.fixtures
    .filter((f) => !f.finalized && (f.teamA === u.teamId || f.teamB === u.teamId) && f.selectionA.submitted && f.selectionB.submitted)
    .filter((f) => {
      const sched = (league.schedule && league.schedule["r" + f.round]) || {};
      if (!sched.date) return true; // nothing scheduled to gate against — same permissive fallback the in-league banner uses
      if (sched.date < todayStr) return true; // a past matchday is well past kickoff either way
      if (sched.date > todayStr) return false;
      if (!sched.time) return true;
      return now >= kickoffMsOf(sched.date, sched.time);
    })
    .sort((a, b) => a.round - b.round);
  const f = candidates[0];
  if (!f) return res.json({});
  const myTeam = league.teams.find((t) => t.id === u.teamId);
  const opp = league.teams.find((t) => t.id === (f.teamA === u.teamId ? f.teamB : f.teamA));
  res.json({
    leagueId: league.id, leagueName: league.name, round: f.round, fixtureId: f.id,
    myTeamName: myTeam ? myTeam.name : "Your team", myTeamLogo: myTeam ? myTeam.logo || "" : "",
    opponentName: opp ? opp.name : "TBD", opponentLogo: opp ? opp.logo || "" : "",
  });
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
      // The photo itself is NOT embedded here — with a real court photo on
      // most leagues now, that was ~1.35MB of this single response's ~1.9MB
      // total (confirmed by measuring the real production payload), all
      // downloaded up front on every app boot before a player can so much
      // as open the search tab. Just a flag; the card fetches its own
      // photo lazily, once it actually scrolls into view (see
      // GET /leagues/:leagueId/court-photo and observeLeagueCardPhotos
      // client-side).
      auctionStatus: (league && league.auctionStatus) || null,
      hasCourtPhoto: !!(league && league.courtPhoto),
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
// Lazy counterpart to the courtPhoto flag above — same image the PUT below
// sets, just fetched one league at a time instead of embedded for all of
// them up front. Public/no session, same as the rest of a hub card's own
// content (a league's name, logos, and status are all visible without
// logging in already).
router.get("/leagues/:leagueId/court-photo", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  res.json({ photo: league ? (league.courtPhoto || "") : "" });
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
const RESULTS_MIN_SHOW_MS = 24 * 60 * 60 * 1000;
function buildNextMatchesPairings(leagues, ratingsData, identityOf) {
  // {id, name} rather than a bare name — the client links each one to that
  // player's profile, which needs their id (and, per pairing, which league
  // they belong to — this carousel spans every league at once).
  const playerRef = (team, id) => {
    const p = team && team.players.find((pl) => pl.id === id);
    return p ? { id: p.id, name: p.name } : null;
  };

  // A fixture drops off this card the moment it is finalized, which can be
  // minutes after the last score goes in. So results stay visible for at
  // least RESULTS_MIN_SHOW_MS after finalizing: those "recent" fixtures are
  // shown after the night's open matches, never ahead of them or in place
  // of them. (A fixture finalized before finalizedAt was recorded has no
  // timestamp to count from, so it is not brought back.)
  const nowMs = Date.now();
  const fixtures = [];
  const recentFixtures = [];
  leagues.forEach((league) => {
    logic.allFixturesOf(league).forEach((f) => {
      if (!f.teamA || !f.teamB) return;
      const recent = !!(f.finalized && f.finalizedAt && nowMs - f.finalizedAt < RESULTS_MIN_SHOW_MS);
      if (f.finalized && !recent) return;
      if (!(f.selectionA.submitted && f.selectionB.submitted)) return;
      const teamA = league.teams.find((t) => t.id === f.teamA);
      const teamB = league.teams.find((t) => t.id === f.teamB);
      if (!teamA || !teamB) return;
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      (recent ? recentFixtures : fixtures).push({ league, f, teamA, teamB, sched });
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
  const flatten = (group) => {
  const byLeague = new Map();
  group.forEach(({ league, f, teamA, teamB, sched }) => {
    f.selectionA.pairs.forEach((pairA, i) => {
      const pairB = f.selectionB.pairs[i];
      const refsA = [playerRef(teamA, pairA[0]), playerRef(teamA, pairA[1])].filter(Boolean);
      const refsB = [playerRef(teamB, pairB[0]), playerRef(teamB, pairB[1])].filter(Boolean);
      if (refsA.length !== 2 || refsB.length !== 2) return;
      // A seed can already be decided while the rest of the night's
      // fixture is still open (captains score them one at a time) — once
      // it is, the card shows that result instead of a bare "vs".
      const rubber = f.rubbers[i];
      const winner = rubber ? logic.rubberWinner(rubber) : null;
      // A double forfeit is also already decided (just with no winning
      // side) — don't predict it, and don't leave it looking like a bare
      // "vs" that's still to be played.
      const decided = winner || (rubber && rubber.forfeited);
      const prediction = decided ? null : logic.predictSeed(league, pairA, pairB, ratingsData, identityOf, seedContext(league, f, i));
      if (!byLeague.has(league.id)) byLeague.set(league.id, []);
      byLeague.get(league.id).push({
        leagueId: league.id,
        leagueName: league.name,
        teamAName: teamA.name,
        teamBName: teamB.name,
        teamALogo: teamA.logo || "",
        teamBLogo: teamB.logo || "",
        seed: i + 1,
        pairA: refsA,
        pairB: refsB,
        date: sched.date || "",
        time: sched.time || "",
        venue: sched.venue || league.defaultVenue || "",
        winner,
        score: decided ? logic.rubberScoreText(rubber) : null,
        prediction,
        hasCourtPhoto: !!league.courtPhoto,
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
  };
  return flatten(sameNight).concat(flatten(recentFixtures));
}

// Public, unauthenticated — every visitor pings this (public/app.js), not
// just logged-in ones, since "how many are on the app right now" should
// count guests browsing fixtures/results too, not just accounts.
router.post("/presence/ping", async (req, res) => {
  const visitorId = ((req.body && req.body.visitorId) || "").slice(0, 100);
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(visitorId)) return res.status(400).json({ error: "Invalid visitor id." });
  await store.touchPresence(visitorId, req.session.playerUser && req.session.playerUser.id);
  res.json({ ok: true });
});
router.get("/admin/live-count", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  res.json({ count: await store.getLiveVisitorCount() });
});
// Every account that's actually used the app today — a wider, calmer
// companion to "On the app right now" above (which only ever shows this
// exact moment). See store.markSeenToday: stamped once per account per
// day off the same presence ping, not a separate tracking mechanism.
router.get("/admin/logins-today", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const rows = store.getUsersLoggedInOn(store.todayStr()).map((u) => ({ id: u.id, name: u.name, email: u.email, lastSeenAt: u.lastSeenAt }));
  res.json(rows);
});

router.get("/next-matches", (req, res) => {
  const myLeagueId = req.session.user && req.session.user.leagueId;
  const index = visibleIndexEntries();
  const hubWalled = isGuestRequest(req) && guestWallSettings().hub;
  const allLeagues = index
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && leagueStatus(l) === "active" && l.format !== "pairs" && !hubWalled && !guestWalledFor(req, l.id));
  const { ratingsData, identityOf } = loadGlobalRatings();

  if (myLeagueId) {
    // Looked up directly, not from allLeagues — a captain/admin session
    // is already scoped to this one specific league, which is real,
    // already-granted access independent of whether it's off public
    // browsing (hidden or incognito — see visibleIndexEntries). Its own
    // captain should still see their own next match here either way.
    const mine = store.getLeague(myLeagueId);
    if (mine && leagueStatus(mine) === "active" && mine.format !== "pairs") {
      const mineMatches = buildNextMatchesPairings([mine], ratingsData, identityOf);
      // Only scope to a captain's own league while it actually has
      // something eligible to show (both sides' line-ups already in) —
      // otherwise this card was disappearing entirely for a captain
      // logged in on their own team's quiet week, even while other
      // leagues had real upcoming matches. Falling through to the
      // site-wide list beats showing nothing.
      if (mineMatches.length > 0) {
        return res.json({ scopedTo: { id: mine.id, name: mine.name }, matches: mineMatches });
      }
    }
  }

  res.json({ scopedTo: null, matches: buildNextMatchesPairings(allLeagues, ratingsData, identityOf) });
});

// A signed-in player's own "Tonight's matches" — same grouping as the
// site-wide carousel, but scoped to only the leagues they've claimed a
// record in, not every active league on the site.
router.get("/players/tonight-matches", (req, res) => {
  if (!req.session.playerUser) return res.json({ matches: [] });
  const user = store.getUser(req.session.playerUser.id);
  if (!user) return res.json({ matches: [] });
  // `hidden` means "import-only, feeds ratings but was never a real
  // league to show anywhere" (see /players/profile) — that still applies
  // here unchanged. An incognito-but-real league is NOT hidden, so it
  // isn't caught by this filter and shows normally.
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  const leagueIds = new Set((user.claims || []).filter((c) => !c.leftAt).map((c) => c.leagueId).filter((id) => !hiddenLeagueIds.has(id)));
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
  // A playoff stage comes in as ?stage=semis|final|positions (no round
  // number of its own — see fixturesForRoundKey); a regular round as
  // ?round=N; neither means "every not-yet-finalized fixture across the
  // whole league" (the pairs-league / no-round-nav case).
  const isPlayoffStage = ["semis", "final", "positions"].includes(req.query.stage);
  const round = req.query.round !== undefined ? Number(req.query.round) : null;
  const fixtures = isPlayoffStage ? fixturesForRoundKey(league, req.query.stage)
    : round !== null ? fixturesForRoundKey(league, round)
    : league.fixtures.filter((f) => !f.finalized);
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
        // A double forfeit is decided too (just with no winning side and no
        // Elo delta on record for it, same as any other forfeit) — treat it
        // like a played seed, not a still-live one.
        const decided = winner || (rubber && rubber.forfeited);
        const refA = (id) => { const p = teamA.players.find((p) => p.id === id); return p ? { id: p.id, name: p.name } : null; };
        const refB = (id) => { const p = teamB.players.find((p) => p.id === id); return p ? { id: p.id, name: p.name } : null; };
        // A decided seed still gets a prediction — not the current one
        // (which already has this very match baked into it), but what the
        // model would genuinely have said beforehand: each player's rating
        // going INTO this match is already on record (deltas.ratingBefore,
        // same field the admin ratings-preview recap reads), so this costs
        // nothing new to compute. Lets the tab show "predicted 63%" next to
        // the actual result instead of the prediction just vanishing once
        // a seed is played.
        let prediction;
        if (decided) {
          // What the same model said before this match (stored as the
          // ratings were replayed); plain Elo from the pre-match ratings for
          // a pairs league, which has no seeds to blend.
          const stored = ratingsData.predictions && ratingsData.predictions.get(`${f.id}:${i}`);
          const parts = [pairA[0], pairA[1], pairB[0], pairB[1]].map((id) => ratingsData.deltas.get(`${f.id}:${i}:${id}`));
          if (stored != null) {
            prediction = { winPctA: stored, winPctB: 100 - stored, provisional: false };
          } else if (parts.every(Boolean)) {
            const ratingA = (parts[0].ratingBefore + parts[1].ratingBefore) / 2;
            const ratingB = (parts[2].ratingBefore + parts[3].ratingBefore) / 2;
            const winPctA = Math.round(logic.expectedScore(ratingA, ratingB) * 100);
            prediction = { winPctA, winPctB: 100 - winPctA, provisional: false };
          } else {
            prediction = null;
          }
        } else {
          prediction = logic.predictSeed(league, pairA, pairB, ratingsData, identityOf, seedContext(league, f, i));
        }
        seeds.push({
          seed: i + 1,
          pairA: pairA.map(refA).filter(Boolean),
          pairB: pairB.map(refB).filter(Boolean),
          winner,
          score: decided ? logic.rubberScoreText(rubber) : null,
          prediction,
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
router.get("/homepage/highlights", (req, res) => {
  const hubWalled = isGuestRequest(req) && guestWallSettings().hub;
  const leagues = visibleIndexEntries()
    .map((entry) => store.getLeague(entry.id))
    .filter((l) => l && leagueStatus(l) === "active" && !hubWalled && !guestWalledFor(req, l.id));
  const extras = store.getHomepageExtras();
  const dismissed = new Set(extras.dismissed || []);

  const potw = [];
  const autoHighlights = [];
  const heroCandidates = [];
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
          playerAId: p.playerAId, playerAName: p.playerAName, playerAPhoto: p.playerAPhoto || "",
          playerBId: p.playerBId, playerBName: p.playerBName, playerBPhoto: p.playerBPhoto || "",
          team: p.teamName,
          leagueId: league.id,
          leagueName: league.name,
          teamLogo: team ? team.logo || "" : "",
        });
      });
      break;
    }

    // A photo an admin attached to a news post is the one piece of real
    // photography we have per league; failing that, the league's own court
    // photo stands in (see newsPostPhoto) — so an existing round-recap
    // post, which has no upload of its own, still qualifies. The newest
    // post with *some* photo, across every visible league, becomes the
    // Leagues-tab hero card below.
    (league.news || []).forEach((p) => {
      const photo = newsPostPhoto(p, league);
      if (!photo) return;
      const { headline, body } = newsPostHeadline(p);
      heroCandidates.push({ title: headline, body, photo, createdAt: p.createdAt, leagueId: league.id, leagueName: league.name, round: p.auto ? p.round : null, pinnedAt: p.pinnedAt || null });
    });

    const latest = (league.news || [])
      .filter((p) => p.auto)
      .sort((a, b) => newsRoundRank(b.round) - newsRoundRank(a.round))[0];
    if (!latest) return;
    (latest.highlights || []).forEach((h) => {
      if (h.type === "quiet") return;
      const dismissKey = league.id + ":" + latest.round + ":" + h.type;
      if (dismissed.has(dismissKey)) return;
      // `short` is a recent addition — a post saved before it existed won't
      // have one, so fall back to the (longer) News Room text rather than
      // showing a blank card.
      const team = h.teamId ? league.teams.find((t) => t.id === h.teamId) : null;
      // The row's own thumbnail — that league's court photo, same fallback
      // idea as newsPostPhoto, so every row in the merged "This week" card
      // gets a photo, not just the one at the top.
      autoHighlights.push({ type: h.type, label: h.label, short: h.short || h.text, leagueId: league.id, leagueName: league.name, round: latest.round, createdAt: latest.createdAt, teamLogo: team ? team.logo || "" : "", photo: league.courtPhoto || "" });
    });
  });
  autoHighlights.sort((a, b) => b.createdAt - a.createdAt);
  // Admin-authored cards always show, on top of (never counted against) the
  // cap on auto-generated ones — they were deliberately added, not just
  // whatever happened to be most recent.
  const manualHighlights = (extras.manual || []).slice().sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => ({ type: "manual", label: "News", short: m.short, leagueId: null, leagueName: m.leagueName || "", createdAt: m.createdAt, manualId: m.id, photo: m.photo || "", pinned: !!m.pinnedAt }));
  // A manual card with its own photo can win the hero slot too, same as a
  // league post — it just has no league to open, so the client leaves its
  // hero un-clickable (see heroNews.leagueId below).
  (extras.manual || []).forEach((m) => {
    if (!m.photo) return;
    heroCandidates.push({ title: m.short, body: "", photo: m.photo, createdAt: m.createdAt, leagueId: null, leagueName: m.leagueName || "Team Padel", round: null, pinnedAt: m.pinnedAt || null, manualId: m.id });
  });
  heroCandidates.sort((a, b) => b.createdAt - a.createdAt);
  // A pin (see the news pin route, and a manual card's own pinnedAt) wins
  // the Leagues-tab hero slot outright — the most recently pinned thing,
  // across every league and every manual card, since this hero is already
  // site-wide and only one pin should ever need to answer for it. Falls
  // back to newest-with-a-photo, as before, when nothing's pinned.
  const pinned = heroCandidates.filter((c) => c.pinnedAt).sort((a, b) => b.pinnedAt - a.pinnedAt);
  const heroNews = pinned[0] || heroCandidates[0] || null;
  // That same round's bigwin/rough-night/table cards would otherwise repeat
  // right below it — once a round is the hero, its own highlights drop out
  // of "Interesting this week" rather than saying the same thing twice.
  // A manual card that won hero gets the same treatment against its own
  // row list, so it doesn't show twice either.
  const shownHighlights = heroNews && heroNews.round != null
    ? autoHighlights.filter((h) => !(h.leagueId === heroNews.leagueId && h.round === heroNews.round))
    : autoHighlights;
  const shownManualHighlights = heroNews && heroNews.manualId
    ? manualHighlights.filter((m) => m.manualId !== heroNews.manualId)
    : manualHighlights;
  if (heroNews) { delete heroNews.round; delete heroNews.pinnedAt; heroNews.pinned = pinned[0] === heroNews; }
  res.json({ potw, highlights: shownManualHighlights.concat(shownHighlights.slice(0, 9)), heroNews });
});

// Every visible league's sponsors, flattened into one site-wide list for
// the Leagues page footer carousel — sponsors are set per league (Admin >
// Sponsors), but the same real-world sponsor often backs several leagues
// at once, so this dedupes on the logo image itself (name gets typed
// slightly differently league to league; the uploaded image doesn't).
router.get("/homepage/sponsors", (req, res) => {
  const leagues = visibleIndexEntries().map((entry) => store.getLeague(entry.id)).filter(Boolean);
  const seenImages = new Set();
  const sponsors = [];
  leagues.forEach((league) => {
    (league.sponsors || []).forEach((s) => {
      if (!s.image || seenImages.has(s.image)) return;
      seenImages.add(s.image);
      sponsors.push({ name: s.name, link: s.link, image: s.image });
    });
  });
  res.json({ sponsors });
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
  const { short, leagueName, photo, pinned } = req.body || {};
  if (!short || !short.trim()) return res.status(400).json({ error: "Enter something to show." });
  if (imageTooLarge(res, photo)) return;
  const extras = store.getHomepageExtras();
  if (!extras.manual) extras.manual = [];
  extras.manual.push({ id: logic.uid(), short: short.trim(), leagueName: (leagueName || "").trim(), photo: photo || "", createdAt: Date.now(), pinnedAt: pinned ? Date.now() : null });
  store.saveHomepageExtras(extras);
  res.json({ ok: true });
});
// Editing an existing manual card — most often just to attach a photo to
// one that was written before photos were an option.
router.put("/admin/interesting/manual/:id", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { short, leagueName, photo, pinned } = req.body || {};
  if (!short || !short.trim()) return res.status(400).json({ error: "Enter something to show." });
  if (imageTooLarge(res, photo)) return;
  const extras = store.getHomepageExtras();
  const entry = (extras.manual || []).find((m) => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "Not found." });
  entry.short = short.trim();
  entry.leagueName = (leagueName || "").trim();
  entry.photo = photo || "";
  // A fresh pin gets a fresh timestamp (so it wins ties against whatever
  // else is pinned elsewhere); unpinning just clears it. Re-saving while
  // already pinned leaves its original pin time alone — editing the text
  // isn't re-pinning it.
  entry.pinnedAt = pinned ? (entry.pinnedAt || Date.now()) : null;
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

router.post("/interest", async (req, res) => {
  const { name, contactNumber, email, playtomicLevel, league, joinAs, photo, context, event } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  if (!contactNumber || !contactNumber.trim()) return res.status(400).json({ error: "Contact number is required." });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  // A one-off event signup (an auction, say) has no league or team/player
  // choice to make — only the ordinary "join a league" form needs those.
  const isEvent = context === "event";
  if (!isEvent && joinAs !== "team" && joinAs !== "individual") return res.status(400).json({ error: "Choose team or individual player." });
  if (imageTooLarge(res, photo)) return;
  const id = logic.uid();
  const signups = store.getSignups();
  signups.unshift({
    id,
    name: name.trim(),
    contactNumber: contactNumber.trim(),
    email: email.trim(),
    playtomicLevel: (playtomicLevel || "").trim(),
    league: (league || "").trim(),
    joinAs: joinAs || "",
    context: isEvent ? "event" : "league",
    event: isEvent ? (event || "").trim() : "",
    photo: photo || "",
    createdAt: Date.now(),
  });
  store.saveSignups(signups);
  await store.saveSignupPhoto(id, photo || "");
  res.json({ ok: true });
});
router.get("/interest", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  res.json(store.getSignups());
});
router.delete("/interest/:id", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  store.saveSignups(store.getSignups().filter((x) => x.id !== req.params.id));
  await store.saveSignupPhoto(req.params.id, "");
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
// Someone who logged in with a team code and only THEN signs up (or logs in)
// would otherwise lose that captaincy the moment the code session ends —
// captaincies are only saved to an account when one is signed in at the time
// the code is entered. Carry the current code session across, so "create a
// free account and this team stays on it" is actually true.
function adoptSessionCaptaincy(req) {
  const u = req.session.user;
  if (!u || u.role !== "captain" || !u.leagueId || !u.teamId || !req.session.playerUser) return;
  persistCaptaincy(req, u.leagueId, u.teamId);
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
      adoptSessionCaptaincy(req);
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
  adoptSessionCaptaincy(req);
  res.json({ id, name: user.name, email: user.email });
});
router.post("/players/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const id = findUserIdByEmail(normalizeEmail(email));
  const user = id ? store.getUser(id) : null;
  const ok = user && (await verifyPassword(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: "Incorrect email or password." });
  req.session.playerUser = { id: user.id };
  adoptSessionCaptaincy(req);
  res.json({ id: user.id, name: user.name, email: user.email });
});
/* ---------- Sign in with Google / Facebook ---------- */

// Which buttons the sign-up and log-in screens should show — only providers
// whose credentials are actually set on this server.
router.get("/auth/providers", (req, res) => {
  res.json(oauth.enabledProviders());
});
function oauthRedirectUri(req, provider) {
  const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${origin}/api/auth/${provider}/callback`;
}
function backToSite(res, params) {
  res.redirect("/?" + new URLSearchParams(params).toString());
}
router.get("/auth/:provider/start", (req, res) => {
  const provider = req.params.provider;
  if (!oauth.isEnabled(provider)) return backToSite(res, { authError: "That sign-in isn't switched on yet." });
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = { state, provider, at: Date.now() };
  req.session.save((err) => {
    if (err) return backToSite(res, { authError: "Couldn't start sign-in — please try again." });
    res.redirect(oauth.buildAuthUrl(provider, { redirectUri: oauthRedirectUri(req, provider), state }));
  });
});
// Finds the account this sign-in belongs to, or makes one. The same rules
// as email sign-up apply, so a social sign-in can never be used to reach
// someone else's account:
//  - already linked to this provider account -> that account;
//  - an account under the same email, and the provider vouches for that
//    email -> the sign-in is added to it (so one person, one profile, and
//    any records already linked to their email come with them);
//  - an admin-made placeholder for that email (no password, no sign-in of
//    its own yet) is taken over exactly as email sign-up would;
//  - otherwise a new account. The password on it is random and unknown, so
//    nobody can later "sign up" or log in with that email and a password
//    of their choosing — only the provider, or a reset link sent to the
//    inbox itself, gets in.
// Returns { user, isNew } — isNew only true for the last branch (a genuine
// brand-new account) — so the callback below can tell the client to open
// the registration wizard exactly once, the same moment the plain
// email/password sign-up does, instead of on every social sign-IN too.
async function accountForSocialProfile(provider, profile) {
  const index = store.getUsersIndex();
  const linked = index.map((e) => store.getUser(e.id)).find((u) => u && u.providers && u.providers[provider] === profile.subject);
  if (linked) return { user: linked, isNew: false };
  if (!profile.email || !profile.emailVerified) {
    throw new Error("We couldn't get a confirmed email from " + oauth.label(provider) + ". Sign up with your email instead, or allow email access and try again.");
  }
  const email = normalizeEmail(profile.email);
  const existingId = findUserIdByEmail(email);
  if (existingId) {
    const existing = store.getUser(existingId);
    if (!existing) throw new Error("Couldn't find your account — please try again.");
    existing.providers = Object.assign({}, existing.providers, { [provider]: profile.subject });
    if (!existing.passwordHash) {
      existing.passwordHash = await hashPassword(crypto.randomBytes(24).toString("hex"));
      if (profile.name) existing.name = profile.name;
    }
    await store.saveUserDurable(existing.id, existing);
    return { user: existing, isNew: false };
  }
  const id = logic.uid();
  const user = {
    id, email, name: (profile.name || email.split("@")[0]).trim(),
    passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")),
    providers: { [provider]: profile.subject }, createdAt: Date.now(), claims: [],
  };
  index.push({ id, email });
  await store.saveUserDurable(id, user);
  await store.saveUsersIndexDurable(index);
  return { user, isNew: true };
}
router.get("/auth/:provider/callback", loginLimiter, async (req, res) => {
  const provider = req.params.provider;
  const pending = req.session.oauthState;
  req.session.oauthState = null;
  if (!oauth.isEnabled(provider)) return backToSite(res, { authError: "That sign-in isn't switched on yet." });
  if (req.query.error) return backToSite(res, { authError: "Sign-in was cancelled." });
  const fresh = pending && Date.now() - pending.at < 10 * 60 * 1000;
  if (!fresh || pending.provider !== provider || !req.query.state || !safeEqual(String(req.query.state), pending.state) || !req.query.code) {
    return backToSite(res, { authError: "That sign-in link expired — please try again." });
  }
  try {
    const profile = await oauth.fetchProfile(provider, { code: String(req.query.code), redirectUri: oauthRedirectUri(req, provider) });
    const { user, isNew } = await accountForSocialProfile(provider, profile);
    req.session.playerUser = { id: user.id };
    adoptSessionCaptaincy(req);
    const backParams = isNew ? { signedIn: "1", isNew: "1" } : { signedIn: "1" };
    req.session.save(() => backToSite(res, backParams));
  } catch (e) {
    console.error("Social sign-in failed:", e.message);
    backToSite(res, { authError: e.message || "Sign-in didn't work — please try again." });
  }
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
// A real deletion, not just a sign-out — the login itself (email,
// password hash, name on the account) is gone for good, and so is any
// photo this person uploaded (that's personal identification, same as
// the account is). What's deliberately NOT touched: the roster name and
// match history their claimed records are part of — those are the
// league's own shared record (other players' results reference them too),
// exactly as they'd stay if this person had simply stopped playing rather
// than asked to be forgotten. The privacy policy states this plainly
// rather than leaving it as a silent implementation choice.
router.post("/players/delete-account", requirePlayerUser, async (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  if (!user) return res.status(404).json({ error: "Account not found." });
  for (const c of user.claims || []) {
    const league = store.getLeague(c.leagueId);
    if (!league) continue;
    const team = league.teams.find((t) => t.id === c.teamId);
    const player = team && team.players.find((p) => p.id === c.playerId);
    if (!player) continue;
    if (player.claimedByUserId === user.id) player.claimedByUserId = null;
    if (player.photo) { player.photo = ""; await store.savePlayerPhoto(league.id, player.id, ""); }
    store.saveLeague(league.id, league);
  }
  const index = store.getUsersIndex().filter((e) => e.id !== user.id);
  store.saveUsersIndex(index);
  store.deleteUser(user.id);
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
    captaincies.push({ leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name, teamLogo: team.logo || "", kitNeeded: league.format !== "pairs" && kitNeedsSetup(team) });
  });
  if (changed) {
    user.captaincies = captaincies.map((c) => ({ leagueId: c.leagueId, teamId: c.teamId }));
    store.saveUser(user.id, user);
  }
  res.json({ id: user.id, name: user.name, email: user.email, captaincies, emailNotifications: user.emailNotifications !== false, emailAvailable: mailConfigured() });
});

// Account-level switch for the emails in emailRecipientsForTeam — on unless
// explicitly turned off.
router.put("/players/email-notifications", (req, res) => {
  const pu = req.session.playerUser;
  const user = pu && store.getUser(pu.id);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  user.emailNotifications = !!(req.body && req.body.enabled);
  store.saveUser(user.id, user);
  res.json({ ok: true, emailNotifications: user.emailNotifications });
});


// Every player record in the store, flat — any league, any format, any
// status, since a player record's existence is what matters here, not the
// league's phase. The shared base both the cross-league name search and
// the combine-suggestions scan build on.
// Includes an incognito league (off public browsing, but a real, actively
// -run league — see visibleIndexEntries) since its own players still need
// to find themselves here to claim a record in the first place. Excludes
// a truly hidden league (import-only, feeds ratings but was never a real
// league to browse or claim into) — same distinction every other
// hidden-league check in this file makes.
// Players on a team that's no longer in the league (or off a roster since),
// found in an archived season — newest season first, each record once. They
// stay claimable so someone whose team sat a season out can still find their
// record and keep their history.
function archivedOnlyRecords(league) {
  const live = new Set();
  // A player who's been moved to another team (or is between teams) isn't a
  // "past" record — he's still here, so his old-team copy isn't offered again.
  league.teams.forEach((t) => t.players.forEach((p) => { live.add(t.id + ":" + p.id); live.add("*:" + p.id); }));
  (league.freeAgents || []).forEach((p) => live.add("*:" + p.id));
  const found = new Map();
  (league.seasonHistory || []).forEach((snap) => {
    (snap.teams || []).forEach((t) => (t.players || []).forEach((p) => {
      const k = t.id + ":" + p.id;
      if (live.has(k) || live.has("*:" + p.id) || found.has(k)) return;
      found.set(k, { team: t, player: p, label: snap.label || "" });
    }));
  });
  return [...found.values()];
}
// A record by team and player id: on the live roster first, otherwise in the
// newest archived season that has it.
function findRecord(league, teamId, playerId) {
  const live = findTeamAndPlayer(league, teamId, playerId);
  if (live.team && live.player) return { ...live, archived: false };
  // Between teams for the new season: still his record, just not on a roster.
  const between = (league.freeAgents || []).find((p) => p.id === playerId);
  if (between) return { team: live.team || league.teams.find((t) => t.id === between.removedFromTeamId) || { id: teamId, name: "No team yet", players: [] }, player: between, archived: true };
  const hit = archivedOnlyRecords(league).find((r) => r.team.id === teamId && r.player.id === playerId);
  return hit ? { team: hit.team, player: hit.player, archived: true } : { team: null, player: null, archived: false };
}
function allPlayersFlat({ includePast } = {}) {
  const results = [];
  store.getIndex().filter((entry) => !entry.hidden).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    league.teams.forEach((team) => {
      team.players.forEach((p) => {
        results.push({
          leagueId: league.id, leagueName: league.name,
          teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
          playerId: p.id, playerName: p.name, photo: p.photo || "",
          claimedByUserId: p.claimedByUserId || null,
        });
      });
    });
    if (includePast) {
      (league.freeAgents || []).forEach((p) => {
        results.push({
          leagueId: league.id, leagueName: league.name,
          teamId: p.removedFromTeamId || "none", teamName: "No team yet", teamLogo: "",
          playerId: p.id, playerName: p.name, photo: "",
          claimedByUserId: p.claimedByUserId || null,
        });
      });
      archivedOnlyRecords(league).forEach(({ team, player: p, label }) => {
        results.push({
          leagueId: league.id, leagueName: league.name,
          teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
          playerId: p.id, playerName: p.name, photo: "",
          claimedByUserId: p.claimedByUserId || null,
          pastSeason: true, seasonLabel: label,
        });
      });
    }
  });
  return results;
}
// Same idea as allPlayersFlat above, one row per team-in-a-league (a
// combined club still lists each of its leagues' teams separately here —
// the same precedent allPlayersFlat already sets for a claimed player's
// multiple appearances, so a search across every league stays a flat,
// predictable list rather than a second grouping rule to reason about).
// Same exact-name match the client already uses to single out this one
// real league for its own special-casing (trophy room, Vibora champion
// logo — see VIBORA_LEAGUE_NAME in app.js). Left out of the directory
// specifically, not hidden league-wide — its own Table/Fixtures tabs are
// unaffected.
const VIBORA_LEAGUE_NAME = "Vibora 50+";
// `includeVibora` defaults to false — the public Teams directory leaves
// Vibora 50+ out entirely (see VIBORA_LEAGUE_NAME above), but that's a
// directory-display concern, not a reason to also hide it from the
// owner's own team-combine search below.
function allTeamsFlat({ includeVibora } = {}) {
  const results = [];
  store.getIndex().filter((entry) => !entry.hidden).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league || (!includeVibora && league.name === VIBORA_LEAGUE_NAME)) return;
    league.teams.forEach((t) => {
      results.push({
        leagueId: league.id, leagueName: league.name,
        teamId: t.id, teamName: t.name, teamLogo: t.logo || "", playerCount: t.players.length, clubId: t.clubId || null,
      });
    });
  });
  return results;
}
// Gated the same way /players/search-index is — a global cross-league
// directory is a different exposure than any one league's own public Table
// tab (which already shows every team's crest with no login at all); the
// login requirement targets the "scrape everything in one shot" case, not
// per-league visibility.
router.get("/teams/search-index", requirePlayerUser, (req, res) => {
  res.json(allTeamsFlat());
});
// Shared by the player-facing search (below) and the owner-only admin
// search used to combine profiles on someone's behalf. Deliberately leaves
// teamLogo out — a search response embedding a full base64 image per row
// (up to 30 of them, one per keystroke once debounced) was the actual
// reason this search felt slow, not the name-matching itself, which is a
// trivial in-memory scan. The client already falls back to a plain
// initials avatar with no logo, so this is a pure payload-size win.
function searchPlayersAcrossLeagues(q) {
  return allPlayersFlat({ includePast: true })
    .filter((p) => p.playerName.toLowerCase().includes(q))
    .map((p) => ({
      leagueId: p.leagueId, leagueName: p.leagueName, teamId: p.teamId, teamName: p.teamName,
      playerId: p.playerId, playerName: p.playerName, claimed: !!p.claimedByUserId, pastSeason: !!p.pastSeason,
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
// The whole trimmed player list (no logos, same shape searchPlayersAcrossLeagues
// returns) in one response, fetched once by the client and filtered
// in-browser after that — replaces a network round trip per keystroke
// with a single upfront one. That round trip, not the name-matching
// itself, is what actually made search feel slow (several hundred ms on
// this hosting, per keystroke once debounced) — see loadPlayerIndex in
// app.js. No `q`/cap here since the client owns the filtering now.
router.get("/players/search-index", requirePlayerUser, (req, res) => {
  res.json(allPlayersFlat({ includePast: true }).map((p) => ({
    leagueId: p.leagueId, leagueName: p.leagueName, teamId: p.teamId, teamName: p.teamName,
    playerId: p.playerId, playerName: p.playerName, claimed: !!p.claimedByUserId,
    ...(p.pastSeason ? { pastSeason: true } : {}),
  })));
});

// A player's own photo, or failing that their team's badge, for every row
// the search index above can produce — kept as a second, separately
// cached fetch (see loadAvatarsIndex in app.js) rather than folded into
// search-index itself, so the always-hot text search never has to carry
// image bytes. Deduplicated by team/player id instead of one logo per
// player row, since teammates would otherwise each embed their own copy
// of the exact same badge.
router.get("/players/avatars-index", requirePlayerUser, (req, res) => {
  const teamLogos = {}, playerPhotos = {};
  allPlayersFlat().forEach((p) => {
    if (p.teamLogo && !teamLogos[p.teamId]) teamLogos[p.teamId] = p.teamLogo;
    if (p.photo) playerPhotos[p.playerId] = p.photo;
  });
  res.json({ teamLogos, playerPhotos });
});

// Links one player record to one user account — used both by a player
// claiming themselves and by the owner combining records on someone's
// behalf. Throws (message is the user-facing error) rather than returning
// a response directly, so both callers can handle the failure their own
// way (one record failing shouldn't half-apply an admin combine).
// A profile photo belongs to the whole person: uploading one copies it to every
// record the account has claimed (see the photo route). That copy only happened
// at upload time, though, so a record claimed afterwards never got the photo and
// showed the team crest instead. This gives every record the account holds that
// has no photo the one it already has somewhere else.
function shareAccountPhoto(user) {
  const find = (c) => {
    const league = store.getLeague(c.leagueId);
    const team = league && league.teams.find((t) => t.id === c.teamId);
    const player = team && team.players.find((p) => p.id === c.playerId);
    return { league, player };
  };
  let photo = "";
  for (const c of user.claims || []) {
    const { player } = find(c);
    if (player && player.photo) { photo = player.photo; break; }
  }
  if (!photo) return 0;
  const touched = new Map();
  let n = 0;
  for (const c of user.claims || []) {
    const { league, player } = find(c);
    if (!player || player.photo || player.claimedByUserId !== user.id) continue;
    player.photo = photo;
    store.savePlayerPhoto(league.id, player.id, photo).catch(() => {});
    touched.set(league.id, league);
    n++;
  }
  touched.forEach((l) => store.saveLeague(l.id, l));
  return n;
}
function claimPlayerRecord(user, leagueId, teamId, playerId) {
  const league = store.getLeague(leagueId);
  if (!league) throw new Error("League not found.");
  const { team, player } = findRecord(league, teamId, playerId);
  if (!team) throw new Error("Team not found.");
  if (!player) throw new Error("Player not found.");
  if (player.claimedByUserId && player.claimedByUserId !== user.id) {
    // Already claimed by someone else is only a hard conflict if that
    // "someone else" could actually be a real person logged in as them.
    // A passwordHash of null means nobody can log into that account —
    // it only exists because an admin combined this record with others on
    // this player's behalf before they'd ever signed up themselves. The
    // real player showing up now to claim it absorbs everything already
    // linked there instead of hitting a wall. A holder that no longer
    // exists at all (the account was deleted at some point without
    // clearing this reference first) is the same story minus anything to
    // absorb — nothing real is holding this claim, so it's free to take.
    const other = store.getUser(player.claimedByUserId);
    if (!other) {
      player.claimedByUserId = null;
    } else if (!other.passwordHash) {
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
  shareAccountPhoto(user);
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
// A record already claimed by a real (passworded) account isn't a dead
// end for whoever the name actually belongs to — it goes to that league's
// admin as a request instead of failing outright, same spirit as a
// selection unlock request. Only one pending request per player at a
// time; a second request just replaces the first rather than queuing
// (the admin resolves them one at a time anyway).
router.post("/players/claim-requests", requirePlayerUser, (req, res) => {
  const { leagueId, teamId, playerId } = req.body || {};
  const league = store.getLeague(leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, teamId, playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  if (!player.claimedByUserId) return res.status(400).json({ error: "This record isn't claimed by anyone yet — just claim it directly." });
  if (player.claimedByUserId === req.session.playerUser.id) return res.status(400).json({ error: "This is already your record." });
  const requester = store.getUser(req.session.playerUser.id);
  player.claimRequest = { userId: requester.id, userName: requester.name, createdAt: Date.now() };
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// "I've left this team" — the other way out of a league besides unlinking a
// wrong record. The record stays claimed by this account, so every match,
// award and rating stays on the profile (and nobody else can take it), but
// the team stops counting as one of their current ones: no upcoming matches,
// nudges or news, and any captaincy of it ends. {left:false} undoes it.
router.put("/players/claims/:leagueId/:teamId/:playerId/left", requirePlayerUser, (req, res) => {
  const { leagueId, teamId, playerId } = req.params;
  const user = store.getUser(req.session.playerUser.id);
  const claim = (user.claims || []).find((c) => c.leagueId === leagueId && c.teamId === teamId && c.playerId === playerId);
  if (!claim) return res.status(404).json({ error: "That record isn't linked to your profile." });
  if (req.body && req.body.left === false) delete claim.leftAt;
  else {
    claim.leftAt = Date.now();
    user.captaincies = (user.captaincies || []).filter((c) => !(c.leagueId === leagueId && c.teamId === teamId));
  }
  store.saveUser(user.id, user);
  res.json({ ok: true, leftAt: claim.leftAt || null });
});
router.delete("/players/claims/:leagueId/:teamId/:playerId", requirePlayerUser, (req, res) => {
  const { leagueId, teamId, playerId } = req.params;
  const user = store.getUser(req.session.playerUser.id);
  user.claims = user.claims.filter((c) => !(c.leagueId === leagueId && c.teamId === teamId && c.playerId === playerId));
  store.saveUser(user.id, user);
  const league = store.getLeague(leagueId);
  const { player } = league ? findRecord(league, teamId, playerId) : {};
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
// Every pending claim request, across every league (hidden/incognito
// included — same "the owner sees everything regardless of public
// visibility" rule Manage Leagues already follows) — this used to only be
// visible one league at a time, from inside that league's own Admin tab,
// which meant actually finding a pending request meant remembering to
// check every league in turn. One flat list here instead.
router.get("/admin/claim-requests", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const pending = [];
  store.getIndex().forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    league.teams.forEach((team) => {
      team.players.forEach((player) => {
        if (!player.claimRequest) return;
        pending.push({
          leagueId: league.id, leagueName: league.name,
          teamId: team.id, teamName: team.name,
          playerId: player.id, playerName: player.name,
          requestedBy: player.claimRequest.userName, createdAt: player.claimRequest.createdAt,
        });
      });
    });
  });
  pending.sort((a, b) => b.createdAt - a.createdAt);
  res.json(pending);
});
router.post("/admin/players/combine", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { name, email, records } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return res.status(400).json({ error: "A valid email is required." });
  if (!Array.isArray(records) || records.length < 2) return res.status(400).json({ error: "Select at least two records to combine." });
  let userId = findUserIdByEmail(normalized);
  let user = userId ? store.getUser(userId) : null;
  // A userId with no matching user record means an earlier attempt at
  // this same email got as far as saving the index entry, then failed
  // claim validation below before the user record itself was ever
  // written — reuse that id and rebuild the record rather than leaving
  // the index permanently pointing at nothing.
  const needsIndexEntry = !userId;
  if (!user) {
    if (!userId) userId = logic.uid();
    // No password — this profile exists so its records show up combined,
    // but nobody can log into it until the real player sets one up
    // themselves. /players/signup, if it sees this exact email with no
    // password set, adopts this account (setting the password on it)
    // instead of blocking them or creating a duplicate.
    user = { id: userId, email: normalized, passwordHash: null, name: name.trim(), createdAt: Date.now(), claims: [] };
  }
  // All-or-nothing, and validated before anything is persisted — if any
  // one record is already claimed by a different profile, reject the
  // whole combine rather than saving a new account/index entry for a
  // combine that didn't actually go through.
  try {
    records.forEach((r) => claimPlayerRecord(user, r.leagueId, r.teamId, r.playerId));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (needsIndexEntry) {
    const index = store.getUsersIndex();
    index.push({ id: userId, email: normalized });
    try {
      await store.saveUsersIndexDurable(index);
    } catch (e) {
      return res.status(503).json({ error: "Couldn't save just now — try again in a moment." });
    }
  }
  try {
    await store.saveUserDurable(user.id, user);
  } catch (e) {
    return res.status(503).json({ error: "Couldn't save just now — try again in a moment." });
  }
  logAdminAction(`Combined ${records.length} player records into ${name.trim()}`);
  res.json({ ok: true, userId: user.id });
});
// Same idea as the player search just above, for the "Combine team
// profiles" card — a team has no separate account to search by, so this
// is a plain name search over allTeamsFlat rather than a dedicated index.
router.get("/admin/teams/search", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const q = ((req.query.q || "") + "").trim().toLowerCase();
  res.json(q ? allTeamsFlat({ includeVibora: true }).filter((t) => t.teamName.toLowerCase().includes(q)) : []);
});
// Owner-only, unlike the PUT /leagues/:leagueId/teams/:teamId route's own
// clubId field (that one's for a league's own admin editing their own
// team directly) — combining spans leagues an ordinary league admin has
// no reason to know about or touch, the same reasoning /admin/players/
// combine above already applies to a claimed player's records. Generates
// the clubId itself (a plain uid, never shown or typed anywhere) rather
// than asking the owner to invent and match a string by hand.
router.post("/admin/teams/combine", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length < 2) return res.status(400).json({ error: "Select at least two teams to combine." });
  const resolved = [];
  for (const r of records) {
    const league = store.getLeague(r.leagueId);
    const team = league && league.teams.find((t) => t.id === r.teamId);
    if (!team) return res.status(400).json({ error: "A selected team couldn't be found." });
    resolved.push({ league, team });
  }
  const clubId = logic.uid();
  resolved.forEach(({ league, team }) => {
    team.clubId = clubId;
    store.saveLeague(league.id, league);
  });
  logAdminAction(`Combined ${resolved.length} team records into one club`);
  res.json({ ok: true });
});
// Owner-only: a password reset link for one account, handed back to the
// admin to pass on by hand (WhatsApp, say) when the reset email never
// arrives. It's the same one-use token the "Forgot password" email carries,
// but good for 24 hours instead of 1, since a person may not open a message
// straight away. Making a new one cancels any earlier link for that account.
router.post("/admin/players/:userId/reset-link", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const user = store.getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: "Account not found." });
  user.resetToken = crypto.randomBytes(32).toString("hex");
  user.resetTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  store.saveUser(user.id, user);
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  logAdminAction(`Made a password reset link for ${user.name}`);
  res.json({ link: `${base}/?resetToken=${user.resetToken}`, expiresAt: user.resetTokenExpiresAt, name: user.name });
});
// Owner-only: send one real test email so "is email working?" has a clear
// answer, with the plain-English reason when it isn't.
router.post("/admin/email/test", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const to = normalizeEmail(req.body && req.body.to);
  if (!to || !to.includes("@")) return res.status(400).json({ error: "Enter an email address to send the test to." });
  const method = process.env.EMAIL_DRY_RUN ? "dry run" : process.env.BREVO_API_KEY ? "Brevo" : (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? "Gmail" : "none";
  if (!mailConfigured()) return res.json({ ok: false, method, message: "Email isn't set up on this server. No email service key is saved in its settings, so no email can go out." });
  const result = await sendMail({ to, subject: "Team Padel email check", text: "If you can read this, Team Padel can send email. Password reset links and line-up reminders will reach people." });
  logAdminAction(`Sent a test email to ${to}`);
  res.json({ ok: !!result.sent, method, message: result.sent ? `Sent to ${to} using ${method}. Check the inbox, and spam too.` : explainSendFailure(result) });
});
// A simple read-back of every player account and what it's linked to —
// so combining someone isn't a write-only black box for the admin.
// A placeholder/test address rather than a real person's — kept in the list
// (never deleted) but shown apart from the real ones.
function looksLikeTestEmail(email) {
  const e = String(email || "").toLowerCase();
  const [local = "", domain = ""] = e.split("@");
  return /(^|\.)(example\.(com|org|net)|invalid|test|example|localhost|mailinator\.com)$/.test(domain)
    || /^(test|trophytest|fake|demo|dummy)([._+\-\d]|$)/.test(local) || /(^|[._-])test\d*$/.test(local);
}
router.get("/admin/players/accounts", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const onlineIds = new Set(await store.getOnlinePlayerUserIds());
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
    return {
      id: user.id, name: user.name, email: user.email, claims,
      // Actually on the site right now (pinged in the last 90 seconds) —
      // not just holding a login session, which lasts two weeks.
      online: onlineIds.has(user.id),
      // No password and no Google/Facebook sign-in: an account an admin made
      // by combining records, waiting for that person to sign up with the
      // same email (see /players/signup).
      signedUp: !!user.passwordHash,
      providers: Object.keys(user.providers || {}),
      createdAt: user.createdAt || null,
      test: looksLikeTestEmail(user.email),
    };
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
// The league's own admin decides a contested claim — approve reassigns the
// record (the previous claimant keeps every other claim they hold, just
// loses this one); reject just clears the request and leaves things as
// they were.
router.put("/leagues/:leagueId/teams/:teamId/players/:playerId/claim-request", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const request = player.claimRequest;
  if (!request) return res.status(400).json({ error: "No pending request for this player." });
  const decision = req.body.decision;
  if (decision !== "approve" && decision !== "reject") return res.status(400).json({ error: "Invalid decision." });
  player.claimRequest = null;
  if (decision === "reject") {
    store.saveLeague(league.id, league);
    return res.json({ ok: true });
  }
  // Approve — the previous claimant keeps every other claim they hold,
  // they just lose this one record.
  if (player.claimedByUserId) {
    const oldUser = store.getUser(player.claimedByUserId);
    if (oldUser) {
      oldUser.claims = (oldUser.claims || []).filter((c) => !(c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
      store.saveUser(oldUser.id, oldUser);
    }
    player.claimedByUserId = null;
  }
  const newUser = store.getUser(request.userId);
  if (!newUser) {
    store.saveLeague(league.id, league);
    return res.status(404).json({ error: "The requesting account no longer exists." });
  }
  // Persist the cleared claim/request first — claimPlayerRecord re-reads
  // the league from the store itself, so without this it'd still see the
  // old claimant and the now-stale request sitting in memory only.
  store.saveLeague(league.id, league);
  try {
    claimPlayerRecord(newUser, league.id, team.id, player.id);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  store.saveUser(newUser.id, newUser);
  res.json({ ok: true });
});

// A team's own next fixture, straight off the schedule — no lineup
// submission required, unlike logic.findPlayerUpcoming (which is about a
// specific player's pairing once selections are in). "Your Fixtures" on My
// Profile needs the real next match the moment it's on the calendar, not
// just once both captains have picked their pairs.
function teamNextFixture(league, team) {
  const upcoming = logic.allFixturesOf(league)
    .filter((f) => !f.finalized && f.teamA && f.teamB && (f.teamA === team.id || f.teamB === team.id))
    .map((f) => {
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      const oppTeam = league.teams.find((t) => t.id === (f.teamA === team.id ? f.teamB : f.teamA));
      return {
        fixtureId: f.id, label: fixtureLabel(league, f),
        opponentTeamId: oppTeam ? oppTeam.id : null,
        opponentTeam: oppTeam ? oppTeam.name : "TBD",
        opponentLogo: oppTeam ? oppTeam.logo || "" : "",
        // Names only — enough to list who you're up against on Find a
        // player without a second request.
        opponentPlayers: oppTeam ? oppTeam.players.map((p) => ({ id: p.id, name: p.name })) : [],
        date: sched.date || "", time: sched.time || "",
      };
    })
    .sort((a, b) => {
      if (a.date && b.date) return (a.date + a.time).localeCompare(b.date + b.time);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
  return upcoming[0] || null;
}
// A semi-final or final this team is actually in, from three days out
// through the day of — the window My Profile takes over with the playoff
// poster (and, the first time each day, the full-screen splash). Both
// sides need to be settled (a semi whose opponent isn't known yet has
// nothing to show), and it goes away the moment the match is finalized or
// the day has passed.
function teamPlayoffSplash(league, team, isCaptain) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const f of logic.allFixturesOf(league)) {
    if ((f.stage !== "semi" && f.stage !== "final") || f.finalized || !f.teamA || !f.teamB) continue;
    if (f.teamA !== team.id && f.teamB !== team.id) continue;
    const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
    if (!sched.date) continue;
    const matchDate = new Date(sched.date + "T00:00:00");
    if (isNaN(matchDate)) continue;
    const daysOut = Math.round((matchDate.getTime() - today.getTime()) / 86400000);
    if (daysOut < 0 || daysOut > 3) continue;
    const opp = league.teams.find((t) => t.id === (f.teamA === team.id ? f.teamB : f.teamA));
    if (!opp) continue;
    const meeting = league.fixtures.find((x) => x.finalized && ((x.teamA === team.id && x.teamB === opp.id) || (x.teamA === opp.id && x.teamB === team.id)));
    let lastMeeting = null;
    if (meeting) {
      const sc = logic.fixtureScore(meeting);
      lastMeeting = meeting.teamA === team.id ? { mine: sc.winsA, theirs: sc.winsB } : { mine: sc.winsB, theirs: sc.winsA };
      lastMeeting.label = fixtureLabel(league, meeting);
    }
    // Once both captains have actually picked their side, the splash's
    // chip strip shows the real court-by-court match-ups instead of just
    // the two team names — the whole point being it updates the moment
    // the second lineup lands, not just once at kickoff.
    const mySide = f.teamA === team.id ? "A" : "B";
    const mySel = mySide === "A" ? f.selectionA : f.selectionB;
    const oppSel = mySide === "A" ? f.selectionB : f.selectionA;
    return {
      fixtureId: f.id, stage: f.stage, leagueId: league.id, leagueName: league.name,
      teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
      opponentTeam: opp.name, opponentLogo: opp.logo || "",
      date: sched.date, time: sched.time || "", venue: sched.venue || league.defaultVenue || "",
      daysOut, matchDay: daysOut === 0, isCaptain: !!isCaptain, isParticipant: true, lastMeeting,
      lineups: buildSplashLineups(mySel, team, oppSel, opp),
    };
  }
  return null;
}
// The same live semi/final window as teamPlayoffSplash, but for a player
// who isn't claimed onto or captaining either finalist team — everyone
// else in the league still gets to see the moment, just without a "my
// team" framing, and (per the client's seen-key) only ever once, rather
// than replayed across each days-out step or when lineups land the way a
// real participant's splash is.
function leagueFinalsSpectatorSplash(league, myTeamIds) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const f of logic.allFixturesOf(league)) {
    // Finals only — a semi is still two teams' own business, and firing
    // this for both of them every season would just be noise for
    // everyone else. The final is the one moment worth surfacing league-wide.
    if (f.stage !== "final" || f.finalized || !f.teamA || !f.teamB) continue;
    if (myTeamIds.has(f.teamA) || myTeamIds.has(f.teamB)) continue; // already covered as a participant
    const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
    if (!sched.date) continue;
    const matchDate = new Date(sched.date + "T00:00:00");
    if (isNaN(matchDate)) continue;
    const daysOut = Math.round((matchDate.getTime() - today.getTime()) / 86400000);
    if (daysOut < 0 || daysOut > 3) continue;
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    if (!teamA || !teamB) continue;
    return {
      fixtureId: f.id, stage: f.stage, leagueId: league.id, leagueName: league.name,
      teamId: teamA.id, teamName: teamA.name, teamLogo: teamA.logo || "",
      opponentTeam: teamB.name, opponentLogo: teamB.logo || "",
      date: sched.date, time: sched.time || "", venue: sched.venue || league.defaultVenue || "",
      daysOut, matchDay: daysOut === 0, isCaptain: false, isParticipant: false, lastMeeting: null,
      lineups: buildSplashLineups(f.selectionA, teamA, f.selectionB, teamB),
    };
  }
  return null;
}
router.get("/players/profile", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  // Repairs records claimed after the photo was uploaded (see shareAccountPhoto).
  shareAccountPhoto(user);
  const cards = [];
  // Every team this account is attached to, whether claimed as a specific
  // player or just captained — a captain who's never personally claimed a
  // roster spot on their own team still needs that team's next fixture to
  // show up here. Deduped by team so a claimed-and-captained team only
  // contributes one fixture card.
  const fixtureCards = [];
  const playoffSplash = [];
  const fixtureTeamKeys = new Set();
  // Every league this account touches, and which of its own teams that
  // is — used below to also surface a no-"my team" splash for a league
  // final the account isn't actually playing in (see
  // leagueFinalsSpectatorSplash): everyone in the league gets the moment,
  // not just the two finalist teams' own players.
  const myLeagues = new Map();
  const addFixtureTeam = (league, team) => {
    if (!myLeagues.has(league.id)) myLeagues.set(league.id, { league, teamIds: new Set() });
    myLeagues.get(league.id).teamIds.add(team.id);
    const key = league.id + ":" + team.id;
    if (fixtureTeamKeys.has(key)) return;
    fixtureTeamKeys.add(key);
    const splash = teamPlayoffSplash(league, team, (user.captaincies || []).some((c) => c.leagueId === league.id && c.teamId === team.id));
    if (splash) playoffSplash.push(splash);
    const next = teamNextFixture(league, team);
    if (next) fixtureCards.push(Object.assign({ leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name, teamLogo: team.logo || "", teamPlayers: team.players.map((p) => ({ id: p.id, name: p.name })) }, next));
  };
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
    let team = league && league.teams.find((t) => t.id === claim.teamId);
    let player = team && team.players.find((p) => p.id === claim.playerId);
    // A team removed from the league for a later season (or a player taken
    // off its roster) is no longer in the live league, but it's still in the
    // archived season it played — and everything on this card (results,
    // awards, rating) already reads across archived seasons. So the claim
    // survives as a former team instead of being dropped, history intact.
    let retired = false;
    if (league && team && !player) {
      // Taken off the team for the new season and not placed yet.
      const between = (league.freeAgents || []).find((x) => x.id === claim.playerId);
      if (between) { player = between; retired = true; }
    }
    if (league && (!team || !player)) {
      for (const snap of league.seasonHistory || []) {
        const t = (snap.teams || []).find((x) => x.id === claim.teamId);
        const pl = t && (t.players || []).find((x) => x.id === claim.playerId);
        if (pl) { team = t; player = pl; retired = true; break; }
      }
    }
    if (!league || !team || !player) { changed = true; return false; }
    // A hidden league (data imported purely to feed ratings, not a real
    // league to manage here) never surfaces in any list on this site — the
    // claim still counts for rating purposes, it just gets no card here.
    if (hiddenLeagueIds.has(claim.leagueId)) return true;
    // Spans every archived season plus the live one — a Pair of the Week
    // win from a season that's since ended shouldn't vanish off the
    // Trophy Room just because the next season started. See
    // logic.allSeasonsOf.
    const awards = logic.potwAwardsAllSeasons(league, claim.playerId);
    // Exact roster match against each Hall of Fame winner (see POST
    // /hall-of-fame) — this player id was actually on the team when it won,
    // same check the single-league player-history route uses. Falls back to
    // a name match against the entry's free-text winner for legacy entries
    // that never got a roster at all (see hofWinnerNameMatch).
    const championships = (league.hallOfFame || [])
      .filter((e) => (e.winnerRoster || []).some((p) => p.id === claim.playerId) || (!e.winnerRoster && hofWinnerNameMatch(e.winner, player.name)))
      .map((e) => ({ season: e.season, label: e.label, teamName: e.winner, teamLogo: e.winnerLogo || "" }));
    // Same idea, the other half of each entry — a runner-up finish is
    // still a real achievement worth a badge of its own.
    const runnerUps = (league.hallOfFame || [])
      .filter((e) => (e.runnerUpRoster || []).some((p) => p.id === claim.playerId) || (!e.runnerUpRoster && hofWinnerNameMatch(e.runnerUp, player.name)))
      .map((e) => ({ season: e.season, label: e.label, teamName: e.runnerUp, teamLogo: e.runnerUpLogo || "" }));
    // Same "spans every season" reasoning as awards above — a claimed
    // player's results shouldn't reset to empty the moment their league
    // starts a new season.
    const results = logic.playerMatchHistoryAllSeasons(league, claim.playerId, ratingsData);
    // Longest run of consecutive wins ever recorded in this league — not
    // "current streak" (that resets the moment a loss happens and would
    // make an unlocked achievement flicker back to locked), a permanent
    // personal best instead. A "6-0" set (a bagel) is counted the same
    // pass — `score` is already flipped so this player's own side leads
    // each set, so "6-0" always means they won it.
    let streak = 0, bestStreak = 0, bagelCount = 0;
    results.forEach((r) => {
      if (r.result === "W") { streak++; bestStreak = Math.max(bestStreak, streak); } else streak = 0;
      if ((r.score || "").split(", ").includes("6-0")) bagelCount++;
    });
    // Only archived (fully finished) seasons count — an ongoing unbeaten
    // run isn't "unbeaten all season" yet. A season snapshot has the same
    // teams/fixtures/playoffs shape a live league does, so
    // playerMatchHistory works on it unchanged.
    const MIN_UNBEATEN_MATCHES = 3;
    const unbeatenSeasons = (league.seasonHistory || [])
      .map((snap, idx) => {
        const snapRows = logic.playerMatchHistory(snap, claim.playerId, ratingsData);
        if (snapRows.length < MIN_UNBEATEN_MATCHES || snapRows.some((r) => r.result === "L")) return null;
        return { season: snap.season || (league.seasonHistory.length - idx), label: snap.label };
      })
      .filter(Boolean);
    // Whether this card's own "View your Season Wrapped" button has
    // anything to show yet — same rule the /wrapped route itself enforces
    // (an ended season with at least one match), computed here too so the
    // "Your leagues" chip can flag it without a separate round trip per
    // league.
    const wrappedAvailable = (league.seasonHistory || []).some((snap) => logic.playerMatchHistory(snap, claim.playerId).length > 0);
    const ratingEntry = ratingsData.players.get(identityOf(league.id, claim.playerId));
    // A compact "your tables" preview — the top of the table (capped) plus
    // your own row pinned below if you've dropped out of that range.
    // Computed twice: the real (finalized-only) standings, and a looser
    // "live" pass that also counts a score that's live on court right now
    // or was entered but not yet finalized — reusing computeStandings'
    // exact same math either way, just a different idea of "counts yet"
    // (see its includeFixture param). Diffed against each other for the
    // movement arrows. Skipped for a league that hasn't started, or has
    // too few teams to meaningfully rank.
    const TABLE_CAP = 6;
    let standings = null;
    if (!retired && leagueStatus(league) === "active" && league.teams.length > 1) {
      const officialRows = logic.computeStandings(league);
      const liveRows = logic.computeStandings(league, (f) => f.finalized || logic.fixtureScore(f).decided > 0);
      const officialRankById = new Map(officialRows.map((r, i) => [r.id, i + 1]));
      const ranked = liveRows.map((r, i) => {
        const rank = i + 1;
        const officialRank = officialRankById.get(r.id) || rank;
        return { id: r.id, name: r.name, logo: r.logo || "", points: r.points, rank, move: officialRank - rank, isMine: r.id === team.id };
      });
      const topRows = ranked.slice(0, TABLE_CAP);
      const myRow = ranked.find((r) => r.isMine);
      standings = {
        totalTeams: ranked.length,
        live: ranked.some((r) => r.move !== 0),
        // The client draws the "top 4 qualify" cutoff off this — passed
        // through as-is rather than a resolved boolean, since whether it
        // actually applies also depends on team count, which the client
        // already has via totalTeams.
        playoffFormat: league.playoffFormat || "none",
        topRows,
        myRow: myRow && myRow.rank > TABLE_CAP ? myRow : null,
      };
    }
    // This team's own match, right now, if one's actually on court — a
    // rubber with a start time and no finish yet. Checked across every
    // fixture (not just upcoming ones), since nothing marks a fixture
    // "live" ahead of time.
    let liveNow = null;
    for (const f of retired ? [] : logic.allFixturesOf(league)) {
      if (f.finalized || (f.teamA !== team.id && f.teamB !== team.id)) continue;
      const liveIdx = f.rubbers.findIndex((r) => r.startedAt && !r.completedAt);
      if (liveIdx === -1) continue;
      const oppTeam = league.teams.find((t) => t.id === (f.teamA === team.id ? f.teamB : f.teamA));
      liveNow = {
        fixtureId: f.id, label: fixtureLabel(league, f), seed: liveIdx + 1,
        opponentName: oppTeam ? oppTeam.name : "TBD", opponentLogo: oppTeam ? oppTeam.logo || "" : "",
        score: logic.rubberScoreText(f.rubbers[liveIdx]) || "",
      };
      break;
    }
    // Which physical court (if the admin's actually assigned one via Live
    // Court Control) each upcoming match lands on — the same join
    // findCourtScheduleCell already does for the score-completion side of
    // things, just read here instead of written.
    const upcoming = logic.findPlayerUpcoming(league, claim.playerId, ratingsData, identityOf).map((row) => {
      const cell = findCourtScheduleCell(league, row.fixtureId, row.rubberIdx);
      return { ...row, court: cell ? ((league.courtNames || [])[cell.court] || `Court ${cell.court + 1}`) : "" };
    });
    // Pair of the Week voting nudge — surfaced right here on My Profile
    // (not a push notification), only within the match-day + the day
    // after window, and only if this player hasn't already voted
    // individually or already been shown this exact prompt before. Marked
    // seen the moment it's returned once, durably on the account, so it
    // only ever shows once per league+round no matter how many times they
    // reload the page within that window.
    let potwPrompt = null;
    const roundsHere = retired || claim.leftAt ? [] : [...new Set(league.fixtures.map((f) => f.round))];
    for (const r of roundsHere) {
      const roundFixtures = league.fixtures.filter((f) => f.round === r);
      if (!roundFixtures.length || !roundFixtures.every((f) => f.finalized)) continue;
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(roundFixtures[0])]) || {};
      if (!sched.date) continue;
      const matchDate = new Date(sched.date + "T00:00:00");
      if (isNaN(matchDate)) continue;
      const windowEnd = new Date(matchDate.getTime() + 2 * 86400000); // exclusive end of "the day after"
      const now = new Date();
      if (now < matchDate || now >= windowEnd) continue;
      const seenKey = `${league.id}:${r}`;
      if ((user.seenPotwPrompts || []).includes(seenKey)) continue;
      const alreadyVoted = !!(league.potwVotes && league.potwVotes[r] && league.potwVotes[r][`player:${claim.playerId}`]);
      if (alreadyVoted) continue;
      if (!logic.potwEligiblePairs(league, r).length) continue;
      potwPrompt = { leagueId: league.id, leagueName: league.name, round: r };
      user.seenPotwPrompts = user.seenPotwPrompts || [];
      user.seenPotwPrompts.push(seenKey);
      changed = true;
      break;
    }
    // "I've left this team": the record stays linked (so the history, awards
    // and rating all stay on this profile) but nothing about it is current
    // any more — no upcoming matches, no live table, no vote or line-up nudge.
    const left = !!claim.leftAt || retired;
    cards.push({
      leagueId: league.id, leagueName: league.name,
      teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
      playerId: player.id, playerName: player.name, photo: player.photo || "",
      isPairs: league.format === "pairs",
      left, retired, leftAt: claim.leftAt || null,
      potwPrompt: left ? null : potwPrompt,
      upcoming: left ? [] : upcoming,
      // Same "flag only, fetch lazily" reasoning as the leagues hub's own
      // hasCourtPhoto — this response already carries every league a
      // claimed record touches, so embedding the actual image here would
      // repeat the exact payload-size problem that flag was built to avoid.
      hasCourtPhoto: !!league.courtPhoto,
      venueName: league.defaultVenue || "",
      standings: left ? null : standings,
      results,
      awards,
      championships,
      runnerUps,
      bestStreak,
      bagelCount,
      unbeatenSeasons,
      wrappedAvailable,
      rating: ratingEntry ? ratingEntry.rating : null,
      ratingPlayed: ratingEntry ? ratingEntry.played : 0,
      ratingProvisional: ratingEntry ? ratingEntry.played < logic.ELO_PROVISIONAL_GAMES : null,
      isTeamOwner: (team.ownerIds || []).includes(player.id),
      liveNow: left ? null : liveNow,
    });
    if (!left) addFixtureTeam(league, team);
    return true;
  });
  // Two records on the same team in the same league (a player entered twice on
  // a roster, say) are one person here: fold the later ones into the first card
  // so the team and league show once, with all of that person's matches. The
  // other records are listed on the card so they can still be unlinked.
  {
    const primary = new Map();
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const key = c.leagueId + ":" + c.teamId;
      const first = primary.get(key);
      if (!first) { primary.set(key, c); continue; }
      const seenRows = new Set(first.results.filter((r) => r.fixtureId).map((r) => r.fixtureId + ":" + r.seed));
      c.results.forEach((r) => { if (!r.fixtureId || !seenRows.has(r.fixtureId + ":" + r.seed)) first.results.push(r); });
      first.awards = first.awards.concat(c.awards);
      first.championships = first.championships.concat(c.championships);
      first.runnerUps = first.runnerUps.concat(c.runnerUps);
      first.bestStreak = Math.max(first.bestStreak, c.bestStreak);
      first.bagelCount += c.bagelCount;
      first.wrappedAvailable = first.wrappedAvailable || c.wrappedAvailable;
      first.potwPrompt = first.potwPrompt || c.potwPrompt;
      first.upcoming = first.upcoming.concat(c.upcoming.filter((u) => !first.upcoming.some((x) => x.fixtureId === u.fixtureId && x.rubberIdx === u.rubberIdx)));
      first.liveNow = first.liveNow || c.liveNow;
      (first.extraRecords = first.extraRecords || []).push({ playerId: c.playerId, playerName: c.playerName });
      cards.splice(i, 1);
      i--;
    }
  }
  (user.captaincies || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    const team = league && league.teams.find((t) => t.id === c.teamId);
    if (league && team) addFixtureTeam(league, team);
  });
  myLeagues.forEach(({ league, teamIds }) => {
    const splash = leagueFinalsSpectatorSplash(league, teamIds);
    if (splash) playoffSplash.push(splash);
  });
  fixtureCards.sort((a, b) => {
    if (a.date && b.date) return (a.date + a.time).localeCompare(b.date + b.time);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  if (changed) store.saveUser(user.id, user);
  res.json({ name: user.name, cards, fixtureCards, playoffSplash });
});

// News Room, aggregated across every league this account has a claimed
// record in — same "one profile, every league" idea as /players/profile,
// just for news posts instead of match history. A hidden league (data-only,
// feeds ratings, never shown anywhere else on the site) is skipped here too.
router.get("/players/news", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
  const leagueIds = [...new Set((user.claims || []).filter((c) => !c.leftAt).map((c) => c.leagueId).filter((id) => !hiddenLeagueIds.has(id)))];
  const posts = [];
  leagueIds.forEach((leagueId) => {
    const league = store.getLeague(leagueId);
    if (!league) return;
    (league.news || []).forEach((p) => posts.push({ ...p, photo: newsPostPhoto(p, league), leagueId: league.id, leagueName: league.name }));
  });
  res.json(sortNewsPosts(posts));
});

// Practice kit: a throwaway league with made-up teams, logos and players,
// kept off every public list (hidden) so it never reaches real players.
router.post("/admin/test-league", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Only the site admin can create a test league." });
  const index = store.getIndex();
  const n = index.filter((e) => e.isTest).length + 1;
  const league = newLeagueObj(`TEST · Auction practice ${n}`, "test@example.invalid", "teams", false);
  league.isTest = true;
  league.teams = testdata.buildTeams({ uid: logic.uid, genCode: () => genTeamCode(league) });
  store.saveLeague(league.id, league);
  index.push({ id: league.id, name: league.name, createdAt: league.createdAt, hidden: true, isTest: true });
  store.saveIndex(index);
  logAdminAction(`Created test league "${league.name}"`);
  res.json({ id: league.id, teams: league.teams.map((t) => ({ name: t.name, code: t.code })) });
});

router.post("/leagues", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Only the site admin can create leagues. Log in first." });
  const { name, adminEmail, format, singlesDecider } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "League name is required." });
  if (!adminEmail || !adminEmail.includes("@")) return res.status(400).json({ error: "A valid admin email is required." });
  if (format && !["teams", "pairs"].includes(format)) return res.status(400).json({ error: "Unknown league format." });
  const league = newLeagueObj(name.trim(), adminEmail, format, singlesDecider);
  store.saveLeague(league.id, league);
  const index = store.getIndex();
  index.push({ id: league.id, name: league.name, createdAt: league.createdAt });
  store.saveIndex(index);
  logAdminAction(`Created league "${league.name}"`);
  res.json({ id: league.id });
});

router.get("/leagues/:leagueId", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (guestWalledFor(req, league.id)) return res.json(walledPreview(league));
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
  // Live Court Control's own learned-duration log — a running average of
  // actual minutes played per closeness bucket (see matchPrediction), so
  // its "quick vs close" time estimate improves instead of staying a
  // fixed guess forever.
  if (!league.courtDurationStats) league.courtDurationStats = {};
  // The raw per-match log courtDurationStats is aggregated from — see
  // findCourtScheduleCell / the rubbers/:idx/complete route.
  if (!league.courtMatchLog) league.courtMatchLog = [];
  // Rubbers created before Live Court Control existed won't have these —
  // backfill so every fixture's rubbers can be addressed the same way.
  league.fixtures.forEach((f) => {
    (f.rubbers || []).forEach((r) => {
      if (r.startedAt === undefined) r.startedAt = null;
      if (r.completedAt === undefined) r.completedAt = null;
    });
  });
  if (league.tieringEnabled === undefined) league.tieringEnabled = false;
  if (!league.goldTierCount) league.goldTierCount = 0;
  // Migration: leagues from before this was its own setting used
  // goldTierCount (gold PLAYERS per team) to also decide how many seeds
  // were gold-eligible — keep that same effective seed count unchanged
  // until an admin deliberately sets goldMatchCount on its own.
  if (league.goldMatchCount === undefined) league.goldMatchCount = Math.max(1, Math.min(4, league.goldTierCount || 1));
  if (league.flatTierLabels === undefined) league.flatTierLabels = false;
  if (league.allowRoundsByDate === undefined) league.allowRoundsByDate = false;
  if (league.strength === undefined) league.strength = 0;
  if (!league.format) league.format = "teams";
  if (league.singlesDecider === undefined) league.singlesDecider = false;
  if (!league.groups) league.groups = [];
  if (!league.hallOfFame) league.hallOfFame = [];
  if (!league.registrationFeeCents) league.registrationFeeCents = 0;
  // League-wide kit badges — the admin's own main/secondary sponsor and
  // the Team Padel brand mark, shared across every team's kit (unlike a
  // team's own logo or sleeve sponsors, which live on team.kit instead).
  if (league.kitMainSponsor === undefined) league.kitMainSponsor = "";
  if (!league.kitMainSponsorPos) league.kitMainSponsorPos = { x: 50, y: 45 };
  if (league.kitSecondarySponsor === undefined) league.kitSecondarySponsor = "";
  if (!league.kitSecondarySponsorPos) league.kitSecondarySponsorPos = { x: 30, y: 22 };
  if (!league.kitTeamPadelLogoPos) league.kitTeamPadelLogoPos = { x: 50, y: 12 };
  // Lives on the leagues-index entry, not this document — surfaced here
  // (harmless either way) so the owner-only "hide from lists" toggle in
  // Admin knows its current state without a separate lookup.
  const indexEntry = store.getIndex().find((e) => e.id === league.id);
  league.hidden = !!(indexEntry && indexEntry.hidden);
  let migrated = syncPlayoffs(league);
  if (migrateLegacyKnockoutRounds(league)) migrated = true;
  // One-time backward-compat recovery for a season ended before this fix
  // (see /season/reset): that route used to leave potwVotes behind on the
  // live league instead of archiving them, so a Pair of the Week vote cast
  // in a season that's since ended can still be sitting here, keyed by a
  // round number the live league has since moved past. Move anything whose
  // round doesn't match one of the LIVE league's own current rounds — but
  // does match a round the most recently archived season actually played —
  // into that snapshot, where it belongs. Only for an archive made before
  // this fix (one with no potwVotes of its own already); skips silently
  // once migrated, or if a round number already collides with the live
  // season (nothing safe to disentangle there).
  if (league.seasonHistory && league.seasonHistory.length && league.potwVotes && Object.keys(league.potwVotes).length) {
    const mostRecent = league.seasonHistory[0];
    if (!mostRecent.potwVotes) {
      const liveRounds = new Set(league.fixtures.map((f) => f.round));
      const archivedRounds = new Set(mostRecent.fixtures.map((f) => f.round));
      const orphaned = {};
      Object.keys(league.potwVotes).forEach((r) => {
        if (!liveRounds.has(Number(r)) && archivedRounds.has(Number(r))) {
          orphaned[r] = league.potwVotes[r];
          delete league.potwVotes[r];
        }
      });
      if (Object.keys(orphaned).length) {
        mostRecent.potwVotes = orphaned;
        migrated = true;
      }
    }
  }
  // Teams created before per-team access codes existed won't have one —
  // give them one automatically so every captain can log in.
  league.teams.forEach((t) => {
    if (!t.code) { t.code = genTeamCode(league); migrated = true; }
    if (!t.paymentStatus) { t.paymentStatus = "unpaid"; migrated = true; }
    if (t.paymentMode === undefined) { t.paymentMode = null; migrated = true; }
    if (!t.pushSubscriptions) { t.pushSubscriptions = []; migrated = true; }
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
      incognito: !!entry.incognito,
      createdAt: entry.createdAt,
      teamCount: league ? league.teams.length : 0,
    };
  });
  res.json(leagues);
});

// Owner-only real push broadcast — every subscribed device in one league,
// or (no leagueId) every subscribed device across every league on the
// site. Hidden leagues (data-only imports, and the separate ELOPadel-owned
// "Community" league that happens to share this database) are never
// included, whether picked explicitly or via "every league" — same
// identity-safety boundary already drawn elsewhere for that data. Awaited
// and its real failure count returned, unlike notify()'s routine
// fire-and-forget send — a deliberate one-off broadcast is worth knowing
// actually went out.
router.post("/admin/push/broadcast", async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const { leagueId, message } = req.body || {};
  const text = (message || "").trim();
  if (!text) return res.status(400).json({ error: "Enter a message to send." });
  if (!getVapidPublicKey()) return res.status(503).json({ error: "Push notifications aren't set up on this server yet." });

  const hiddenIds = new Set(store.getIndex().filter((e) => e.hidden).map((e) => e.id));
  let targetEntries;
  if (leagueId) {
    if (hiddenIds.has(leagueId)) return res.status(400).json({ error: "Can't broadcast to a hidden league." });
    targetEntries = store.getIndex().filter((e) => e.id === leagueId);
    if (!targetEntries.length) return res.status(404).json({ error: "League not found." });
  } else {
    targetEntries = store.getIndex().filter((e) => !hiddenIds.has(e.id));
  }

  const jobs = [];
  targetEntries.forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    league.teams.forEach((team) => {
      (team.pushSubscriptions || []).forEach((sub) => jobs.push({ league, team, sub }));
    });
  });
  if (!jobs.length) return res.json({ ok: true, total: 0, sent: 0, failed: 0 });

  const { deadEndpoints, errors } = await sendPushToSubscriptions(jobs.map((j) => j.sub), { title: "Team Padel", body: text, type: "announcement" });
  if (deadEndpoints.length) {
    const dead = new Set(deadEndpoints);
    const touchedLeagues = new Map();
    jobs.forEach(({ league, team, sub }) => {
      if (dead.has(sub.endpoint)) {
        team.pushSubscriptions = team.pushSubscriptions.filter((s) => s.endpoint !== sub.endpoint);
        touchedLeagues.set(league.id, league);
      }
    });
    touchedLeagues.forEach((l) => store.saveLeague(l.id, l));
  }
  logAdminAction(`Sent push: ${text.length > 60 ? text.slice(0, 57) + "…" : text}`);
  res.json({ ok: true, total: jobs.length, sent: jobs.length - errors.length, failed: errors.length });
});

// Owner-only, read-only — powers the admin bar's "Control room" button on
// every screen: how many matches are live right now in each league that
// runs a court schedule, so the button can show a live count and take the
// owner straight to the one league that's playing (or list them when
// several are). Pairs leagues have no court board and never appear.
router.get("/admin/control-room", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const leagues = [];
  let totalLive = 0;
  store.getIndex().filter((e) => !e.hidden).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league || league.format === "pairs" || leagueStatus(league) !== "active") return;
    let live = 0;
    logic.allFixturesOf(league).forEach((f) => {
      if (f.finalized) return;
      f.rubbers.forEach((r) => { if (r.startedAt && !r.completedAt) live++; });
    });
    totalLive += live;
    leagues.push({ id: league.id, name: league.name, liveCount: live });
  });
  leagues.sort((a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name));
  res.json({ totalLive, leagues });
});

// Owner-only, read-only — powers the "Push notifications" stat card on the
// Admin tab (see renderPushStatsCard).
// How good the match predictions are, and how much to trust that — kept up
// to date by a background job (accuracy.js); this just reads the last result.
router.get("/admin/prediction-accuracy", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  const saved = store.getPredictionAccuracy();
  res.json({ latest: saved.latest, history: saved.history.slice(-12), running: accuracy.isRunning() });
});
// "Check now" — starts a fresh check in the background and returns straight
// away; the card polls until it lands.
router.post("/admin/prediction-accuracy/refresh", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  accuracy.refresh(store, { force: true });
  res.json({ ok: true, running: true });
});
router.get("/admin/push/stats", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const hiddenIds = new Set(store.getIndex().filter((e) => e.hidden).map((e) => e.id));
  const byLeague = [];
  let totalSubscriptions = 0, totalTeams = 0;
  store.getIndex().filter((e) => !hiddenIds.has(e.id)).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    const teamsWithPush = league.teams.filter((t) => (t.pushSubscriptions || []).length > 0);
    const subs = league.teams.reduce((sum, t) => sum + (t.pushSubscriptions || []).length, 0);
    if (subs > 0) byLeague.push({ leagueId: league.id, name: league.name, teamsSubscribed: teamsWithPush.length, deviceCount: subs });
    totalSubscriptions += subs;
    totalTeams += teamsWithPush.length;
  });
  res.json({ totalSubscriptions, totalTeamsWithAtLeastOneDevice: totalTeams, byLeague });
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
  logAdminAction(`${entry.hidden ? "Hid" : "Unhid"} league "${entry.name}"`);
  res.json({ ok: true, hidden: entry.hidden });
});

// The lighter-weight sibling of the route above — keeps a real, actively
// -run league off public discovery (same lists as hidden: the Leagues
// page, homepage teasers, "Join a league") without erasing it from
// search, a claimed player's own profile, or a captain's own session —
// see visibleIndexEntries' comment for the full hidden vs. incognito
// distinction. For a second city's leagues that aren't ready to advertise
// site-wide but are otherwise fully live.
router.put("/leagues/:leagueId/incognito", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const index = store.getIndex();
  const entry = index.find((l) => l.id === req.params.leagueId);
  if (!entry) return res.status(404).json({ error: "Not found." });
  entry.incognito = !!req.body.incognito;
  store.saveIndex(index);
  logAdminAction(`${entry.incognito ? "Made" : "Un-made"} league "${entry.name}" incognito`);
  res.json({ ok: true, incognito: entry.incognito });
});

router.delete("/leagues/:leagueId", requireAdmin, (req, res) => {
  // Best-effort — kit photos live in their own keys now (store.saveKitPhoto),
  // so deleting just the league record would leave every team's orphaned
  // behind forever otherwise.
  const league = store.getLeague(req.params.leagueId);
  if (league) Promise.all(league.teams.map((t) => store.deleteKitPhotosForTeam(league.id, t.id))).catch(() => {});
  store.deleteLeague(req.params.leagueId);
  const index = store.getIndex().filter((l) => l.id !== req.params.leagueId);
  store.saveIndex(index);
  req.session.destroy(() => {});
  res.json({ ok: true });
});

/* ---------- Auth ---------- */

router.get("/leagues/:leagueId/me", (req, res) => {
  if (isOwnerSession(req)) return res.json({ role: "admin", teamId: null });
  const u = resolveLeagueSession(req, req.params.leagueId);
  if (!u) return res.json({ role: "guest" });
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
// This now DOES grant real access on its own, not just display — see
// resolveLeagueSession (src/auth.js): a signed-in player account already
// recognized here as a team's captain can act as that team on any device
// without re-entering the code there too. That's read fresh from this
// same array on every single request rather than cached anywhere, so
// removing an entry here (see the captaincy-removal flow) revokes real
// access immediately, not just the on-screen badge.
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
  const val = code.replace(/[\s\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "").toUpperCase();
  const team = league.teams.find((t) => t.code === val);
  if (!team) return res.status(401).json({ error: "That team code wasn't recognised. Codes are 6 letters or numbers — check look-alikes such as S and 5, B and 8, or U and V, or ask your league admin to send it again." });
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
  const val = code.replace(/[\s\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "").toUpperCase();
  if (email !== undefined && email.trim() && !email.includes("@"))
    return res.status(400).json({ error: "Enter a valid email, or leave it blank." });

  const matches = [];
  // Every league except a hidden (import-only) one — an incognito league is a
  // real, running league, so its captains must be able to log in with their
  // code even though it's off public browsing. Only someone holding the code
  // gets anything from this.
  for (const entry of store.getIndex().filter((e) => !e.hidden)) {
    const league = store.getLeague(entry.id);
    if (!league) continue;
    const team = league.teams.find((t) => t.code === val);
    if (team) matches.push({ league, team });
  }
  if (matches.length === 0) return res.status(401).json({ error: "That team code wasn't recognised. Codes are 6 letters or numbers — check look-alikes such as S and 5, B and 8, or U and V, or ask your league admin to send it again." });
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
  if (req.body.logo !== undefined) {
    if (imageTooLarge(res, req.body.logo)) return;
    team.logo = req.body.logo;
  }
  if (req.body.name !== undefined) {
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: "Name is required." });
    if (league.teams.some((t) => t.id !== team.id && t.name.toLowerCase() === name.toLowerCase()))
      return res.status(400).json({ error: "A team with that name already exists." });
    team.name = name;
  }
  // Up to 2 of this team's own roster players, tagged as its "owner" —
  // who owns it, not who's logged in as its captain (that's still the
  // access code). Purely informational: grants no login or permissions
  // of its own. Picked from a dropdown (not free text) so it's always a
  // real player id on this exact team, never a name that drifts out of
  // sync with a rename or a since-removed player.
  if (req.body.ownerIds !== undefined) {
    const ids = Array.isArray(req.body.ownerIds) ? req.body.ownerIds.filter(Boolean) : [];
    if (ids.length > 2) return res.status(400).json({ error: "A team can have at most 2 owners." });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: "Pick two different players." });
    if (ids.some((id) => !team.players.some((p) => p.id === id)))
      return res.status(400).json({ error: "That player isn't on this team's roster." });
    team.ownerIds = ids;
  }
  // An arbitrary, admin-chosen string shared across leagues — not matched
  // by name, since two unrelated teams called "Aces" would otherwise get
  // merged by accident. Give the same club fielding two squads (an A team
  // in one league, a B team in another) the same clubId and their records
  // combine on the team page; leave it blank and nothing changes.
  if (req.body.clubId !== undefined) {
    team.clubId = String(req.body.clubId || "").trim().slice(0, 60) || null;
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Every OTHER league a clubId scan reaches into is filtered to non-hidden
// (a hidden league's existence/data shouldn't leak into a public team page
// just because its admin also set a matching clubId), but the league this
// request is already scoped to is always included even if it's hidden —
// the caller is already looking straight at it.
function teamsSharingClub(league, team) {
  if (!team.clubId) return [];
  const entries = [];
  store.getIndex().filter((entry) => !entry.hidden || entry.id === league.id).forEach((entry) => {
    const lg = entry.id === league.id ? league : store.getLeague(entry.id);
    if (!lg) return;
    (lg.teams || []).forEach((t) => {
      if (t.clubId !== team.clubId) return;
      entries.push({ leagueId: lg.id, leagueName: lg.name, teamId: t.id, teamName: t.name, teamLogo: t.logo || "" });
    });
  });
  return entries;
}
// This league's own Hall of Fame entries this team either won or was
// runner-up in — admin-curated (same source the player Trophy Room reads),
// matched by the frozen winnerTeamId/runnerUpTeamId rather than a roster
// lookup, since a team (unlike a player across seasons) keeps the same id.
function teamTrophiesIn(league, teamId) {
  return (league.hallOfFame || []).reduce((acc, e) => {
    if (e.winnerTeamId === teamId) acc.push({ season: e.season, label: e.label, role: "winner" });
    else if (e.runnerUpTeamId === teamId) acc.push({ season: e.season, label: e.label, role: "runnerUp" });
    return acc;
  }, []).sort((a, b) => b.season - a.season);
}
// Every finalized fixture this team has played in this league, newest
// first — the "tab for all matches played" behind the team card's Matches
// tab. `result` folds in matchWinner's own knockout-decider handling
// (see matchWinner) rather than a plain score compare, so a playoff tie
// settled on its 5th rubber shows the right side as the winner.
function teamMatchesIn(league, teamId) {
  return logic.allFixturesOf(league)
    .filter((f) => f.finalized && (f.teamA === teamId || f.teamB === teamId))
    .map((f) => {
      const isA = f.teamA === teamId;
      const opp = league.teams.find((t) => t.id === (isA ? f.teamB : f.teamA));
      const { winsA, winsB } = logic.fixtureScore(f);
      const myWins = isA ? winsA : winsB, oppWins = isA ? winsB : winsA;
      const winner = logic.matchWinner(f);
      const result = winner ? (winner === (isA ? "A" : "B") ? "W" : "L") : myWins === oppWins ? "D" : myWins > oppWins ? "W" : "L";
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      return {
        fixtureId: f.id, opponentName: opp ? opp.name : "TBD", opponentLogo: opp ? opp.logo || "" : "",
        score: `${myWins}-${oppWins}`, result, date: sched.date || "", venue: sched.venue || "",
      };
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
// A self-contained team snapshot — the cross-league Search teams directory
// (and the tab-switcher below, for a Club ID-linked team) has no
// already-loaded league payload to read from the way opening a team from
// inside its own Table tab does (see openTeamModal client-side), so it
// needs everything the team card shows in one fetch, the same role
// /leagues/:leagueId/players/:playerId/history plays for a player opened
// from cross-league context.
router.get("/leagues/:leagueId/teams/:teamId/profile", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const rows = logic.computeStandings(league);
  const idx = rows.findIndex((r) => r.id === team.id);
  const row = idx >= 0 ? rows[idx] : null;
  const ownerNames = (team.ownerIds || []).map((id) => (team.players.find((p) => p.id === id) || {}).name).filter(Boolean);
  const shared = teamsSharingClub(league, team);
  const otherLeagues = shared.filter((e) => !(e.leagueId === league.id && e.teamId === team.id));
  // Win/loss records don't actually combine well across leagues — different
  // opponents, different strength — so a combined team no longer gets a
  // summed played/won/lost line, just the tabs to flip between each
  // league's own (see otherLeagues above). Trophies are the one thing that
  // genuinely does add up regardless of league, so that's what the header
  // aggregates: every "winner" Hall of Fame entry across every linked
  // league, not just this one.
  const totalTrophyCount = otherLeagues.length
    ? shared.reduce((sum, e) => {
        const lg = e.leagueId === league.id ? league : store.getLeague(e.leagueId);
        if (!lg) return sum;
        return sum + teamTrophiesIn(lg, e.teamId).filter((t) => t.role === "winner").length;
      }, 0)
    : teamTrophiesIn(league, team.id).filter((t) => t.role === "winner").length;
  // Last season's finishing position — only once there's a most-recently-
  // archived season to read it from (see /leagues/:id/season-history,
  // which treats seasonHistory[0] the same way, newest first). A team
  // absent from that snapshot (added this season) just gets no position.
  let lastSeasonPosition = null;
  if (league.seasonHistory && league.seasonHistory.length) {
    const snap = league.seasonHistory[0];
    const snapRows = logic.computeStandings(snap);
    const snapIdx = snapRows.findIndex((r) => r.id === team.id);
    if (snapIdx >= 0) lastSeasonPosition = { rank: snapIdx + 1, teamCount: snapRows.length, season: seasonNumberOf(league.seasonHistory, snap), label: snap.label };
  }
  res.json({
    leagueId: league.id, leagueName: league.name,
    teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
    rank: idx >= 0 ? idx + 1 : null, teamCount: rows.length,
    stats: row ? { points: row.points, played: row.rubbersWon + row.rubbersLost, won: row.rubbersWon, diff: row.diff } : null,
    ownerNames,
    roster: team.players.map((p) => ({ id: p.id, name: p.name, gold: !!p.gold })),
    tieringEnabled: !!league.tieringEnabled,
    matches: teamMatchesIn(league, team.id),
    trophies: teamTrophiesIn(league, team.id),
    totalTrophyCount,
    lastSeasonPosition,
    otherLeagues: otherLeagues.sort((a, b) => a.leagueName.localeCompare(b.leagueName)),
  });
});

/* ---------- Team kit (captain-managed — upload the kit design, place
   sponsor logos on it, list who wants one and what size) ---------- */

router.put("/leagues/:leagueId/teams/:teamId/kit/photo", requireAdminOrCaptain((req) => req.params.teamId), async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const { side, image } = req.body || {};
  if (side !== "front" && side !== "back") return res.status(400).json({ error: "Invalid side." });
  if (imageTooLarge(res, image)) return;
  if (!team.kit) team.kit = defaultKit();
  // The actual bytes go to their own key (store.saveKitPhoto) — the
  // league's own record only ever keeps a boolean flag now, so a team's
  // kit photos stop costing anything on every other save of this league.
  await store.saveKitPhoto(league.id, team.id, side, image || "");
  team.kit[side] = !!image;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.put("/leagues/:leagueId/teams/:teamId/kit/logo", requireAdminOrCaptain((req) => req.params.teamId), async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const image = req.body && req.body.image;
  if (imageTooLarge(res, image)) return;
  if (!team.kit) team.kit = defaultKit();
  await store.saveKitPhoto(league.id, team.id, "logo", image || "");
  // A real upload is stored as true; an explicit removal is remembered as
  // null (not "") so it stays removed instead of falling back to the
  // team's own logo again on the very next load — see resolvedKit.
  team.kit.logo = image ? true : null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

const KIT_SPONSOR_SLOTS = ["sleeveLeft", "sleeveRight", "backSponsor1", "backSponsor2", "backSponsor3"];
router.put("/leagues/:leagueId/teams/:teamId/kit/sponsor", requireAdminOrCaptain((req) => req.params.teamId), async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const { slot, image } = req.body || {};
  if (!KIT_SPONSOR_SLOTS.includes(slot)) return res.status(400).json({ error: "Invalid sponsor slot." });
  if (imageTooLarge(res, image)) return;
  if (!team.kit) team.kit = defaultKit();
  await store.saveKitPhoto(league.id, team.id, slot, image || "");
  team.kit.sponsors[slot] = !!image;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// The Kit Designer's own lazy fetch — real photo bytes, only when it's
// actually opened (see kitSummary above for why the general team payload
// doesn't carry these).
router.get("/leagues/:leagueId/teams/:teamId/kit/full", requireAdminOrCaptain((req) => req.params.teamId), async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  res.json({ kit: await resolvedKit(league, team) });
});

// Percent coordinates (0-100), relative to whichever photo that badge sits
// on — set by dragging the badge on the actual uploaded photo client-side,
// so it lands in the right spot regardless of how that photo happens to be
// framed or cropped. size is a scale multiplier off the badge's own base
// size (1 = default), set by dragging its resize handle; clamped so a
// badge can't be dragged down to invisible or up past the photo.
const KIT_POSITION_KEYS = ["logo", "sleeveLeft", "sleeveRight", "backSponsor1", "backSponsor2", "backSponsor3"];
function clampBadgeSize(size) {
  const n = Number(size);
  return Number.isFinite(n) ? Math.max(0.5, Math.min(2.5, n)) : 1;
}
router.put("/leagues/:leagueId/teams/:teamId/kit/position", requireAdminOrCaptain((req) => req.params.teamId), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const { key, x, y, size } = req.body || {};
  if (!KIT_POSITION_KEYS.includes(key)) return res.status(400).json({ error: "Invalid position key." });
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return res.status(400).json({ error: "Invalid position." });
  if (!team.kit) team.kit = defaultKit();
  team.kit.positions[key] = { x: Math.max(0, Math.min(100, nx)), y: Math.max(0, Math.min(100, ny)), size: clampBadgeSize(size) };
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Replaces the whole order list in one call — simpler than per-row add/
// remove/edit endpoints for what's normally filled in once per season by
// one captain, not a frequently-edited live list.
router.put("/leagues/:leagueId/teams/:teamId/kit/orders", requireAdminOrCaptain((req) => req.params.teamId), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const incoming = Array.isArray(req.body.orders) ? req.body.orders : [];
  const orders = incoming
    .map((o) => ({ id: (o && o.id) || logic.uid(), name: String((o && o.name) || "").trim().slice(0, 60), size: String((o && o.size) || "").trim().slice(0, 10) }))
    .filter((o) => o.name);
  if (!team.kit) team.kit = defaultKit();
  team.kit.orders = orders;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Free text for the kit supplier — fabric, fit, a deadline, anything that
// doesn't fit a badge or a size. Shown on the kit-share page along with
// everything else, so a supplier reading that link sees it too.
router.put("/leagues/:leagueId/teams/:teamId/kit/notes", requireAdminOrCaptain((req) => req.params.teamId), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (!team.kit) team.kit = defaultKit();
  team.kit.notes = String((req.body && req.body.notes) || "").trim().slice(0, 500);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Where a captain is in the guided kit setup (step 1 to 4), and whether they
// have finished it. A team with no `setup` at all that already has kit content
// is treated as done by the client, so nobody who set their kit up before this
// existed is pushed back through it.
router.put("/leagues/:leagueId/teams/:teamId/kit/setup", requireAdminOrCaptain((req) => req.params.teamId), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const step = Number(req.body && req.body.step);
  if (!Number.isInteger(step) || step < 1 || step > 4) return res.status(400).json({ error: "Step must be 1 to 4." });
  if (!team.kit) team.kit = defaultKit();
  team.kit.setup = { step, done: !!(req.body && req.body.done) };
  store.saveLeague(league.id, league);
  res.json({ ok: true, setup: team.kit.setup });
});

// The league's own sponsor badges — unlike a team's logo or sleeve
// sponsors, these are set once by the admin and shown on every team's
// kit (front-centre and left chest), so they're stored on the league,
// not the team.
router.put("/leagues/:leagueId/kit-main-sponsor", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (imageTooLarge(res, req.body && req.body.image)) return;
  league.kitMainSponsor = (req.body && req.body.image) || "";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.put("/leagues/:leagueId/kit-secondary-sponsor", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (imageTooLarge(res, req.body && req.body.image)) return;
  league.kitSecondarySponsor = (req.body && req.body.image) || "";
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
const KIT_LEAGUE_SPONSOR_POSITION_FIELD = {
  mainSponsor: "kitMainSponsorPos",
  secondarySponsor: "kitSecondarySponsorPos",
  teamPadelLogo: "kitTeamPadelLogoPos",
};
router.put("/leagues/:leagueId/kit-sponsor-position", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { key, x, y, size } = req.body || {};
  const field = KIT_LEAGUE_SPONSOR_POSITION_FIELD[key];
  if (!field) return res.status(400).json({ error: "Invalid position key." });
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return res.status(400).json({ error: "Invalid position." });
  league[field] = { x: Math.max(0, Math.min(100, nx)), y: Math.max(0, Math.min(100, ny)), size: clampBadgeSize(size) };
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// One link, every team's kit — for handing the whole league's kit designs
// to an outside kit supplier who has no login at all. Same "random token
// is the only auth" shape as a pay-link, just league-wide and admin-issued
// rather than per-player. Creates the token on first request, then keeps
// returning the same one (a supplier who bookmarks or re-visits the link
// shouldn't have it silently stop working) until explicitly revoked below.
router.get("/leagues/:leagueId/kit-share-link", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (!league.kitShareToken) {
    league.kitShareToken = crypto.randomBytes(16).toString("hex");
    store.saveLeague(league.id, league);
  }
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/#kit-share/${league.id}/${league.kitShareToken}` });
});
router.post("/leagues/:leagueId/kit-share-link/revoke", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  league.kitShareToken = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Public read (no session) — the token itself is the only thing gating
// this, same as a pay-link. Hands back every team's kit design (photos,
// logo, sponsors and their placement, who's ordering) so a supplier can
// see and download everything from one link without ever needing an
// account or captain code.
router.get("/leagues/:leagueId/kit-share/:token", async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league || !league.kitShareToken || league.kitShareToken !== req.params.token) {
    return res.status(404).json({ error: "This link is invalid or has been revoked." });
  }
  const teams = await Promise.all(league.teams.map(async (t) => ({ id: t.id, name: t.name, kit: await resolvedKit(league, t) })));
  res.json({
    leagueId: league.id, leagueName: league.name, teams,
    mainSponsor: league.kitMainSponsor || "", mainSponsorPos: league.kitMainSponsorPos || { x: 50, y: 45 },
    secondarySponsor: league.kitSecondarySponsor || "", secondarySponsorPos: league.kitSecondarySponsorPos || { x: 30, y: 22 },
    teamPadelLogoPos: league.kitTeamPadelLogoPos || { x: 50, y: 12 },
  });
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
router.put("/leagues/:leagueId/teams/:teamId/players/:playerId/photo", async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const player = team.players.find((p) => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: "Player not found." });

  const isAdmin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
  const isCaptain = u && u.leagueId === league.id && u.role === "captain" && u.teamId === team.id;
  let isOwnProfile = false;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    isOwnProfile = !!(account && (account.claims || []).some((c) => c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
  }
  if (!isAdmin && !isCaptain && !isOwnProfile) return res.status(403).json({ error: "Not allowed." });
  if (imageTooLarge(res, req.body.photo)) return;

  const photo = req.body.photo || "";
  player.photo = photo;
  await store.savePlayerPhoto(league.id, player.id, photo);
  const touchedLeagues = new Map([[league.id, league]]);
  // A profile photo belongs to the whole person, not just this one
  // league's roster row — once this record is claimed, the same photo
  // carries to every other league that account is claimed into too, same
  // "one person, every claim" idea the ratings engine's identityOf already
  // uses. An unclaimed record has no account to fan out to, so it just
  // keeps the plain single-league behavior.
  if (player.claimedByUserId) {
    const account = store.getUser(player.claimedByUserId);
    for (const c of (account ? account.claims || [] : [])) {
      const otherLeague = touchedLeagues.get(c.leagueId) || store.getLeague(c.leagueId);
      if (!otherLeague) continue;
      const otherTeam = otherLeague.teams.find((t) => t.id === c.teamId);
      const otherPlayer = otherTeam && otherTeam.players.find((p) => p.id === c.playerId);
      if (!otherPlayer) continue;
      otherPlayer.photo = photo;
      await store.savePlayerPhoto(otherLeague.id, otherPlayer.id, photo);
      touchedLeagues.set(otherLeague.id, otherLeague);
    }
  }
  touchedLeagues.forEach((l) => store.saveLeague(l.id, l));
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

// Public — it's a public key by design (that's the whole point of the
// VAPID key PAIR: the public half is safe to hand to any client, only the
// private half server-side ever signs anything). No leagueId scoping needed
// either, since there's exactly one key pair for the whole deployment, but
// it lives under /leagues/:leagueId for symmetry with the subscribe route
// right below, which the client calls in the same breath.
router.get("/leagues/:leagueId/push/vapid-public-key", (req, res) => {
  res.json({ key: getVapidPublicKey() });
});

router.post(
  "/leagues/:leagueId/teams/:teamId/push-subscribe",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const subscription = req.body.subscription;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Invalid subscription." });
    if (!team.pushSubscriptions) team.pushSubscriptions = [];
    if (!team.pushSubscriptions.some((s) => s.endpoint === subscription.endpoint)) {
      team.pushSubscriptions.push(subscription);
      store.saveLeague(league.id, league);
    }
    res.json({ ok: true });
  }
);

router.post(
  "/leagues/:leagueId/teams/:teamId/push-unsubscribe",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const endpoint = req.body.endpoint;
    team.pushSubscriptions = (team.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

// Sends one push to just the caller's own current subscription (identified
// by its endpoint, not the whole team) — a way to actually verify push
// works end-to-end without needing a second captain to trigger a real
// notify() event. Real errors (a genuinely dead endpoint, say) are
// surfaced back to the client rather than silently swallowed the way
// notify()'s fire-and-forget send is, since this IS the diagnostic.
router.post(
  "/leagues/:leagueId/teams/:teamId/push-test",
  requireAdminOrCaptain((req) => req.params.teamId),
  async (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const endpoint = req.body.endpoint;
    const sub = (team.pushSubscriptions || []).find((s) => s.endpoint === endpoint);
    if (!sub) return res.status(404).json({ error: "This device isn't subscribed yet." });
    if (!getVapidPublicKey()) return res.status(503).json({ error: "Push notifications aren't set up on this server yet." });
    // An optional custom body — lets whoever's testing put something
    // specific and recognizable in it ("mentions tonight's venue", say),
    // rather than always getting the same generic line every time.
    const customBody = typeof req.body.message === "string" ? req.body.message.trim().slice(0, 200) : "";
    const { deadEndpoints, errors } = await sendPushToSubscriptions([sub], {
      title: league.name,
      body: customBody || "Test notification — if you're seeing this, push is working.",
      type: "test",
    });
    if (deadEndpoints.length) {
      team.pushSubscriptions = team.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
      store.saveLeague(league.id, league);
      return res.status(410).json({ error: "That subscription is no longer valid — try turning notifications off and on again." });
    }
    if (errors.length) return res.status(502).json({ error: "Push service rejected it: " + errors[0].message });
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

// The newest archived copy of every team that played in an earlier season of
// this league but isn't in the live league now — what "Past teams" lists and
// what "Bring back" restores from.
function pastTeamsOf(league) {
  const liveIds = new Set(league.teams.map((t) => t.id));
  const found = new Map();
  (league.seasonHistory || []).forEach((snap) => { // newest first, so the first hit per team is its latest
    (snap.teams || []).forEach((t) => {
      if (liveIds.has(t.id) || found.has(t.id)) return;
      found.set(t.id, { team: t, season: snap.season, label: snap.label });
    });
  });
  return [...found.values()];
}
router.delete("/leagues/:leagueId/teams/:teamId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams are locked once the season has started." });
  // Whether this team already has a season in the archive — i.e. whether its
  // history outlives the removal (and it can be brought back later).
  const kept = (league.seasonHistory || []).some((snap) => (snap.teams || []).some((t) => t.id === req.params.teamId));
  league.teams = league.teams.filter((t) => t.id !== req.params.teamId);
  store.saveLeague(league.id, league);
  store.deleteKitPhotosForTeam(league.id, req.params.teamId).catch(() => {}); // best-effort cleanup
  res.json({ ok: true, kept });
});
router.get("/leagues/:leagueId/past-teams", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  res.json(pastTeamsOf(league).map(({ team, season, label }) => ({
    id: team.id, name: team.name, hasLogo: !!team.logo, playerCount: (team.players || []).length, season, label: label || "",
  })));
});
// Brings a team from an earlier season back into this one's setup: same team
// id (so every player's linked record and the team's history carry straight
// on), with its roster, logo and captain code as they were.
router.post("/leagues/:leagueId/teams/:teamId/restore", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (leagueStatus(league) !== "setup") return res.status(400).json({ error: "Teams can only be brought back before the season starts." });
  const hit = pastTeamsOf(league).find((x) => x.team.id === req.params.teamId);
  if (!hit) return res.status(404).json({ error: "That team isn't in this league's past seasons." });
  const old = hit.team;
  if (league.teams.some((t) => t.name.toLowerCase() === old.name.toLowerCase()))
    return res.status(400).json({ error: `A team called ${old.name} is already in this season.` });
  const team = JSON.parse(JSON.stringify(old));
  team.groupId = null;
  // Same code, so the captain can log straight back in — unless another team
  // has taken it since.
  if (!team.code || codeInUse(team.code)) team.code = genTeamCode(league);
  league.teams.push(team);
  store.saveLeague(league.id, league);
  res.json({ ok: true, id: team.id, code: team.code });
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

/* ---------- Hall of Fame: past-season champions, admin-picks-the-team —
   both winner and runner-up are real team references (so either can link
   to that team's roster), not free text. Only the winner's roster
   propagates a trophy onto its players' own profiles — runner-up is just a
   record, nothing "won". ---------- */

// Whichever roster actually existed for that season — the archived
// snapshot if that season's already been ended (see season/reset), or the
// live league if this entry is for the season still in progress. Frozen
// onto the entry itself at save time (name + full roster), so a later
// rename, roster change, or even deleting the team never breaks what
// already got recorded as history.
function seasonTeamSource(league, season) {
  const history = league.seasonHistory || [];
  const snapshot = history.find((s) => seasonNumberOf(history, s) === season);
  return snapshot || league;
}

// Hall of Fame entries added before roster-linking existed (this site's two
// oldest leagues have a batch each) only ever recorded the winner as free
// text, e.g. "Ahmed Khota & Hussain Mohamedy" — no winnerRoster at all, so
// exact-id matching alone silently credits nobody. Falls back to matching
// the player's own name against that text, but only a whole "&"/"/"-
// separated segment (not a substring) — "Ahmed" alone shouldn't match
// "Ahmed Khota", and this never runs at all once an entry actually has a
// roster, so two different people sharing a name can't cross-credit each
// other there.
function hofWinnerNameMatch(winnerText, playerName) {
  if (!winnerText || !playerName) return false;
  const target = playerName.trim().toLowerCase();
  return winnerText.split(/[&/]/).some((part) => part.trim().toLowerCase() === target);
}
function freezeHofTeam(league, season, teamId) {
  const team = seasonTeamSource(league, season).teams.find((t) => t.id === teamId);
  if (!team) return null;
  return { teamId, name: team.name, logo: team.logo || "", roster: team.players.map((p) => ({ id: p.id, name: p.name })) };
}
router.get("/leagues/:leagueId/hall-of-fame/teams-for-season/:season", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const season = Number(req.params.season);
  if (!Number.isInteger(season) || season < 1) return res.status(400).json({ error: "Invalid season." });
  const source = seasonTeamSource(league, season);
  res.json({ teams: source.teams.map((t) => ({ id: t.id, name: t.name })) });
});
router.post("/leagues/:leagueId/hall-of-fame", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const season = Number(req.body.season);
  const label = (req.body.label || "").trim();
  const winnerTeamId = (req.body.winnerTeamId || "").trim();
  const runnerUpTeamId = (req.body.runnerUpTeamId || "").trim();
  if (!Number.isInteger(season) || season < 1) return res.status(400).json({ error: "Enter a valid season number." });
  if (!label) return res.status(400).json({ error: "Title is required." });
  if (!winnerTeamId) return res.status(400).json({ error: "Choose a winning team." });
  const winner = freezeHofTeam(league, season, winnerTeamId);
  if (!winner) return res.status(400).json({ error: "That team isn't part of this season." });
  let runnerUp = null;
  if (runnerUpTeamId) {
    runnerUp = freezeHofTeam(league, season, runnerUpTeamId);
    if (!runnerUp) return res.status(400).json({ error: "That runner-up team isn't part of this season." });
  }
  if (!league.hallOfFame) league.hallOfFame = [];
  const entry = {
    id: logic.uid(), season, label,
    winnerTeamId, winner: winner.name, winnerLogo: winner.logo, winnerRoster: winner.roster,
    runnerUpTeamId: runnerUpTeamId || null, runnerUp: runnerUp ? runnerUp.name : null, runnerUpLogo: runnerUp ? runnerUp.logo : "", runnerUpRoster: runnerUp ? runnerUp.roster : null,
  };
  league.hallOfFame.push(entry);
  store.saveLeague(league.id, league);
  res.json({ id: entry.id });
});

router.put("/leagues/:leagueId/hall-of-fame/:entryId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const entry = (league.hallOfFame || []).find((e) => e.id === req.params.entryId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  if (req.body.label !== undefined) {
    const label = req.body.label.trim();
    if (!label) return res.status(400).json({ error: "Title is required." });
    entry.label = label;
  }
  const nextSeason = req.body.season !== undefined ? Number(req.body.season) : entry.season;
  if (!Number.isInteger(nextSeason) || nextSeason < 1) return res.status(400).json({ error: "Enter a valid season number." });
  const nextWinnerTeamId = req.body.winnerTeamId !== undefined ? req.body.winnerTeamId.trim() : entry.winnerTeamId;
  // Re-freeze whenever the season or the team itself actually changed — an
  // edit to just the label leaves the frozen roster exactly as it was.
  if (nextSeason !== entry.season || nextWinnerTeamId !== entry.winnerTeamId) {
    const winner = freezeHofTeam(league, nextSeason, nextWinnerTeamId);
    if (!winner) return res.status(400).json({ error: "That team isn't part of this season." });
    entry.winnerTeamId = nextWinnerTeamId;
    entry.winner = winner.name;
    entry.winnerLogo = winner.logo;
    entry.winnerRoster = winner.roster;
  }
  if (req.body.runnerUpTeamId !== undefined) {
    const nextRunnerUpTeamId = req.body.runnerUpTeamId.trim();
    if (!nextRunnerUpTeamId) {
      entry.runnerUpTeamId = null; entry.runnerUp = null; entry.runnerUpLogo = ""; entry.runnerUpRoster = null;
    } else if (nextRunnerUpTeamId !== entry.runnerUpTeamId || nextSeason !== entry.season) {
      const runnerUp = freezeHofTeam(league, nextSeason, nextRunnerUpTeamId);
      if (!runnerUp) return res.status(400).json({ error: "That runner-up team isn't part of this season." });
      entry.runnerUpTeamId = nextRunnerUpTeamId;
      entry.runnerUp = runnerUp.name;
      entry.runnerUpLogo = runnerUp.logo;
      entry.runnerUpRoster = runnerUp.roster;
    }
  }
  entry.season = nextSeason;
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
  const u = resolveLeagueSession(req, league.id);
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
  const goldSlots = Math.max(0, Math.min(4, league.goldMatchCount || 0));
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
  const myTeam = league.teams.find((t) => t.id === (side === "A" ? f.teamA : f.teamB));
  const goldIds = myTeam ? new Set(myTeam.players.filter((p) => p.gold).map((p) => p.id)) : null;
  const firstSilverRound = rounds.findIndex((r) => r && r.tier === "silver");
  const silverGoldAllowed = roundIdx === firstSilverRound ? goldInSilverMax(league) : 0;
  const result = logic.validateRoundPair(f[selKey].pairs, roundIdx, pair, !!req.body.confirmDoubleUp, round.tier, goldIds, silverGoldAllowed);
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

// Deleting a player who's already played breaks real match history —
// their id stays referenced in every finalized selection, so their name
// silently disappears from results, stats, and Recent form everywhere
// that history is looked up by id, instead of erroring loudly. The PUT
// route above exists precisely so a mistaken name gets corrected in
// place without losing that history; delete stays safe for someone
// added and never actually selected into a match.
router.delete(
  "/leagues/:leagueId/teams/:teamId/players/:playerId",
  requireAdminOrCaptain((req) => req.params.teamId),
  (req, res) => {
    const league = store.getLeague(req.params.leagueId);
    const team = league.teams.find((t) => t.id === req.params.teamId);
    if (!team) return res.status(404).json({ error: "Team not found." });
    const player = team.players.find((p) => p.id === req.params.playerId);
    if (!player) return res.status(404).json({ error: "Player not found." });
    const hasPlayed = logic.allFixturesOf(league).some((f) =>
      (f.selectionA.pairs || []).flat().includes(player.id) || (f.selectionB.pairs || []).flat().includes(player.id)
    );
    if (hasPlayed) {
      return res.status(400).json({
        error: `${player.name} has already played a match — deleting them would break that history. Fix a typo by renaming instead, or just leave them off future line-ups if they've left the team.`,
      });
    }
    team.players = team.players.filter((p) => p.id !== req.params.playerId);
    // Roster changes weren't logged at all before this — the only reason
    // "who deleted this player" is answerable going forward.
    logAudit(league, req, null, "player_delete", { playerName: player.name, teamName: team.name });
    store.saveLeague(league.id, league);
    res.json({ ok: true });
  }
);

// Between seasons a player can be taken off a team without being deleted (he
// goes into the league's "no team yet" list, with his history, photo and
// account link intact) or moved straight to another team. Setup only, since
// mid-season a roster change would rewrite who played what.
function movePlayerBetweenTeams(league, player, fromTeam, toTeam) {
  // Whatever he was on the old team doesn't carry: not an owner, not gold.
  if (fromTeam) {
    fromTeam.players = fromTeam.players.filter((p) => p.id !== player.id);
    fromTeam.ownerIds = (fromTeam.ownerIds || []).filter((id) => id !== player.id);
  }
  league.freeAgents = (league.freeAgents || []).filter((p) => p.id !== player.id);
  player.gold = false;
  // A new team, a new fee: last season's payment record doesn't follow him.
  player.paymentStatus = "unpaid"; player.paymentMethod = null; player.paymentRef = null; player.paidAt = null;
  player.paidCents = 0; player.payments = []; player.coveredByTeam = false;
  if (toTeam) {
    delete player.removedFromTeamId; delete player.removedAt;
    toTeam.players.push(player);
  } else {
    player.removedFromTeamId = fromTeam ? fromTeam.id : player.removedFromTeamId || null;
    player.removedAt = Date.now();
    league.freeAgents.push(player);
  }
  // Accounts linked to him follow him to the new team.
  const oldTeamId = fromTeam ? fromTeam.id : player.removedFromTeamId;
  if (toTeam) {
    store.getUsersIndex().forEach(({ id }) => {
      const user = store.getUser(id);
      if (!user || !(user.claims || []).some((c) => c.leagueId === league.id && c.playerId === player.id)) return;
      const seen = new Set();
      user.claims = user.claims.map((c) => (c.leagueId === league.id && c.playerId === player.id ? { ...c, teamId: toTeam.id } : c))
        .filter((c) => { const k = c.leagueId + ":" + c.teamId + ":" + c.playerId; if (seen.has(k)) return false; seen.add(k); return true; });
      store.saveUser(user.id, user);
    });
  }
  return oldTeamId;
}
function requireSetupTeamLeague(league, res) {
  if (league.format === "pairs") { res.status(400).json({ error: "Moving players between teams isn't available for a Vibora league." }); return false; }
  if (leagueStatus(league) !== "setup") { res.status(400).json({ error: "Players can be moved between seasons, before the new season starts." }); return false; }
  return true;
}
router.post("/leagues/:leagueId/teams/:teamId/players/:playerId/move", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (!requireSetupTeamLeague(league, res)) return;
  const from = league.teams.find((t) => t.id === req.params.teamId);
  const player = from && from.players.find((p) => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: "Player not found on that team." });
  const toId = req.body && req.body.toTeamId;
  const to = toId ? league.teams.find((t) => t.id === toId) : null;
  if (toId && !to) return res.status(404).json({ error: "That team isn't in this league." });
  if (to && to.id === from.id) return res.status(400).json({ error: "He's already on that team." });
  if (to && to.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) return res.status(400).json({ error: `${to.name} already has a player called ${player.name}.` });
  movePlayerBetweenTeams(league, player, from, to);
  logAudit(league, req, null, to ? "player_transfer" : "player_remove_from_team", { playerName: player.name, teamName: from.name, toTeamName: to ? to.name : null });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Puts someone from the "no team yet" list on a team.
router.post("/leagues/:leagueId/free-agents/:playerId/assign", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (!requireSetupTeamLeague(league, res)) return;
  const player = (league.freeAgents || []).find((p) => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: "Player not found." });
  const to = league.teams.find((t) => t.id === (req.body && req.body.toTeamId));
  if (!to) return res.status(404).json({ error: "Choose a team." });
  if (to.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) return res.status(400).json({ error: `${to.name} already has a player called ${player.name}.` });
  movePlayerBetweenTeams(league, player, null, to);
  logAudit(league, req, null, "player_assign", { playerName: player.name, toTeamName: to.name });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

/* ---------- Admin hub (one page for every league) ----------
   Notes, player payments, sponsor money, court bills, follow-ups and kit
   deliveries in one place. Site owner only. Every item records which admin
   created or last changed it, by name. */
// The name to put on what an admin does: the player account they're signed in
// with if any, otherwise a name they've set for this session.
function adminActorName(req) {
  const pu = req.session && req.session.playerUser;
  const user = pu && store.getUser(pu.id);
  if (user && user.name) return user.name;
  if (req.session && req.session.adminName) return req.session.adminName;
  return "Admin";
}
function requireOwnerSession(req, res, next) {
  if (!req.session || !req.session.isOwner) return res.status(403).json({ error: "Admin login required." });
  next();
}
// The leagues Team Padel runs itself aren't managed through the Note Machine.
// Anything already filed against them stays saved, just out of sight here.
function hubExcludedLeague(name) { return /premier league|business class/i.test(String(name || "")); }
function hubExcludedLeagueIds() {
  return new Set(store.getIndex().filter((e) => hubExcludedLeague(e.name)).map((e) => e.id));
}
const HUB_TYPES = ["note", "payment", "sponsor", "court", "kit", "followup"];
const HUB_DONE_BY = ["ZG", "ID", "JN"];
const HUB_PRIORITIES = ["urgent", "high", "normal", "low"];
// Categories down the left of the Note Machine. Anyone can add more; it
// starts with Tasks and Reminders.
const HUB_CATEGORY_COLORS = ["#579BFC", "#A25DDC", "#FF7575", "#9CD326", "#CAB641", "#66CCFF", "#FF158A", "#7F5347", "#037F4C", "#BB3354"];
const HUB_DEFAULT_CATEGORIES = [{ id: "tasks", name: "Tasks", color: HUB_CATEGORY_COLORS[0] }, { id: "reminders", name: "Reminders", color: HUB_CATEGORY_COLORS[1] }];
function hubCategories(hub) {
  if (!Array.isArray(hub.categories)) hub.categories = HUB_DEFAULT_CATEGORIES.map((c) => ({ ...c, createdAt: Date.now() }));
  // Anything without a colour (made before categories had them) gets the next free one.
  hub.categories.forEach((c, i) => { if (!c.color) c.color = HUB_CATEGORY_COLORS[i % HUB_CATEGORY_COLORS.length]; });
  return hub.categories;
}
// A note that says "remind me…" or "task: …" lands in that category on its own.
function guessHubCategoryId(text, categories) {
  const t = String(text || "").toLowerCase();
  const has = (id) => categories.some((c) => c.id === id);
  if (/\bremind(er|ers|me)?\b/.test(t) && has("reminders")) return "reminders";
  if (/\b(task|todo|to-do|to do)\b/.test(t) && has("tasks")) return "tasks";
  return null;
}
const HUB_STAGES = {
  kit: ["ordered", "received", "handed", "problem"],
  sponsor: ["pitched", "agreed", "invoiced", "paid"],
};
const HUB_MONEY = { payment: "in", sponsor: "in", court: "out" };
// Sponsors come in three kinds: a team's own, a league's, or a region's.
const SPONSOR_SCOPES = ["team", "league", "region"];
function guessHubType(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(sponsor|sponsors|sponsorship|invoice|invoiced)\b/.test(t)) return "sponsor";
  if (/\b(court|courts|venue|hire|booking|bookings)\b/.test(t)) return "court";
  if (/\b(kit|kits|shirt|shirts|jersey|jerseys|box|boxes|delivery|printer|printing|received)\b/.test(t)) return "kit";
  if (/\b(chase|follow up|follow-up|followup|remind|reminder|call|email|ask|check with|waiting on)\b/.test(t)) return "followup";
  if (/\b(paid|pay|pays|owe|owes|owing|eft|deposit|instalment|installment)\b|\br\s?\d/.test(t)) return "payment";
  return "note";
}
// "R 3 200", "R3200", "R1,500.50" → cents (null when there's no amount).
function parseHubAmountCents(text) {
  const m = String(text || "").match(/\br\s?(\d[\d\s,]*(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
// today / tomorrow / a weekday name → yyyy-mm-dd (next one), else null.
function parseHubDue(text) {
  const t = String(text || "").toLowerCase();
  const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }); };
  if (/\btoday\b/.test(t)) return day(0);
  if (/\btomorrow\b/.test(t)) return day(1);
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const idx = names.findIndex((n) => new RegExp("\\b" + n.slice(0, 3) + "(" + n.slice(3) + ")?\\b").test(t));
  if (idx === -1) return null;
  const todayIdx = new Date(day(0) + "T12:00:00").getDay();
  return day(((idx - todayIdx + 7) % 7) || 7);
}
function hubItemView(item) {
  const paid = (item.payments || []).reduce((t, x) => t + x.cents, 0);
  return { ...item, paidCents: paid };
}
function cleanHubText(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }
function applyHubFields(item, b, league, actor) {
  if (b.title !== undefined) item.title = cleanHubText(b.title, 200);
  if (b.text !== undefined) item.text = cleanHubText(b.text, 2000);
  if (b.leagueId !== undefined) item.leagueId = b.leagueId && store.getLeague(b.leagueId) && !hubExcludedLeagueIds().has(b.leagueId) ? b.leagueId : null;
  if (b.teamId !== undefined) item.teamId = b.teamId || null;
  if (b.playerId !== undefined) item.playerId = b.playerId || null;
  if (b.amountRands !== undefined) {
    const c = Math.round(Number(b.amountRands) * 100);
    item.amountCents = Number.isFinite(c) && c > 0 ? c : null;
  }
  if (b.dueDate !== undefined) item.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate)) ? b.dueDate : null;
  if (b.qty !== undefined) { const q = Math.round(Number(b.qty)); item.qty = Number.isFinite(q) && q > 0 ? q : null; }
  if (b.status !== undefined) {
    item.status = b.status === "done" ? "done" : "open";
    // Who ticked it off (the "Done by" column); cleared if it's reopened.
    if (item.status === "done") { if (!item.doneBy) { item.doneBy = HUB_DONE_BY.includes(b.doneBy) ? b.doneBy : (actor || "Admin"); item.doneAt = Date.now(); } } else { delete item.doneBy; delete item.doneAt; }
  }
  // "Done by" is one of the three people who work the board.
  if (b.doneBy !== undefined && item.status === "done" && HUB_DONE_BY.includes(b.doneBy)) item.doneBy = b.doneBy;
  if (b.pinned !== undefined) item.pinned = !!b.pinned;
  if (b.priority !== undefined && HUB_PRIORITIES.includes(b.priority)) item.priority = b.priority;
  if (b.categoryId !== undefined) item.categoryId = b.categoryId && hubCategories(store.getAdminHub()).some((c) => c.id === b.categoryId) ? b.categoryId : null;
  if (b.sponsorScope !== undefined && SPONSOR_SCOPES.includes(b.sponsorScope)) item.sponsorScope = b.sponsorScope;
  if (b.region !== undefined) item.region = cleanHubText(b.region, 80) || null;
  if (b.stage !== undefined && HUB_STAGES[item.type] && HUB_STAGES[item.type].includes(b.stage)) item.stage = b.stage;
  return item;
}
router.get("/admin/hub", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  const excluded = hubExcludedLeagueIds();
  const categories = hubCategories(hub);
  res.json({
    categories: categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    me: { name: adminActorName(req), fromAccount: !!(req.session.playerUser && store.getUser(req.session.playerUser.id)) },
    items: (hub.items || []).filter((i) => !(i.leagueId && excluded.has(i.leagueId))).map(hubItemView).sort((a, b) => b.createdAt - a.createdAt),
    leagues: store.getIndex().filter((e) => !e.hidden && !hubExcludedLeague(e.name)).map((e) => {
      const l = store.getLeague(e.id);
      return { id: e.id, name: e.name, teams: l ? l.teams.map((t) => ({ id: t.id, name: t.name })) : [] };
    }),
  });
});
router.post("/admin/hub/name", requireOwnerSession, (req, res) => {
  const name = cleanHubText(req.body && req.body.name, 40);
  if (!name) return res.status(400).json({ error: "Enter your name." });
  req.session.adminName = name;
  res.json({ ok: true, name: adminActorName(req) });
});
router.post("/admin/hub/categories", requireOwnerSession, (req, res) => {
  const name = cleanHubText(req.body && req.body.name, 30);
  if (!name) return res.status(400).json({ error: "Give the category a name." });
  const hub = store.getAdminHub();
  const cats = hubCategories(hub);
  if (cats.length >= 30) return res.status(400).json({ error: "That's the most categories you can have." });
  if (cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "You already have a category with that name." });
  const used = new Set(cats.map((c) => c.color));
  const color = HUB_CATEGORY_COLORS.find((c) => !used.has(c)) || HUB_CATEGORY_COLORS[cats.length % HUB_CATEGORY_COLORS.length];
  const cat = { id: logic.uid(), name, color, createdAt: Date.now(), by: adminActorName(req) };
  cats.push(cat);
  store.saveAdminHub(hub);
  res.json({ id: cat.id, name: cat.name, color: cat.color });
});
router.put("/admin/hub/categories/:id", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  const cat = hubCategories(hub).find((c) => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: "Category not found." });
  const b = req.body || {};
  if (b.color !== undefined) {
    if (!HUB_CATEGORY_COLORS.includes(b.color)) return res.status(400).json({ error: "Pick one of the colours." });
    cat.color = b.color;
  }
  if (b.name !== undefined || b.color === undefined) {
    const name = cleanHubText(b.name, 30);
    if (!name) return res.status(400).json({ error: "Give the category a name." });
    if (hub.categories.some((c) => c.id !== cat.id && c.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "You already have a category with that name." });
    cat.name = name;
  }
  store.saveAdminHub(hub);
  res.json({ id: cat.id, name: cat.name, color: cat.color });
});
// Deleting a category keeps its notes; they just lose the category.
router.delete("/admin/hub/categories/:id", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  hub.categories = hubCategories(hub).filter((c) => c.id !== req.params.id);
  (hub.items || []).forEach((i) => { if (i.categoryId === req.params.id) i.categoryId = null; });
  store.saveAdminHub(hub);
  res.json({ ok: true });
});
// Builds (without saving) a Note Machine item from what the admin typed. Used by
// the quick add and by James once the admin has confirmed his proposal.
function hubBuildItem(b, who) {
  const text = cleanHubText(b.text || b.title, 2000);
  if (!text) { const e = new Error("Write something first."); e.status = 400; throw e; }
  const type = HUB_TYPES.includes(b.type) ? b.type : guessHubType(text);
  const now = Date.now();
  const item = {
    id: logic.uid(), type, title: cleanHubText(b.title || text, 200), text: b.title ? cleanHubText(b.text, 2000) : "",
    leagueId: null, teamId: null, playerId: null, amountCents: null, dueDate: null, qty: null,
    status: "open", pinned: false, priority: HUB_PRIORITIES.includes(b.priority) ? b.priority : "normal", payments: [], direction: HUB_MONEY[type] || null,
    stage: HUB_STAGES[type] ? HUB_STAGES[type][0] : null,
    createdAt: now, createdBy: who, updatedAt: now, updatedBy: who,
  };
  // Amount and due date can be written straight into the text ("Pay Sandton R3200 by friday").
  if (b.amountRands === undefined) item.amountCents = HUB_MONEY[type] ? parseHubAmountCents(text) : null;
  if (b.dueDate === undefined) item.dueDate = parseHubDue(text);
  applyHubFields(item, { ...b, title: undefined, text: undefined }, null);
  if (b.categoryId === undefined) item.categoryId = guessHubCategoryId(text, hubCategories(store.getAdminHub()));
  if (type === "sponsor" && !item.sponsorScope) {
    // Not said outright: a team if one's named, else the league if there is one,
    // else a region ("region" in the words also points there).
    const t = text.toLowerCase();
    item.sponsorScope = /\bregion(al)?\b/.test(t) ? "region" : item.teamId || /\bteam sponsor/.test(t) ? "team" : item.leagueId ? "league" : "region";
  }
  return item;
}
router.post("/admin/hub/items", requireOwnerSession, (req, res) => {
  let item;
  try { item = hubBuildItem(req.body || {}, adminActorName(req)); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const hub = store.getAdminHub();
  hub.items = hub.items || [];
  hub.items.push(item);
  store.saveAdminHub(hub);
  res.json(hubItemView(item));
});
router.put("/admin/hub/items/:id", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  const item = (hub.items || []).find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const b = req.body || {};
  if (b.type !== undefined && HUB_TYPES.includes(b.type) && b.type !== item.type) {
    item.type = b.type; item.direction = HUB_MONEY[b.type] || null;
    if (b.type === "sponsor" && !item.sponsorScope) item.sponsorScope = item.teamId ? "team" : item.leagueId ? "league" : "region";
    item.stage = HUB_STAGES[b.type] ? (HUB_STAGES[b.type].includes(item.stage) ? item.stage : HUB_STAGES[b.type][0]) : null;
  }
  applyHubFields(item, b, null, adminActorName(req));
  if (b.title !== undefined && !item.title) return res.status(400).json({ error: "An item needs some text." });
  item.updatedAt = Date.now(); item.updatedBy = adminActorName(req);
  store.saveAdminHub(hub);
  res.json(hubItemView(item));
});
// Money in or out against an item: a sponsor instalment received, a part
// payment to a court. Adds up; the item is done once it's all paid.
router.post("/admin/hub/items/:id/payments", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  const item = (hub.items || []).find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  const cents = Math.round(Number(req.body && req.body.amountRands) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ error: "Enter an amount in rands." });
  const paid = (item.payments || []).reduce((t, x) => t + x.cents, 0);
  if (item.amountCents && paid + cents > item.amountCents) return res.status(400).json({ error: `That's more than what's left (R${((item.amountCents - paid) / 100).toFixed(2)}).` });
  item.payments = (item.payments || []).concat([{ cents, at: Date.now(), by: adminActorName(req) }]);
  if (item.amountCents && paid + cents >= item.amountCents) { item.status = "done"; item.doneBy = item.doneBy || adminActorName(req); item.doneAt = item.doneAt || Date.now(); if (item.type === "sponsor") item.stage = "paid"; }
  item.updatedAt = Date.now(); item.updatedBy = adminActorName(req);
  store.saveAdminHub(hub);
  res.json(hubItemView(item));
});
// Clears a batch of items at once (the completed ones, from "Delete all completed").
router.post("/admin/hub/items/delete", requireOwnerSession, (req, res) => {
  const ids = new Set(Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((x) => typeof x === "string") : []);
  if (!ids.size) return res.status(400).json({ error: "Nothing to delete." });
  const hub = store.getAdminHub();
  const before = (hub.items || []).length;
  hub.items = (hub.items || []).filter((x) => !ids.has(x.id));
  store.saveAdminHub(hub);
  res.json({ ok: true, deleted: before - hub.items.length });
});
router.delete("/admin/hub/items/:id", requireOwnerSession, (req, res) => {
  const hub = store.getAdminHub();
  hub.items = (hub.items || []).filter((x) => x.id !== req.params.id);
  store.saveAdminHub(hub);
  res.json({ ok: true });
});
// Wipes every recorded payment in one league (teams and players, part payments
// and ledgers) back to unpaid, for starting a fresh collection. What's cleared is
// saved first so the last reset can be undone.
const RESET_PAYMENT_FIELDS = ["paymentStatus", "paymentMethod", "paymentRef", "paidAt", "paidCents", "payments", "coveredByTeam", "lumpCents", "lumpRefs", "overpaidCents"];
function snapshotPayments(league) {
  const pick = (o) => Object.fromEntries(RESET_PAYMENT_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, JSON.parse(JSON.stringify(o[k]))]));
  return league.teams.map((t) => ({ teamId: t.id, team: pick(t), players: t.players.map((p) => ({ playerId: p.id, ...pick(p) })) }));
}
router.post("/leagues/:leagueId/payments/reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  let teamsPaid = 0, playersPaid = 0;
  league.teams.forEach((t) => {
    if (t.paymentStatus === "paid" || (t.lumpCents || 0) > 0) teamsPaid++;
    t.players.forEach((p) => { if (p.paymentStatus === "paid" || (p.paidCents || 0) > 0) playersPaid++; });
  });
  const wasTracked = leagueTracksFees(league);
  league.paymentsBackup = { at: Date.now(), by: adminActorName(req), teams: snapshotPayments(league), teamsPaid, playersPaid };
  league.teams.forEach((t) => {
    t.paymentStatus = "unpaid"; t.paymentMethod = null; t.paymentRef = null; t.paidAt = null;
    delete t.lumpCents; delete t.lumpRefs; delete t.overpaidCents;
    t.players.forEach((p) => {
      p.paymentStatus = "unpaid"; p.paymentMethod = null; p.paymentRef = null; p.paidAt = null;
      p.paidCents = 0; p.payments = []; p.coveredByTeam = false; delete p.overpaidCents;
    });
  });
  // Starting a fresh collection: the league stays on the Note Machine, now at zero.
  if (wasTracked) league.hubTrackFees = true;
  logAudit(league, req, null, "payments_reset", { teamsPaid, playersPaid });
  store.saveLeague(league.id, league);
  res.json({ ok: true, teamsPaid, playersPaid });
});
router.post("/leagues/:leagueId/payments/undo-reset", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const backup = league && league.paymentsBackup;
  if (!backup) return res.status(400).json({ error: "There's no reset to undo." });
  league.teams.forEach((t) => {
    const b = backup.teams.find((x) => x.teamId === t.id);
    if (!b) return;
    RESET_PAYMENT_FIELDS.forEach((k) => { delete t[k]; });
    Object.assign(t, JSON.parse(JSON.stringify(b.team)));
    t.players.forEach((p) => {
      const bp = b.players.find((x) => x.playerId === p.id);
      if (!bp) return;
      RESET_PAYMENT_FIELDS.forEach((k) => { delete p[k]; });
      const { playerId: _id, ...fields } = JSON.parse(JSON.stringify(bp));
      Object.assign(p, fields);
    });
  });
  logAudit(league, req, null, "payments_reset_undone", { teamsPaid: backup.teamsPaid, playersPaid: backup.playersPaid });
  delete league.paymentsBackup;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// What players across every league owe and have paid (from each league's own
// payment records), for the hub's Money sheet. A league only counts once
// payments are being tracked there: switched on by an admin, or automatically
// once any payment has been recorded, so fees collected by cash outside the app
// don't show up as "owed".
function leagueTracksFees(league) {
  if (league.hubTrackFees !== undefined) return !!league.hubTrackFees;
  return league.teams.some((t) => t.paymentStatus === "paid" || (t.lumpCents || 0) > 0 || t.players.some((p) => (p.paidCents || 0) > 0 || p.paymentStatus === "paid"));
}
function hubPaymentsData() {
  const teams = [], leagues = [];
  store.getIndex().filter((e) => !e.hidden && !hubExcludedLeague(e.name)).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league || league.format === "pairs") return;
    const fee = league.registrationFeeCents || 0;
    // No payment amount set yet: listed so it can be set, with nothing to count.
    if (!fee) {
      leagues.push({ leagueId: league.id, leagueName: league.name, feeCents: 0, noFee: true, tracked: false, collectedCents: 0, owedCents: 0, teamCount: league.teams.length, totalCents: 0, fullPaidCents: 0, partPaidCents: 0, teamsPaid: 0, teamBars: [] });
      return;
    }
    const tracked = leagueTracksFees(league);
    let collected = 0, owed = 0;
    league.teams.forEach((team) => {
      const paid = teamPaidCents(league, team);
      collected += paid;
      owed += teamBalanceCents(league, team);
      if (!tracked || team.paymentStatus === "paid") return;
      const players = team.players.map((p) => ({
        playerId: p.id, name: p.name, owedCents: playerOwedCents(league, team, p), paidCents: playerPaidCents(league, team, p), shareCents: playerShareCents(league, team, p), discountCents: p.discountCents || 0,
      })).filter((p) => p.owedCents > 0);
      if (!players.length) return;
      teams.push({ leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name, feeCents: teamFeeCents(league, team), teamOwedCents: teamBalanceCents(league, team), players });
    });
    // The bar: money in from teams that have paid in full, money in part from
    // teams still paying, and what's left. Each team gets a bar of its own.
    let fullPaid = 0, partPaid = 0;
    const teamBars = league.teams.map((team) => {
      const tFee = teamFeeCents(league, team);
      const paid = teamPaidCents(league, team);
      const complete = team.paymentStatus === "paid" || paid >= tFee - 1;
      if (complete) fullPaid += tFee; else partPaid += paid;
      return { teamId: team.id, teamName: team.name, feeCents: tFee, baseFeeCents: fee, discountCents: team.discountCents || 0, discountNote: team.discountNote || "", paidCents: Math.min(paid, tFee), complete, playerCount: team.players.length };
    }).sort((a, b) => ((a.feeCents ? a.paidCents / a.feeCents : 1) - (b.feeCents ? b.paidCents / b.feeCents : 1)) || a.teamName.localeCompare(b.teamName));
    const total = teamBars.reduce((t, b) => t + b.feeCents, 0);
    leagues.push({
      leagueId: league.id, leagueName: league.name, feeCents: fee, tracked, collectedCents: collected, owedCents: owed, teamCount: league.teams.length,
      totalCents: total, fullPaidCents: fullPaid, partPaidCents: partPaid, teamsPaid: teamBars.filter((t) => t.complete).length, teamBars,
      canUndoReset: !!league.paymentsBackup, resetAt: league.paymentsBackup ? league.paymentsBackup.at : null, resetBy: league.paymentsBackup ? league.paymentsBackup.by : null,
    });
  });
  return { teams, leagues };
}
router.get("/admin/hub/payments", requireOwnerSession, (req, res) => { res.json(hubPaymentsData()); });
// ---- James: the admin assistant in the Note Machine (see src/james.js).
// He reads a summary of the notes and payments, and can answer, propose notes
// or draft messages. He can't save or send anything: notes are only created
// when the admin confirms, through the same builder as the quick add.
function jamesContext() {
  const hub = store.getAdminHub();
  const excluded = hubExcludedLeagueIds();
  const categories = hubCategories(hub).map((c) => ({ id: c.id, name: c.name }));
  const leagues = store.getIndex().filter((e) => !e.hidden && !hubExcludedLeague(e.name)).map((e) => {
    const l = store.getLeague(e.id);
    return { id: e.id, name: e.name, teams: l ? l.teams.map((t) => ({ id: t.id, name: t.name })) : [] };
  });
  const pay = hubPaymentsData();
  const leagueName = (id) => (leagues.find((l) => l.id === id) || {}).name || null;
  const catName = (id) => (categories.find((c) => c.id === id) || {}).name || null;
  const build = (playerCap, noteCap) => {
    const payments = pay.leagues.map((l) => ({
      league: l.leagueName, leagueId: l.leagueId, feePerPlayerRands: l.feeCents / 100, noFeeSetYet: !!l.noFee, paymentsTracked: !!l.tracked,
      collectedRands: l.collectedCents / 100, owedRands: l.owedCents / 100, teams: l.teamCount, teamsPaidInFull: l.teamsPaid || 0,
      teamsOwing: pay.teams.filter((t) => t.leagueId === l.leagueId).slice(0, 30).map((t) => ({
        team: t.teamName, teamOwedRands: t.teamOwedCents / 100,
        playersOwing: t.players.slice(0, playerCap).map((p) => ({ name: p.name, owedRands: p.owedCents / 100, paidRands: p.paidCents / 100 })),
      })),
    }));
    const openNotes = (hub.items || []).filter((i) => i.status !== "done" && !(i.leagueId && excluded.has(i.leagueId)))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, noteCap).map((i) => ({
        title: i.title, type: i.type, priority: i.priority || "normal", due: i.dueDate || null, league: leagueName(i.leagueId), category: catName(i.categoryId),
        amountRands: i.amountCents ? i.amountCents / 100 : null, addedBy: i.createdBy, added: new Date(i.createdAt).toISOString().slice(0, 10),
      }));
    const day = james.saNow().day;
    const weekday = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
    return JSON.stringify({ today: `${weekday} ${day}`, categories, leagues: leagues.map((l) => ({ id: l.id, name: l.name, teams: l.teams })), payments, openNotes });
  };
  let text = build(12, 60);
  if (text.length > 60000) text = build(5, 20);
  return { text, raw: { categories, leagues } };
}
router.get("/admin/james/status", requireOwnerSession, (req, res) => {
  const cfg = james.config();
  res.json({ enabled: !!cfg.apiKey, model: cfg.model, usage: james.usageSummary(store.getJamesUsage(), adminActorName(req), cfg) });
});
router.post("/admin/james", requireOwnerSession, async (req, res) => {
  const actor = adminActorName(req);
  const cfg = james.config();
  const message = String((req.body && req.body.message) || "").trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: "Ask James something first." });
  try {
    if (!cfg.apiKey) throw new james.JamesError("James isn't connected yet. Add ANTHROPIC_API_KEY to your host's Secrets, then publish.", 503);
    james.checkLimits(store.getJamesUsage(), actor, cfg);
    const ctx = jamesContext();
    const result = await james.callClaude({ cfg, system: james.systemPrompt(ctx.text), messages: james.cleanHistory(req.body.history, message) });
    const usage = james.recordUsage(store.getJamesUsage(), actor, james.costUsd(result.model, result.usage));
    store.saveJamesUsage(usage);
    const proposals = james.cleanProposals(result.toolUses, ctx.raw);
    const reply = result.text || (proposals.notes.length || proposals.messages.length ? "" : "I didn't catch that. Could you say it another way?");
    res.json({ reply, notes: proposals.notes, messages: proposals.messages, usage: james.usageSummary(usage, actor, cfg) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "James hit a problem." });
  }
});
// The admin pressed Confirm on James's proposed notes.
router.post("/admin/james/notes", requireOwnerSession, (req, res) => {
  const list = Array.isArray(req.body && req.body.notes) ? req.body.notes.slice(0, 10) : [];
  if (!list.length) return res.status(400).json({ error: "There's nothing to save." });
  const who = adminActorName(req);
  const items = [];
  try {
    list.forEach((n) => {
      const body = { title: n.title, text: n.details || "", type: n.type, priority: n.priority };
      if (n.categoryId) body.categoryId = n.categoryId;
      if (n.leagueId) body.leagueId = n.leagueId;
      if (n.teamId) body.teamId = n.teamId;
      if (n.amountRands) body.amountRands = n.amountRands;
      if (n.dueDate) body.dueDate = n.dueDate;
      const item = hubBuildItem(body, who);
      item.via = "james";
      items.push(item);
    });
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const hub = store.getAdminHub();
  hub.items = (hub.items || []).concat(items);
  store.saveAdminHub(hub);
  res.json({ items: items.map(hubItemView) });
});
router.put("/admin/hub/league-tracking", requireOwnerSession, (req, res) => {
  const league = store.getLeague(req.body && req.body.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  league.hubTrackFees = !!(req.body && req.body.track);
  store.saveLeague(league.id, league);
  res.json({ ok: true, tracked: league.hubTrackFees });
});

// Every match-history reference to a player id that no longer has a roster
// entry — the state left behind by a delete that happened before the
// guard above existed. Includes who they played alongside and which
// rounds, since that's usually enough for an admin to recognize who's
// missing even though the name itself is gone.
router.get("/leagues/:leagueId/admin/orphaned-players", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const currentIds = new Set(league.teams.flatMap((t) => t.players.map((p) => p.id)));
  const found = new Map();
  logic.allFixturesOf(league).forEach((f) => {
    [["A", f.teamA, f.selectionA], ["B", f.teamB, f.selectionB]].forEach(([, teamId, sel]) => {
      const team = league.teams.find((t) => t.id === teamId);
      (sel.pairs || []).forEach((pair) => {
        (pair || []).forEach((pid, idx) => {
          if (!pid || currentIds.has(pid)) return;
          if (!found.has(pid)) found.set(pid, { playerId: pid, teamId, teamName: team ? team.name : "Unknown team", rounds: new Set(), partners: new Set() });
          const entry = found.get(pid);
          entry.rounds.add(f.round || 0);
          const partnerId = pair[1 - idx];
          const partner = team && partnerId ? team.players.find((p) => p.id === partnerId) : null;
          if (partner) entry.partners.add(partner.name);
        });
      });
    });
  });
  res.json([...found.values()].map((e) => ({
    playerId: e.playerId, teamId: e.teamId, teamName: e.teamName,
    rounds: [...e.rounds].sort((a, b) => a - b), partners: [...e.partners],
  })));
});
// Gives a deleted player their name back at the exact same id, so every
// finalized match that already references them reconnects instead of
// staying broken — only ever usable on an id genuinely found dangling in
// this league's own match history, not a way to add a player with a
// chosen id out of nowhere.
router.post("/leagues/:leagueId/teams/:teamId/players/:playerId/restore", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const playerId = req.params.playerId;
  if (team.players.some((p) => p.id === playerId)) return res.status(400).json({ error: "This player is already on the roster." });
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "A name is required." });
  const isOrphaned = logic.allFixturesOf(league).some((f) =>
    (f.selectionA.pairs || []).flat().includes(playerId) || (f.selectionB.pairs || []).flat().includes(playerId)
  );
  if (!isOrphaned) return res.status(400).json({ error: "This id isn't referenced in any match history here — use Add player instead." });
  team.players.push({ id: playerId, name });
  logAudit(league, req, null, "player_restore", { playerName: name, teamName: team.name });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

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
  // goldMatchCount (how many of the 4 seeds are gold-eligible) is its own
  // dial, independent of goldTierCount (how many players per team may be
  // tagged gold) — a team can easily have 3 gold players who only ever
  // fit into 2 gold-flagged matches (2 there, 1 sharing a silver match).
  if (req.body.goldMatchCount !== undefined) {
    const goldMatchCount = Number(req.body.goldMatchCount);
    if (!Number.isInteger(goldMatchCount) || goldMatchCount < 1 || goldMatchCount > 4)
      return res.status(400).json({ error: "Gold matches must be between 1 and 4." });
    league.goldMatchCount = goldMatchCount;
  }
  // Balwin rules: how many gold players may also play the first silver seed.
  if (req.body.goldInFirstSilverSeed !== undefined) {
    const n = Number(req.body.goldInFirstSilverSeed);
    if (!Number.isInteger(n) || n < 0 || n > 2) return res.status(400).json({ error: "Gold players allowed in the first silver seed must be 0, 1 or 2." });
    league.goldInFirstSilverSeed = n;
  }
  // Two ways a league can present its gold/silver split: "seeded" keeps
  // Seed 1..N as a fixed ranking, with only the first goldMatchCount seeds
  // gold-eligible (silver can still play any seed) — the original design.
  // "flat" drops seed numbers entirely: a match is just labeled Gold match
  // or Silver match, no ranking implied between two seeds of the same tier.
  if (req.body.flatTierLabels !== undefined) league.flatTierLabels = !!req.body.flatTierLabels;
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
  // Ormonde rules can also be switched on here (not just at league creation)
  // — it only actually does anything once, right below, when the season's
  // fixtures get generated with either 4 or 5 seeds, so any later point is
  // just as valid as creation time. Team-format only, same as creation.
  if (!isPairs && req.body.singlesDecider !== undefined) league.singlesDecider = !!req.body.singlesDecider;

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
    const gen = logic.generateRoundRobin(league.teams, !!req.body.doubleRound, isPairs ? 1 : (league.singlesDecider ? 5 : 4));
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
  // saving an empty snapshot — and neither does a season whose fixtures
  // exist but not one rubber has an actual result yet (e.g. resetting
  // right after Start season to change a setting like Ormonde rules,
  // before a single match has been played): archiving that would just
  // leave an empty, score-free entry cluttering Season History.
  const hasAnyResult = league.fixtures.some((f) => f.finalized || f.rubbers.some((r) => logic.rubberWinner(r) !== null));
  if (hasAnyResult) {
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
      // Copied, not shared: in the server's in-memory store this snapshot and
      // the live league would otherwise be the SAME team objects, so renaming
      // a team or changing its roster for the next season would quietly
      // rewrite the archived season too (and removing a team still left the
      // archive pointing at live data). The schedule is carried into the new
      // season too, so it needs its own copy for the same reason.
      teams: JSON.parse(JSON.stringify(league.teams)),
      fixtures: league.fixtures,
      playoffs: league.playoffs,
      playoffFormat: league.playoffFormat,
      roundMeta: league.roundMeta,
      schedule: league.schedule ? JSON.parse(JSON.stringify(league.schedule)) : league.schedule,
      defaultVenue: league.defaultVenue,
      // Pair of the Week votes are keyed by round NUMBER, not by fixture —
      // without archiving them here and clearing the live copy below, the
      // next season's own round 1/2/3... would silently inherit whatever
      // votes this season cast for those same round numbers, crowning the
      // wrong pair (or nobody at all) once the new season reaches them.
      potwVotes: league.potwVotes || {},
    });
  }
  league.fixtures = [];
  league.byes = [];
  league.playoffs = null;
  league.roundMeta = {};
  league.potwVotes = {};
  // Round dates/venues and the court grids are keyed by round number, so left
  // in place the new season's round 1 would inherit last season's date. The
  // archive above already holds its own copy of the schedule. Only when a
  // season was actually archived: resetting right after Start season (no
  // results yet) is a redo of the same season, so its dates are kept.
  if (hasAnyResult) {
    league.schedule = {};
    league.courtSchedule = {};
  }
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
// Permanently wipes every archived season for this league — the past
// fixtures/results/standings snapshots season/reset creates. Hall of Fame
// entries are untouched (they're admin-entered free text, not derived from
// these snapshots), but anything computed FROM a snapshot (a player's
// "unbeaten season" badge, an archived season's own results view) is gone
// for good along with it. Owner-only, same tier as deleting the league
// itself.
router.delete("/leagues/:leagueId/season-history", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const removed = (league.seasonHistory || []).length;
  league.seasonHistory = [];
  store.saveLeague(league.id, league);
  res.json({ ok: true, removed });
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
  // A hand-entered score means this is a real, played result after all —
  // same reasoning as the live PUT above, clears a previously-set
  // forfeited flag so it goes back to counting for Elo.
  if (f.rubbers[idx].forfeited) f.rubbers[idx].forfeited = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// Same idea as POST .../fixtures/:fixtureId/rubbers/:idx/forfeit, just
// scoped to an archived season's frozen fixtures instead of the live
// league — a forfeit noticed or corrected after a season's already been
// archived is exactly as real as one caught during the season itself.
// Every archived fixture is already "finalized" by definition (that's
// what makes it archived), so unlike the live route this never refuses
// on that basis — there's no "unlock" step for a past season.
router.post("/leagues/:leagueId/season-history/:seasonId/fixtures/:fixtureId/rubbers/:idx/forfeit", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const snapshot = (league.seasonHistory || []).find((s) => s.id === req.params.seasonId);
  if (!snapshot) return res.status(404).json({ error: "That season isn't archived here." });
  const f = findArchivedFixture(snapshot, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Match not found in that season." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  const winner = req.body && req.body.winner;
  if (winner !== "A" && winner !== "B" && winner !== "double") return res.status(400).json({ error: "Say which side gets the walkover, or that both sides forfeited." });

  const rubber = f.rubbers[idx];
  // See the live-fixture forfeit route above for why "double" leaves the
  // score untouched instead of writing a synthetic walkover.
  if (winner !== "double") {
    // Ormonde rules' Super Tie seed has no sets at all — its walkover is a
    // synthetic 10-0 tie-break instead of a synthetic 6-0, 6-0.
    if (rubber.sets.length === 0) {
      rubber.tb = winner === "A" ? [10, 0] : [0, 10];
    } else {
      rubber.sets = rubber.sets.map((_, si) => (si < 2 ? (winner === "A" ? [6, 0] : [0, 6]) : [null, null]));
      rubber.tb = [null, null];
    }
  }
  rubber.forfeited = winner;
  rubber.startedAt = Date.now();
  rubber.completedAt = rubber.startedAt;

  logAudit(league, req, f, "forfeit", { seedIdx: idx, winner, season: snapshot.season, seasonLabel: snapshot.label });
  store.saveLeague(league.id, league);
  res.json({ ok: true, rubber });
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
router.put("/leagues/:leagueId/court-photo", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (imageTooLarge(res, req.body.photo)) return;
  league.courtPhoto = req.body.photo || "";
  await store.saveLeagueCourtPhoto(league.id, league.courtPhoto);
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

// Every fixture that belongs to a given round key — a plain integer for a
// regular-season round (league.fixtures, unchanged from before playoffs
// got this too), or one of "semis"/"final"/"positions" for a playoff
// stage. Mirrors the client's fixturesForKey. Used by court-scheduling
// below and by the Predictions route.
function fixturesForRoundKey(league, key) {
  if (typeof key === "number") return league.fixtures.filter((f) => f.round === key);
  if (!league.playoffs) return [];
  if (key === "semis") return league.playoffs.semis || [];
  if (key === "final") return league.playoffs.final ? [league.playoffs.final] : [];
  if (key === "positions") return league.playoffs.matches || [];
  return [];
}
// Every player named in one seed of a fixture — both sides' pairs, since a
// "double" puts two of a fixture's OWN seeds on two different courts at
// once, and either side's player could be the one who can't be in both
// places. Selections not yet submitted for a side just contribute nothing
// (an unrevealed seed can't conflict with anything).
function playersOfSeed(f, seed) {
  const a = (f.selectionA.pairs[seed] || []).filter(Boolean);
  const b = (f.selectionB.pairs[seed] || []).filter(Boolean);
  return a.concat(b);
}
// True if the two seeds share a real person — a captain is allowed to name
// the same player twice across a fixture's seeds (the "double-up" a
// selection submit already asks them to confirm), but that player
// physically can't play both seeds if the court schedule then puts them
// in the same time slot on two different courts. Only meaningful once
// both seeds are actually revealed; an unrevealed one has no players to
// clash with yet, so this returns false rather than blocking on nothing.
function seedsSharePlayer(f, seedA, seedB) {
  const a = playersOfSeed(f, seedA), b = playersOfSeed(f, seedB);
  return a.some((p) => b.includes(p));
}
// Which two of a fixture's four seeds should share a time slot (the
// "double") — every pairing that's actually revealed and conflict-free,
// preferring 0+1 (the longstanding default) when it's safe so behavior
// doesn't change for the common case. Falls back to 0+1 regardless if
// every pairing clashes or nothing's revealed yet to check — the double-
// up confirmation at selection time is the real guard for that edge case,
// this is just about not handing out an avoidable conflict by default.
function safeDoubleSeeds(f) {
  const candidates = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  for (const [i, j] of candidates) {
    if (!seedsSharePlayer(f, i, j)) return [i, j];
  }
  return [0, 1];
}
// Every court-schedule round key worth generating/balancing, in the order
// they're actually played: every regular round ascending, then whichever
// playoff stage(s) exist with real fixtures in them. Playoffs are appended
// (not interleaved) so the season-fairness tally in generateSeasonCourtRotation
// and computeOptimumCourtSchedule carries forward naturally — a team that
// already had more than its share of doubles in the regular season doesn't
// get a clean slate the moment playoffs start.
function courtScheduleRoundKeys(league) {
  const keys = [...new Set(league.fixtures.map((f) => f.round))].sort((a, b) => a - b);
  if (league.playoffs) {
    if (league.playoffs.format === "position") {
      if ((league.playoffs.matches || []).length) keys.push("positions");
    } else {
      if ((league.playoffs.semis || []).length) keys.push("semis");
      if (league.playoffs.final) keys.push("final");
    }
  }
  return keys;
}
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

// Where a fixture+seed currently sits on the court schedule, if anywhere —
// scans every round key rather than assuming f.round, since a knockout
// fixture's own round is always 0 internally (its court schedule instead
// lives under a "semis"/"final"/"positions" key). Used only for enriching
// the courtMatchLog entry below with which physical court a match was
// actually played on; a league is small enough that scanning is cheap.
function findCourtScheduleCell(league, fixtureId, seed) {
  const schedule = league.courtSchedule || {};
  for (const roundKey of Object.keys(schedule)) {
    const grid = schedule[roundKey] || [];
    for (let s = 0; s < grid.length; s++) {
      const row = grid[s] || [];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell && cell.fixtureId === fixtureId && cell.seed === seed) return { roundKey, slot: s, court: c };
      }
    }
  }
  return null;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const res = [];
  arr.forEach((x, i) => {
    permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((p) => res.push([x].concat(p)));
  });
  return res;
}

// Given this round's fixtures and the running per-team-per-slot double
// tally, picks which slot each fixture's "double" (its 4th rubber, sharing
// a slot with one of the other three) lands in — brute-force over every
// slot permutation, scoring for season-long fairness. Extracted out of
// generateSeasonCourtRotation so the court-BALANCING preview below can
// reuse the exact same rotation decision rather than drifting out of sync
// with it — only which COURT a seed lands in should differ between the
// two, never which slot gets the double. Returns fixtureId -> slot (or
// null for a fixture that didn't fit the round's slot permutation at all,
// e.g. more matches this round than slots).
function pickDoubleSlots(fixtures, slots, teamTally) {
  const doublePerms = permutations(Array.from({ length: slots }, (_, i) => i));
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
  const result = new Map();
  fixtures.forEach((f, i) => result.set(f.id, i < best.perm.length ? best.perm[i] : null));
  return result;
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
  const roundKeys = courtScheduleRoundKeys(league);
  const tally = {};
  const teamTally = (id) => tally[id] || (tally[id] = Array(slots).fill(0));
  const needsDoubles = slots < 4;
  // Ormonde rules reserves the LAST court exclusively for that round's
  // Super Tie seed (one per fixture, one player a side) — the remaining
  // courts handle the usual 4 pairs seeds, same as any other league. Only
  // applied when there's a spare court to give it and enough slots that
  // pairs seeds don't already need to double up (the rarer needsDoubles
  // case below is left exactly as before — Super Ties there go unscheduled,
  // same as an admin can already place them manually).
  const singlesOn = !!league.singlesDecider && league.format !== "pairs" && !needsDoubles && courts > 1;
  const pairsCourts = singlesOn ? courts - 1 : courts;
  const superTieCourt = singlesOn ? courts - 1 : null;

  if (!league.courtSchedule) league.courtSchedule = {};

  roundKeys.forEach((round) => {
    const fixtures = fixturesForRoundKey(league, round);
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

    if (!needsDoubles && singlesOn) {
      // Ormonde rules: don't give each fixture its own dedicated court —
      // pool every fixture's 4 pairs seeds into one flat list and pack them
      // densely, `pairsCourts` at a time, across consecutive slots. 16
      // matches over 5 pairs courts is 3 full slots of 5 plus a 4th slot
      // with just 1 match, instead of a court sitting idle every single
      // slot because there simply aren't enough fixtures to give it one of
      // its own. The Super Tie keeps its usual one-per-fixture placement on
      // its own reserved court, untouched by this.
      const flat = [];
      fixtures.forEach((f) => {
        for (let seed = 0; seed < 4; seed++) flat.push({ fixtureId: f.id, seed });
        teamTally(f.teamA); teamTally(f.teamB);
      });
      flat.forEach((item, k) => {
        const slot = Math.floor(k / pairsCourts), court = k % pairsCourts;
        if (slot < slots) grid[slot][court] = item;
      });
      fixtures.forEach((f, i) => { grid[i % slots][superTieCourt] = { fixtureId: f.id, seed: 4 }; });
    } else if (!needsDoubles) {
      fixtures.forEach((f, i) => {
        const court = i % pairsCourts;
        for (let seed = 0; seed < 4 && seed < slots; seed++) grid[seed][court] = { fixtureId: f.id, seed };
        teamTally(f.teamA); teamTally(f.teamB);
      });
    } else {
      const doubleSlotOf = pickDoubleSlots(fixtures, slots, teamTally);
      fixtures.forEach((f) => {
        const doubleSlot = doubleSlotOf.get(f.id);
        if (doubleSlot === null || doubleSlot === undefined) {
          // More matches this round than slots to double into — spread its
          // seeds across whatever courts are free, best effort only.
          for (let seed = 0; seed < 4; seed++) {
            const slot = seed % slots;
            place(slot, f.id, seed);
          }
          return;
        }
        // Which two seeds actually share the double slot — not always 0+1;
        // see safeDoubleSeeds for why (a player named in both of those
        // seeds can't be on two courts at once).
        const [dblA, dblB] = safeDoubleSeeds(f);
        const remaining = [0, 1, 2, 3].filter((s) => s !== dblA && s !== dblB);
        place(doubleSlot, f.id, dblA);
        place(doubleSlot, f.id, dblB);
        const others = Array.from({ length: slots }, (_, s) => s).filter((s) => s !== doubleSlot);
        remaining.forEach((seed, idx) => { if (others.length) place(others[idx % others.length], f.id, seed); });
        teamTally(f.teamA)[doubleSlot]++; teamTally(f.teamB)[doubleSlot]++;
      });
    }

    league.courtSchedule[round] = grid;
  });
}

// "Generate optimum layout" — same season-fairness rotation as Auto-fill
// above (which slot gets each fixture's double is decided by the exact
// same pickDoubleSlots search, so that part of the schedule doesn't fork
// into a second, competing notion of "fair"), but chooses which COURT
// each seed lands in to balance predicted match length across courts
// instead of Auto-fill's plain round-robin/first-free-court placement.
// Without this, one court can end up carrying every close, likely-to-run-
// long match a round while another finishes its blowouts early — the
// classic "everyone's waiting on Court 2" complaint. Read-only: returns
// the proposed grids (plus each court's resulting predicted load, for the
// preview UI) without saving anything — the admin reviews it in a preview
// modal, then either cancels or resubmits this exact payload to
// court-schedule/optimum-apply below to commit it.
// How likely a rubber is to run long: 100 for a dead coin-flip prediction,
// down to 0 for a lopsided mismatch. A pair not yet revealed (or with no
// rated history at all) gets a neutral mid-value rather than skewing a
// balance computation toward or away from it for no real reason. Shared
// by computeOptimumCourtSchedule (a hypothetical new layout) and
// computeCurrentCourtLoad (whatever's already saved) so the two always
// agree on what "close" means.
// The actual win% split behind a cell's closeness score — null while
// either side's line-up for this seed isn't in yet (nothing to predict).
// Surfaced to admins on the court-balance/optimum-layout grids below so
// "why is this court red" has a real number attached, not just a color.
// What a manual pace stands in for — well inside bucket 0 / bucket 4 of the
// learned-duration buckets (closenessBucket), so a Quick call gets the
// lopsided-match time estimate and a Long call the dead-even one.
const PACE_QUICK_CLOSENESS = 10, PACE_LONG_CLOSENESS = 90;
// The extra information the Elo + seeding blend needs for one seed of one
// fixture (see logic.blendedStrength): which seed it is, and which two teams.
// A pairs league has no seeds, so it gets none and stays on plain Elo.
function seedContext(league, f, seedIndex) {
  return league.format === "pairs" ? null : { seed: seedIndex + 1, teamA: f.teamA, teamB: f.teamB };
}
function matchPrediction(league, f, seed, ratingsData, identityOf) {
  const pairA = f.selectionA.submitted && f.selectionA.pairs[seed];
  const pairB = f.selectionB.submitted && f.selectionB.pairs[seed];
  if (!pairA || !pairB || pairA.some((x) => !x) || pairB.some((x) => !x)) return null;
  const { winPctA, winPctB, provisional } = logic.predictSeed(league, pairA, pairB, ratingsData, identityOf, seedContext(league, f, seed));
  const predictedCloseness = 100 - Math.abs(winPctA - winPctB);
  // An admin's manual Quick/Long call on Live Court Control (rubber.pace)
  // stands in for the model's guess everywhere the court balancing reads
  // `closeness` — a match marked Long is treated as long, not just
  // recoloured. `predictedCloseness` stays the model's own number, which is
  // what the duration learning below has to keep using: it's learning how
  // long matches the MODEL calls close actually run, so a human's override
  // must never be folded into that.
  const rubber = f.rubbers[seed];
  const pace = rubber && rubber.pace;
  const closeness = pace === "quick" ? PACE_QUICK_CLOSENESS : pace === "long" ? PACE_LONG_CLOSENESS : predictedCloseness;
  return { winPctA, winPctB, provisional, closeness, predictedCloseness };
}
// Which of Live Court Control's 5 learned-duration buckets a closeness
// score falls into (0 = lopsided/quick, 4 = dead even/long) — shared by
// the rubbers/:idx/complete route (writes) and left for the client to use
// the same way when reading league.courtDurationStats back (reads).
function closenessBucket(closeness) {
  return Math.min(4, Math.max(0, Math.floor(closeness / 20)));
}
// A match that's already on court (or finished) is fixed to its court and
// slot — Live Court Control refuses to drag one, and nothing that rewrites
// the court grid may either. Both the season-wide optimiser and the
// mid-night re-balance below treat these as immovable.
function roundHasStartedMatch(league, round) {
  return fixturesForRoundKey(league, round).some((f) => f.rubbers.some((r) => r.startedAt));
}
// Re-balances ONE round without disturbing what's under way: every started
// or finished match stays exactly where it is, and only the still-upcoming
// ones can change court — never slot, since the slot decides who plays
// when (double-ups, rest between seeds), which is planning, not balancing.
// Load is each court's predicted minutes across its upcoming matches only,
// the same measure Live Court Control's "a lighter court exists" nudge uses,
// and each match's closeness already reflects an admin's manual Quick/Long.
// A team league with a dedicated court per fixture (4+ slots) moves whole
// fixtures, not single seeds, so a fixture never splits across courts; one
// with any seed already started stays put entirely. Nothing is proposed
// unless it actually narrows the gap between the busiest and lightest court.
function rebalanceRoundGrid(league, round, ratingsData, identityOf) {
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  const fixtures = fixturesForRoundKey(league, round);
  const current = getCourtGrid(league, round);
  const dedicated = slots >= 4;
  const predictionOf = (f, seed) => matchPrediction(league, f, seed, ratingsData, identityOf) || { closeness: 50 };
  const grid = emptyCourtGrid(slots, courts);
  const units = new Map();
  current.forEach((row, sl) => row.forEach((cell, c) => {
    if (!cell) return;
    const f = fixtures.find((x) => x.id === cell.fixtureId);
    const started = !!(f && f.rubbers[cell.seed] && f.rubbers[cell.seed].startedAt);
    const fixtureStarted = !!(f && f.rubbers.some((r) => r.startedAt));
    if (!f || f.finalized || started || (dedicated && fixtureStarted)) {
      grid[sl][c] = { fixtureId: cell.fixtureId, seed: cell.seed, pinned: true };
      return;
    }
    const key = dedicated ? f.id : f.id + ":" + cell.seed;
    if (!units.has(key)) units.set(key, { cells: [], load: 0, fromCourt: c });
    const u = units.get(key);
    const pred = predictionOf(f, cell.seed);
    u.cells.push({ slot: sl, court: c, fixtureId: cell.fixtureId, seed: cell.seed, pred });
    u.load += pred.closeness;
  }));
  const list = [...units.values()];
  const currentLoad = Array(courts).fill(0);
  list.forEach((u) => u.cells.forEach((cl) => { currentLoad[cl.court] += cl.pred.closeness; }));
  const spread = (arr) => Math.max(...arr) - Math.min(...arr);

  const courtLoad = Array(courts).fill(0);
  const placed = [];
  list.slice().sort((a, b) => b.load - a.load || (a.cells[0].fixtureId + a.cells[0].seed).localeCompare(b.cells[0].fixtureId + b.cells[0].seed)).forEach((u) => {
    let best = -1;
    for (let c = 0; c < courts; c++) {
      if (!u.cells.every((cl) => !grid[cl.slot][c])) continue;
      if (best === -1 || courtLoad[c] < courtLoad[best] || (courtLoad[c] === courtLoad[best] && c === u.fromCourt)) best = c;
    }
    u.cells.forEach((cl) => {
      let court = best;
      // No single court free across every seed of a fixture (a hand-edited
      // grid) — keep each seed where it is, or the first free court in its
      // slot, rather than dropping a match off the board.
      if (court === -1) {
        court = grid[cl.slot][cl.court] ? grid[cl.slot].findIndex((x) => !x) : cl.court;
        if (court === -1) court = cl.court;
      }
      grid[cl.slot][court] = { fixtureId: cl.fixtureId, seed: cl.seed, ...cl.pred };
      courtLoad[court] += cl.pred.closeness;
      placed.push({ ...cl, to: court });
    });
  });
  const moves = placed.filter((p) => p.to !== p.court).map((p) => ({ fixtureId: p.fixtureId, seed: p.seed, slot: p.slot, from: p.court, to: p.to }));
  if (!moves.length || spread(courtLoad) >= spread(currentLoad)) {
    // Not an improvement — hand back the schedule exactly as it stands.
    const unchanged = emptyCourtGrid(slots, courts);
    current.forEach((row, sl) => row.forEach((cell, c) => { if (cell) unchanged[sl][c] = { fixtureId: cell.fixtureId, seed: cell.seed }; }));
    return { grid: unchanged, courtLoad: currentLoad, currentLoad, moves: [] };
  }
  return { grid, courtLoad, currentLoad, moves };
}
function computeOptimumCourtSchedule(league, ratingsData, identityOf) {
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  const roundKeys = courtScheduleRoundKeys(league);
  const tally = {};
  const teamTally = (id) => tally[id] || (tally[id] = Array(slots).fill(0));
  const needsDoubles = slots < 4;
  // Neutral default (closeness 50, no winPct fields) while either side's
  // line-up isn't in yet — same "not revealed" case matchPrediction itself
  // returns null for.
  const predictionOf = (f, seed) => matchPrediction(league, f, seed, ratingsData, identityOf) || { closeness: 50 };

  const rounds = {};
  roundKeys.forEach((round) => {
    const fixtures = fixturesForRoundKey(league, round);
    if (fixtures.every((f) => f.finalized)) {
      getCourtGrid(league, round).forEach((row, s) => row.forEach((cell) => {
        if (!cell) return;
        const f = fixtures.find((x) => x.id === cell.fixtureId);
        if (f) { teamTally(f.teamA)[s]++; teamTally(f.teamB)[s]++; }
      }));
      return;
    }

    // A round already under way can't be re-planned from scratch — that
    // would move matches that are live or finished. Only its still-upcoming
    // matches get re-balanced, and the fairness tally still counts every
    // placement so later rounds plan around it.
    if (roundHasStartedMatch(league, round)) {
      const r = rebalanceRoundGrid(league, round, ratingsData, identityOf);
      r.grid.forEach((row, sl) => row.forEach((cell) => {
        if (!cell) return;
        const f = fixtures.find((x) => x.id === cell.fixtureId);
        if (f) { teamTally(f.teamA)[sl]++; teamTally(f.teamB)[sl]++; }
      }));
      rounds[round] = { grid: r.grid, courtLoad: r.courtLoad };
      return;
    }

    const grid = emptyCourtGrid(slots, courts);
    const courtLoad = Array(courts).fill(0);

    if (!needsDoubles) {
      // Enough slots that every match gets its own dedicated court for the
      // whole night, so it's the FIXTURE (not the seed) that needs
      // balancing here — all of a lopsided match's rubbers sit on the same
      // court all evening either way. Greedy longest-first: the match most
      // likely to run long claims the lightest court so far, in order.
      const order = fixtures.map((f) => {
        let total = 0;
        for (let seed = 0; seed < 4 && seed < slots; seed++) total += predictionOf(f, seed).closeness;
        return { f, total };
      }).sort((a, b) => b.total - a.total);
      order.forEach(({ f, total }) => {
        let bestCourt = 0;
        for (let c = 1; c < courts; c++) if (courtLoad[c] < courtLoad[bestCourt]) bestCourt = c;
        for (let seed = 0; seed < 4 && seed < slots; seed++) grid[seed][bestCourt] = { fixtureId: f.id, seed, ...predictionOf(f, seed) };
        courtLoad[bestCourt] += total;
        teamTally(f.teamA); teamTally(f.teamB);
      });
    } else {
      const doubleSlotOf = pickDoubleSlots(fixtures, slots, teamTally);
      const placements = [];
      fixtures.forEach((f) => {
        const doubleSlot = doubleSlotOf.get(f.id);
        if (doubleSlot === null || doubleSlot === undefined) {
          for (let seed = 0; seed < 4; seed++) placements.push({ fixtureId: f.id, seed, slot: seed % slots, ...predictionOf(f, seed) });
          return;
        }
        // Same shape Auto-fill uses: two of the fixture's seeds double up
        // in the chosen slot, the other two each get one of the remaining
        // slots — only the court within each slot is free to move below.
        // Which two double is decided the same conflict-free way Auto-fill
        // does (see safeDoubleSeeds), not always 0+1.
        const [dblA, dblB] = safeDoubleSeeds(f);
        [dblA, dblB].forEach((seed) => placements.push({ fixtureId: f.id, seed, slot: doubleSlot, ...predictionOf(f, seed) }));
        const others = Array.from({ length: slots }, (_, s) => s).filter((s) => s !== doubleSlot);
        const remaining = [0, 1, 2, 3].filter((s) => s !== dblA && s !== dblB);
        remaining.forEach((seed, idx) => { if (others.length) placements.push({ fixtureId: f.id, seed, slot: others[idx % others.length], ...predictionOf(f, seed) }); });
        teamTally(f.teamA)[doubleSlot]++; teamTally(f.teamB)[doubleSlot]++;
      });
      // Greedy longest-first load balancing (LPT) across the WHOLE round at
      // once, not slot by slot — the closest matches claim courts first,
      // each going to whichever court is both free in that seed's already-
      // decided slot and has taken the least total load so far.
      placements.sort((a, b) => b.closeness - a.closeness).forEach((p) => {
        let bestCourt = -1, bestLoad = Infinity;
        for (let c = 0; c < courts; c++) {
          if (grid[p.slot][c]) continue;
          if (courtLoad[c] < bestLoad) { bestLoad = courtLoad[c]; bestCourt = c; }
        }
        if (bestCourt === -1) return; // more seeds than courts this slot — leftover, same overflow case Auto-fill has
        grid[p.slot][bestCourt] = { fixtureId: p.fixtureId, seed: p.seed, closeness: p.closeness, winPctA: p.winPctA, winPctB: p.winPctB, provisional: p.provisional };
        courtLoad[bestCourt] += p.closeness;
      });
    }

    rounds[round] = { grid, courtLoad };
  });

  return rounds;
}

// "Show current balance" — same predicted-load math as the optimum
// preview above, but read from whatever's ALREADY saved in
// league.courtSchedule instead of proposing anything new. Lets an admin
// see how balanced today's actual schedule already is before deciding
// whether regenerating it is even worth doing.
function computeCurrentCourtLoad(league, ratingsData, identityOf) {
  const courts = league.courtCount || 4;
  const roundKeys = courtScheduleRoundKeys(league);

  const rounds = {};
  roundKeys.forEach((round) => {
    const fixtures = fixturesForRoundKey(league, round);
    if (fixtures.every((f) => f.finalized)) return;
    const courtLoad = Array(courts).fill(0);
    // Builds fresh cell objects for the response rather than mutating the
    // saved grid's own cells in place — getCourtGrid hands back the SAME
    // cell references league.courtSchedule holds, and this response
    // carries a closeness field the stored schedule has no business
    // holding.
    const grid = getCourtGrid(league, round).map((row, s) => row.map((cell, c) => {
      if (!cell) return null;
      const f = fixtures.find((x) => x.id === cell.fixtureId);
      if (!f) return null;
      const pred = matchPrediction(league, f, cell.seed, ratingsData, identityOf) || { closeness: 50 };
      courtLoad[c] += pred.closeness;
      return { fixtureId: cell.fixtureId, seed: cell.seed, ...pred };
    }));
    rounds[round] = { grid, courtLoad };
  });

  return rounds;
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

// A team or a single player can be given a discount. The team's fee is the
// league's less the team's discount; each player's share is that split evenly,
// less their own discount (which lowers what the team owes, not what the
// others pay).
function teamBaseFeeCents(league, team) {
  return Math.max(0, (league.registrationFeeCents || 0) - Math.min(team.discountCents || 0, league.registrationFeeCents || 0));
}
function playerBaseShareCents(league, team) {
  return Math.round(teamBaseFeeCents(league, team) / (team.players.length || 1));
}
function playerShareCents(league, team, p) {
  const base = playerBaseShareCents(league, team);
  return p ? Math.max(0, base - Math.min(p.discountCents || 0, base)) : base;
}
// What the team owes in total once every discount is taken off.
function teamFeeCents(league, team) {
  const base = playerBaseShareCents(league, team);
  const playerDiscounts = team.players.reduce((t, p) => t + Math.min(p.discountCents || 0, base), 0);
  return Math.max(0, teamBaseFeeCents(league, team) - playerDiscounts);
}
// Payments move freely between the team and its players: the team owes one fee,
// and anything a player pays toward their share or the team pays as a lump sum
// both count against it. Nothing is locked to one way of paying.
// What a player has paid toward their share: the running total of their own
// payments (a part payment counts), or for records from before part payments
// existed, their whole share if they were marked paid.
function playerPaidCents(league, team, p) {
  if (p.paidCents != null) return p.paidCents;
  return p.paymentStatus === "paid" && !p.coveredByTeam ? playerShareCents(league, team, p) : 0;
}
// What's still owed on a player's share (nothing once the team's covered it).
function playerOwedCents(league, team, p) {
  if (p.paymentStatus === "paid") return 0;
  return Math.max(0, playerShareCents(league, team, p) - playerPaidCents(league, team, p));
}
// Records one payment from a player — the whole share or just part of it.
// Once their payments add up to the share they're paid in full.
function addPlayerPayment(league, team, p, cents, method, ref, at) {
  const total = playerPaidCents(league, team, p) + cents;
  p.payments = (p.payments || []).concat([{ cents, method, ref: ref || null, at }]);
  p.paidCents = total;
  p.paymentMethod = method; p.paymentRef = ref || null; p.paidAt = at;
  p.coveredByTeam = false;
  p.paymentStatus = total >= playerShareCents(league, team, p) - 1 ? "paid" : "unpaid";
  reconcileTeamPayment(league, team);
}
function resetPlayerPayments(p) {
  p.paymentStatus = "unpaid"; p.paymentMethod = null; p.paymentRef = null; p.paidAt = null;
  p.paidCents = 0; p.payments = []; p.coveredByTeam = false;
}
function teamPaidCents(league, team) {
  const fee = teamFeeCents(league, team);
  if (team.paymentStatus === "paid") return fee;
  return (team.lumpCents || 0) + team.players.reduce((t, p) => t + playerPaidCents(league, team, p), 0);
}
function teamBalanceCents(league, team) {
  return Math.max(0, teamFeeCents(league, team) - teamPaidCents(league, team));
}
// The team fee is settled: everyone still unpaid is covered by it.
function coverTeamPlayers(team, method, ref, at) {
  team.players.forEach((p) => {
    if (p.paymentStatus === "paid") return;
    // Whatever part a player had already paid stays on their record.
    p.paymentStatus = "paid"; p.paymentMethod = method; p.paymentRef = ref || null; p.paidAt = at; p.coveredByTeam = true;
  });
}
// Keeps the team's own status in step with what its players have paid: all the
// shares in means the team is paid; a share taken back reopens it.
function reconcileTeamPayment(league, team) {
  if (!league.registrationFeeCents) return;
  const fee = teamFeeCents(league, team);
  if (team.paymentStatus === "paid" && team.paymentMethod === "split") {
    if (teamPaidCents(league, { ...team, paymentStatus: "unpaid" }) < fee - 1) { team.paymentStatus = "unpaid"; team.paymentMethod = null; team.paidAt = null; }
    return;
  }
  if (team.paymentStatus !== "paid" && teamPaidCents(league, team) >= fee - 1) {
    team.paymentStatus = "paid"; team.paymentMethod = "split"; team.paidAt = Date.now();
  }
}
// After a discount changes what someone owes: paid up if what they've put in now
// covers it, or open again if a discount was taken away.
function reconcilePlayerStatus(league, team, p) {
  if (p.coveredByTeam) return;
  const share = playerShareCents(league, team, p);
  const paid = playerPaidCents(league, team, p);
  if (p.paymentStatus !== "paid" && (share === 0 || (paid > 0 && paid >= share - 1))) {
    p.paymentStatus = "paid"; p.paymentMethod = share === 0 ? "discount" : (p.paymentMethod || "manual"); p.paidAt = p.paidAt || Date.now();
    if (p.paidCents == null) p.paidCents = 0;
  } else if (p.paymentStatus === "paid" && p.paidCents != null && paid < share - 1) {
    p.paymentStatus = "unpaid"; p.paymentMethod = null; p.paidAt = null;
  }
}
// Reads a discount in rands from a request into cents, against `baseCents`.
function discountCentsFromBody(body, baseCents) {
  const rands = Number(body && body.amountRands);
  if (!Number.isFinite(rands) || rands < 0) return { error: "Enter the discount as an amount in rands." };
  const cents = Math.round(rands * 100);
  if (cents > baseCents) return { error: `That's more than what's owed (R${(baseCents / 100).toFixed(2)}).` };
  return { cents };
}
router.put("/leagues/:leagueId/teams/:teamId/discount", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league && league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const r = discountCentsFromBody(req.body, league.registrationFeeCents || 0);
  if (r.error) return res.status(400).json({ error: r.error });
  team.discountCents = r.cents || 0;
  team.discountNote = cleanHubText(req.body && req.body.note, 120) || null;
  if (!team.discountCents) { delete team.discountCents; delete team.discountNote; }
  team.players.forEach((p) => reconcilePlayerStatus(league, team, p));
  reconcileTeamPayment(league, team);
  logAudit(league, req, null, "team_discount", { teamName: team.name, discountCents: team.discountCents || 0, note: team.discountNote || "" });
  store.saveLeague(league.id, league);
  res.json({ ok: true, discountCents: team.discountCents || 0, feeCents: teamFeeCents(league, team) });
});
router.put("/leagues/:leagueId/teams/:teamId/players/:playerId/discount", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { team, player } = league ? findTeamAndPlayer(league, req.params.teamId, req.params.playerId) : {};
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const r = discountCentsFromBody(req.body, playerBaseShareCents(league, team));
  if (r.error) return res.status(400).json({ error: r.error });
  player.discountCents = r.cents || 0;
  player.discountNote = cleanHubText(req.body && req.body.note, 120) || null;
  if (!player.discountCents) { delete player.discountCents; delete player.discountNote; }
  reconcilePlayerStatus(league, team, player);
  reconcileTeamPayment(league, team);
  logAudit(league, req, null, "player_discount", { playerName: player.name, teamName: team.name, discountCents: player.discountCents || 0, note: player.discountNote || "" });
  store.saveLeague(league.id, league);
  res.json({ ok: true, discountCents: player.discountCents || 0, shareCents: playerShareCents(league, team, player) });
});
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
  if (team.paymentStatus === "paid" || teamBalanceCents(league, team) <= 0) return res.status(400).json({ error: "This team is already marked as paid." });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: teamBalanceCents(league, team) / 100,
    itemName: `${league.name} registration — ${team.name}`.slice(0, 100),
    returnUrl: `${base}/#league/${league.id}`,
    cancelUrl: `${base}/#league/${league.id}`,
    notifyUrl: `${base}/api/payfast/notify`,
    customStr1: league.id,
    customStr2: team.id,
  });
  res.json(checkout);
});

// No-login link for a team's lump-sum fee — same idea as a player's
// pay-link below, just for "team" mode instead of "split": whoever holds
// the link can pay the whole team's fee without ever signing in.
router.get("/leagues/:leagueId/teams/:teamId/pay-link", requireAdminOrCaptain(), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (!team.payLinkToken) {
    team.payLinkToken = crypto.randomBytes(16).toString("hex");
    store.saveLeague(league.id, league);
  }
  const base = `${req.protocol}://${req.get("host")}`;
  // A real path, not the app's own #pay-link-team/... hash route — a
  // hash fragment never reaches the server at all, so WhatsApp/iMessage's
  // link-preview crawler had nothing to read except whatever index.html's
  // own static <head> says (generic "Team Padel" branding, not "Payment
  // link"). This real path is handled in server.js: it serves its own
  // <head> (title, description, a distinct payment-themed image) for the
  // crawler, then immediately sends a real visitor on into the exact same
  // #pay-link-team/... page.
  res.json({ url: `${base}/pay-team/${league.id}/${team.id}/${team.payLinkToken}` });
});
router.get("/leagues/:leagueId/teams/:teamId/pay-link/:token", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Link not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team || !team.payLinkToken || team.payLinkToken !== req.params.token) {
    return res.status(404).json({ error: "This payment link is invalid." });
  }
  res.json({
    leagueName: league.name, teamName: team.name, teamLogo: team.logo || "",
    amountCents: teamBalanceCents(league, team), feeCents: teamFeeCents(league, team),
    paid: team.paymentStatus === "paid" || teamBalanceCents(league, team) <= 0, paidAt: team.paidAt || null,
    // Same league-wide context as the per-player pay-link, so a team's
    // lump-sum link looks identical to an individual player's — see that
    // route's comment for why the photo itself isn't embedded here.
    venueName: league.defaultVenue || "", hasCourtPhoto: !!league.courtPhoto,
    teamLogos: league.teams.map((t) => ({ name: t.name, logo: t.logo || "" })),
    totalPlayers: league.teams.reduce((sum, t) => sum + t.players.length, 0),
    teamCount: league.teams.length,
  });
});
router.get("/leagues/:leagueId/teams/:teamId/pay-link/:token/checkout", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team || !team.payLinkToken || team.payLinkToken !== req.params.token) {
    return res.status(404).json({ error: "This payment link is invalid." });
  }
  if (!league.registrationFeeCents) return res.status(400).json({ error: "This league has no registration fee set." });
  if (team.paymentStatus === "paid" || teamBalanceCents(league, team) <= 0) return res.status(400).json({ error: "This team is already marked as paid." });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: teamBalanceCents(league, team) / 100,
    itemName: `${league.name} registration — ${team.name}`.slice(0, 100),
    returnUrl: `${base}/#pay-link-team/${league.id}/${team.id}/${team.payLinkToken}`,
    cancelUrl: `${base}/#pay-link-team/${league.id}/${team.id}/${team.payLinkToken}`,
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
  if (paid) {
    coverTeamPlayers(team, "manual", null, team.paidAt);
  } else {
    // Taking the team payment back also takes back the shares it covered;
    // anything a player paid themselves stays paid.
    team.lumpCents = 0;
    team.players.forEach((p) => {
      if (!p.coveredByTeam) return;
      p.paymentStatus = "unpaid"; p.paymentMethod = null; p.paymentRef = null; p.paidAt = null; p.coveredByTeam = false;
    });
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
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
  // Real path, not a #pay-link/... hash — see the team pay-link route's
  // comment above for why (WhatsApp/iMessage can't read a hash fragment).
  res.json({ url: `${base}/pay/${league.id}/${team.id}/${player.id}/${player.payLinkToken}` });
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
    leagueName: league.name, teamName: team.name, teamLogo: team.logo || "", playerName: player.name,
    amountCents: playerOwedCents(league, team, player), shareCents: playerShareCents(league, team, player),
    paidCents: player.paymentStatus === "paid" && !player.coveredByTeam && player.paidCents == null ? playerShareCents(league, team, player) : (player.paidCents || 0),
    paid: player.paymentStatus === "paid", paidAt: player.paidAt || null,
    // League-wide context — the venue photo (fetched lazily by the client
    // from GET /leagues/:leagueId/court-photo, same as a hub card, rather
    // than embedded here), every team's logo for the roster strip, and
    // the league's total headcount so the page reads as "you're one of
    // many", not just a bare amount.
    venueName: league.defaultVenue || "", hasCourtPhoto: !!league.courtPhoto,
    teamLogos: league.teams.map((t) => ({ name: t.name, logo: t.logo || "" })),
    totalPlayers: league.teams.reduce((sum, t) => sum + t.players.length, 0),
    teamCount: league.teams.length,
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
  if (player.paymentStatus === "paid") return res.status(400).json({ error: "This player is already marked as paid." });
  // Pay the lot, or part of it: ?amount= (rands) between R10 and what's left.
  const owed = playerOwedCents(league, team, player);
  if (owed <= 0) return res.status(400).json({ error: "This player is already marked as paid." });
  let payCents = owed;
  if (req.query.amount !== undefined) {
    payCents = Math.round(Number(req.query.amount) * 100);
    const min = Math.min(1000, owed);
    if (!Number.isFinite(payCents) || payCents < min || payCents > owed) {
      return res.status(400).json({ error: `Enter an amount between R${(min / 100).toFixed(2)} and R${(owed / 100).toFixed(2)}.` });
    }
  }
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: payCents / 100,
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
  if (paid) {
    // "Mark paid" settles whatever is left of their share.
    const left = player.paymentStatus === "paid" ? 0 : playerOwedCents(league, team, player);
    if (left > 0) addPlayerPayment(league, team, player, left, "manual", null, Date.now());
    else { player.paymentStatus = "paid"; reconcileTeamPayment(league, team); }
  } else {
    resetPlayerPayments(player);
    reconcileTeamPayment(league, team);
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// A part (or full) payment collected outside PayFast — cash or EFT — recorded
// against one player's share. It adds up with anything they've already paid.
router.post("/leagues/:leagueId/teams/:teamId/players/:playerId/payments", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { team, player } = findTeamAndPlayer(league, req.params.teamId, req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const cents = Math.round(Number(req.body && req.body.amountRands) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ error: "Enter an amount in rands." });
  const owed = playerOwedCents(league, team, player);
  if (cents > owed) return res.status(400).json({ error: `That's more than what's left on their share (R${(owed / 100).toFixed(2)}).` });
  addPlayerPayment(league, team, player, cents, "manual", null, Date.now());
  store.saveLeague(league.id, league);
  res.json({ ok: true, paid: player.paymentStatus === "paid", paidCents: player.paidCents });
});

/* ---------- Custom charges — a one-off amount + reason, not tied to the
   season's own registration fee. The admin picks a team (or a specific
   player on it), sets any price and a reason ("Kit fee", "Late fine",
   whatever), and gets a link the same way the season fee does — this
   just isn't limited to the one fixed, whole-season amount every team or
   player already owes. ---------- */
// `base` is the list route's own req-derived origin — every charge needs
// its pay link here, not just the one just created, so whoever's copying a
// link for an older charge from the list gets the real URL instead of
// "undefined" (payLinkToken itself stays out of this payload either way,
// same as a player/team's own pay-link token never ships in the general
// league payload — only ever folded into the URL string here).
function customChargeSummary(league, c, base) {
  const team = league.teams.find((t) => t.id === c.teamId);
  const player = c.playerId && team ? team.players.find((p) => p.id === c.playerId) : null;
  return {
    id: c.id, teamId: c.teamId, teamName: team ? team.name : "Deleted team",
    playerId: c.playerId, playerName: player ? player.name : null,
    reason: c.reason, amountCents: c.amountCents,
    paid: !!c.paid, paidAt: c.paidAt || null, paymentMethod: c.paymentMethod || null, paymentRef: c.paymentRef || null,
    createdAt: c.createdAt,
    url: base ? `${base}/pay-custom/${league.id}/${c.id}/${c.payLinkToken}` : undefined,
  };
}
router.get("/leagues/:leagueId/custom-charges", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const base = `${req.protocol}://${req.get("host")}`;
  const charges = (league.customCharges || []).slice().sort((a, b) => b.createdAt - a.createdAt).map((c) => customChargeSummary(league, c, base));
  res.json(charges);
});
router.post("/leagues/:leagueId/custom-charges", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { teamId, playerId, amountRands, reason } = req.body || {};
  const team = league.teams.find((t) => t.id === teamId);
  if (!team) return res.status(400).json({ error: "Team not found." });
  if (playerId && !team.players.some((p) => p.id === playerId)) return res.status(400).json({ error: "Player not found on that team." });
  const amount = Number(amountRands);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Enter a valid amount." });
  const reasonTrimmed = ((reason || "") + "").trim();
  if (!reasonTrimmed) return res.status(400).json({ error: "Enter a reason for this payment." });
  if (!league.customCharges) league.customCharges = [];
  const charge = {
    id: logic.uid(), teamId, playerId: playerId || null,
    amountCents: Math.round(amount * 100), reason: reasonTrimmed.slice(0, 200),
    payLinkToken: crypto.randomBytes(16).toString("hex"),
    paid: false, paidAt: null, paymentMethod: null, paymentRef: null,
    createdAt: Date.now(),
  };
  league.customCharges.push(charge);
  store.saveLeague(league.id, league);
  const base = `${req.protocol}://${req.get("host")}`;
  res.json(customChargeSummary(league, charge, base));
});
router.put("/leagues/:leagueId/custom-charges/:chargeId/payment-status", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const charge = (league.customCharges || []).find((c) => c.id === req.params.chargeId);
  if (!charge) return res.status(404).json({ error: "Charge not found." });
  const paid = !!req.body.paid;
  charge.paid = paid;
  charge.paymentMethod = paid ? "manual" : null;
  charge.paymentRef = paid ? charge.paymentRef : null;
  charge.paidAt = paid ? Date.now() : null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Only while unpaid — once real money has moved against it, deleting
// would erase the only record of that payment ever happening.
router.delete("/leagues/:leagueId/custom-charges/:chargeId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const charge = (league.customCharges || []).find((c) => c.id === req.params.chargeId);
  if (!charge) return res.status(404).json({ error: "Charge not found." });
  if (charge.paid) return res.status(400).json({ error: "This has already been paid — it can't be deleted." });
  league.customCharges = league.customCharges.filter((c) => c.id !== req.params.chargeId);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Public read (no login) — the standalone pay page behind a custom
// charge's own link needs to show it, same as any other pay-link.
router.get("/leagues/:leagueId/custom-charges/:chargeId/pay-link/:token", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Link not found." });
  const charge = (league.customCharges || []).find((c) => c.id === req.params.chargeId);
  if (!charge || charge.payLinkToken !== req.params.token) return res.status(404).json({ error: "This payment link is invalid." });
  const team = league.teams.find((t) => t.id === charge.teamId);
  const player = charge.playerId && team ? team.players.find((p) => p.id === charge.playerId) : null;
  res.json({
    leagueName: league.name, teamName: team ? team.name : "", teamLogo: team ? (team.logo || "") : "",
    playerName: player ? player.name : null,
    reason: charge.reason, amountCents: charge.amountCents,
    paid: charge.paid, paidAt: charge.paidAt,
    // Same league-wide context the season-fee pay-link shows — see that
    // route's comment for why the photo itself isn't embedded here.
    venueName: league.defaultVenue || "", hasCourtPhoto: !!league.courtPhoto,
    teamLogos: league.teams.map((t) => ({ name: t.name, logo: t.logo || "" })),
    totalPlayers: league.teams.reduce((sum, t) => sum + t.players.length, 0),
    teamCount: league.teams.length,
  });
});
router.get("/leagues/:leagueId/custom-charges/:chargeId/pay-link/:token/checkout", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const charge = (league.customCharges || []).find((c) => c.id === req.params.chargeId);
  if (!charge || charge.payLinkToken !== req.params.token) return res.status(404).json({ error: "This payment link is invalid." });
  if (charge.paid) return res.status(400).json({ error: "This is already marked as paid." });
  const team = league.teams.find((t) => t.id === charge.teamId);
  const player = charge.playerId && team ? team.players.find((p) => p.id === charge.playerId) : null;
  const base = `${req.protocol}://${req.get("host")}`;
  const checkout = payfast.buildCheckout({
    amountRands: charge.amountCents / 100,
    itemName: `${league.name} — ${charge.reason}`.slice(0, 100),
    returnUrl: `${base}/#pay-custom/${league.id}/${charge.id}/${charge.payLinkToken}`,
    cancelUrl: `${base}/#pay-custom/${league.id}/${charge.id}/${charge.payLinkToken}`,
    notifyUrl: `${base}/api/payfast/notify`,
    customStr1: league.id,
    customStr2: charge.teamId,
    customStr3: player ? player.id : "",
    customStr4: charge.id,
  });
  res.json(checkout);
});

// Every not-yet-finalized fixture across every league this account
// captains where THIS team's own line-up hasn't been submitted yet — the
// same "surface it on the homepage" treatment /players/dues gets for
// outstanding registration fees, just for line-ups instead. Fully
// recomputed on every request, nothing persisted here — the persisted,
// once-only side of this same concern is the in-league/email notification
// checkLineupReminders sends as kickoff approaches.
router.get("/players/lineups-due", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const out = [];
  (user.captaincies || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    if (!league || league.format === "pairs") return;
    const team = league.teams.find((t) => t.id === c.teamId);
    if (!team) return;
    logic.allFixturesOf(league).forEach((f) => {
      if (f.finalized || !f.teamA || !f.teamB) return;
      // Every round's fixtures exist from the season's first day, but a
      // captain can't submit a line-up for a round that hasn't opened yet
      // (still waiting on the previous round, or its date-based lead time)
      // — without this, every future round's still-empty selection shows
      // up as "due" from week one, not just the one actually open right now.
      if (!isRoundOpen(league, f)) return;
      const side = f.teamA === c.teamId ? "A" : f.teamB === c.teamId ? "B" : null;
      if (!side) return;
      const sel = side === "A" ? f.selectionA : f.selectionB;
      if (sel.submitted) return;
      const oppTeam = league.teams.find((t) => t.id === (side === "A" ? f.teamB : f.teamA));
      const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
      // Only meaningful once there's a real kickoff time, not just a date —
      // the client uses this to count down to the *real* deadline (24h
      // before kickoff), not kickoff itself; a date-only fixture has no
      // exact instant to count down to, so it stays null and falls back to
      // the plain day label like before.
      out.push({
        leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name,
        fixtureId: f.id, label: fixtureLabel(league, f),
        opponentName: oppTeam ? oppTeam.name : "TBD",
        opponentLogo: oppTeam ? oppTeam.logo || "" : "",
        date: sched.date || "", time: sched.time || "",
        kickoffMs: kickoffMsOf(sched.date, sched.time),
      });
    });
  });
  // Soonest kickoff first; nothing scheduled yet sinks to the bottom
  // rather than sorting arbitrarily.
  out.sort((a, b) => {
    if (a.date && b.date) return (a.date + a.time).localeCompare(b.date + b.time);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
  res.json(out);
});

// Plain-text "A & B" for one rubber's pair — the server-side equivalent of
// the client's pairNamesGoldHtml, minus the gold-sub styling this has no
// use for. A missing pair (lineup not submitted, or a slot skipped) reads
// as "TBD" rather than blank, since this feeds a list meant to stand on
// its own without the fixture's full context alongside it.
function pairNamesText(team, pair) {
  if (!team || !pair) return "TBD";
  const names = pair.map((pid) => (team.players.find((p) => p.id === pid) || {}).name).filter(Boolean);
  return names.length ? names.join(" & ") : "TBD";
}
// "Sam Ortiz" -> "Sam O." — same shortening the client's shortPlayerName
// applies for tight spaces (the poster's grid cells), used here so the
// playoff splash's court chips (see teamPlayoffSplash) fit a full pair's
// names in a fifth of the screen's width.
function shortNameOf(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[0] + " " + parts[parts.length - 1].charAt(0).toUpperCase() + "." : parts[0];
}
function shortPairNamesText(team, pair) {
  if (!team || !pair) return "TBD";
  const names = pair.map((pid) => (team.players.find((p) => p.id === pid) || {}).name).filter(Boolean).map(shortNameOf);
  return names.length ? names.join(" & ") : "TBD";
}
// The playoff splash's court-by-court chip strip (see teamPlayoffSplash and
// leagueFinalsSpectatorSplash below) — null until both sides have actually
// picked their lineup, since there's nothing real to show before then.
function buildSplashLineups(mySel, myTeam, oppSel, oppTeam) {
  if (!(mySel.submitted && oppSel.submitted)) return null;
  const isSinglesFixture = mySel.pairs.length === 5;
  return mySel.pairs.map((pair, idx) => ({
    seed: idx + 1,
    isSingles: isSinglesFixture && idx === 4,
    mine: shortPairNamesText(myTeam, pair),
    theirs: shortPairNamesText(oppTeam, oppSel.pairs[idx]),
  }));
}
// Every fixture a captained team has actually started playing (something's
// been entered or its kickoff has passed) but hasn't been finalized yet —
// the cross-league equivalent of the "tap an opponent to enter a score"
// list already on each league's own Results tab, surfaced on My Profile so
// a captain doesn't have to go hunting for the right league first. Each
// fixture carries its own rubbers (real pair names, per-seed score) so the
// client can show the same per-rubber breakdown resultsCard does, without
// a second round-trip once the captain taps in.
router.get("/players/pending-results", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const out = [];
  const seen = new Set();
  const now = Date.now();
  // `playerId` set means a player (not the captain) is looking: they only get
  // the matches they played in, and only those they're still allowed to enter
  // or fix (a score their captain or the admin put in is theirs to change).
  const consider = (league, team, f, playerId) => {
    if (f.finalized || !f.teamA || !f.teamB) return;
    if (f.teamA !== team.id && f.teamB !== team.id) return;
    const key = league.id + ":" + f.id;
    if (seen.has(key)) return;
    const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
    const kickoffMs = kickoffMsOf(sched.date, sched.time);
    const started = f.rubbers.some((r) => r.startedAt) || logic.fixtureScore(f).decided > 0 || (kickoffMs && kickoffMs < now);
    if (!started) return;
    const oppTeam = league.teams.find((t) => t.id === (f.teamA === team.id ? f.teamB : f.teamA));
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    const lineupsSubmitted = !!(f.selectionA.submitted && f.selectionB.submitted);
    if (playerId && !lineupsSubmitted) return;
    const { winsA, winsB } = logic.fixtureScore(f);
    // The 5th rubber (index 4) is either the knockout playoff decider —
    // only shown once the first 4 rubbers have actually tied, and no
    // selection slot of its own — or, on an Ormonde-rules regular fixture,
    // a real singles match with its own (single-player) selection slot,
    // always shown. Same rule resultsCard uses client-side.
    const isSinglesFixture = f.selectionA.pairs.length === 5;
    const playedIn = (idx) => ((f.selectionA.pairs[idx] || []).includes(playerId)) || ((f.selectionB.pairs[idx] || []).includes(playerId));
    const rubbers = lineupsSubmitted
      ? f.rubbers
          .map((rubber, idx) => ({ rubber, idx }))
          .filter(({ idx }) => idx !== 4 || isSinglesFixture || winsA === winsB)
          .filter(({ idx }) => !playerId || playedIn(idx))
          .map(({ rubber, idx }) => {
            const winner = logic.rubberWinner(rubber);
            const isKnockoutDecider = idx === 4 && !isSinglesFixture;
            return {
              seed: idx + 1, isDecider: isKnockoutDecider, isSingles: idx === 4 && isSinglesFixture,
              pairA: isKnockoutDecider ? teamA.name : pairNamesText(teamA, f.selectionA.pairs[idx]),
              pairB: isKnockoutDecider ? teamB.name : pairNamesText(teamB, f.selectionB.pairs[idx]),
              scoreText: logic.rubberScoreText(rubber) || null,
              wonSide: winner,
              // A double forfeit has no winning side but is still fully
              // settled — distinct from wonSide so "everything's decided"
              // doesn't wrongly stay true just because nobody won.
              decided: !!(winner || rubber.forfeited),
              // A player can't change a score their captain or the admin entered.
              locked: !!playerId && (rubber.forfeited || (!!logic.rubberScoreText(rubber) && rubber.scoreBy !== "player")),
            };
          })
      : [];
    if (playerId) {
      // Nothing for a player to do: none of their matches is open to them.
      if (!rubbers.length || rubbers.every((r) => r.locked)) return;
    } else if (lineupsSubmitted && rubbers.length && rubbers.every((r) => r.decided)) {
      // Nothing left to enter — every match already has a settled result,
      // it's only waiting to be finalized — so it isn't "due" any more and
      // shouldn't sit at the top of the profile.
      return;
    }
    seen.add(key);
    out.push({
      leagueId: league.id, leagueName: league.name, teamId: team.id, teamName: team.name, teamLogo: team.logo || "",
      fixtureId: f.id, label: fixtureLabel(league, f),
      opponentTeamId: oppTeam ? oppTeam.id : null,
      opponentName: oppTeam ? oppTeam.name : "TBD",
      opponentLogo: oppTeam ? oppTeam.logo || "" : "",
      date: sched.date || "", time: sched.time || "",
      lineupsSubmitted, score: { a: winsA, b: winsB },
      playerOnly: !!playerId,
      rubbers,
    });
  };
  (user.captaincies || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    if (!league) return;
    const team = league.teams.find((t) => t.id === c.teamId);
    if (!team) return;
    logic.allFixturesOf(league).forEach((f) => consider(league, team, f, null));
  });
  // Players who aren't captains get their own matches too.
  (user.claims || []).forEach((c) => {
    if (c.leftAt) return;
    const league = store.getLeague(c.leagueId);
    if (!league || league.format === "pairs") return;
    const team = league.teams.find((t) => t.id === c.teamId);
    if (!team) return;
    logic.allFixturesOf(league).forEach((f) => consider(league, team, f, c.playerId));
  });
  // Most recently played first — a fixture from last week waiting on a
  // score is more urgent than one from an hour ago.
  out.sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
  res.json(out);
});

// ---- Player auction room ----
// Teams arrive with retained players and a fixed budget; the open spots are
// filled by captains bidding live. Rules live in auction.js; this is only the
// HTTP wrapper: load the league's auction, run one action, save, answer.
function auctionViewer(req, league) {
  const isAdmin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
  return { isAdmin, teamId: u && u.role === "captain" ? u.teamId : null };
}
// The league record only remembers the auction's overall status (so the tab
// can show or hide without an extra request); the bids live in their own key.
function syncAuctionStatus(league, a) {
  const next = a ? a.status : undefined;
  if (league.auctionStatus === next) return;
  if (next === undefined) delete league.auctionStatus; else league.auctionStatus = next;
  store.saveLeague(league.id, league);
}
function loadAuction(req, res) {
  const league = store.getLeague(req.params.leagueId);
  if (!league) { res.status(404).json({ error: "League not found." }); return null; }
  const a = store.getAuction(league.id);
  return { league, a };
}
router.get("/leagues/:leagueId/auction", (req, res) => {
  const ctx = loadAuction(req, res);
  if (!ctx) return;
  const { league, a } = ctx;
  const viewer = auctionViewer(req, league);
  if (!a) return res.json({ exists: false, isAdmin: viewer.isAdmin });
  if (req.query.since && Number(req.query.since) === a.version) return res.json({ unchanged: true, version: a.version, serverTime: Date.now() });
  res.json(auction.publicState(a, league, viewer));
});
// Creates the room for this league (the Auction tab then appears for everyone).
router.post("/leagues/:leagueId/auction", requireAdmin, (req, res) => {
  const ctx = loadAuction(req, res);
  if (!ctx) return;
  if (ctx.a) return res.status(400).json({ error: "This league already has an auction." });
  if (league_isPairs(ctx.league)) return res.status(400).json({ error: "Auctions are for team leagues." });
  const a = auction.newAuction(ctx.league);
  store.saveAuction(ctx.league.id, a);
  syncAuctionStatus(ctx.league, a);
  res.json(auction.publicState(a, ctx.league, auctionViewer(req, ctx.league)));
});
function league_isPairs(league) { return league.format === "pairs"; }
router.delete("/leagues/:leagueId/auction", requireAdmin, (req, res) => {
  const ctx = loadAuction(req, res);
  if (!ctx || !ctx.a) return ctx && res.status(404).json({ error: "No auction to delete." });
  if (ctx.a.applied) return res.status(400).json({ error: "The results are already in the team rosters, so this auction can't be deleted." });
  store.deleteAuction(ctx.league.id);
  syncAuctionStatus(ctx.league, null);
  res.json({ ok: true });
});
// One handler shape for every admin action: run it, and on success save and
// return the fresh room, on failure return the plain-English reason.
function adminAuctionAction(fn) {
  return (req, res) => {
    const ctx = loadAuction(req, res);
    if (!ctx) return;
    if (!ctx.a) return res.status(404).json({ error: "This league has no auction yet." });
    const r = fn(ctx.a, ctx.league, req.body || {}, req);
    if (r && r.error) return res.status(400).json({ error: r.error });
    store.saveAuction(ctx.league.id, ctx.a);
    syncAuctionStatus(ctx.league, ctx.a);
    res.json(auction.publicState(ctx.a, ctx.league, auctionViewer(req, ctx.league)));
  };
}
// Dummy import (test leagues only): each team keeps its first two players at
// a price of 5, and a made-up pool of 20 players goes up for sale.
router.post("/leagues/:leagueId/auction/dummy-import", requireAdmin, adminAuctionAction((a, league) => {
  if (!league.isTest) return { error: "Dummy import is only for test leagues." };
  if (a.status !== "setup") return { error: "The auction has started." };
  const retained = {};
  league.teams.forEach((t) => { retained[t.id] = t.players.slice(0, 2).map((p) => ({ playerId: p.id, price: 5 })); });
  const set = auction.setupAuction(a, league, a.config, retained);
  if (set.error) return set;
  for (const tier of testdata.poolPlan(league, a.pool, a.config.minBid)) {
    if (!tier.names.length) continue;
    const r = auction.addToPool(a, tier.names, tier.base);
    if (r.error) return r;
  }
  return { ok: true };
}));
router.put("/leagues/:leagueId/auction/setup", requireAdmin, adminAuctionAction((a, league, body) => auction.setupAuction(a, league, body.config, body.retained)));
router.post("/leagues/:leagueId/auction/pool", requireAdmin, adminAuctionAction((a, league, body) => auction.addToPool(a, body.names, body.basePrice)));
router.put("/leagues/:leagueId/auction/pool/:poolId", requireAdmin, adminAuctionAction((a, league, body, req) => auction.updatePoolItem(a, req.params.poolId, body)));
router.delete("/leagues/:leagueId/auction/pool/:poolId", requireAdmin, adminAuctionAction((a, league, body, req) => auction.removeFromPool(a, req.params.poolId)));
router.post("/leagues/:leagueId/auction/start", requireAdmin, adminAuctionAction((a) => auction.start(a)));
router.post("/leagues/:leagueId/auction/pause", requireAdmin, adminAuctionAction((a) => auction.setPaused(a, true)));
router.post("/leagues/:leagueId/auction/resume", requireAdmin, adminAuctionAction((a) => auction.setPaused(a, false)));
router.post("/leagues/:leagueId/auction/next", requireAdmin, adminAuctionAction((a, league, body) => auction.nextPlayer(a, body.poolId)));
router.post("/leagues/:leagueId/auction/sold", requireAdmin, adminAuctionAction((a, league) => auction.sell(a, league)));
router.post("/leagues/:leagueId/auction/pass", requireAdmin, adminAuctionAction((a) => auction.pass(a)));
router.post("/leagues/:leagueId/auction/undo-sale", requireAdmin, adminAuctionAction((a) => auction.undoSale(a)));
router.post("/leagues/:leagueId/auction/undo-bid", requireAdmin, adminAuctionAction((a) => auction.undoBid(a)));
router.post("/leagues/:leagueId/auction/ask", requireAdmin, adminAuctionAction((a, league, body) => auction.setAsk(a, body.amount)));
router.put("/leagues/:leagueId/auction/pricing", requireAdmin, adminAuctionAction((a, league, body) => auction.updatePricing(a, body)));
router.post("/leagues/:leagueId/auction/finish", requireAdmin, adminAuctionAction((a, league, body) => {
  // Check that adding the results to the rosters can work BEFORE changing
  // anything, so a refusal leaves the auction exactly as it was.
  if (body.apply && !a.applied) {
    const blocked = auction.rosterBlockers(a, league);
    if (blocked.length) return { error: `These players are already in match line-ups and can't be released: ${blocked.join(", ")}.` };
  }
  const r = auction.finish(a);
  if (r.error) return r;
  if (body.apply) {
    const applied = auction.applyToRosters(a, league);
    if (applied.error) return applied;
    store.saveLeague(league.id, league);
  }
  return r;
}));
router.post("/leagues/:leagueId/auction/apply", requireAdmin, adminAuctionAction((a, league) => {
  if (a.status !== "done") return { error: "Finish the auction first." };
  const r = auction.applyToRosters(a, league);
  if (r.error) return r;
  store.saveLeague(league.id, league);
  return r;
}));
// A captain bids for their own team; the admin may bid on behalf of any team
// (a captain with no signal, say) by naming it.
router.post("/leagues/:leagueId/auction/bid", (req, res) => {
  const ctx = loadAuction(req, res);
  if (!ctx) return;
  if (!ctx.a) return res.status(404).json({ error: "This league has no auction yet." });
  const viewer = auctionViewer(req, ctx.league);
  const wantedTeam = viewer.isAdmin && req.body && req.body.teamId ? req.body.teamId : viewer.teamId;
  if (!wantedTeam) return res.status(403).json({ error: "Only team captains can bid. Log in with your team code first." });
  const team = ctx.league.teams.find((t) => t.id === wantedTeam);
  if (!team) return res.status(400).json({ error: "Team not found." });
  const r = auction.placeBid(ctx.a, team, req.body && req.body.amount);
  if (r.error) {
    // A stale bid is not a fault: send the fresh room too so the screen can
    // jump straight to the new price.
    return res.status(r.stale ? 409 : 400).json({ error: r.error, room: r.stale ? auction.publicState(ctx.a, ctx.league, viewer) : undefined });
  }
  store.saveAuction(ctx.league.id, ctx.a);
  res.json(auction.publicState(ctx.a, ctx.league, viewer));
});

// ---- Opponent ratings (the FIFA-style player card) ----
// Rated by the people who actually faced you, only ever through the splash
// that follows a finalized match (see ratableMatchesFor): eight attributes,
// 1 Weak to 5 Elite, anonymous. A player's card only shows once they've
// collected RATINGS_TO_UNLOCK ratings.
const RATING_ATTRS = [
  ["consistency", "Consistency"], ["defence", "Defence"], ["coverage", "Court Coverage"], ["volleys", "Volleys"], ["vibora", "Vibora"],
  ["smash", "Smash"], ["lob", "Lob"], ["serve", "Serve"], ["mentality", "Mentality"],
];
const RATINGS_TO_UNLOCK = 3;
// How many of someone's most recent finished matches stay rate-able (My Profile
// shows them all); the pop-up on opening the app only ever shows the newest few
// of these — see RATING_POPUP_SIZE in app.js.
const RATING_QUEUE_SIZE = 10;
const RATING_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

function ratingMatchTime(league, f, rubber) {
  if (f.finalizedAt) return f.finalizedAt;
  if (rubber && rubber.completedAt) return rubber.completedAt;
  const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
  const date = sched.date || f.date;
  if (!date) return 0;
  const ms = kickoffMsOf(date, sched.time) || new Date(date + "T12:00:00+02:00").getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
// The rubbers this account actually played in that are finished and
// finalized, newest first, capped to the last few — each with the pair they
// faced. A rubber (one court's match) is the unit, not the whole team
// fixture, since that is what a player really played against two people.
// Anything older than the cap simply falls out of the window, so a player who
// closes the splash never has old matches resurface later.
function ratableMatchesFor(user) {
  const hidden = new Set(store.getIndex().filter((e) => e.hidden).map((e) => e.id));
  const mine = new Set((user.claims || []).map((c) => c.leagueId + ":" + c.playerId));
  const cutoff = Date.now() - RATING_WINDOW_MS;
  const byKey = new Map();
  let seq = 0;
  (user.claims || []).forEach((c) => {
    if (hidden.has(c.leagueId)) return;
    const league = store.getLeague(c.leagueId);
    const team = league && league.teams.find((t) => t.id === c.teamId);
    if (!team) return;
    logic.allFixturesOf(league).forEach((f) => {
      if (!f || !f.finalized || (f.teamA !== team.id && f.teamB !== team.id)) return;
      const mySide = f.teamA === team.id ? "A" : "B";
      const mySel = mySide === "A" ? f.selectionA : f.selectionB;
      const oppSel = mySide === "A" ? f.selectionB : f.selectionA;
      const oppTeam = league.teams.find((t) => t.id === (mySide === "A" ? f.teamB : f.teamA));
      if (!mySel || !oppSel || !oppTeam) return;
      (mySel.pairs || []).forEach((pair, idx) => {
        if (!pair || !pair.includes(c.playerId)) return;
        const rubber = f.rubbers[idx];
        if (!rubber || rubber.forfeited) return;
        const winner = logic.rubberWinner(rubber);
        const played = rubber.sets.length > 0 && !!(logic.setWinner(rubber.sets[0]) && logic.setWinner(rubber.sets[1]));
        if (!winner && !played) return;
        const key = league.id + ":" + f.id + ":" + idx;
        if (byKey.has(key)) return;
        const when = ratingMatchTime(league, f, rubber);
        if (when && when < cutoff) return;
        const ref = (team2, pid) => { const p = team2.players.find((x) => x.id === pid); return p ? { playerId: p.id, name: p.name } : null; };
        const opponents = (oppSel.pairs[idx] || []).map((pid) => ref(oppTeam, pid)).filter((o) => o && !mine.has(league.id + ":" + o.playerId));
        if (!opponents.length) return;
        // The other half of this player's own pair, if there is one (a singles
        // seed has none) — rated too, but at half weight (see attributeCardForKeys).
        const partner = pair.filter((pid) => pid && pid !== c.playerId && !mine.has(league.id + ":" + pid)).map((pid) => ref(team, pid)).filter(Boolean)[0] || null;
        const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
        byKey.set(key, {
          key, leagueId: league.id, leagueName: league.name, fixtureId: f.id, idx, when, seq: seq++,
          date: sched.date || f.date || "", label: logic.stageLabel(league, f),
          result: winner === null ? "D" : winner === mySide ? "W" : "L",
          scoreText: logic.rubberScoreText(rubber, mySide === "B"),
          mine: pair.map((pid) => ref(team, pid)).filter(Boolean),
          opponents, partner, myTeamName: team.name, oppTeamName: oppTeam.name,
        });
      });
    });
  });
  // Newest first; matches with no usable date (older data) fall back to the
  // order they sit in the fixture list, later meaning more recent.
  return Array.from(byKey.values()).sort((a, b) => b.when - a.when || b.seq - a.seq).slice(0, RATING_QUEUE_SIZE);
}
// A match that was dismissed (closed or skipped) comes back on the next
// couple of visits rather than being gone for good — people who close it
// once mostly just weren't ready. After this many dismissals it stops
// popping up on its own, but stays rate-able from the match on My Profile.
const RATING_MAX_DISMISSALS = 2;
// The matches this account could still rate: finished, within the window and
// with at least one opponent not yet rated. `all` includes ones already
// dismissed or marked done — what the "Rate" buttons on My Profile use.
function pendingRatingMatches(user, all) {
  const state = user.ratingState || {};
  const items = store.getPlayerRatings().items;
  return ratableMatchesFor(user)
    .filter((m) => all || (!(state.done && state.done[m.key]) && !((state.skips || {})[m.key] >= RATING_MAX_DISMISSALS)))
    .map((m) => ({
      ...m,
      opponents: m.opponents.map((o) => ({ ...o, rated: !!items[user.id + "|" + m.key + "|" + o.playerId] })),
      partner: m.partner ? { ...m.partner, role: "partner", rated: !!items[user.id + "|" + m.key + "|" + m.partner.playerId] } : null,
    }))
    .filter((m) => m.opponents.some((o) => !o.rated) || (m.partner && !m.partner.rated));
}
// How many people still to rate across these matches (opponents and partners).
function peopleWaiting(matches) {
  return matches.reduce((n, m) => n + m.opponents.filter((o) => !o.rated).length + (m.partner && !m.partner.rated ? 1 : 0), 0);
}
router.get("/players/rating-queue", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const items = store.getPlayerRatings().items;
  // edit=1: the ratings this account has already given (with the scores it
  // gave), for fixing a mistake. Overwriting is just rating again.
  if (req.query.edit === "1") {
    const matches = ratableMatchesFor(user)
      .map((m) => {
        const given = (pid) => items[user.id + "|" + m.key + "|" + pid];
        const opponents = m.opponents.map((o) => { const r = given(o.playerId); return r ? { ...o, rated: true, scores: r.scores } : null; }).filter(Boolean);
        const pr = m.partner && given(m.partner.playerId);
        return { ...m, opponents, partner: pr ? { ...m.partner, role: "partner", rated: true, scores: pr.scores } : null };
      })
      .filter((m) => m.opponents.length || m.partner);
    return res.json({ intro: false, matches });
  }
  const state = user.ratingState || {};
  const all = req.query.all === "1";
  const matches = pendingRatingMatches(user, all);
  const card = attributeCardFor(user);
  res.json({
    intro: !state.introSeen, matches,
    // Matches with at least one rating already given, so My Profile can offer
    // "change a rating" on them.
    editable: all ? ratableMatchesFor(user).filter((m) => m.opponents.some((o) => items[user.id + "|" + m.key + "|" + o.playerId]) || (m.partner && items[user.id + "|" + m.key + "|" + m.partner.playerId])).map((m) => m.key) : undefined,
    waiting: peopleWaiting(matches),
    progress: { count: card.count, needed: card.needed, unlocked: card.unlocked },
  });
});
router.post("/players/ratings", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const { matchKey, playerId, scores } = req.body || {};
  const match = ratableMatchesFor(user).find((m) => m.key === matchKey);
  if (!match) return res.status(404).json({ error: "That match can't be rated." });
  const opp = match.opponents.find((o) => o.playerId === playerId) || (match.partner && match.partner.playerId === playerId ? match.partner : null);
  if (!opp) return res.status(400).json({ error: "You can only rate players you played with or against in that match." });
  const role = match.partner && match.partner.playerId === playerId ? "partner" : "opponent";
  const clean = {};
  RATING_ATTRS.forEach(([k]) => {
    const v = scores && Number(scores[k]);
    if (Number.isInteger(v) && v >= 1 && v <= 5) clean[k] = v;
  });
  if (!Object.keys(clean).length) return res.status(400).json({ error: "Rate at least one attribute." });
  const ratings = store.getPlayerRatings();
  ratings.items[user.id + "|" + match.key + "|" + opp.playerId] = {
    raterId: user.id, matchKey: match.key, leagueId: match.leagueId, targetPlayerId: opp.playerId, scores: clean, role, at: Date.now(),
  };
  store.savePlayerRatings(ratings);
  res.json({ ok: true });
});
// Called when the splash is rated through, skipped past, or closed: marks
// those matches finished so they never come back, and remembers the
// first-time "start rating" intro has been seen.
router.post("/players/ratings/done", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const keys = Array.isArray(req.body && req.body.matchKeys) ? req.body.matchKeys : [];
  const valid = new Set(ratableMatchesFor(user).map((m) => m.key));
  const state = user.ratingState || { done: {}, introSeen: false };
  state.done = state.done || {};
  state.skips = state.skips || {};
  // mode "dismissed" = closed or skipped without finishing: it comes back
  // next visit, up to RATING_MAX_DISMISSALS times. Anything else (every
  // opponent rated, or the legacy call) is final.
  const dismissed = req.body && req.body.mode === "dismissed";
  keys.forEach((k) => {
    if (!valid.has(k)) return;
    if (dismissed) state.skips[k] = (state.skips[k] || 0) + 1;
    else state.done[k] = Date.now();
  });
  state.introSeen = true;
  user.ratingState = state;
  store.saveUser(user.id, user);
  res.json({ ok: true });
});

/* ---------- Rating reminders ----------
   After a fixture is finalized, every signed-in player who played in it hears
   (email and/or push) that they have opponents to rate. Push and email are
   each best-effort and independent: a missing mail service or an account
   with no subscribed device just means that channel is skipped. */
const RATING_REMIND_GAP_MS = 3 * 60 * 60 * 1000; // at most one automatic reminder per account in this window
const RATING_NUDGE_GAP_MS = 12 * 60 * 60 * 1000; // a captain can nudge a team once per this window
function ratingReminderText(user, matches) {
  const n = peopleWaiting(matches);
  const card = attributeCardFor(user);
  const left = Math.max(0, card.needed - card.count);
  const league = matches[0] ? matches[0].leagueName : "your match";
  let msg = `Rate ${n === 1 ? "the player" : n + " players"} from your match in ${league}. It takes about 30 seconds and it's anonymous.`;
  if (!card.unlocked) msg += ` Ratings go both ways: ${left} more from opponents unlocks your own player card.`;
  return { n, message: msg };
}
// Sends one reminder to one account. Returns which channels it went down.
async function sendRatingReminder(user, matches, { force } = {}) {
  const now = Date.now();
  if (!matches.length) return { email: false, push: false };
  if (!force && user.ratingRemindedAt && now - user.ratingRemindedAt < RATING_REMIND_GAP_MS) return { email: false, push: false, skipped: "recent" };
  const { n, message } = ratingReminderText(user, matches);
  if (!n) return { email: false, push: false };
  const sent = { email: false, push: false };
  const subs = user.pushSubscriptions || [];
  if (subs.length) {
    try {
      const { deadEndpoints, errors } = await sendPushToSubscriptions(subs, { title: "Rate your opponents", body: message, type: "rating", url: "/?rate=1" });
      if (deadEndpoints.length) { user.pushSubscriptions = subs.filter((x) => !deadEndpoints.includes(x.endpoint)); }
      sent.push = errors.length < subs.length;
    } catch (e) { console.error("Rating push failed:", e.message); }
  }
  if (user.email && user.emailNotifications !== false && mailConfigured()) {
    try {
      const mail = buildRatingEmail({ message, count: n });
      const r = await sendMail({ to: user.email, ...mail });
      sent.email = !!(r && r.sent);
    } catch (e) { console.error("Rating email failed:", e.message); }
  }
  if (sent.email || sent.push) user.ratingRemindedAt = now;
  store.saveUser(user.id, user);
  return sent;
}
// Called once a fixture is finalized (fire-and-forget): reminds each
// signed-in player who played in it.
function remindFixtureRatings(league, fixture) {
  setImmediate(async () => {
    try {
      const prefix = league.id + ":" + fixture.id + ":";
      const seen = new Set();
      for (const team of league.teams) {
        if (team.id !== fixture.teamA && team.id !== fixture.teamB) continue;
        for (const p of team.players) {
          const uid = p.claimedByUserId;
          if (!uid || seen.has(uid)) continue;
          seen.add(uid);
          const user = store.getUser(uid);
          if (!user) continue;
          const claim = (user.claims || []).find((c) => c.leagueId === league.id && c.playerId === p.id);
          if (!claim || claim.leftAt) continue;
          const mine = pendingRatingMatches(user, true).filter((m) => m.key.startsWith(prefix));
          if (!mine.length) continue;
          user.ratingReminded = user.ratingReminded || {};
          if (user.ratingReminded[fixture.id]) continue;
          user.ratingReminded[fixture.id] = Date.now();
          await sendRatingReminder(user, mine);
        }
      }
    } catch (e) { console.error("Rating reminders failed:", e.message); }
  });
}
// A captain (or admin) nudging their own team: everyone on it with an
// account and something to rate gets a reminder now, and the reply says how
// many players have no account yet, with a message ready to paste to them.
router.post("/leagues/:leagueId/teams/:teamId/rating-nudge", requireAdminOrCaptain((req) => req.params.teamId), async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const team = league && league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  const siteLink = (process.env.PUBLIC_URL || "https://teampadelsports.com").replace(/\/$/, "") + "/?rate=1";
  const shareText = `Rate your opponents from our last match on Team Padel (30 seconds, anonymous). Ratings go both ways: 3 ratings unlock your own player card. ${siteLink}`;
  const noAccount = team.players.filter((p) => !p.claimedByUserId).length;
  const last = (league.ratingNudgedAt || {})[team.id] || 0;
  if (Date.now() - last < RATING_NUDGE_GAP_MS) {
    return res.status(429).json({ error: "You already nudged this team in the last 12 hours.", shareText, noAccount });
  }
  let sentTo = 0, withAccount = 0;
  for (const p of team.players) {
    const user = p.claimedByUserId && store.getUser(p.claimedByUserId);
    if (!user) continue;
    const claim = (user.claims || []).find((c) => c.leagueId === league.id && c.playerId === p.id);
    if (!claim || claim.leftAt) continue;
    withAccount++;
    const mine = pendingRatingMatches(user, true).filter((m) => m.leagueId === league.id);
    if (!mine.length) continue;
    const r = await sendRatingReminder(user, mine, { force: true });
    if (r.email || r.push) sentTo++;
  }
  if (!league.ratingNudgedAt) league.ratingNudgedAt = {};
  league.ratingNudgedAt[team.id] = Date.now();
  store.saveLeague(league.id, league);
  res.json({ ok: true, sentTo, withAccount, noAccount, shareText });
});

// Per-account web push (the existing push is per team, for captains): lets a
// player get the rating reminder on their own phone. One entry per device.
router.post("/players/push-subscribe", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: "Invalid subscription." });
  user.pushSubscriptions = user.pushSubscriptions || [];
  if (!user.pushSubscriptions.some((x) => x.endpoint === subscription.endpoint)) user.pushSubscriptions.push(subscription);
  store.saveUser(user.id, user);
  res.json({ ok: true });
});
router.post("/players/push-unsubscribe", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const endpoint = req.body && req.body.endpoint;
  user.pushSubscriptions = (user.pushSubscriptions || []).filter((x) => x.endpoint !== endpoint);
  store.saveUser(user.id, user);
  res.json({ ok: true });
});
router.get("/players/push-status", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  res.json({ endpoints: (user.pushSubscriptions || []).map((x) => x.endpoint), pushAvailable: !!getVapidPublicKey(), key: getVapidPublicKey(), emailAvailable: mailConfigured() && user.emailNotifications !== false });
});

// This account's own card: every rating given to any player record it has
// claimed, averaged per attribute. Hidden entirely (just a progress count)
// until it has RATINGS_TO_UNLOCK ratings, and once there are 5+ values for
// an attribute, a lone score 3 or more away from the median is ignored so
// one spiteful rating can't drag it.
function attributeCardFor(user) {
  return attributeCardForKeys(new Set((user.claims || []).map((c) => c.leagueId + ":" + c.playerId)));
}
// A partner's rating counts for half an opponent's. A card needs RATINGS_TO_UNLOCK
// ratings from OPPONENTS to open, so friends playing together can't unlock one
// on their own; once it's open, partner ratings fill in the numbers too.
const PARTNER_RATING_WEIGHT = 0.5;
const ATTR_FULL_AT = 3; // ratings of one attribute before it counts toward Overall and the player type
function attributeCardForKeys(mine) {
  const mineRatings = Object.values(store.getPlayerRatings().items).filter((r) => mine.has(r.leagueId + ":" + r.targetPlayerId));
  const count = mineRatings.filter((r) => r.role !== "partner").length; // opponent ratings (older ones have no role)
  const partnerCount = mineRatings.length - count;
  if (count < RATINGS_TO_UNLOCK) return { count, needed: RATINGS_TO_UNLOCK, unlocked: false };
  const attributes = RATING_ATTRS.map(([key, label]) => {
    let rows = mineRatings.filter((r) => r.scores[key]).map((r) => ({ v: r.scores[key], w: r.role === "partner" ? PARTNER_RATING_WEIGHT : 1 }));
    if (rows.length >= 5) {
      const sorted = rows.map((x) => x.v).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      rows = rows.filter((x) => Math.abs(x.v - median) < 3);
    }
    if (!rows.length) return { key, label, avg: null, n: 0 };
    const totalW = rows.reduce((t, x) => t + x.w, 0);
    const avg = Math.round((rows.reduce((t, x) => t + x.v * x.w, 0) / totalW) * 10) / 10;
    // Shown from the first rating, but flagged until enough people have rated it.
    return { key, label, avg, n: rows.length, provisional: rows.length < ATTR_FULL_AT };
  });
  const shown = attributes.filter((a) => a.avg !== null && !a.provisional);
  const overall = shown.length ? Math.min(99, Math.round((shown.reduce((s2, a) => s2 + a.avg, 0) / shown.length) * 20)) : null;
  return { count, partnerCount, needed: RATINGS_TO_UNLOCK, unlocked: true, attributes, overall };
}
// Trophy Room "new badge" splash. The badges themselves are worked out on the
// client (see trophyTiles), each with a stable key; the server only remembers
// which keys this account has already been shown. The first check for an
// account just records everything it already has, so nobody gets a splash
// for every old badge the day this ships.
function cleanBadgeKeys(keys) {
  return (Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string" && k.length > 0 && k.length <= 160).slice(0, 300);
}
router.post("/players/badges/check", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const keys = cleanBadgeKeys(req.body && req.body.keys);
  if (!user.badgesSeen) {
    user.badgesSeen = { keys: Array.from(new Set(keys)), startedAt: Date.now() };
    store.saveUser(user.id, user);
    return res.json({ newKeys: [] });
  }
  const seen = new Set(user.badgesSeen.keys);
  res.json({ newKeys: keys.filter((k) => !seen.has(k)) });
});
router.post("/players/badges/seen", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const keys = cleanBadgeKeys(req.body && req.body.keys);
  if (!user.badgesSeen) user.badgesSeen = { keys: [], startedAt: Date.now() };
  const all = new Set(user.badgesSeen.keys);
  keys.forEach((k) => all.add(k));
  user.badgesSeen.keys = Array.from(all).slice(-500);
  store.saveUser(user.id, user);
  res.json({ ok: true });
});
// Owner-only, read-only — powers the Admin tab's Leagues view: every league
// with its health on one line (line-ups due, results waiting, courts live).
function leagueHealth(league) {
  const now = Date.now();
  let lineupsDue = 0, lineupsOverdue = 0, resultsWaiting = 0, liveCourts = 0, unfinalized = 0;
  let current = null;
  logic.allFixturesOf(league).forEach((f) => {
    if (!f || f.finalized || !f.teamA || !f.teamB) return;
    unfinalized++;
    if (!current) current = f;
    const sched = (league.schedule && league.schedule[logic.stageKeyFor(f)]) || {};
    const kickoffMs = kickoffMsOf(sched.date, sched.time);
    f.rubbers.forEach((r) => { if (r.startedAt && !r.completedAt) liveCourts++; });
    const started = f.rubbers.some((r) => r.startedAt) || logic.fixtureScore(f).decided > 0 || (kickoffMs && kickoffMs < now);
    if (started) resultsWaiting++;
    if (league.format !== "pairs" && isRoundOpen(league, f)) {
      [f.selectionA, f.selectionB].forEach((sel) => {
        if (sel && !sel.submitted) {
          lineupsDue++;
          if (kickoffMs && kickoffMs - 24 * 3600000 < now) lineupsOverdue++;
        }
      });
    }
  });
  const status = leagueStatus(league);
  let stage = "Setting up";
  if (current) stage = fixtureLabel(league, current);
  else if (logic.allFixturesOf(league).length) stage = "Season complete";
  return { status, stage, lineupsDue, lineupsOverdue, resultsWaiting, liveCourts, unfinalized };
}
router.get("/admin/leagues-health", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const out = [];
  store.getIndex().filter((e) => !e.hidden).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    out.push({ id: league.id, name: league.name, format: league.format || "teams", incognito: !!entry.incognito, teamCount: league.teams.length, ...leagueHealth(league) });
  });
  // The ones with something wrong first, then live, then the rest.
  const score = (l) => (l.lineupsOverdue ? 4 : 0) + (l.resultsWaiting ? 2 : 0) + (l.liveCourts ? 1 : 0);
  out.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  res.json(out);
});
// Owner-only, read-only — the Today view: a few numbers that don't have a
// card of their own, plus a short "just happened" feed built from what's
// already stored (new accounts, confirmed results, interest signups, ratings,
// and the admin action log).
router.get("/admin/today", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const now = Date.now();
  const DAY = 86400000;
  const dayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
  const today = dayOf(now);
  const users = store.getUsersIndex().map(({ id }) => store.getUser(id)).filter((u) => u && u.createdAt && !u.test);
  const newAccounts7d = users.filter((u) => now - u.createdAt < 7 * DAY).length;
  const newAccountsPrev7d = users.filter((u) => now - u.createdAt >= 7 * DAY && now - u.createdAt < 14 * DAY).length;
  const ratings = Object.values(store.getPlayerRatings().items);
  const ratingsToday = ratings.filter((r) => dayOf(r.at || 0) === today).length;
  let matchesLive = 0, lineupsOverdue = 0, resultsWaiting = 0;
  const feed = [];
  store.getIndex().filter((e) => !e.hidden).forEach((entry) => {
    const league = store.getLeague(entry.id);
    if (!league) return;
    const h = leagueHealth(league);
    matchesLive += h.liveCourts;
    lineupsOverdue += h.lineupsOverdue;
    resultsWaiting += h.resultsWaiting;
    logic.allFixturesOf(league).forEach((f) => {
      if (f && f.finalized && f.finalizedAt && now - f.finalizedAt < 3 * DAY) {
        feed.push({ at: f.finalizedAt, kind: "result", text: `${league.name}: ${fixtureLabel(league, f)} result confirmed` });
      }
    });
  });
  users.filter((u) => now - u.createdAt < 3 * DAY).forEach((u) => feed.push({ at: u.createdAt, kind: "account", text: `${u.name || "Someone"} joined` }));
  (store.getSignups() || []).filter((sg) => sg.createdAt && now - sg.createdAt < 3 * DAY).forEach((sg) => feed.push({ at: sg.createdAt, kind: "signup", text: `League interest: ${sg.name || "a new sign-up"}` }));
  if (ratingsToday) feed.push({ at: Math.max(...ratings.filter((r) => dayOf(r.at || 0) === today).map((r) => r.at || 0)), kind: "rating", text: `${ratingsToday} opponent rating${ratingsToday === 1 ? "" : "s"} given today` });
  ((store.getSiteSettings().adminActions) || []).filter((a) => now - a.at < 3 * DAY).forEach((a) => feed.push({ at: a.at, kind: "admin", text: a.text }));
  feed.sort((a, b) => b.at - a.at);
  res.json({ newAccounts7d, newAccountsPrev7d, ratingsToday, matchesLive, lineupsOverdue, resultsWaiting, feed: feed.slice(0, 8) });
});
router.get("/admin/actions", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  res.json(((store.getSiteSettings().adminActions) || []).slice(0, 12));
});
// Owner-only, read-only — powers the "Opponent ratings" card on the Admin tab.
// Totals and averages only: who gave a rating is never returned, so the
// feature stays anonymous to the owner too. A player's own average is only
// shown once they have enough ratings to have an unlocked card, the same
// bar the player sees, so a single rating can't be read back to one person.
router.get("/admin/ratings-overview", (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ error: "Site owner login required." });
  const items = Object.values(store.getPlayerRatings().items);
  const claimsIndex = buildClaimsIndex();
  const identityOf = (l, p) => claimsIndex.get(l + ":" + p) || l + ":" + p;
  const dayOf = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
  const now = Date.now();
  const byPlayer = new Map();
  const attr = {};
  RATING_ATTRS.forEach(([k]) => { attr[k] = { sum: 0, n: 0 }; });
  const perDay = {};
  items.forEach((r) => {
    const id = identityOf(r.leagueId, r.targetPlayerId);
    let e = byPlayer.get(id);
    if (!e) {
      const league = store.getLeague(r.leagueId);
      let name = "Unknown player", team = "";
      if (league) league.teams.forEach((t) => t.players.forEach((p) => { if (p.id === r.targetPlayerId) { name = p.name; team = t.name; } }));
      e = { name, team, league: league ? league.name : "", count: 0, sum: 0, n: 0, last: 0 };
      byPlayer.set(id, e);
    }
    if (r.role !== "partner") e.count++;
    e.last = Math.max(e.last, r.at || 0);
    Object.values(r.scores).forEach((v) => { e.sum += v; e.n++; });
    RATING_ATTRS.forEach(([k]) => { if (r.scores[k]) { attr[k].sum += r.scores[k]; attr[k].n++; } });
    const d = dayOf(r.at || 0);
    perDay[d] = (perDay[d] || 0) + 1;
  });
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = dayOf(now - i * 86400000); days.push({ date: d, count: perDay[d] || 0 }); }
  // How far the splash has actually reached: accounts that currently have
  // at least one match to rate, how many of those have dealt with it
  // (rated, skipped or closed it), and how many still have one waiting.
  let eligible = 0, seen = 0, pending = 0;
  store.getUsersIndex().forEach(({ id }) => {
    const u = store.getUser(id);
    if (!u || !(u.claims || []).length) return;
    const ms = ratableMatchesFor(u);
    if (!ms.length) return;
    eligible++;
    const st = u.ratingState || {};
    if (st.introSeen) seen++;
    if (ms.some((m) => !(st.done && st.done[m.key]))) pending++;
  });
  const players = Array.from(byPlayer.values())
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, 25)
    .map((e) => ({ name: e.name, team: e.team, league: e.league, count: e.count, unlocked: e.count >= RATINGS_TO_UNLOCK, avg: e.count >= RATINGS_TO_UNLOCK && e.n ? Math.round((e.sum / e.n) * 10) / 10 : null }));
  res.json({
    config: { queueSize: RATING_QUEUE_SIZE, windowDays: Math.round(RATING_WINDOW_MS / 86400000), unlockAt: RATINGS_TO_UNLOCK },
    totals: {
      ratings: items.length,
      raters: new Set(items.map((r) => r.raterId)).size,
      playersRated: byPlayer.size,
      unlocked: Array.from(byPlayer.values()).filter((e) => e.count >= RATINGS_TO_UNLOCK).length,
      last24h: items.filter((r) => now - (r.at || 0) < 86400000).length,
      last7d: items.filter((r) => now - (r.at || 0) < 7 * 86400000).length,
    },
    reach: { eligible, seen, pending },
    days,
    attributes: RATING_ATTRS.map(([key, label]) => ({ key, label, n: attr[key].n, avg: attr[key].n ? Math.round((attr[key].sum / attr[key].n) * 10) / 10 : null })),
    players,
  });
});
router.get("/players/attributes", requirePlayerUser, (req, res) => {
  res.json(attributeCardFor(store.getUser(req.session.playerUser.id)));
});
// Anyone can see a player's attributes — same open access as their match
// history. The card belongs to the person: if the record is claimed, ratings
// given to every record that account has claimed are combined. Only the
// averages are returned, never who rated whom.
router.get("/leagues/:leagueId/players/:playerId/attributes", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const player = league.teams.flatMap((t) => t.players).find((p) => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: "Player not found." });
  const keys = new Set([league.id + ":" + player.id]);
  const owner = player.claimedByUserId ? store.getUser(player.claimedByUserId) : null;
  if (owner) (owner.claims || []).forEach((c) => keys.add(c.leagueId + ":" + c.playerId));
  res.json(attributeCardForKeys(keys));
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
    const chargeId = fields.custom_str4 || null;
    const league = store.getLeague(leagueId);
    if (!league) return console.error("PayFast ITN: unknown league", leagueId);
    if (chargeId) {
      const charge = (league.customCharges || []).find((c) => c.id === chargeId);
      if (!charge) return console.error("PayFast ITN: unknown custom charge", chargeId);
      const paidRands = Number(fields.amount_gross);
      const expectedRands = charge.amountCents / 100;
      if (Math.abs(paidRands - expectedRands) > 0.01) {
        return console.error(`PayFast ITN: amount mismatch for custom charge ${chargeId} — expected ${expectedRands}, got ${paidRands}`);
      }
      charge.paid = true;
      charge.paymentMethod = "payfast";
      charge.paymentRef = fields.pf_payment_id || null;
      charge.paidAt = Date.now();
      store.saveLeague(league.id, league);
      return;
    }
    const team = league.teams.find((t) => t.id === teamId);
    if (!team) return console.error("PayFast ITN: unknown team", leagueId, teamId);
    const paidRands = Number(fields.amount_gross);
    if (playerId) {
      const player = team.players.find((p) => p.id === playerId);
      if (!player) return console.error("PayFast ITN: unknown player", playerId);
      // PayFast retries an ITN until it gets a 200, so the same payment can
      // arrive twice — never count one payment reference twice.
      if (fields.pf_payment_id && (player.payments || []).some((x) => x.ref === fields.pf_payment_id)) return;
      if (fields.pf_payment_id && player.paymentRef === fields.pf_payment_id && player.paymentStatus === "paid") return;
      const paidCents = Math.round(paidRands * 100);
      const owed = playerOwedCents(league, team, player);
      // Nothing left to pay (their share was covered, or paid another way)
      // before this payment landed: flag the extra money so it can be refunded.
      if (owed <= 0 || paidCents <= 0) {
        player.overpaidCents = (player.overpaidCents || 0) + Math.max(0, paidCents);
        console.error(`PayFast ITN: player ${playerId} was already paid — ${paidRands} to refund`);
        store.saveLeague(league.id, league);
        return;
      }
      // A part payment is fine; anything beyond what's owed is flagged.
      const credited = Math.min(paidCents, owed);
      if (paidCents > owed + 1) player.overpaidCents = (player.overpaidCents || 0) + (paidCents - owed);
      addPlayerPayment(league, team, player, credited, "payfast", fields.pf_payment_id, Date.now());
    } else {
      const seenRefs = team.lumpRefs || [];
      if (fields.pf_payment_id && (team.paymentRef === fields.pf_payment_id || seenRefs.includes(fields.pf_payment_id))) return;
      // The team pays what's still owed (the fee less whatever players have
      // paid). If that's covered, the team is settled and any unpaid players are
      // covered by it; an amount short of that is credited and the rest stays due.
      const owed = teamBalanceCents(league, team);
      const paidCents = Math.round(paidRands * 100);
      team.lumpRefs = seenRefs.concat(fields.pf_payment_id || []);
      if (paidCents >= owed - 1) {
        if (paidCents > owed + 1) team.overpaidCents = (team.overpaidCents || 0) + (paidCents - owed);
        team.paymentStatus = "paid";
        team.paymentMethod = "payfast";
        team.paymentRef = fields.pf_payment_id || null;
        team.paidAt = Date.now();
        coverTeamPlayers(team, "payfast", fields.pf_payment_id, team.paidAt);
      } else {
        team.lumpCents = (team.lumpCents || 0) + paidCents;
        console.error(`PayFast ITN: team ${teamId} paid ${paidCents}c of ${owed}c owed — credited, balance remains`);
      }
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
  const roundParam = req.params.round;
  const isPlayoffKey = ["semis", "final", "positions"].includes(roundParam);
  const round = isPlayoffKey ? roundParam : Number(roundParam);
  if (!isPlayoffKey && !Number.isInteger(round)) return res.status(400).json({ error: "Invalid round." });

  // Admins can rearrange any block; a captain can tap-swap blocks too, but
  // only ones that are already theirs — enforced below, not just hidden
  // client-side, since this is the same endpoint either role calls.
  const isAdmin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
  const isCaptain = !isAdmin && !!u && u.leagueId === league.id && u.role === "captain";
  if (!isAdmin && !isCaptain) return res.status(403).json({ error: "Not allowed." });

  const { slot, court, fixtureId, seed, expectedTargetFixtureId, expectedTargetSeed } = req.body || {};
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) return res.status(400).json({ error: "Invalid slot." });
  if (!Number.isInteger(court) || court < 0 || court >= courts) return res.status(400).json({ error: "Invalid court." });

  const grid = getCourtGrid(league, round);
  const roundFixtures = fixturesForRoundKey(league, round);

  // Live Court Control's own rule: once a rubber has been started courtside,
  // it can't be dragged to a different slot/court — only still-upcoming
  // matches are movable. Applies to both the match being placed and
  // whatever it would displace, and to both roles equally.
  const rubberIsStarted = (fxId, sd) => {
    if (!fxId) return false;
    const f = roundFixtures.find((x) => x.id === fxId);
    return !!(f && f.rubbers[sd] && f.rubbers[sd].startedAt);
  };
  const targetCell = grid[slot] && grid[slot][court];
  if (targetCell && rubberIsStarted(targetCell.fixtureId, targetCell.seed)) {
    return res.status(400).json({ error: "That court's match is already in play — it can't be moved." });
  }
  if (fixtureId && rubberIsStarted(fixtureId, seed)) {
    return res.status(400).json({ error: "That match is already in play — it can't be moved." });
  }
  // Courtside, more than one captain/admin can easily be rearranging the
  // board at the same moment. Every caller already knows what it expects
  // to find in the target cell (empty, or a specific match it's swapping
  // with) from the grid it just rendered — if that's changed by the time
  // this write lands, someone else got there first, so this rejects
  // instead of silently overwriting whatever they just placed there.
  // Optional (omitted) so nothing outside this app's own client breaks.
  if (expectedTargetFixtureId !== undefined) {
    const actualFixtureId = targetCell ? targetCell.fixtureId : null;
    const actualSeed = targetCell ? targetCell.seed : null;
    const expectedFixtureId = expectedTargetFixtureId || null;
    const mismatch = expectedFixtureId
      ? (actualFixtureId !== expectedFixtureId || actualSeed !== expectedTargetSeed)
      : !!actualFixtureId;
    if (mismatch) return res.status(409).json({ error: "That court's schedule just changed — refresh and try again." });
  }

  if (isCaptain) {
    const ownsFixture = (fxId) => {
      if (!fxId) return true;
      const f = roundFixtures.find((x) => x.id === fxId);
      return !!f && (f.teamA === u.teamId || f.teamB === u.teamId);
    };
    const existing = grid[slot] && grid[slot][court];
    if (!ownsFixture(fixtureId) || (existing && !ownsFixture(existing.fixtureId))) {
      return res.status(403).json({ error: "You can only rearrange your own team's matches." });
    }
  }

  // Ormonde rules reserves the LAST court exclusively for the Super Tie
  // seed (index 4) — same reservation generateSeasonCourtRotation applies
  // when auto-filling, enforced here too so a manual drag/tap-swap can't
  // put a pairs seed there or a Super Tie anywhere else.
  const singlesOn = !!league.singlesDecider && league.format !== "pairs" && courts > 1;
  const superTieCourt = singlesOn ? courts - 1 : null;
  if (fixtureId) {
    const f = roundFixtures.find((x) => x.id === fixtureId);
    if (!f) return res.status(400).json({ error: "That match isn't in this round." });
    const maxSeed = f.selectionA.pairs.length === 5 ? 4 : 3;
    if (!Number.isInteger(seed) || seed < 0 || seed > maxSeed) return res.status(400).json({ error: "Invalid seed." });
    if (seed === 4 && court !== superTieCourt) return res.status(400).json({ error: "Singles matches can only go on the reserved singles court." });
    if (seed !== 4 && superTieCourt !== null && court === superTieCourt) return res.status(400).json({ error: "That court is reserved for singles matches." });
    // A player named in two of this fixture's seeds (a captain-confirmed
    // "double-up" at selection time) physically can't play both if this
    // placement would put them in the same time slot on two different
    // courts — reject before creating that conflict, whether it comes
    // from a drag, a tap-swap, or the empty-cell picker. The reserved
    // singles court is exempt on both sides of that check: its slot number
    // is just where it happens to sit in the grid, not a real simultaneous
    // time, so a player down for both a doubles seed and the Super Tie
    // never gets treated as double-booked, and neither placement should be
    // blocked because of the other.
    const conflict = seed !== 4 && (grid[slot] || []).some((cell, c) => c !== court && c !== superTieCourt && cell && cell.fixtureId === fixtureId && cell.seed !== seed && seedsSharePlayer(f, cell.seed, seed));
    if (conflict) return res.status(400).json({ error: "That would put the same player on two courts at once in this time slot." });
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

// "Generate optimum layout" — step 1: compute and hand back a proposed
// court schedule for every unfinished round, without saving anything. The
// admin reviews this in a preview modal before deciding whether to commit
// it (below) or cancel and leave the current schedule untouched.
router.post("/leagues/:leagueId/court-schedule/optimum-preview", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ rounds: computeOptimumCourtSchedule(league, ratingsData, identityOf) });
});

// Live Court Control's "Re-balance remaining matches" — step 1 for ONE round:
// proposes a court re-shuffle of only what hasn't started (see
// rebalanceRoundGrid), saving nothing. The admin reviews it, then it goes
// through optimum-apply below like any other layout.
router.post("/leagues/:leagueId/court-schedule/:round/rebalance-preview", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const roundParam = req.params.round;
  const isPlayoffKey = ["semis", "final", "positions"].includes(roundParam);
  const round = isPlayoffKey ? roundParam : Number(roundParam);
  if (!isPlayoffKey && !Number.isInteger(round)) return res.status(400).json({ error: "Invalid round." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ round, ...rebalanceRoundGrid(league, round, ratingsData, identityOf) });
});

// Read-only: how balanced the CURRENT court schedule already is, same
// per-court predicted-load numbers as the optimum preview but computed
// from what's actually saved rather than a hypothetical new layout —
// see computeCurrentCourtLoad.
router.get("/leagues/:leagueId/court-schedule/current-balance", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  res.json({ rounds: computeCurrentCourtLoad(league, ratingsData, identityOf) });
});

// "Generate optimum layout" — step 2: commits exactly the payload the
// preview above returned (nothing is recomputed here, so what the admin
// saw is exactly what gets saved). Any round that's since been finalized,
// or a cell that no longer matches a real fixture in that round, is
// silently dropped rather than trusted — a preview can go stale if a
// score got entered while the modal was open.
router.post("/leagues/:leagueId/court-schedule/optimum-apply", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const rounds = req.body.rounds;
  if (!rounds || typeof rounds !== "object") return res.status(400).json({ error: "Missing layout." });
  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  if (!league.courtSchedule) league.courtSchedule = {};
  const skipped = [];
  Object.keys(rounds).forEach((roundKey) => {
    // Every object key arrives as a string over JSON regardless of what it
    // was server-side — a regular round goes back to its real number, a
    // playoff stage ("semis"/"final"/"positions") stays as-is.
    const isPlayoffKey = ["semis", "final", "positions"].includes(roundKey);
    const round = isPlayoffKey ? roundKey : Number(roundKey);
    if (!isPlayoffKey && !Number.isFinite(round)) return;
    const roundFixtures = fixturesForRoundKey(league, round);
    if (roundFixtures.length === 0 || roundFixtures.every((f) => f.finalized)) return;
    const fixturesById = {};
    roundFixtures.forEach((f) => { fixturesById[f.id] = f; });
    const incoming = rounds[roundKey] && rounds[roundKey].grid;
    if (!Array.isArray(incoming)) return;
    const grid = emptyCourtGrid(slots, courts);
    for (let s = 0; s < slots && s < incoming.length; s++) {
      const row = incoming[s] || [];
      for (let c = 0; c < courts && c < row.length; c++) {
        const cell = row[c];
        if (!cell || !fixturesById[cell.fixtureId]) continue;
        grid[s][c] = { fixtureId: cell.fixtureId, seed: Number(cell.seed) };
      }
    }
    // A preview can go stale while its modal is open — a match may have
    // started since. Anything already under way must still sit exactly
    // where it is; if the incoming layout moved or dropped one, skip this
    // round entirely (and say so) rather than move a live match.
    const currentGrid = getCourtGrid(league, round);
    const movedStarted = currentGrid.some((row, sl) => row.some((cell, c) => {
      if (!cell) return false;
      const f = fixturesById[cell.fixtureId];
      if (!f || !f.rubbers[cell.seed] || !f.rubbers[cell.seed].startedAt) return false;
      const now = grid[sl] && grid[sl][c];
      return !now || now.fixtureId !== cell.fixtureId || now.seed !== cell.seed;
    }));
    if (movedStarted) { skipped.push(roundKey); return; }
    league.courtSchedule[round] = grid;
  });
  store.saveLeague(league.id, league);
  res.json({ ok: true, skipped });
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
  const extraSeedCount = league.format === "pairs" ? 1 : (league.singlesDecider ? 5 : 4);
  const newFixtures = matches.map((m) =>
    Object.assign({ id: logic.uid(), round: nextRound, stage: "regular", teamA: m.teamA, teamB: m.teamB }, logic.emptyFixtureExtras(extraSeedCount))
  );
  league.fixtures.push(...newFixtures);
  if (!league.roundMeta) league.roundMeta = {};
  league.roundMeta[nextRound] = { label: name.trim(), type };
  store.saveLeague(league.id, league);
  res.json({ ok: true, round: nextRound });
});
// Undoes the route above — for when one too many extra rounds got added.
// Only ever a round that shows up in roundMeta (an admin-added one, or an
// original round-robin round the admin explicitly labeled via the
// table-count toggle) and only while nothing in it has been played yet —
// a round with even one finalized result is left alone, so a stray extra
// round can't silently take a real score down with it.
router.delete("/leagues/:leagueId/rounds/:round", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const round = Number(req.params.round);
  if (!Number.isInteger(round) || round < 1) return res.status(400).json({ error: "Invalid round." });
  const roundFixtures = league.fixtures.filter((f) => f.round === round && f.stage === "regular");
  if (roundFixtures.length === 0) return res.status(404).json({ error: "That round doesn't exist." });
  if (!league.roundMeta || !league.roundMeta[round]) return res.status(400).json({ error: "Only a round added here can be deleted this way." });
  if (roundFixtures.some((f) => f.finalized)) return res.status(400).json({ error: "This round has finalized results — unlock and clear those first if you really want to delete it." });
  league.fixtures = league.fixtures.filter((f) => !(f.round === round && f.stage === "regular"));
  delete league.roundMeta[round];
  // Round-keyed data left behind would otherwise resurface if a future
  // round happens to land on this same number again.
  if (league.courtSchedule) delete league.courtSchedule[round];
  if (league.potwVotes) delete league.potwVotes[round];
  if (league.potwNotified) delete league.potwNotified[round];
  if (league.schedule) delete league.schedule["r" + round];
  store.saveLeague(league.id, league);
  res.json({ ok: true });
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

  const u = resolveLeagueSession(req, league.id);
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
  const singlesIdx = league.singlesDecider && league.format !== "pairs" && expectedSeeds === 5 ? 4 : null;
  const teamA = league.teams.find((t) => t.id === f.teamA);
  const teamB = league.teams.find((t) => t.id === f.teamB);
  const myTeam = side === "A" ? teamA : teamB;
  // A seed's gold/silver tier is normally fixed by position (Seed 1..N are
  // gold), but if this fixture's pair-toss ceremony already tossed a tier
  // for that seed, that decision is the real one and wins — the ceremony
  // can hand "gold" to any of the 4 pairings, not just the first.
  const goldMatchCount = Math.max(0, Math.min(4, league.goldMatchCount || 0));
  const isGoldSeedAt = (i) => {
    const tossed = f.pairToss && f.pairToss[i] && f.pairToss[i].tier;
    return tossed ? tossed === "gold" : i < goldMatchCount;
  };
  // The first silver seed (Seed 3 with two gold matches) may also take a set
  // number of gold players — Balwin rules allow one.
  let firstSilverSeed = -1;
  for (let i = 0; i < 4; i++) { if (!isGoldSeedAt(i)) { firstSilverSeed = i; break; } }
  const goldRule = league.tieringEnabled && league.format !== "pairs" && myTeam
    ? {
        goldIds: new Set(myTeam.players.filter((p) => p.gold).map((p) => p.id)),
        isGoldSeed: isGoldSeedAt,
        silverAllowance: { seedIdx: firstSilverSeed, max: goldInSilverMax(league) },
      }
    : null;
  const result = logic.validateSelection(pairs, !!req.body.confirmDoubleUp, singlesIdx, goldRule);
  if (result) return res.status(400).json({ error: result.error, needsConfirm: !!result.needsConfirm });

  const isFirstSubmit = !f[selKey].submitted;
  f[selKey] = { submitted: true, pairs };
  const label = fixtureLabel(league, f);
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
  const u = resolveLeagueSession(req, league.id);
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
  const u = resolveLeagueSession(req, league.id);
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
  const u = resolveLeagueSession(req, league.id);
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

  const u = resolveLeagueSession(req, league.id);
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

  const u = resolveLeagueSession(req, league.id);
  const isAdmin = isAdminSession(req, league.id);
  const isPlayer = u && u.leagueId === league.id && u.role === "captain" && (u.teamId === f.teamA || u.teamId === f.teamB);
  // A signed-in player who actually played this match can enter its score too
  // (not the captain's say-so): they're in this seed's pairs, either side.
  // What they enter counts, until the captain or admin enters or changes it.
  let rubberPlayer = null;
  if (!isAdmin && !isPlayer && req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    const inPair = (sel, pid) => !!(sel && sel.pairs && (sel.pairs[idx] || []).includes(pid));
    const claim = account && (account.claims || []).find((c) => c.leagueId === league.id && !c.leftAt && (inPair(f.selectionA, c.playerId) || inPair(f.selectionB, c.playerId)));
    if (claim) {
      const t = league.teams.find((x) => x.id === claim.teamId);
      const pl = t && t.players.find((x) => x.id === claim.playerId);
      rubberPlayer = { name: pl ? pl.name : "A player", teamId: claim.teamId };
    }
  }
  if (!isAdmin && !isPlayer && !rubberPlayer) return res.status(403).json({ error: "Not allowed." });
  if (f.finalized && !isAdmin) return res.status(400).json({ error: "This fixture is finalized — ask the admin to unlock it." });
  if (!f.selectionA.submitted || !f.selectionB.submitted) return res.status(400).json({ error: "Both line-ups must be submitted first." });
  if (rubberPlayer) {
    const r = f.rubbers[idx];
    const filled = (v) => v !== null && v !== undefined && v !== "";
    const hasScore = (r.sets || []).some((st) => filled(st[0]) || filled(st[1])) || (r.tb || []).some((v) => filled(v) && Number(v) > 0);
    if (r.forfeited || (hasScore && r.scoreBy !== "player")) return res.status(403).json({ error: "This score was entered by your captain or the admin. Ask them to change it." });
    // Same shapes the score form sends, and nothing else: a few sets of two
    // numbers, plus an optional tie-break pair.
    const okNum = (v) => v === null || v === "" || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 99);
    const okPair = (pr) => Array.isArray(pr) && pr.length === 2 && okNum(pr[0]) && okNum(pr[1]);
    const body = req.body || {};
    if ((body.sets !== undefined && !(Array.isArray(body.sets) && body.sets.length <= 3 && body.sets.every(okPair))) || (body.tb !== undefined && !okPair(body.tb)))
      return res.status(400).json({ error: "That score doesn't look right." });
  }

  const before = { sets: f.rubbers[idx].sets, tb: f.rubbers[idx].tb };
  if (req.body.sets) f.rubbers[idx].sets = req.body.sets;
  if (req.body.tb) f.rubbers[idx].tb = req.body.tb;
  const after = { sets: f.rubbers[idx].sets, tb: f.rubbers[idx].tb };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    // A hand-entered score means this is a real, played result after all
    // (correcting a mistaken forfeit, most likely) — clears the walkover
    // flag so it goes back to counting for Elo like any other rubber.
    if (f.rubbers[idx].forfeited) f.rubbers[idx].forfeited = null;
    // The official result supersedes whatever the control room had jotted
    // down courtside (see the live-score route below).
    delete f.rubbers[idx].live;
    f.rubbers[idx].scoreBy = isAdmin ? "admin" : isPlayer ? "captain" : "player";
    logAudit(league, req, f, "score_edit", { seedIdx: idx, before, after, wasFinalized: f.finalized, ...(rubberPlayer ? { actor: "Player — " + rubberPlayer.name } : {}) });
    if (rubberPlayer) {
      // The captains hear about it, with the way to correct it.
      const text = logic.rubberScoreText(f.rubbers[idx]);
      const seedWord = f.rubbers.length === 1 ? "the match" : "Seed " + (idx + 1);
      if (text) {
        const msg = `${rubberPlayer.name} entered ${text} for ${seedWord} in ${fixtureLabel(league, f)}. If that's wrong, correct it from Results.`;
        [f.teamA, f.teamB].forEach((tid) => notify(league, tid, "result", msg, { round: f.round }));
      }
    }
  }
  // A score that settles the match means it's over — so it's finished on
  // Live Court Control too, whoever entered it (a captain from their
  // profile, the Results tab, or an admin). Without this a captain could
  // post the result and the court would still show the match as live or
  // waiting to start until someone remembered to tap Mark complete. A
  // half-entered score (no winner yet) leaves it alone.
  if (!f.rubbers[idx].completedAt && logic.rubberWinner(f.rubbers[idx])) completeRubberNow(league, f, idx);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// A no-show/withdrawal gets a real result on the board — a 6-0, 6-0
// walkover posts for standings exactly like any other decisive win — but
// it never happened as a match, so nobody's rating should move for it
// either direction. Admin-only (unlike the score PUT above, which a
// captain can also use pre-finalize) since either side unilaterally
// declaring the other forfeited is exactly the kind of call that needs a
// neutral adjudicator, not a self-interested party.
router.post("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/forfeit", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  const winner = req.body && req.body.winner;
  if (winner !== "A" && winner !== "B" && winner !== "double") return res.status(400).json({ error: "Say which side gets the walkover, or that both sides forfeited." });
  if (!f.selectionA.submitted || !f.selectionB.submitted) return res.status(400).json({ error: "Both line-ups must be submitted first." });
  if (f.finalized) return res.status(400).json({ error: "This fixture is already finalized — unlock it first." });

  const rubber = f.rubbers[idx];
  // A double forfeit has no real (or synthetic walkover) score at all —
  // neither side showed up, so there's nothing to award. Leave sets/tb
  // untouched; rubberWinner already reads an all-null rubber as "no
  // winner", and rubberScoreText/fixtureScore/requiredRubbersOk/
  // computeStandings all special-case rubber.forfeited === "double" to
  // still treat it as settled.
  if (winner !== "double") {
    // Ormonde rules' Super Tie seed has no sets at all — its walkover is a
    // synthetic 10-0 tie-break instead of a synthetic 6-0, 6-0.
    if (rubber.sets.length === 0) {
      rubber.tb = winner === "A" ? [10, 0] : [0, 10];
    } else {
      rubber.sets = rubber.sets.map((_, si) => (si < 2 ? (winner === "A" ? [6, 0] : [0, 6]) : [null, null]));
      rubber.tb = [null, null];
    }
  }
  rubber.forfeited = winner;
  // Matches how a real completion reads everywhere that checks these two
  // fields (Live Court Control's live/done state, the elapsed-time strip)
  // — same instant for both so it shows a clean 00:00 rather than however
  // long ago the round started.
  rubber.startedAt = Date.now();
  rubber.completedAt = rubber.startedAt;

  const teamA = league.teams.find((t) => t.id === f.teamA);
  const teamB = league.teams.find((t) => t.id === f.teamB);
  const label = fixtureLabel(league, f);
  const isSuperTieSeed = idx === 4 && f.selectionA.pairs.length === 5;
  const seedLabel = f.rubbers.length === 1 ? "The match" : isSuperTieSeed ? "The Singles" : "Seed " + (idx + 1);
  const msg = winner === "double"
    ? `${seedLabel} for ${label} was forfeited by both sides — no result, no points to either team.`
    : (() => {
      const winnerName = winner === "A" ? (teamA ? teamA.name : "?") : (teamB ? teamB.name : "?");
      const loserName = winner === "A" ? (teamB ? teamB.name : "?") : (teamA ? teamA.name : "?");
      const walkoverScore = rubber.sets.length === 0 ? "10-0" : "6-0, 6-0";
      return `${seedLabel} for ${label} was forfeited — ${winnerName} awarded a ${walkoverScore} walkover over ${loserName}.`;
    })();
  notify(league, f.teamA, "forfeit", msg, { round: f.round });
  notify(league, f.teamB, "forfeit", msg, { round: f.round });
  logAudit(league, req, f, "forfeit", { seedIdx: idx, winner });
  store.saveLeague(league.id, league);
  res.json({ ok: true, rubber });
});

// Live Court Control's own scoreboard: whatever the control room keys in
// courtside lives in rubber.live, completely apart from rubber.sets/tb —
// the official result. It never feeds Results, the table, the live table
// preview, ratings or finalizing; captains still post the official score
// themselves (the PUT above), and doing so replaces this. A score that
// settles the match still finishes it on the court board, since that's
// Court Control's own state, not a result.
router.put("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/live-score", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  if (f.finalized) return res.status(400).json({ error: "This fixture is finalized — the official result is already in." });
  if (!f.selectionA.submitted || !f.selectionB.submitted) return res.status(400).json({ error: "Both line-ups must be submitted first." });
  const rubber = f.rubbers[idx];
  const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
  const { sets, tb } = req.body || {};
  if (!Array.isArray(sets) || sets.length !== rubber.sets.length) return res.status(400).json({ error: "Invalid score." });
  const cleanSets = sets.map((s) => [num(Array.isArray(s) ? s[0] : null), num(Array.isArray(s) ? s[1] : null)]);
  const cleanTb = Array.isArray(tb) ? [num(tb[0]), num(tb[1])] : rubber.tb.slice();
  const empty = cleanSets.every((s) => s[0] === null && s[1] === null) && !cleanTb[0] && !cleanTb[1];
  if (empty) delete rubber.live;
  else {
    rubber.live = { sets: cleanSets, tb: cleanTb, updatedAt: Date.now() };
    if (!rubber.completedAt && logic.rubberWinner({ ...rubber, sets: cleanSets, tb: cleanTb })) completeRubberNow(league, f, idx);
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

// A cheap "has anything changed?" stamp for Live Court Control and the Table
// tab. They ask this every few seconds and only fetch the whole league when it
// differs, so a score keyed in on one device shows up on the others almost
// straight away without anyone downloading the league each time.
router.get("/leagues/:leagueId/live-version", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  if (guestWalledFor(req, league.id)) return res.json({ v: "walled" });
  const h = crypto.createHash("md5");
  logic.allFixturesOf(league).forEach((f) => {
    h.update(`${f.id}|${f.finalized ? 1 : 0}|${f.selectionA && f.selectionA.submitted ? 1 : 0}${f.selectionB && f.selectionB.submitted ? 1 : 0}|`);
    (f.rubbers || []).forEach((r) => h.update(JSON.stringify([r.sets, r.tb, r.startedAt || 0, r.completedAt || 0, r.pace || "", r.forfeited || "", r.live ? [r.live.sets, r.live.tb] : 0])));
  });
  h.update(JSON.stringify([league.courtSchedule || {}, league.courtNames || [], league.courtCount || 0, league.slotCount || 0]));
  res.json({ v: h.digest("hex").slice(0, 12) });
});

// Live Court Control: mark a rubber as under way courtside. Independent of
// score entry entirely — this just starts the clock the live board times
// against, so an admin can tap "Start" the moment players walk on.
router.post("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/start", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  if (!f.selectionA.submitted || !f.selectionB.submitted) return res.status(400).json({ error: "Both line-ups must be submitted first." });
  if (!f.rubbers[idx].startedAt) {
    f.rubbers[idx].startedAt = Date.now();
    store.saveLeague(league.id, league);
  }
  res.json({ ok: true, startedAt: f.rubbers[idx].startedAt });
});

// Live Court Control: an admin's manual call on how long a match will run —
// "quick" (green) or "long" (red) — overriding the app's own guess from the
// win-probability gap. null hands it back to the app. Only meaningful before
// the match starts (once it's live the real clock takes over).
router.post("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/pace", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  const { pace } = req.body || {};
  if (pace !== null && pace !== "quick" && pace !== "long") return res.status(400).json({ error: "Pace must be quick, long or null." });
  const rubber = f.rubbers[idx];
  if (rubber.startedAt) return res.status(400).json({ error: "This match has already started." });
  if (pace) rubber.pace = pace; else delete rubber.pace;
  store.saveLeague(league.id, league);
  res.json({ ok: true, pace: rubber.pace || null });
});

// Marks one rubber finished — the single place that does it, whether an
// admin taps "Mark complete" on Live Court Control or a score comes in that
// settles the match (see the score PUT above). A match that really was
// started courtside has its actual elapsed time folded into
// league.courtDurationStats and the raw courtMatchLog, exactly as before. A
// match that was scored without ever being started (a captain entering the
// result afterwards) is just marked done at that moment — it has no real
// duration, so it's deliberately kept out of the timing data rather than
// teaching the estimates a bogus zero. Returns true only if this call
// actually completed it.
function completeRubberNow(league, f, idx) {
  const rubber = f.rubbers[idx];
  if (rubber.completedAt) return false;
  const wasStarted = !!rubber.startedAt;
  rubber.completedAt = Date.now();
  if (!wasStarted) { rubber.startedAt = rubber.completedAt; return true; }
  const { ratingsData, identityOf } = loadGlobalRatings();
  const pred = matchPrediction(league, f, idx, ratingsData, identityOf);
  const durationMinutes = (rubber.completedAt - rubber.startedAt) / 60000;
  // A real rubber runs 20-150 min or so — anything outside that almost
  // certainly means Start was tapped early or Mark complete was forgotten
  // for hours, not a genuinely long match. Left out of the learned average
  // entirely (still recorded below in courtMatchLog, for whatever it's
  // worth) so one forgotten tap can't drag every future estimate in that
  // bucket toward it — a single outlier otherwise dominates a small count.
  const REALISTIC_MATCH_MINUTES = { min: 20, max: 150 };
  if (pred && durationMinutes >= REALISTIC_MATCH_MINUTES.min && durationMinutes <= REALISTIC_MATCH_MINUTES.max) {
    if (!league.courtDurationStats) league.courtDurationStats = {};
    const bucket = closenessBucket(pred.predictedCloseness);
    const stat = league.courtDurationStats[bucket] || (league.courtDurationStats[bucket] = { count: 0, totalMinutes: 0 });
    stat.count += 1;
    stat.totalMinutes += durationMinutes;
  }
  // A raw, per-match record alongside the courtDurationStats aggregate —
  // the aggregate can always be recomputed from this, but not the other
  // way around, so this is where any future "what actually predicts a
  // long match" analysis (by pairing, by court, by time of night, ...)
  // would read from. Not surfaced in any UI yet — purely collection for
  // now, per an explicit "gather more than just duration" ask.
  const where = findCourtScheduleCell(league, f.id, idx);
  if (!league.courtMatchLog) league.courtMatchLog = [];
  league.courtMatchLog.push({
    fixtureId: f.id,
    round: f.round,
    stage: f.stage,
    seed: idx,
    teamAId: f.teamA,
    teamBId: f.teamB,
    pairAIds: (f.selectionA.pairs[idx] || []).slice(),
    pairBIds: (f.selectionB.pairs[idx] || []).slice(),
    court: where ? where.court : null,
    courtName: where ? ((league.courtNames || [])[where.court] || null) : null,
    slot: where ? where.slot : null,
    startedAt: rubber.startedAt,
    completedAt: rubber.completedAt,
    durationMinutes: (rubber.completedAt - rubber.startedAt) / 60000,
    closeness: pred ? pred.predictedCloseness : null,
    pace: rubber.pace || null,
    winPctA: pred ? pred.winPctA : null,
    winPctB: pred ? pred.winPctB : null,
    provisional: pred ? pred.provisional : null,
    sets: (rubber.live ? rubber.live.sets : rubber.sets).map((set) => set.slice()),
    tb: (rubber.live ? rubber.live.tb : rubber.tb).slice(),
  });
  return true;
}

// Live Court Control's "Mark complete": finishes a match that's under way.
// Separate from finalizing the whole fixture (POST .../finalize below, which
// requires every rubber to carry a real score); a score that settles the
// match completes it on its own too (see the score PUT above).
router.post("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/complete", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  const rubber = f.rubbers[idx];
  if (!rubber.startedAt) return res.status(400).json({ error: "This match hasn't been started yet." });
  completeRubberNow(league, f, idx);
  store.saveLeague(league.id, league);
  res.json({ ok: true, completedAt: rubber.completedAt });
});

// Undo an accidental "Mark complete" — Live Court Control's own "Start
// again". Puts the rubber back to live (clock resumes from its original
// startedAt) or, if it was completed without ever really being started
// (a score entered straight from Results, which synthesizes startedAt ===
// completedAt — see completeRubberNow), back to upcoming instead. Also
// rolls back whatever that completion recorded in courtDurationStats/
// courtMatchLog, so a genuine completion later isn't shadowed by a
// mistaken one's numbers.
router.post("/leagues/:leagueId/fixtures/:fixtureId/rubbers/:idx/reopen", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const idx = Number(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= f.rubbers.length) return res.status(400).json({ error: "Invalid match." });
  const rubber = f.rubbers[idx];
  if (!rubber.completedAt) return res.status(400).json({ error: "This match isn't marked complete." });
  const completedAt = rubber.completedAt;
  const wasSyntheticStart = rubber.startedAt === completedAt;
  rubber.completedAt = null;
  if (wasSyntheticStart) rubber.startedAt = null;
  else {
    const { ratingsData, identityOf } = loadGlobalRatings();
    const pred = matchPrediction(league, f, idx, ratingsData, identityOf);
    const durationMinutes = (completedAt - rubber.startedAt) / 60000;
    // Same realistic-range guard completeRubberNow itself uses — an
    // out-of-range completion was never added to the aggregate in the
    // first place, so subtracting it here would wrongly dock some other,
    // legitimately-recorded match's contribution to that bucket.
    const REALISTIC_MATCH_MINUTES = { min: 20, max: 150 };
    if (pred && league.courtDurationStats && durationMinutes >= REALISTIC_MATCH_MINUTES.min && durationMinutes <= REALISTIC_MATCH_MINUTES.max) {
      const bucket = closenessBucket(pred.predictedCloseness);
      const stat = league.courtDurationStats[bucket];
      if (stat && stat.count > 0) {
        stat.count -= 1;
        stat.totalMinutes = Math.max(0, stat.totalMinutes - durationMinutes);
      }
    }
    if (league.courtMatchLog) {
      const i = league.courtMatchLog.findIndex((e) => e.fixtureId === f.id && e.seed === idx && e.completedAt === completedAt);
      if (i !== -1) league.courtMatchLog.splice(i, 1);
    }
  }
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/finalize", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const u = resolveLeagueSession(req, league.id);
  const isAdmin = isAdminSession(req, league.id);
  const isPlayer = u && u.leagueId === league.id && u.role === "captain" && (u.teamId === f.teamA || u.teamId === f.teamB);
  if (!isAdmin && !isPlayer) return res.status(403).json({ error: "Not allowed." });
  // An Ormonde-rules regular fixture's 5th rubber is a real, always-played
  // singles match — all 5 rubbers are required, not just the first 4 with
  // the 5th only on a tie (that's the knockout-decider shape, still used by
  // playoff fixtures, which stay untouched by leaving this undefined).
  const singlesRegulation = league.singlesDecider && f.stage === "regular" && f.rubbers.length === 5 ? 5 : undefined;
  if (!logic.requiredRubbersOk(f, league.format === "pairs", singlesRegulation)) return res.status(400).json({ error: "Enter a full score before finalizing." });
  f.finalized = true;
  f.finalizedAt = Date.now();
  logAudit(league, req, f, "finalize", {});
  remindFixtureRatings(league, f);
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
  } else if ((f.stage === "semi" || f.stage === "final") && league.format !== "pairs" && league.playoffs) {
    // A semi-final's recap needs BOTH semis in, same "the whole stage, not
    // just this one match" reasoning roundComplete uses above — finalizing
    // the first semi shouldn't post a half-finished wrap-up. The final is
    // just itself.
    const stageKey = f.stage === "semi" ? "semis" : "final";
    const stageFixtures = stageKey === "semis" ? (league.playoffs.semis || []).filter((x) => x && x.teamA && x.teamB) : [league.playoffs.final];
    const stageComplete = stageFixtures.length > 0 && stageFixtures.every((x) => x.finalized);
    if (stageComplete && postOrUpdatePlayoffRecap(league, stageKey)) {
      league.teams.forEach((t) => {
        notify(league, t.id, "news", (stageKey === "final" ? "The Final" : "Semi-finals") + " wrap-up is posted in News Room.", { stage: stageKey });
      });
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
  const u = resolveLeagueSession(req, league.id);
  const isAdmin = isAdminSession(req, league.id);
  const isCaptain = !!(u && u.leagueId === league.id && u.role === "captain");
  // Anyone who's claimed a player record in this league gets a vote too,
  // not just captains/admin — one per claimed identity, same as a
  // captain's is one per team.
  let claimedPlayerId = null;
  let myPlayerIds = [];
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    const mine = account ? (account.claims || []).filter((c) => c.leagueId === league.id && !c.leftAt) : [];
    if (mine.length) claimedPlayerId = mine[0].playerId;
    myPlayerIds = mine.map((c) => c.playerId);
  }
  if (!isAdmin && !isCaptain && !claimedPlayerId) return res.status(403).json({ error: "Log in as a captain, or claim your player record in this league, to vote." });
  // Admin gets one vote too, same as a team captain, just not tied to any
  // specific team — stored under a fixed "admin" key rather than a teamId.
  // A captain who has ALSO claimed a player record still votes as their
  // team (unchanged, backward compatible); everyone else votes under
  // their own claimed identity instead.
  const voterKey = isAdmin ? "admin" : isCaptain ? u.teamId : `player:${claimedPlayerId}`;
  const roundFixtures = league.fixtures.filter((f) => f.round === round);
  if (roundFixtures.length === 0) return res.status(404).json({ error: "No fixtures in that round." });
  if (!roundFixtures.every((f) => f.finalized)) return res.status(400).json({ error: "Voting opens once every match in the round is finalized." });
  const { pairKey } = req.body || {};
  const eligible = logic.potwEligiblePairs(league, round);
  if (!eligible.some((p) => p.key === pairKey)) return res.status(400).json({ error: "That pair didn't play this round." });
  // Nobody votes for their own game (the admin isn't playing, so is exempt).
  const chosen = eligible.find((p) => p.key === pairKey);
  if (!isAdmin && logic.potwIsOwnGame(league, chosen, { playerIds: myPlayerIds, teamId: isCaptain ? u.teamId : null })) {
    return res.status(400).json({ error: "You can't vote for a pair from your own match." });
  }
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
  const u = resolveLeagueSession(req, league.id);
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
  const u = resolveLeagueSession(req, league.id);
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

// Same responder as confirm (admin, or the captain who didn't propose it)
// — just declines instead of applying it. The court schedule was never
// touched while the proposal sat pending, so rejecting it is purely
// clearing the proposal: whatever was there before (or nothing, if this
// was the first order for the match) stands unchanged.
router.post("/leagues/:leagueId/fixtures/:fixtureId/court-order/reject", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  if (!f.courtOrderProposal) return res.status(400).json({ error: "There's no proposal to reject." });
  const admin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
  const side = u && u.role === "captain" ? (u.teamId === f.teamA ? "A" : u.teamId === f.teamB ? "B" : null) : null;
  if (!admin && (!side || side === f.courtOrderProposal.by)) return res.status(403).json({ error: "Only the other captain can reject this." });

  const proposerTeamId = f.courtOrderProposal.by === "A" ? f.teamA : f.teamB;
  notify(league, proposerTeamId, "timeslot", `Your proposed court/playing order for ${fixtureLabel(league, f)} was rejected — the previous order stays.`);
  f.courtOrderProposal = null;
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.post("/leagues/:leagueId/fixtures/:fixtureId/unlock", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const f = findFixture(league, req.params.fixtureId);
  if (!f) return res.status(404).json({ error: "Fixture not found." });
  const isAdmin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
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

// True once a generated playoffs bracket has nothing real riding on it yet
// (no line-up submitted anywhere in it) — the only state it's ever safe to
// silently overwrite, e.g. re-seeding after a tie that got missed (or was
// only resolved after the fact) is fixed up.
function playoffsUntouched(playoffs) {
  if (!playoffs) return true;
  const matches = playoffs.format === "position" ? (playoffs.matches || []) : [playoffs.final, ...(playoffs.semis || [])];
  return matches.every((m) => !m || (!m.selectionA.submitted && !m.selectionB.submitted));
}
router.post("/leagues/:leagueId/knockout/generate", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!["semis_final", "position"].includes(league.playoffFormat)) return res.status(400).json({ error: "This league wasn't set up with playoffs." });
  if (!playoffsUntouched(league.playoffs)) {
    return res.status(400).json({ error: "A line-up has already been submitted against the existing playoffs — this can't be regenerated from here anymore." });
  }
  const allDone = league.fixtures.length > 0 && league.fixtures.every((f) => f.finalized);
  if (!allDone) return res.status(400).json({ error: "Every regular-season fixture must be finalized first." });
  // The standings order below is what seeds every pairing — a genuine
  // points tie anywhere that leaves it ambiguous who plays whom (1st, or a
  // final-spot pairing boundary further down — see logic.detectSuperTie)
  // has to be resolved by a real Super Tie first, or that order only
  // exists because logic.computeStandings' own diff/alphabetical fallback
  // broke the tie, not because anyone actually won it.
  if (!league.superTie && logic.detectSuperTie(league)) {
    return res.status(400).json({ error: "There's a points tie that needs a Super Tie decider before playoffs can be generated." });
  }
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

// A points tie at the top needs a real decider before the season can be
// called — see logic.detectSuperTie for the 2-teams-vs-3+-teams rule. This
// just turns that detection into a normal admin-added "knockout" round (see
// POST /rounds above) with the right teams and seed count already filled
// in, so every existing fixture/selection/score/finalize route handles it
// for free — the round is just excluded from the table, exactly like any
// other knockout-type round.
router.post("/leagues/:leagueId/super-tie/generate", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (league.superTie) return res.status(400).json({ error: "A Super Tie decider has already been set up for this season." });
  const detected = logic.detectSuperTie(league);
  if (!detected) return res.status(400).json({ error: "There's no points tie to resolve right now." });
  const tiedTeams = detected.teamIds.map((id) => league.teams.find((t) => t.id === id)).filter(Boolean);
  const seedCount = detected.type === "3way" ? 3 : 1;
  const gen = logic.generateRoundRobin(tiedTeams, false, seedCount);
  // A 1-way decider is "top pair vs top pair" — one seed, but still a team
  // fixture, so it plays a normal team rubber (2 sets + a match tie-break
  // if split), not the Vibora 3-real-sets shape a 1-seed fixture would
  // otherwise default to.
  if (seedCount === 1) gen.fixtures.forEach((f) => { f.rubbers[0] = logic.emptyRubber(2); });
  const nextRound = (league.fixtures.reduce((max, f) => Math.max(max, f.round), 0) || 0) + 1;
  const offset = nextRound - 1;
  gen.fixtures.forEach((f) => { f.round += offset; });
  league.fixtures.push(...gen.fixtures);
  const rounds = [...new Set(gen.fixtures.map((f) => f.round))];
  if (!league.roundMeta) league.roundMeta = {};
  rounds.forEach((r, i) => {
    league.roundMeta[r] = { label: "Super Tie decider" + (rounds.length > 1 ? " " + (i + 1) : ""), type: "knockout" };
  });
  league.superTie = { type: detected.type, teamIds: detected.teamIds, rounds };
  store.saveLeague(league.id, league);
  res.json({ ok: true, round: rounds[0] });
});

/* ---------- News ---------- */

router.get("/leagues/:leagueId/news", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const posts = sortNewsPosts(league.news || []).map((p) => ({ ...p, photo: newsPostPhoto(p, league) }));
  res.json(posts);
});
router.post("/leagues/:leagueId/news", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { title, body, photo } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Title is required." });
  if (imageTooLarge(res, photo)) return;
  if (!league.news) league.news = [];
  league.news.push({ id: logic.uid(), title: title.trim(), body: (body || "").trim(), photo: photo || "", createdAt: Date.now() });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.delete("/leagues/:leagueId/news/:postId", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.news = (league.news || []).filter((p) => p.id !== req.params.postId);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Overrides sortNewsPosts' own headline pick (round rank, or recency for a
// manual post — see its own comment) with an admin's explicit choice. At
// most one pinned post per league — pinning a new one silently un-pins
// whichever was pinned before, so "which post is pinned" never needs its
// own separate answer from "which post is the headline".
router.put("/leagues/:leagueId/news/:postId/pin", requireAdmin, (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const post = (league.news || []).find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found." });
  const pinned = !!req.body.pinned;
  (league.news || []).forEach((p) => { if (p.pinnedAt) p.pinnedAt = null; });
  // A real timestamp, not just true/false — the Leagues-tab hero (see
  // /homepage/highlights) compares pin times across every league AND every
  // manual "Interesting this week" card, since only one of them can win
  // that single site-wide slot: whichever was pinned most recently.
  post.pinnedAt = pinned ? Date.now() : null;
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
// A quiet nudge for whoever's actually building the line-up — this team's
// own roster, ranked strongest to weakest and grouped into suggested seed
// pairs (a seed IS a pairing, not a single name), by the same rating engine
// behind the (still-unreleased) rankings/ratings-preview features. Also
// returns the flat per-player ranking (`players`) so the client can rate
// whatever the captain actually picks — including combinations the
// suggestion itself never proposed — live as they fill seeds in, before
// they submit. Gated to admin or that team's own captain (never the
// opposing captain, never a guest) — the same reason topScorers/rankings
// stay off the public UI while RATINGS_ENABLED is off, just enforced
// server-side here since this one carries a per-team roster rather than a
// leaguewide leaderboard nobody's meant to see yet. Gold-tier leagues
// already have their own, deliberate seeding ceremony (see tieringEnabled)
// — this would just be a second, conflicting opinion on the same decision,
// so it's withheld there instead of shown alongside it.
router.get("/leagues/:leagueId/teams/:teamId/suggested-seeds", requireAdminOrCaptain((req) => req.params.teamId), (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "League not found." });
  const team = league.teams.find((t) => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: "Team not found." });
  if (league.tieringEnabled) return res.status(400).json({ error: "This league seeds by gold tier, not by rating." });
  const { ratingsData, identityOf } = loadGlobalRatings();
  // Who goes at which seed is ranked by the same Elo + seeding blend the
  // predictions use (logic.blendedStrength): a player's rating pulled toward
  // where their captain has actually been playing them, trusting the rating
  // more the more games sit behind it. Someone who has played five Seed 1
  // games is a Seed 1 player — they are losing because Seed 1 faces every
  // team's strongest pair, so a poor record there must not walk them down to
  // Seed 4 (and a weak pair cleaning up at Seed 4 shouldn't leapfrog them).
  // Checked against the line-ups captains actually chose, this ordering
  // matched about twice as well as rating alone (0.52 vs 0.26 rank
  // correlation, and 0.31 for the old 20%-weight rule). A player with no
  // seed history yet is ranked on rating alone, as before.
  const teamMean = logic.teamMeanRating(league, team.id, ratingsData.players, identityOf);
  const players = team.players.map((p) => {
    const stat = ratingsData.players.get(identityOf(league.id, p.id));
    const seedsPlayed = stat ? stat.seedN || 0 : 0;
    const avgSeedPlayed = seedsPlayed ? stat.seedSum / seedsPlayed : null;
    return {
      playerId: p.id,
      playerName: p.name,
      rating: stat ? stat.rating : logic.ELO_BASE,
      played: stat ? stat.played : 0,
      provisional: !stat || stat.played < logic.ELO_PROVISIONAL_GAMES,
      avgSeedPlayed,
      seedsPlayed,
      // No seed history -> the fallback seed is never used for the ranking
      // (null keeps this on rating alone).
      strength: logic.blendedStrength(stat, teamMean, null),
    };
  });
  players.sort((a, b) => b.strength - a.strength || b.rating - a.rating);
  // A seed IS a pairing, not a single name — the suggestion has to say who
  // partners with whom, not just list the roster strongest to weakest.
  // Pairing the ranked list off in adjacent twos (1st with 2nd, 3rd with
  // 4th, ...) keeps each pair close in strength while still ordering the
  // pairs themselves strongest to weakest, seed 1 down. An odd-sized
  // roster leaves the last player unpaired rather than guessing a partner.
  const pairs = [];
  for (let i = 0; i + 1 < players.length; i += 2) {
    const a = players[i], b = players[i + 1];
    pairs.push({
      seed: pairs.length + 1,
      players: [{ id: a.playerId, name: a.playerName }, { id: b.playerId, name: b.playerName }],
      rating: Math.round((a.rating + b.rating) / 2),
    });
  }
  const last = players[players.length - 1];
  const unpaired = players.length % 2 === 1 ? { id: last.playerId, name: last.playerName } : null;
  res.json({ players, pairs, unpaired });
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
      // Same model as the live predictions: the blended figure stored before
      // the match where there is one, plain Elo otherwise (a pairs league).
      const storedPct = ratingsData.predictions && ratingsData.predictions.get(`${f.id}:${i}`);
      const winPctA = storedPct != null ? storedPct : Math.round(logic.expectedScore(ratingA, ratingB) * 100);
      const favoriteSide = winPctA >= 50 ? "A" : "B";
      recapAll.push({
        leagueId: league.id,
        pairA: pairA.map((id) => { const p = teamA.players.find((p) => p.id === id); return p ? { id: p.id, name: p.name } : null; }).filter(Boolean),
        pairB: pairB.map((id) => { const p = teamB.players.find((p) => p.id === id); return p ? { id: p.id, name: p.name } : null; }).filter(Boolean),
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
// Season Wrapped — a Spotify-Wrapped-style recap of one season for one
// player. `season` query param picks which one: omit it (or "live") for
// the current season, or pass an archived season's own `season` number
// (see logic.allSeasonsOf) for one that's already ended — so someone who
// finished their season last month gets exactly the same recap someone
// mid-season gets right now, just with the numbers already final.
router.get("/leagues/:leagueId/players/:playerId/wrapped", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const team = league.teams.find((t) => t.players.some((p) => p.id === req.params.playerId));
  const player = team && team.players.find((p) => p.id === req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  // A personal recap, not a public profile stat — only the account that
  // actually claimed this exact record gets to see it, same ownership
  // check the photo upload uses. A 404, not a 403: the wrapped route
  // shouldn't confirm to a stranger that a player record exists at all.
  let isOwnProfile = false;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    isOwnProfile = !!(account && (account.claims || []).some((c) => c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
  }
  if (!isOwnProfile) return res.status(404).json({ error: "Not found." });
  // Ended seasons only — a season still being played hasn't finished
  // deciding what it's a recap OF yet (the final table position keeps
  // moving, a title isn't a title until Hall of Fame actually records it).
  // allSeasonsOf's own live league entry (no `.season` field) never gets
  // this far.
  const seasons = logic.allSeasonsOf(league).filter((s) => s.season !== undefined);
  // Only offer a season this player actually played a match in — no point
  // showing a recap of a season they never featured in at all.
  const available = seasons
    .map((s) => ({
      season: s.season,
      label: s.label || `Season ${s.season}`,
      played: logic.playerMatchHistory(s, player.id).length,
    }))
    .filter((entry) => entry.played > 0);
  if (!available.length) return res.status(404).json({ error: "Nothing to wrap up yet — check back once your season ends." });
  const wanted = req.query.season;
  const season = wanted ? seasons.find((s) => String(s.season) === String(wanted)) : seasons[seasons.length - 1];
  if (!season) return res.status(404).json({ error: "That season wasn't found." });
  const { ratingsData } = loadGlobalRatings();
  const stats = logic.seasonWrappedStats(league, season, player.id, ratingsData);
  res.json({
    ...stats,
    season: season.season,
    leagueId: league.id,
    teamId: team.id,
    playerId: player.id,
    available: available.map(({ season: s, label }) => ({ season: s, label })),
    // The live league's own sponsors, not the archived snapshot's — a
    // sponsor relationship is current, not a historical fact worth
    // freezing into an old season's recap.
    sponsors: (league.sponsors || []).slice(0, 5),
  });
});
router.get("/leagues/:leagueId/players/:playerId/history", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const team = league.teams.find((t) => t.players.some((p) => p.id === req.params.playerId));
  const player = team && team.players.find((p) => p.id === req.params.playerId);
  if (!team || !player) return res.status(404).json({ error: "Player not found." });
  const { ratingsData } = loadGlobalRatings();
  // Both span every archived season plus the live one — see
  // logic.allSeasonsOf. A player's own record shouldn't shrink back to
  // nothing the moment their league starts a new season.
  const rows = logic.playerMatchHistoryAllSeasons(league, req.params.playerId, ratingsData);
  const potwWins = logic.potwAwardsAllSeasons(league, player.id).length;
  // Exact match against the winning team's own frozen roster (see
  // POST /hall-of-fame) — this player id was actually on that team when it
  // won. Falls back to a name match against the free-text winner (see
  // hofWinnerNameMatch) only for legacy entries with no roster at all.
  const hallOfFameTitlesFor = (aLeague, aPlayerId, aPlayerName) => (aLeague.hallOfFame || [])
    .filter((e) => (e.winnerRoster || []).some((p) => p.id === aPlayerId) || (!e.winnerRoster && hofWinnerNameMatch(e.winner, aPlayerName)))
    .map((e) => ({ season: e.season, label: e.label, teamName: e.winner, teamLogo: e.winnerLogo || "", leagueId: aLeague.id, leagueName: aLeague.name }));
  const hallOfFameTitles = hallOfFameTitlesFor(league, player.id, player.name).sort((a, b) => b.season - a.season);
  // Same idea as hallOfFameTitlesFor below — a Pair of the Week award
  // belongs to the person, not to whichever league tab happens to be open,
  // so the Trophy Room on this page needs the actual round/partner detail
  // for every league they're claimed in, not just a bare count.
  const potwAwardsFor = (aLeague, aPlayerId) => {
    return logic.potwAwardsAllSeasons(aLeague, aPlayerId)
      .map((w) => ({
        round: w.round,
        leagueId: aLeague.id,
        leagueName: aLeague.name,
        teamName: w.teamName,
        partnerName: w.playerAId === aPlayerId ? w.playerBName : w.playerAName,
      }));
  };
  let allAwards = potwAwardsFor(league, player.id);
  // Same idea, the other half of each Hall of Fame entry — a runner-up
  // finish is still a real achievement worth its own badge.
  const runnerUpTitlesFor = (aLeague, aPlayerId, aPlayerName) => (aLeague.hallOfFame || [])
    .filter((e) => (e.runnerUpRoster || []).some((p) => p.id === aPlayerId) || (!e.runnerUpRoster && hofWinnerNameMatch(e.runnerUp, aPlayerName)))
    .map((e) => ({ season: e.season, label: e.label, teamName: e.runnerUp, teamLogo: e.runnerUpLogo || "", leagueId: aLeague.id, leagueName: aLeague.name }));
  let allRunnerUps = runnerUpTitlesFor(league, player.id, player.name);
  // Longest run of consecutive wins EVER recorded in a league — not the
  // "current streak" the Stats page shows (that resets the moment a loss
  // happens, which would make an unlocked achievement flicker back to
  // locked), a permanent personal best instead. A "6-0" set (a bagel) is
  // counted the same pass over the same rows — `score` is already
  // flipped so this player's own side leads each set, so "6-0" always
  // means they won it, never the opponent.
  const careerStatsIn = (aLeague, aPlayerId) => {
    const aRows = logic.playerMatchHistoryAllSeasons(aLeague, aPlayerId, ratingsData);
    let streak = 0, bestStreak = 0, bagels = 0;
    aRows.forEach((r) => {
      if (r.result === "W") { streak++; bestStreak = Math.max(bestStreak, streak); } else streak = 0;
      if ((r.score || "").split(", ").includes("6-0")) bagels++;
    });
    return { bestStreak, bagels };
  };
  const myCareerStats = careerStatsIn(league, player.id);
  let bestWinStreak = { count: myCareerStats.bestStreak, leagueId: league.id, leagueName: league.name };
  let bagelCount = myCareerStats.bagels;
  // Only archived (fully finished) seasons count — an ongoing unbeaten run
  // isn't "unbeaten all season" yet, it's just unbeaten so far. A season
  // snapshot has the same teams/fixtures/playoffs shape a live league
  // does, so playerMatchHistory works on it unchanged. A minimum match
  // count keeps a season with 1-2 games played from trivially counting.
  const MIN_UNBEATEN_MATCHES = 3;
  const unbeatenSeasonsIn = (aLeague, aPlayerId) => (aLeague.seasonHistory || [])
    .map((snap, idx) => {
      const snapRows = logic.playerMatchHistory(snap, aPlayerId, ratingsData);
      if (snapRows.length < MIN_UNBEATEN_MATCHES || snapRows.some((r) => r.result === "L")) return null;
      return { season: snap.season || (aLeague.seasonHistory.length - idx), label: snap.label, leagueId: aLeague.id, leagueName: aLeague.name };
    })
    .filter(Boolean);
  let allUnbeatenSeasons = unbeatenSeasonsIn(league, player.id);
  // A championship belongs to the person, not to whichever tab happens to
  // be open — a claimed player's hero shows every title across every
  // league they're claimed in, not just this one, so it doesn't look like
  // they've never won anything the moment someone switches tabs. Starts
  // with this league's own titles; the loop below (already walking every
  // other claimed league for the tabs) adds the rest as it goes.
  let allChampionships = hallOfFameTitles.slice();
  // Same "belongs to the person, not the open tab" rule as championships —
  // owning a team in one league shouldn't vanish the moment the viewer
  // switches to a different one of this player's claimed records.
  let allOwnedTeams = (team.ownerIds || []).includes(player.id)
    ? [{ leagueId: league.id, leagueName: league.name, teamName: team.name }]
    : [];
  // If this player record has been claimed (see the player-accounts
  // feature), surface which other leagues that same real person plays
  // in — so a captain/admin browsing one league's roster can see this
  // isn't the only team this player is on, and can switch straight to
  // that league's record for the same player without leaving the modal.
  // Excludes only this exact record, not the whole league — a claim on a
  // *different* team in this same league is real too (e.g. the same
  // person won a title with one team, then moved to another the next
  // season) and still deserves its own tab, not to be silently dropped.
  let otherLeagues = [];
  if (player.claimedByUserId) {
    const user = store.getUser(player.claimedByUserId);
    if (user) {
      // Same rule as everywhere else: a hidden league (data-only, feeds
      // ratings but isn't a real league to browse) never surfaces as a tab
      // here either.
      const hiddenLeagueIds = new Set(store.getIndex().filter((entry) => entry.hidden).map((entry) => entry.id));
      otherLeagues = user.claims
        .filter((c) => !(c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id) && !hiddenLeagueIds.has(c.leagueId))
        .map((c) => {
          const otherLeague = store.getLeague(c.leagueId);
          const otherTeam = otherLeague && otherLeague.teams.find((t) => t.id === c.teamId);
          const otherPlayer = otherTeam && otherTeam.players.find((p) => p.id === c.playerId);
          if (!otherLeague || !otherTeam || !otherPlayer) return null;
          if ((otherTeam.ownerIds || []).includes(otherPlayer.id)) {
            allOwnedTeams.push({ leagueId: otherLeague.id, leagueName: otherLeague.name, teamName: otherTeam.name });
          }
          allChampionships = allChampionships.concat(hallOfFameTitlesFor(otherLeague, otherPlayer.id, otherPlayer.name));
          allAwards = allAwards.concat(potwAwardsFor(otherLeague, otherPlayer.id));
          allRunnerUps = allRunnerUps.concat(runnerUpTitlesFor(otherLeague, otherPlayer.id, otherPlayer.name));
          const otherStats = careerStatsIn(otherLeague, otherPlayer.id);
          if (otherStats.bestStreak > bestWinStreak.count) bestWinStreak = { count: otherStats.bestStreak, leagueId: otherLeague.id, leagueName: otherLeague.name };
          bagelCount += otherStats.bagels;
          allUnbeatenSeasons = allUnbeatenSeasons.concat(unbeatenSeasonsIn(otherLeague, otherPlayer.id));
          return { leagueId: otherLeague.id, leagueName: otherLeague.name, teamName: otherTeam.name, playerId: otherPlayer.id, playerName: otherPlayer.name };
        })
        .filter(Boolean);
    }
  }
  allChampionships.sort((a, b) => b.season - a.season);
  allAwards.sort((a, b) => b.round - a.round);
  allRunnerUps.sort((a, b) => b.season - a.season);
  allUnbeatenSeasons.sort((a, b) => b.season - a.season);
  const isAdmin = isAdminSession(req, league.id);
  const u = resolveLeagueSession(req, league.id);
  const isCaptain = u && u.leagueId === league.id && u.role === "captain" && u.teamId === team.id;
  let isOwnProfile = false;
  if (req.session.playerUser) {
    const account = store.getUser(req.session.playerUser.id);
    isOwnProfile = !!(account && (account.claims || []).some((c) => c.leagueId === league.id && c.teamId === team.id && c.playerId === player.id));
  }
  // If the knockout stage has started and this player's team is in one of
  // its still-undecided matches (a semi, the final, or a final-spot
  // playoff), surface which one and against whom — this popup otherwise
  // only shows results already decided, nothing about what's coming next.
  // Kept in sync by hand with positionMatchLabel client-side (same "Final"
  // / "Nth v Nth" labeling, just needed here server-side too).
  let nextKnockout = null;
  if (league.playoffs) {
    const ordinalOf = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
    const matches = league.playoffs.format === "position"
      ? (league.playoffs.matches || []).map((m, i) => ({ m, label: i === 0 ? "Final" : `${ordinalOf(i * 2 + 1)} v ${ordinalOf(i * 2 + 2)}` }))
      : [
        { m: league.playoffs.semis && league.playoffs.semis[0], label: "Semi-final" },
        { m: league.playoffs.semis && league.playoffs.semis[1], label: "Semi-final" },
        { m: league.playoffs.final, label: "Final" },
      ];
    const mine = matches.find((x) => x.m && !x.m.finalized && (x.m.teamA === team.id || x.m.teamB === team.id));
    if (mine) {
      const oppId = mine.m.teamA === team.id ? mine.m.teamB : mine.m.teamA;
      const oppTeam = oppId ? league.teams.find((t) => t.id === oppId) : null;
      nextKnockout = { label: mine.label, opponentTeam: oppTeam ? oppTeam.name : "TBD", opponentLogo: oppTeam ? oppTeam.logo || "" : "" };
    }
  }
  res.json({
    leagueId: league.id,
    leagueName: league.name,
    teamId: team.id,
    teamName: team.name,
    teamLogo: team.logo || "",
    playerId: player.id,
    playerName: player.name,
    photo: player.photo || "",
    isTeamOwner: (team.ownerIds || []).includes(player.id),
    allOwnedTeams,
    isPairs: league.format === "pairs",
    rows,
    potwWins,
    hallOfFameTitles,
    allChampionships,
    allAwards,
    allRunnerUps,
    bestWinStreak,
    bagelCount,
    allUnbeatenSeasons,
    otherLeagues,
    claimed: !!player.claimedByUserId,
    canEditPhoto: isAdmin || isCaptain || isOwnProfile,
    nextKnockout,
  });
});

// Not scoped to just this one league — a single match can't span leagues,
// but the SAME two real people can easily share more than one (a claimed
// account already tracks every league it plays in, same idea the ratings
// engine uses to follow a player across leagues). So: find every league
// where BOTH the viewer's claimed account and the viewed player's claimed
// account (if they have one — an unclaimed record only exists in this one
// league, so that's the only one it can contribute) hold a record, run the
// existing per-league scan in each, and add the totals together.
router.get("/leagues/:leagueId/players/:playerId/head-to-head", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  if (!req.session.playerUser) return res.json({ eligible: false });
  const myAccount = store.getUser(req.session.playerUser.id);
  if (!myAccount) return res.json({ eligible: false });
  const team = league.teams.find((t) => t.players.some((p) => p.id === req.params.playerId));
  const viewedPlayer = team && team.players.find((p) => p.id === req.params.playerId);
  if (!viewedPlayer) return res.json({ eligible: false });

  let viewedClaims = [{ leagueId: league.id, teamId: team.id, playerId: viewedPlayer.id }];
  if (viewedPlayer.claimedByUserId) {
    const viewedAccount = store.getUser(viewedPlayer.claimedByUserId);
    if (viewedAccount && viewedAccount.claims) viewedClaims = viewedAccount.claims;
  }
  const hiddenLeagueIds = new Set(store.getIndex().filter((e) => e.hidden).map((e) => e.id));
  const opponent = { wins: 0, losses: 0, draws: 0, matches: [] };
  const partner = { wins: 0, losses: 0, draws: 0, matches: [] };
  let myName = null, sharedAny = false;

  (myAccount.claims || []).forEach((mine) => {
    if (hiddenLeagueIds.has(mine.leagueId)) return;
    const theirs = viewedClaims.find((v) => v.leagueId === mine.leagueId);
    if (!theirs || mine.playerId === theirs.playerId) return;
    const lg = store.getLeague(mine.leagueId);
    const myTeam = lg && lg.teams.find((t) => t.id === mine.teamId);
    const myPlayer = myTeam && myTeam.players.find((p) => p.id === mine.playerId);
    if (!myPlayer) return;
    sharedAny = true;
    myName = myPlayer.name;
    const opp = logic.headToHead(lg, mine.playerId, theirs.playerId);
    const part = logic.partnerRecord(lg, mine.playerId, theirs.playerId);
    opponent.wins += opp.wins; opponent.losses += opp.losses; opponent.draws += opp.draws;
    opponent.matches.push(...opp.matches.map((m) => ({ ...m, leagueName: lg.name })));
    partner.wins += part.wins; partner.losses += part.losses; partner.draws += part.draws;
    partner.matches.push(...part.matches.map((m) => ({ ...m, leagueName: lg.name })));
  });

  if (!sharedAny) return res.json({ eligible: false });
  res.json({ eligible: true, myName, opponent, partner });
});

/* ---------- Notifications ---------- */

router.get("/leagues/:leagueId/notifications", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  if (!league) return res.status(404).json({ error: "Not found." });
  const u = resolveLeagueSession(req, league.id);
  const admin = isAdminSession(req, league.id);
  if (!admin && (!u || u.leagueId !== league.id)) return res.json([]);
  const all = league.notifications || [];
  const mine = admin ? all : all.filter((n) => n.teamId === u.teamId);
  res.json(mine.slice().sort((a, b) => b.createdAt - a.createdAt));
});
router.post("/leagues/:leagueId/notifications/:notifId/read", (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const u = resolveLeagueSession(req, league.id);
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
  const u = resolveLeagueSession(req, league.id);
  if (!u || u.leagueId !== league.id || u.role !== "captain") return res.status(401).json({ error: "Not logged in." });
  (league.notifications || []).forEach((n) => { if (n.teamId === u.teamId) n.read = true; });
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
// Every notification across every team this account captains, in one
// list — the header-wide bell (see renderBellWidget in app.js), as
// opposed to the per-league Notifications tab above, which only ever
// showed one league's own. resolveLeagueSession already recognizes a
// signed-in player account's own captaincies with no separate per-league
// login, so the existing mark-read/read-all routes above work unchanged
// when called with this account's session — this route only needs to
// answer "what is there to show," not duplicate how it gets marked read.
router.get("/players/notifications", requirePlayerUser, (req, res) => {
  const user = store.getUser(req.session.playerUser.id);
  const out = [];
  (user.captaincies || []).forEach((c) => {
    const league = store.getLeague(c.leagueId);
    if (!league) return;
    const team = league.teams.find((t) => t.id === c.teamId);
    if (!team) return;
    (league.notifications || []).filter((n) => n.teamId === c.teamId).forEach((n) => {
      out.push({ ...n, leagueId: league.id, leagueName: league.name, teamName: team.name });
    });
  });
  out.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ notifications: out, isCaptain: (user.captaincies || []).length > 0 });
});

/* ---------- Sponsors ---------- */

router.post("/leagues/:leagueId/sponsors", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  const { name, link, image } = req.body || {};
  if (!image) return res.status(400).json({ error: "An image is required." });
  if (imageTooLarge(res, image)) return;
  if (!league.sponsors) league.sponsors = [];
  const id = logic.uid();
  league.sponsors.push({ id, name: (name || "").trim(), link: (link || "").trim(), image });
  await store.saveSponsorPhoto(league.id, id, image);
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});
router.delete("/leagues/:leagueId/sponsors/:sponsorId", requireAdmin, async (req, res) => {
  const league = store.getLeague(req.params.leagueId);
  league.sponsors = (league.sponsors || []).filter((s) => s.id !== req.params.sponsorId);
  await store.saveSponsorPhoto(league.id, req.params.sponsorId, "");
  store.saveLeague(league.id, league);
  res.json({ ok: true });
});

router.backfillRoundRecaps = backfillRoundRecaps;
router.checkLineupReminders = checkLineupReminders;
// Reused by server.js to build the OG-tagged landing page a pay link
// redirects through — see the /pay and /pay-team routes there.
router.findTeamAndPlayer = findTeamAndPlayer;
router.playerShareCents = playerShareCents;
module.exports = router;
