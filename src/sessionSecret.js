const crypto = require("crypto");

// Values that ship in the repo or that anyone would guess first. A session
// cookie signed with one of these can be forged by anybody who reads the
// source, so they are never accepted in production.
const KNOWN_WEAK = new Set([
  "change-this-in-production",
  "replace-with-a-long-random-string",
  "changeme",
  "change-me",
  "secret",
  "password",
  "session-secret",
]);
const MIN_LENGTH = 32;

// What a host operator should run to make one.
const HOW_TO_MAKE_ONE = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

// Picks the secret the sessions are signed with.
// - Production: SESSION_SECRET must be set, at least 32 characters, and not
//   one of the well-known placeholder values. Anything else throws, so the
//   server refuses to start instead of quietly running with forgeable sessions.
// - Anywhere else (local dev, tests): SESSION_SECRET if set, otherwise a random
//   one for this process only. Nothing hardcoded is ever used; the cost is that
//   local sessions reset when the dev server restarts.
function resolveSessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (env.NODE_ENV === "production") {
    if (!secret) {
      throw new Error(`SESSION_SECRET is not set. Set it in the host's environment variables to a long random string (${HOW_TO_MAKE_ONE}).`);
    }
    if (KNOWN_WEAK.has(secret.trim().toLowerCase())) {
      throw new Error(`SESSION_SECRET is a placeholder value that anyone could guess. Replace it with a long random string (${HOW_TO_MAKE_ONE}).`);
    }
    if (secret.length < MIN_LENGTH) {
      throw new Error(`SESSION_SECRET is too short (${secret.length} characters; needs at least ${MIN_LENGTH}). Use a long random string (${HOW_TO_MAKE_ONE}).`);
    }
    return secret;
  }
  return secret || crypto.randomBytes(32).toString("hex");
}

module.exports = { resolveSessionSecret, MIN_LENGTH };
