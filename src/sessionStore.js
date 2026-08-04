const session = require("express-session");

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// express-session's default MemoryStore leaks memory and doesn't survive a
// restart (everyone gets logged out on every deploy). If Upstash is
// configured — it already is, for league data — reuse it for sessions too.
// Without it, this returns null and server.js falls back to MemoryStore,
// which is fine for local dev.
class UpstashSessionStore extends session.Store {
  constructor(redis, prefix) {
    super();
    this.redis = redis;
    this.prefix = prefix;
  }
  ttlSeconds(sessionData) {
    const maxAge = sessionData.cookie && sessionData.cookie.maxAge;
    return Math.max(60, Math.ceil((maxAge || 1000 * 60 * 60 * 24 * 14) / 1000));
  }
  get(sid, cb) {
    this.redis
      .get(this.prefix + sid)
      .then((data) => cb(null, data || null))
      .catch((e) => cb(e));
  }
  set(sid, sessionData, cb) {
    this.redis
      .set(this.prefix + sid, sessionData, { ex: this.ttlSeconds(sessionData) })
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  destroy(sid, cb) {
    this.redis
      .del(this.prefix + sid)
      .then(() => cb && cb(null))
      .catch((e) => cb && cb(e));
  }
  touch(sid, sessionData, cb) {
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
