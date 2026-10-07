// Balwin rules: two gold seeds, but one gold player may also play Seed 3.
const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../src/logic");

const goldIds = new Set(["g1", "g2", "g3"]);
const rule = (max) => ({ goldIds, isGoldSeed: (i) => i < 2, silverAllowance: { seedIdx: 2, max } });
const line = (...pairs) => pairs;

test("gold players can play the two gold seeds", () => {
  const r = logic.validateSelection(line(["g1", "g2"], ["g3", "s1"], ["s2", "s3"], ["s4", "s5"]), true, null, rule(1));
  assert.equal(r, null);
});

test("with the Balwin allowance, one gold player may play Seed 3", () => {
  const r = logic.validateSelection(line(["g1", "s1"], ["g2", "s2"], ["g3", "s3"], ["s4", "s5"]), true, null, rule(1));
  assert.equal(r, null);
});

test("two gold players in Seed 3 is refused even with the allowance", () => {
  const r = logic.validateSelection(line(["s1", "s2"], ["s3", "s4"], ["g1", "g2"], ["s5", "s6"]), true, null, rule(1));
  assert.match(r.error, /at most 1 gold-tier player/);
});

test("the allowance covers Seed 3 only, not Seed 4", () => {
  const r = logic.validateSelection(line(["s1", "s2"], ["s3", "s4"], ["s5", "s6"], ["g1", "s7"]), true, null, rule(1));
  assert.match(r.error, /only be seeded in a gold-tier seed/);
});

test("without the allowance a gold player in Seed 3 is refused, as before", () => {
  const r = logic.validateSelection(line(["g1", "s1"], ["g2", "s2"], ["g3", "s3"], ["s4", "s5"]), true, null, rule(0));
  assert.match(r.error, /only be seeded in a gold-tier seed/);
});

test("a rule with no allowance object still behaves as before", () => {
  const r = logic.validateSelection(line(["s1", "s2"], ["s3", "s4"], ["g1", "s5"], ["s6", "s7"]), true, null, { goldIds, isGoldSeed: (i) => i < 2 });
  assert.match(r.error, /only be seeded in a gold-tier seed/);
});

test("pair-toss: a silver pairing takes one gold player only when allowed", () => {
  const blank = [[null, null], [null, null], [null, null], [null, null]];
  assert.equal(logic.validateRoundPair(blank, 2, ["g1", "s1"], false, "silver", goldIds, 1), null);
  assert.match(logic.validateRoundPair(blank, 2, ["g1", "g2"], false, "silver", goldIds, 1).error, /at most 1 gold-tier player/);
  assert.match(logic.validateRoundPair(blank, 3, ["g1", "s1"], false, "silver", goldIds, 0).error, /only play a gold pairing/);
  assert.equal(logic.validateRoundPair(blank, 0, ["g1", "g2"], false, "gold", goldIds, 0), null);
});
