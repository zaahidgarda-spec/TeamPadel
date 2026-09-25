// Unit tests for the pure business logic in src/logic.js — no server, no
// store, no network. Node's own test runner (built in since Node 18, which
// this repo already requires), so this needs zero new dependencies.
//
// Scoped deliberately: this isn't "test everything", it's the handful of
// rules that have actually broken in production, so a future change to any
// of them fails loudly here instead of shipping quietly broken again.
const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../src/logic");

test("validateSelection — the singles seed doesn't count as a double-up", () => {
  const pairs = [["P1", "P2"], ["P3", "P4"], ["P5", "P6"], ["P7", "P8"], ["P1", null]];
  assert.equal(logic.validateSelection(pairs, false, 4, null), null);
});

test("validateSelection — the same player in two DOUBLES seeds is still a double-up", () => {
  const pairs = [["P1", "P2"], ["P1", "P4"], ["P5", "P6"], ["P7", "P8"], ["P9", null]];
  const result = logic.validateSelection(pairs, false, 4, null);
  assert.ok(result && result.needsConfirm, "expected a double-up to be flagged");
});

test("validateSelection — confirmDoubleUp lets a real double-up through", () => {
  const pairs = [["P1", "P2"], ["P1", "P4"], ["P5", "P6"], ["P7", "P8"], ["P9", null]];
  assert.equal(logic.validateSelection(pairs, true, 4, null), null);
});

test("validateSelection — a gold player can't be seeded outside a gold seed", () => {
  const goldRule = { goldIds: new Set(["P1"]), isGoldSeed: (i) => i === 0 };
  const pairs = [["P3", "P4"], ["P1", "P2"], ["P5", "P6"], ["P7", "P8"]];
  const result = logic.validateSelection(pairs, false, null, goldRule);
  assert.match(result.error, /gold-tier player/);
});

test("validateSelection — a gold player IS allowed in a gold seed", () => {
  const goldRule = { goldIds: new Set(["P1"]), isGoldSeed: (i) => i === 0 };
  const pairs = [["P1", "P2"], ["P3", "P4"], ["P5", "P6"], ["P7", "P8"]];
  assert.equal(logic.validateSelection(pairs, false, null, goldRule), null);
});

test("validateSelection — silver players are never restricted", () => {
  const goldRule = { goldIds: new Set(["P1"]), isGoldSeed: (i) => i === 0 };
  const pairs = [["P3", "P4"], ["P5", "P6"], ["P7", "P8"], ["P9", "P10"]];
  assert.equal(logic.validateSelection(pairs, false, null, goldRule), null);
});

test("validateRoundPair — the singles seed (index 4) never makes a player 'already used'", () => {
  const existingPairs = [[null, null], [null, null], [null, null], [null, null], ["P1", null]];
  const result = logic.validateRoundPair(existingPairs, 0, ["P1", "P2"], false, "gold", new Set());
  assert.equal(result, null);
});

test("validateRoundPair — reusing a player from an earlier DOUBLES round is still a double-up", () => {
  const existingPairs = [[null, null], ["P1", "P3"], [null, null], [null, null], [null, null]];
  const result = logic.validateRoundPair(existingPairs, 0, ["P1", "P2"], false, "gold", new Set());
  assert.ok(result && result.needsConfirm, "expected a double-up to be flagged");
});

test("validateRoundPair — a gold player is blocked from a silver-tossed pairing", () => {
  const existingPairs = [[null, null], [null, null], [null, null], [null, null], [null, null]];
  const result = logic.validateRoundPair(existingPairs, 0, ["P1", "P2"], false, "silver", new Set(["P1"]));
  assert.match(result.error, /gold-tier player/);
});

test("validateRoundPair — a gold player is fine in a gold-tossed pairing", () => {
  const existingPairs = [[null, null], [null, null], [null, null], [null, null], [null, null]];
  const result = logic.validateRoundPair(existingPairs, 0, ["P1", "P2"], false, "gold", new Set(["P1"]));
  assert.equal(result, null);
});

test("rubberScoreText — a double forfeit reads as its own thing, not a score", () => {
  const r = logic.emptyRubber(2);
  r.forfeited = "double";
  assert.equal(logic.rubberScoreText(r), "Double forfeit");
});

test("fixtureScore — a double-forfeited rubber counts as decided, wins nobody", () => {
  const rubbers = [logic.emptyRubber(2), logic.emptyRubber(2), logic.emptyRubber(2), logic.emptyRubber(2)];
  rubbers[0].forfeited = "double";
  const { winsA, winsB, decided } = logic.fixtureScore({ rubbers });
  assert.equal(winsA, 0);
  assert.equal(winsB, 0);
  assert.equal(decided, 1);
});

test("requiredRubbersOk — a double-forfeited pairs rubber counts as settled", () => {
  const rubber = logic.emptyRubber(3);
  rubber.forfeited = "double";
  assert.equal(logic.requiredRubbersOk({ rubbers: [rubber] }, true), true);
});

test("computeStandings — a double-forfeited pairs night is not a phantom draw", () => {
  const rubber = logic.emptyRubber(3);
  rubber.forfeited = "double";
  const league = {
    format: "pairs",
    teams: [{ id: "A", name: "Team A" }, { id: "B", name: "Team B" }],
    fixtures: [{ teamA: "A", teamB: "B", round: 1, finalized: true, rubbers: [rubber] }],
    roundMeta: {},
  };
  const rows = logic.computeStandings(league);
  const a = rows.find((r) => r.id === "A");
  assert.equal(a.nightsWon, 0);
  // This is the actual regression this test guards: a double forfeit used
  // to read as a genuine 0-0 draw and quietly hand both sides a point.
  assert.equal(a.nightsDrawn, 0);
  assert.equal(a.nightsLost, 0);
  assert.equal(a.points, 0);
});

test("computeStandings — an ordinary pairs win still scores normally", () => {
  const rubber = logic.emptyRubber(3);
  rubber.sets = [["6", "2"], ["6", "3"], [null, null]];
  const league = {
    format: "pairs",
    teams: [{ id: "A", name: "Team A" }, { id: "B", name: "Team B" }],
    fixtures: [{ teamA: "A", teamB: "B", round: 1, finalized: true, rubbers: [rubber] }],
    roundMeta: {},
  };
  const rows = logic.computeStandings(league);
  const a = rows.find((r) => r.id === "A");
  const b = rows.find((r) => r.id === "B");
  assert.equal(a.nightsWon, 1);
  assert.equal(a.points, 2);
  assert.equal(b.nightsLost, 1);
  assert.equal(b.points, 0);
});
