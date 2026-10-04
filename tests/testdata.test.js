const test = require("node:test");
const assert = require("node:assert");
const testdata = require("../src/testdata");
const auction = require("../src/auction");

let n = 0;
const uid = () => "id" + ++n;
let c = 0;
const genCode = () => "CODE" + ++c;

test("a test league has 8 teams with logos, unique codes and 6 players each", () => {
  const teams = testdata.buildTeams({ uid, genCode });
  assert.strictEqual(teams.length, 8);
  assert.ok(teams.every((t) => t.logo.startsWith("data:image/svg+xml;base64,") && t.players.length === 6));
  assert.strictEqual(new Set(teams.map((t) => t.code)).size, 8);
  const names = teams.flatMap((t) => t.players.map((p) => p.name));
  assert.strictEqual(new Set(names).size, names.length, "no player name repeats");
});

test("the pool plan never repeats a name already in the league or pool", () => {
  const league = { teams: testdata.buildTeams({ uid, genCode }) };
  const a = auction.newAuction(league);
  for (const tier of testdata.poolPlan(league, a.pool, a.config.minBid)) auction.addToPool(a, tier.names, tier.base);
  assert.strictEqual(a.pool.length, 20);
  const taken = new Set(league.teams.flatMap((t) => t.players.map((p) => p.name)));
  assert.ok(a.pool.every((p) => !taken.has(p.name)));
  for (const tier of testdata.poolPlan(league, a.pool, a.config.minBid)) auction.addToPool(a, tier.names, tier.base);
  assert.strictEqual(new Set(a.pool.map((p) => p.name)).size, a.pool.length);
});
