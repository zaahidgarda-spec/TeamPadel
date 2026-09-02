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

// Must be awaited before the server starts accepting requests: it pulls
// everything Redis has into the in-memory cache so reads below can stay
// synchronous instead of forcing every route handler to become async.
async function init() {
  if (!useRedis) return;
  const index = (await redis.get("leagues-index")) || [];
  cache.set("leagues-index", index);
  for (const entry of index) {
    const league = await redis.get("league-" + entry.id);
    if (league) cache.set("league-" + entry.id, league);
  }
  const usersIndex = (await redis.get("users-index")) || [];
  cache.set("users-index", usersIndex);
  for (const entry of usersIndex) {
    const user = await redis.get("user-" + entry.id);
    if (user) cache.set("user-" + entry.id, user);
  }
  cache.set("interest-signups", (await redis.get("interest-signups")) || []);
  cache.set("homepage-extras", (await redis.get("homepage-extras")) || { dismissed: [], manual: [] });
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
function saveLeague(id, league) {
  if (useRedis) {
    cache.set("league-" + id, league);
    persist("league-" + id, league);
    return;
  }
  writeJsonFile("league-" + id, league);
}
function deleteLeague(id) {
  if (useRedis) {
    cache.delete("league-" + id);
    remove("league-" + id);
    return;
  }
  const p = filePath("league-" + id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
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
function saveSignups(signups) {
  if (useRedis) {
    cache.set("interest-signups", signups);
    persist("interest-signups", signups);
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

module.exports = {
  init,
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
  getSignups,
  saveSignups,
  getHomepageExtras,
  saveHomepageExtras,
};
