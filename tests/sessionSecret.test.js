// Production must never run with a missing, placeholder or short session secret.
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveSessionSecret } = require("../src/sessionSecret");

const good = "a".repeat(16) + "b".repeat(16) + "c1";
const prod = (extra) => ({ NODE_ENV: "production", ...extra });

test("production refuses to start without a secret", () => {
  assert.throws(() => resolveSessionSecret(prod({})), /SESSION_SECRET is not set/);
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "" })), /SESSION_SECRET is not set/);
});

test("production refuses the placeholder values from the repo", () => {
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "change-this-in-production" })), /placeholder/);
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "replace-with-a-long-random-string" })), /placeholder/);
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "  CHANGEME " })), /placeholder/);
});

test("production refuses a short secret", () => {
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "tooshort" })), /too short/);
  assert.throws(() => resolveSessionSecret(prod({ SESSION_SECRET: "x".repeat(31) })), /too short/);
});

test("production accepts a long random secret, exactly as given", () => {
  assert.equal(resolveSessionSecret(prod({ SESSION_SECRET: good })), good);
  assert.equal(resolveSessionSecret(prod({ SESSION_SECRET: "y".repeat(32) })), "y".repeat(32));
});

test("outside production a missing secret gets a random one, never a fixed value", () => {
  const a = resolveSessionSecret({ NODE_ENV: "development" });
  const b = resolveSessionSecret({});
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, "change-this-in-production");
});

test("outside production a secret that is set is used as is", () => {
  assert.equal(resolveSessionSecret({ NODE_ENV: "development", SESSION_SECRET: "dev" }), "dev");
});
