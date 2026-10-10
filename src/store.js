const fs = require("fs");
const path = require("path");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

let redis;
const cache = new Map();
let writeQueue = Promise.resolve();
const DATA_DIR = path.join(__dirname, "..", "data");

if (useRedis) {
  const { Redis } = require("@upstash/redis");
  redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
} else {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  return path.join(DATA_DIR, name + ".json");
}

function readJsonFile(name, fallback) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Failed to read " + name + ":", e.message);
    return fallback;
  }
}

function writeJsonFile(name, data) {
  const p = filePath(name);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// Redis writes happen in the background so callers keep the same
// synchronous feel as the old fs-only store. They're serialized through
// this queue so a crash-and-restart can't reorder two writes to the same key.
function persist(key, value) {
  writeQueue = writeQueue
    .then(() => redis.set(key, value))
    .catch((e) => console.error("Failed to persist " + key + " to Redis:", e.message));
}
// Same queue/ordering as persist(), but hands the real success/failure of
// THIS write back to the caller instead of always swallowing it — for the
// handful of writes (new account, new signup) where silently losing the
// data is worse than a request briefly waiting on Redis. The shared queue
// itself still never rejects, or every write queued after this one would
// silently stop happening too.
function persistDurable(key, value) {
  const result = writeQueue.then(() => redis.set(key, value));
  writeQueue = result.catch((e) => console.error("Failed to persist " + key + " to Redis:", e.message));
  return result;
}

function remove(key) {
  writeQueue = writeQueue
    .then(() => redis.del(key))
    .catch((e) => console.error("Failed to delete " + key + " from Redis:", e.message));
}

// Every account with a live (unexpired) session right now — reads the
// same "sess:*" keys sessionStore.js writes, straight from Redis rather
// than the in-memory cache, since sessions aren't cached here at all.
// Any key that still exists hasn't hit its TTL, so nothing needs a
// separate staleness check.
async function getActivePlayerUserIds() {
  if (!useRedis) return [];
  const keys = await redis.keys("sess:*");
  if (!keys.length) return [];
  const sessions = await Promise.all(keys.map((k) => redis.get(k).catch(() => null)));
  const ids = new Set();
  sessions.forEach((s) => { if (s && s.playerUser && s.playerUser.id) ids.add(s.playerUser.id); });
  return Array.from(ids);
}

// A genuine "on the app right now" count, distinct from the session store
// above — the auth session lasts 14 days and is only ever created for
// someone who logs in, so it can't answer "how many people, logged in or
// not, are actually browsing right now." Instead the client pings this
// with a per-browser id (public/app.js) every ~60s while its tab is
// visible; each ping just refreshes a short-lived key, so the count of
// keys still alive is the count of browsers that pinged in the last
// PRESENCE_TTL_SECONDS — no separate cleanup pass needed, Redis expires
// the key on its own.
const PRESENCE_TTL_SECONDS = 90;
// Each ping also carries who it is when a player account is signed in, so
// the Admin page can list the people online right now by name (guests stay
// anonymous — just counted). Without Redis (local runs) the same thing is
// kept in memory.
const localPresence = new Map(); // visitorId -> { t, userId }
// "YYYY-MM-DD" in local time — matches how a match's own schedule.date is
// read elsewhere (new Date(sched.date+"T00:00:00")), so "today" means the
// same calendar day throughout the app.
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Stamps the account with today's date the first time it pings today —
// every later ping that same day is a no-op, so an active user costs one
// write a day here, not one every ~60s. This is what answers "who was
// logged in today" on the owner Admin page (see getUsersLoggedInOn); it's
// a courtesy indicator, not durable data, so an occasional missed write on
// a restart mid-cache-flush is fine.
function markSeenToday(userId) {
  if (!userId) return;
  const user = getUser(userId);
  if (!user) return;
  const today = todayStr();
  if (user.lastSeenDate === today) return;
  user.lastSeenDate = today;
  user.lastSeenAt = Date.now();
  saveUser(userId, user);
}
async function touchPresence(visitorId, userId) {
  if (!visitorId) return;
  markSeenToday(userId);
  if (!useRedis) { localPresence.set(visitorId, { t: Date.now(), userId: userId || null }); return; }
  await redis.set("presence:" + visitorId, { t: Date.now(), userId: userId || null }, { ex: PRESENCE_TTL_SECONDS }).catch((e) => console.error("Failed to touch presence:", e.message));
}
// Every account that's pinged at least once today, most recent first —
// the "logged in today" list on the owner Admin page. A wider net than
// "online now" (last 90s): this is anyone who's actually used the app
// today with an authenticated session, not just this exact moment.
function getUsersLoggedInOn(dateStr) {
  return getUsersIndex()
    .map((entry) => getUser(entry.id))
    .filter((u) => u && u.lastSeenDate === dateStr)
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}
function livePresence() {
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  for (const [id, v] of localPresence) if (v.t < cutoff) localPresence.delete(id);
  return [...localPresence.values()];
}
async function getLiveVisitorCount() {
  if (!useRedis) return livePresence().length;
  const keys = await redis.keys("presence:*");
  return keys.length;
}
// Account ids of the signed-in players who pinged in the last 90 seconds.
async function getOnlinePlayerUserIds() {
  if (!useRedis) return [...new Set(livePresence().map((v) => v.userId).filter(Boolean))];
  const keys = await redis.keys("presence:*");
  if (!keys.length) return [];
  const values = await Promise.all(keys.map((k) => redis.get(k).catch(() => null)));
  return [...new Set(values.map((v) => v && typeof v === "object" ? v.userId : null).filter(Boolean))];
}

// Must be awaited before the server starts accepting requests: it pulls
// everything Redis has into the in-memory cache so reads below can stay
// synchronous instead of forcing every route handler to become async.
async function init() {
  if (!useRedis) return;
  const index = (await redis.get("leagues-index")) || [];
  cache.set("leagues-index", index);
  for (const entry of index) {
    const league = await redis.get("league-" + entry.id);
    if (league) {
      await hydrateLeaguePhotos(league);
      cache.set("league-" + entry.id, league);
    }
  }
  for (const entry of index) {
    const auction = await redis.get("auction-" + entry.id);
    if (auction) cache.set("auction-" + entry.id, auction);
  }
  const usersIndex = (await redis.get("users-index")) || [];
  cache.set("users-index", usersIndex);
  for (const entry of usersIndex) {
    const user = await redis.get("user-" + entry.id);
    if (user) cache.set("user-" + entry.id, user);
  }
  const signups = (await redis.get("interest-signups")) || [];
  for (const s of signups) {
    if (s.hasPhoto && !s.photo) s.photo = await getSignupPhoto(s.id);
  }
  cache.set("interest-signups", signups);
  cache.set("homepage-extras", (await redis.get("homepage-extras")) || { dismissed: [], manual: [] });
  cache.set("admin-hub", (await redis.get("admin-hub")) || { items: [] });
  cache.set("james-usage", (await redis.get("james-usage")) || { months: {}, days: {} });
  cache.set("james-settings", (await redis.get("james-settings")) || {});
  cache.set("james-log", (await redis.get("james-log")) || { sets: [] });
  cache.set("player-ratings", (await redis.get("player-ratings")) || { items: {} });
  cache.set("prediction-accuracy", (await redis.get("prediction-accuracy")) || { latest: null, history: [] });
  cache.set("site-settings", (await redis.get("site-settings")) || {});
}

// Lets the server wait for any in-flight writes before exiting on
// SIGTERM/SIGINT, so a deploy doesn't drop the last save.
function flush() {
  return writeQueue;
}

function getIndex() {
  if (useRedis) return cache.get("leagues-index") || [];
  return readJsonFile("leagues-index", []);
}
function saveIndex(index) {
  if (useRedis) {
    cache.set("leagues-index", index);
    persist("leagues-index", index);
    return;
  }
  writeJsonFile("leagues-index", index);
}
function getLeague(id) {
  if (useRedis) return cache.get("league-" + id) || null;
  return readJsonFile("league-" + id, null);
}
// A league with a full roster of uploaded player photos, a court photo
// and a few sponsor banners can add real weight to a document that gets
// rewritten on every score entry — and Upstash's 10MB per-request cap
// doesn't care that only a rubber's result actually changed. These three
// image kinds get split into their own key (leaguePhotosKey), same
// reasoning as kit photos above, just applied to the main league record
// instead of a team's kit sheet. Redis-only: the local file store has no
// such limit, so saveLeague there still just writes everything together,
// exactly as it always has.
function leaguePhotosKey(id) { return "leaguephotos:" + id; }
function emptyLeaguePhotos() { return { players: {}, sponsors: {}, court: "" }; }
async function getLeaguePhotosBlob(id) {
  if (!useRedis) return emptyLeaguePhotos();
  return (await redis.get(leaguePhotosKey(id)).catch((e) => { console.error("Failed to read league photos:", e.message); return null; })) || emptyLeaguePhotos();
}
// Merges previously-split-out photos back onto a league object just
// pulled fresh from Redis — called once, at boot (init above), since
// Redis mode then serves every read straight from the in-memory cache
// for the rest of this process's life; nothing else ever needs to call
// this again until the next restart.
async function hydrateLeaguePhotos(league) {
  const photos = await getLeaguePhotosBlob(league.id);
  (league.teams || []).forEach((t) => (t.players || []).forEach((p) => { if (photos.players[p.id]) p.photo = photos.players[p.id]; }));
  (league.sponsors || []).forEach((s) => { if (photos.sponsors[s.id]) s.image = photos.sponsors[s.id]; });
  if (photos.court) league.courtPhoto = photos.court;
}
// The inverse, for the Redis WRITE only — a shallow-ish clone with every
// photo byte blanked out, so the document saveLeague actually sends to
// Redis stays small. The in-memory object callers already hold onto
// (and the cache, below) keeps its real photos untouched.
function stripLeaguePhotosForWrite(league) {
  return {
    ...league,
    teams: (league.teams || []).map((t) => (
      (t.players || []).some((p) => p.photo)
        ? { ...t, players: t.players.map((p) => (p.photo ? { ...p, photo: "" } : p)) }
        : t
    )),
    sponsors: (league.sponsors || []).map((s) => (s.image ? { ...s, image: "" } : s)),
    courtPhoto: "",
  };
}
async function saveLeaguePhotoField(leagueId, mutate) {
  const photos = await getLeaguePhotosBlob(leagueId);
  mutate(photos);
  await redis.set(leaguePhotosKey(leagueId), photos).catch((e) => console.error("Failed to save league photos:", e.message));
}
// Safety net for saveLeague, below — a league can still be carrying
// legacy photo bytes on its in-memory object that were never captured by
// a dedicated upload call (savePlayerPhoto etc.), either because they
// predate this split existing at all, or because some other code path
// set player.photo/team logo/sponsor image directly. Stripping those for
// the Redis write without ALSO folding them into the split store first
// would silently delete them the moment this league next gets saved for
// any unrelated reason (a score entry, say) — which is exactly what
// happened to a real player's profile photo before this existed. Skipped
// entirely (no extra Redis round trip) for the common case of a league
// with no photos on it at all. Merges rather than replaces, so it can
// never undo an explicit deletion (savePlayerPhoto(...,"") already
// updated the split store directly, and this only ever adds keys the
// in-memory object still has bytes for).
async function migrateLegacyLeaguePhotos(id, league) {
  const players = {}, sponsors = {};
  (league.teams || []).forEach((t) => (t.players || []).forEach((p) => { if (p.photo) players[p.id] = p.photo; }));
  (league.sponsors || []).forEach((s) => { if (s.image) sponsors[s.id] = s.image; });
  const court = league.courtPhoto || "";
  if (!Object.keys(players).length && !Object.keys(sponsors).length && !court) return;
  const existing = await getLeaguePhotosBlob(id);
  const merged = { players: { ...existing.players, ...players }, sponsors: { ...existing.sponsors, ...sponsors }, court: court || existing.court };
  await redis.set(leaguePhotosKey(id), merged).catch((e) => console.error("Failed to migrate legacy league photos for " + id + ":", e.message));
}
// Called by the player-photo upload route (and its cross-league fan-out,
// and account deletion's cleanup) right alongside the ordinary
// `player.photo = photo` — a no-op locally, since local mode still just
// lets saveLeague persist the byte in place like before this split existed.
async function savePlayerPhoto(leagueId, playerId, dataUrl) {
  if (!useRedis) return;
  await saveLeaguePhotoField(leagueId, (photos) => { if (dataUrl) photos.players[playerId] = dataUrl; else delete photos.players[playerId]; });
}
async function saveSponsorPhoto(leagueId, sponsorId, dataUrl) {
  if (!useRedis) return;
  await saveLeaguePhotoField(leagueId, (photos) => { if (dataUrl) photos.sponsors[sponsorId] = dataUrl; else delete photos.sponsors[sponsorId]; });
}
async function saveLeagueCourtPhoto(leagueId, dataUrl) {
  if (!useRedis) return;
  await saveLeaguePhotoField(leagueId, (photos) => { photos.court = dataUrl || ""; });
}
function saveLeague(id, league) {
  if (useRedis) {
    cache.set("league-" + id, league);
    migrateLegacyLeaguePhotos(id, league);
    persist("league-" + id, stripLeaguePhotosForWrite(league));
    return;
  }
  writeJsonFile("league-" + id, league);
}
// A league's player auction lives under its own key, not inside the league
// record: every bid is a write, and a bid shouldn't rewrite the whole league.
function getAuction(leagueId) {
  if (useRedis) return cache.get("auction-" + leagueId) || null;
  return readJsonFile("auction-" + leagueId, null);
}
function saveAuction(leagueId, auction) {
  if (useRedis) {
    cache.set("auction-" + leagueId, auction);
    persist("auction-" + leagueId, auction);
    return;
  }
  writeJsonFile("auction-" + leagueId, auction);
}
function deleteAuction(leagueId) {
  if (useRedis) {
    cache.delete("auction-" + leagueId);
    remove("auction-" + leagueId);
    return;
  }
  const p = filePath("auction-" + leagueId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function deleteLeague(id) {
  if (useRedis) {
    cache.delete("league-" + id);
    remove("league-" + id);
    deleteAuction(id);
    remove(leaguePhotosKey(id));
    return;
  }
  const p = filePath("league-" + id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  deleteAuction(id);
}

// Kit photos (a team's front/back, logo, up to 5 sponsor slots) are the
// one exception to "everything lives in the league's own JSON record" —
// every team's set can add up to several high-resolution images, and
// unlike a fixture score or a court photo, they're rarely read (only the
// Kit Designer, a kit-sheet download, or a supplier's kit-share link ever
// need them). Bundling them into the shared league blob meant every
// future save of THAT league — a score, a new fixture, anything — carried
// their bytes too, until a big enough kit collection tipped that one
// league's record over Upstash's 10MB per-request limit and started
// silently failing to save (see saveLeague/persist's fire-and-forget
// write). Each kit photo gets its own key instead, fetched only when
// actually needed, so resolution stops being a shared-blob risk.
// Deliberately NOT preloaded into `cache` at boot like leagues/users are —
// loading every team's kit photos into memory on every restart would cost
// far more than the rare reads they serve.
function kitPhotoKey(leagueId, teamId, field) {
  return `kitphoto:${leagueId}:${teamId}:${field}`;
}
async function getKitPhoto(leagueId, teamId, field) {
  if (!useRedis) return readJsonFile(kitPhotoKey(leagueId, teamId, field).replace(/:/g, "_"), "");
  return (await redis.get(kitPhotoKey(leagueId, teamId, field)).catch((e) => { console.error("Failed to read kit photo:", e.message); return null; })) || "";
}
// Awaited directly (unlike saveLeague's fire-and-forget persist) — kit
// photo uploads are rare enough that it's worth the round trip to know
// the write actually landed before telling the uploader it saved.
async function saveKitPhoto(leagueId, teamId, field, dataUrl) {
  const key = kitPhotoKey(leagueId, teamId, field);
  if (!useRedis) {
    const fname = key.replace(/:/g, "_");
    if (dataUrl) writeJsonFile(fname, dataUrl);
    else { const p = filePath(fname); if (fs.existsSync(p)) fs.unlinkSync(p); }
    return;
  }
  if (dataUrl) await redis.set(key, dataUrl).catch((e) => console.error("Failed to save kit photo:", e.message));
  else await redis.del(key).catch((e) => console.error("Failed to delete kit photo:", e.message));
}
const KIT_PHOTO_FIELDS = ["front", "back", "logo", "sleeveLeft", "sleeveRight", "backSponsor1", "backSponsor2", "backSponsor3"];
// Best-effort cleanup so a deleted team/league doesn't leave orphaned kit
// photo keys behind forever — not urgent (each is its own tiny key, never
// itself a size risk) but tidy.
async function deleteKitPhotosForTeam(leagueId, teamId) {
  await Promise.all(KIT_PHOTO_FIELDS.map((f) => saveKitPhoto(leagueId, teamId, f, "")));
}

function getUsersIndex() {
  if (useRedis) return cache.get("users-index") || [];
  return readJsonFile("users-index", []);
}
function saveUsersIndex(index) {
  if (useRedis) {
    cache.set("users-index", index);
    persist("users-index", index);
    return;
  }
  writeJsonFile("users-index", index);
}
// Same as saveUsersIndex, but the caller can await it to know the write
// actually reached Redis before telling a new signup "you're in."
function saveUsersIndexDurable(index) {
  if (useRedis) {
    cache.set("users-index", index);
    return persistDurable("users-index", index);
  }
  writeJsonFile("users-index", index);
  return Promise.resolve();
}
function getUser(id) {
  if (useRedis) return cache.get("user-" + id) || null;
  return readJsonFile("user-" + id, null);
}
function saveUser(id, user) {
  if (useRedis) {
    cache.set("user-" + id, user);
    persist("user-" + id, user);
    return;
  }
  writeJsonFile("user-" + id, user);
}
// Same as saveUser, but the caller can await Redis confirmation — used
// wherever a brand-new account is created, so the write can't silently
// vanish (session survives a restart either way, since sessions live in
// their own always-awaited Redis store; the account record doesn't,
// unless a call site opts into this).
function saveUserDurable(id, user) {
  if (useRedis) {
    cache.set("user-" + id, user);
    return persistDurable("user-" + id, user);
  }
  writeJsonFile("user-" + id, user);
  return Promise.resolve();
}
function deleteUser(id) {
  if (useRedis) {
    cache.delete("user-" + id);
    remove("user-" + id);
    return;
  }
  const p = filePath("user-" + id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function getSignups() {
  if (useRedis) return cache.get("interest-signups") || [];
  return readJsonFile("interest-signups", []);
}
// The whole interest-signups list is one Redis key, rewritten on every
// new signup or removal — fine for names and emails, but a growing
// history of submitted photos (the auction notice, say) would mean that
// one rewrite keeps carrying every earlier photo too, forever. Each
// signup's photo gets its own key instead (see signupPhotoKey below);
// the list itself only ever keeps a hasPhoto flag. Redis-only, same
// "local mode doesn't need this" reasoning as league photos above.
function signupPhotoKey(id) { return "signupphoto:" + id; }
async function getSignupPhoto(id) {
  if (!useRedis) return "";
  return (await redis.get(signupPhotoKey(id)).catch((e) => { console.error("Failed to read signup photo:", e.message); return null; })) || "";
}
async function saveSignupPhoto(id, dataUrl) {
  if (!useRedis) return;
  if (dataUrl) await redis.set(signupPhotoKey(id), dataUrl).catch((e) => console.error("Failed to save signup photo:", e.message));
  else await redis.del(signupPhotoKey(id)).catch((e) => console.error("Failed to delete signup photo:", e.message));
}
// Same reasoning as migrateLegacyLeaguePhotos above — stripping a
// signup's photo for the write without first making sure its own
// signupPhotoKey actually has it would silently delete any photo that
// didn't happen to arrive through saveSignupPhoto specifically.
function migrateLegacySignupPhotos(signups) {
  signups.forEach((s) => {
    if (!s.photo) return;
    redis.get(signupPhotoKey(s.id)).then((existing) => {
      if (!existing) return redis.set(signupPhotoKey(s.id), s.photo);
    }).catch((e) => console.error("Failed to migrate legacy signup photo for " + s.id + ":", e.message));
  });
}
function saveSignups(signups) {
  if (useRedis) {
    cache.set("interest-signups", signups);
    migrateLegacySignupPhotos(signups);
    persist("interest-signups", signups.map((s) => (s.photo ? { ...s, photo: "", hasPhoto: true } : s)));
    return;
  }
  writeJsonFile("interest-signups", signups);
}

// Owner-only curation of the homepage's "Interesting this week" strip —
// `dismissed` is a list of "leagueId:round:type" keys (a highlight's
// stable identity, since a round recap has at most one highlight per
// type) hiding an auto-generated card; `manual` is admin-authored cards
// added on top of the auto ones.
function getHomepageExtras() {
  if (useRedis) return cache.get("homepage-extras") || { dismissed: [], manual: [] };
  return readJsonFile("homepage-extras", { dismissed: [], manual: [] });
}
function saveHomepageExtras(extras) {
  if (useRedis) {
    cache.set("homepage-extras", extras);
    persist("homepage-extras", extras);
    return;
  }
  writeJsonFile("homepage-extras", extras);
}

// The universal admin hub: notes, sponsor/court money, follow-ups and kit
// deliveries across every league. Owner-only, one list for the whole site.
function getAdminHub() {
  if (useRedis) return cache.get("admin-hub") || { items: [] };
  return readJsonFile("admin-hub", { items: [] });
}
function saveAdminHub(hub) {
  if (useRedis) {
    cache.set("admin-hub", hub);
    persist("admin-hub", hub);
    return;
  }
  writeJsonFile("admin-hub", hub);
}

// James (the admin assistant): what he has cost this month and how many
// requests each admin has made today, so the spending cap and daily limit hold
// across restarts.
function getJamesUsage() {
  if (useRedis) return cache.get("james-usage") || { months: {}, days: {} };
  return readJsonFile("james-usage", { months: {}, days: {} });
}
function saveJamesUsage(u) {
  if (useRedis) {
    cache.set("james-usage", u);
    persist("james-usage", u);
    return;
  }
  writeJsonFile("james-usage", u);
}

// What James is allowed to read and change (switched on and off in the Note
// Machine), and the record of every change he has made, with what's needed to undo it.
function getJamesSettings() {
  if (useRedis) return cache.get("james-settings") || {};
  return readJsonFile("james-settings", {});
}
function saveJamesSettings(v) {
  if (useRedis) { cache.set("james-settings", v); persist("james-settings", v); return; }
  writeJsonFile("james-settings", v);
}
function getJamesLog() {
  if (useRedis) return cache.get("james-log") || { sets: [] };
  return readJsonFile("james-log", { sets: [] });
}
function saveJamesLog(v) {
  if (useRedis) { cache.set("james-log", v); persist("james-log", v); return; }
  writeJsonFile("james-log", v);
}

// Opponent attribute ratings (the FIFA-style player card) — one record per
// rater + match + rated player, keyed so a repeat submit overwrites rather
// than double-counts. Rater ids stay in the store but are never sent to a
// client: ratings are anonymous to whoever is being rated.
function getPlayerRatings() {
  if (useRedis) return cache.get("player-ratings") || { items: {} };
  return readJsonFile("player-ratings", { items: {} });
}
function savePlayerRatings(ratings) {
  if (useRedis) {
    cache.set("player-ratings", ratings);
    persist("player-ratings", ratings);
    return;
  }
  writeJsonFile("player-ratings", ratings);
}

// The latest prediction-accuracy report plus one small point per day for the
// trend (see accuracy.js).
function getPredictionAccuracy() {
  if (useRedis) return cache.get("prediction-accuracy") || { latest: null, history: [] };
  return readJsonFile("prediction-accuracy", { latest: null, history: [] });
}
function savePredictionAccuracy(data) {
  if (useRedis) {
    cache.set("prediction-accuracy", data);
    persist("prediction-accuracy", data);
    return;
  }
  writeJsonFile("prediction-accuracy", data);
}

// Owner-controlled site-wide switches (see the guest sign-up wall).
function getSiteSettings() {
  if (useRedis) return cache.get("site-settings") || {};
  return readJsonFile("site-settings", {});
}
function saveSiteSettings(data) {
  if (useRedis) {
    cache.set("site-settings", data);
    persist("site-settings", data);
    return;
  }
  writeJsonFile("site-settings", data);
}

module.exports = {
  init,
  getSiteSettings,
  saveSiteSettings,
  getPredictionAccuracy,
  savePredictionAccuracy,
  flush,
  getIndex,
  saveIndex,
  getLeague,
  saveLeague,
  deleteLeague,
  getUsersIndex,
  saveUsersIndex,
  saveUsersIndexDurable,
  getUser,
  saveUser,
  saveUserDurable,
  deleteUser,
  getActivePlayerUserIds,
  touchPresence,
  getLiveVisitorCount,
  getOnlinePlayerUserIds,
  getUsersLoggedInOn,
  todayStr,
  getSignups,
  saveSignups,
  getSignupPhoto,
  saveSignupPhoto,
  getAuction,
  saveAuction,
  deleteAuction,
  getPlayerRatings,
  savePlayerRatings,
  getHomepageExtras,
  saveHomepageExtras,
  getAdminHub,
  saveAdminHub,
  getJamesUsage,
  saveJamesUsage,
  getJamesSettings,
  saveJamesSettings,
  getJamesLog,
  saveJamesLog,
  getKitPhoto,
  saveKitPhoto,
  deleteKitPhotosForTeam,
  savePlayerPhoto,
  saveSponsorPhoto,
  saveLeagueCourtPhoto,
};
