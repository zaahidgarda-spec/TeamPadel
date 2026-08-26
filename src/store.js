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

function remove(key) {
  writeQueue = writeQueue
    .then(() => redis.del(key))
    .catch((e) => console.error("Failed to delete " + key + " from Redis:", e.message));
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
  getUser,
  saveUser,
  getSignups,
  saveSignups,
};
