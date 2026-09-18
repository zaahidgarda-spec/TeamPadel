const session = require("express-session");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// express-session's default MemoryStore leaks memory and doesn't survive a
// restart (everyone gets logged out on every deploy). If Upstash is
// configured — it already is, for league data — reuse it for sessions too.
// Without it, this returns null and server.js falls back to MemoryStore,
// which is fine for local dev.
//
// Every request under /api loads its session before the route handler even
// runs (see server.js), which without the cache below meant a real network
// round trip to Upstash on every single one — a few hundred ms, easily the
// dominant cost of a fast in-memory route like player search. A logged-in
// browser firing one request per keystroke pause (search's 200ms debounce)
// paid that same round trip again and again for a session that hadn't
// changed at all. CACHE_MS keeps a just-loaded session in memory for a
// few seconds so a burst of requests from the same browser — a name being
// typed, a few taps in a row — only pays Upstash once; short enough that a
// login/logout elsewhere is picked up almost immediately, and safe only
// because this app runs as a single Node process (a second instance behind
// a load balancer could serve a stale cached session from the wrong one).
const CACHE_MS = 5000;
class UpstashSessionStore extends session.Store {
  constructor(redis, prefix) {
    super();
    this.redis = redis;
    this.prefix = prefix;
    this.cache = new Map(); // sid -> { data, expiresAt }
  }
  ttlSeconds(sessionData) {
    const maxAge = sessionData.cookie && sessionData.cookie.maxAge;
    return Math.max(60, Math.ceil((maxAge || 1000 * 60 * 60 * 24 * 14) / 1000));
  }
  get(sid, cb) {
    const cached = this.cache.get(sid);
    if (cached && cached.expiresAt > Date.now()) return cb(null, cached.data);
    this.redis
      .get(this.prefix + sid)
      .then((data) => {
        this.cache.set(sid, { data: data || null, expiresAt: Date.now() + CACHE_MS });
        cb(null, data || null);
      })
      .catch((e) => cb(e));
  }
  set(sid, sessionData, cb) {
    this.cache.set(sid, { data: sessionData, expiresAt: Date.now() + CACHE_MS });
    this.redis
      .set(this.prefix + sid, sessionData, { ex: this.ttlSeconds(sessionData) })
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  destroy(sid, cb) {
    this.cache.delete(sid);
    this.redis
      .del(this.prefix + sid)
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  touch(sid, sessionData, cb) {
    this.cache.set(sid, { data: sessionData, expiresAt: Date.now() + CACHE_MS });
    this.redis
      .get(this.prefix + sid)
      .then((existing) => (existing ? this.redis.set(this.prefix + sid, existing, { ex: this.ttlSeconds(sessionData) }) : null))
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
}

function createSessionStore() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  return new UpstashSessionStore(redis, "sess:");
}

module.exports = { createSessionStore };
