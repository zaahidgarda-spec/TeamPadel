const test = require("node:test");
const assert = require("node:assert");
const A = require("../src/auction");

function league() {
  const mk = (id, name, n) => ({ id, name, logo: "", players: Array.from({ length: n }, (_, i) => ({ id: `${id}-p${i + 1}`, name: `${name} P${i + 1}` })) });
  return { id: "L", teams: [mk("t1", "Alpha", 3), mk("t2", "Bravo", 3)], fixtures: [] };
}
function ready(mode) {
  const lg = league();
  const a = A.newAuction(lg);
  const r = A.setupAuction(a, lg, { purse: 20, squadSize: 5, minBid: 1, increment: 1, ...(mode ? { priceMode: mode } : {}) }, {
    t1: [{ playerId: "t1-p1", price: 4 }, { playerId: "t1-p2", price: 4 }, { playerId: "t1-p3", price: 4 }],
    t2: [{ playerId: "t2-p1", price: 2 }, { playerId: "t2-p2", price: 2 }, { playerId: "t2-p3", price: 2 }],
  });
  assert.ok(r.ok, r.error);
  A.addToPool(a, ["Zed", "Yan", "Xia"], 2);
  return { lg, a, t1: lg.teams[0], t2: lg.teams[1] };
}

test("a team's cap leaves the minimum bid for every other open spot", () => {
  const { a, t1, t2 } = ready("open");
  // t1: 20 - 12 = 8 left, 2 spots -> may bid up to 8 - 1*(2-1) = 7
  assert.strictEqual(A.teamState(a, t1).maxBid, 7);
  // t2: 20 - 6 = 14 left, 2 spots -> 13
  assert.strictEqual(A.teamState(a, t2).maxBid, 13);
});

test("setup refuses kept players that cost more than the budget", () => {
  const lg = league();
  const a = A.newAuction(lg);
  const r = A.setupAuction(a, lg, { purse: 10, squadSize: 5, minBid: 1, increment: 1 }, { t1: [{ playerId: "t1-p1", price: 11 }] });
  assert.ok(r.error);
});

test("setup refuses more kept players than the squad size", () => {
  const lg = league();
  const a = A.newAuction(lg);
  const r = A.setupAuction(a, lg, { purse: 50, squadSize: 2, minBid: 1, increment: 1 }, {});
  assert.ok(r.error);
});

test("cannot start with an empty pool", () => {
  const lg = league();
  const a = A.newAuction(lg);
  assert.ok(A.start(a).error);
});

test("a full bidding round: bid, outbid, sell", () => {
  const { lg, a, t1, t2 } = ready("open");
  assert.ok(A.start(a).ok);
  const zed = a.pool[0];
  assert.ok(A.nextPlayer(a, zed.id).ok);
  assert.strictEqual(A.currentLot(a).minNext, 2);
  assert.ok(A.placeBid(a, t1, 2).ok);
  assert.strictEqual(A.currentLot(a).minNext, 3);
  assert.ok(A.placeBid(a, t2, 3).ok);
  assert.ok(A.sell(a, lg).ok);
  assert.strictEqual(zed.status, "sold");
  assert.strictEqual(zed.teamId, "t2");
  assert.strictEqual(zed.price, 3);
  assert.strictEqual(A.teamState(a, t2).purseLeft, 20 - 6 - 3);
  assert.strictEqual(a.current, null);
});

test("bids are checked: too low, own bid, over the cap, wrong state", () => {
  const { a, t1, t2 } = ready("open");
  assert.ok(A.placeBid(a, t1, 5).error, "not live yet");
  A.start(a);
  assert.ok(A.placeBid(a, t1, 5).error, "no one on the block");
  A.nextPlayer(a, a.pool[0].id);
  assert.ok(A.placeBid(a, t1, 1).error, "below the base price");
  assert.ok(A.placeBid(a, t1, 8).error, "over the 7 cap");
  assert.ok(A.placeBid(a, t1, 4).ok);
  assert.ok(A.placeBid(a, t1, 9).error, "already the highest bidder");
  const stale = A.placeBid(a, t2, 4);
  assert.ok(stale.error && stale.stale, "same amount as the leader is too low");
});

test("a full squad cannot bid", () => {
  const lg = league();
  const a = A.newAuction(lg);
  A.setupAuction(a, lg, { purse: 50, squadSize: 3, minBid: 1, increment: 1 }, {});
  A.addToPool(a, ["Zed"], 1);
  A.start(a);
  A.nextPlayer(a);
  const r = A.placeBid(a, lg.teams[0], 5);
  assert.ok(r.error && /full/i.test(r.error));
});

test("pass, undo, and passing only works with a player up", () => {
  const { lg, a, t1 } = ready("open");
  A.start(a);
  assert.ok(A.pass(a).error);
  A.nextPlayer(a, a.pool[0].id);
  A.placeBid(a, t1, 2);
  assert.ok(A.undoBid(a).ok);
  assert.ok(A.undoBid(a).error);
  assert.ok(A.sell(a, lg).error, "no bids, nothing to sell");
  assert.ok(A.pass(a).ok);
  assert.strictEqual(a.pool[0].status, "unsold");
});

test("an unsold player can come back once the others are done", () => {
  const { lg, a, t1 } = ready("open");
  A.start(a);
  a.pool.slice(1).forEach((p) => { p.status = "sold"; p.teamId = "t2"; p.price = 1; });
  A.nextPlayer(a, a.pool[0].id);
  A.pass(a);
  const again = A.nextPlayer(a);
  assert.ok(again.ok);
  assert.strictEqual(A.currentLot(a).item.id, a.pool[0].id);
  void lg; void t1;
});

test("only one player on the block at a time; paused stops bidding", () => {
  const { a, t1 } = ready("open");
  A.start(a);
  A.nextPlayer(a, a.pool[0].id);
  assert.ok(A.nextPlayer(a, a.pool[1].id).error);
  A.setPaused(a, true);
  assert.ok(A.placeBid(a, t1, 2).error);
  A.setPaused(a, false);
  assert.ok(A.placeBid(a, t1, 2).ok);
});

test("finishing needs the block empty; applying adds buyers and drops unkept players", () => {
  const lg = league();
  const a = A.newAuction(lg);
  A.setupAuction(a, lg, { purse: 30, squadSize: 5, minBid: 1, increment: 1 }, { t1: [{ playerId: "t1-p1", price: 3 }], t2: [{ playerId: "t2-p1", price: 3 }] });
  A.addToPool(a, ["Zed"], 2);
  A.start(a);
  A.nextPlayer(a);
  A.placeBid(a, lg.teams[0], 2);
  assert.ok(A.finish(a).error, "player still on the block");
  A.sell(a, lg);
  assert.ok(A.finish(a).ok);
  const r = A.applyToRosters(a, lg);
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(lg.teams[0].players.map((p) => p.name), ["Alpha P1", "Zed"]);
  assert.deepStrictEqual(lg.teams[1].players.map((p) => p.name), ["Bravo P1"]);
  assert.ok(A.applyToRosters(a, lg).error, "only once");
});

test("applying refuses to drop a player who is in a match line-up", () => {
  const lg = league();
  lg.fixtures = [{ selectionA: { pairs: [["t1-p2", "t1-p3"]] }, selectionB: { pairs: [] } }];
  const a = A.newAuction(lg);
  A.setupAuction(a, lg, { purse: 30, squadSize: 5, minBid: 1, increment: 1 }, { t1: [{ playerId: "t1-p1", price: 1 }], t2: [] });
  const r = A.applyToRosters(a, lg);
  assert.ok(r.error && /line-ups/.test(r.error));
  assert.strictEqual(lg.teams[0].players.length, 3, "nothing changed");
});

test("the public view hides nothing private and carries the viewer's team", () => {
  const { lg, a, t1 } = ready("open");
  A.start(a);
  A.nextPlayer(a, a.pool[0].id);
  A.placeBid(a, t1, 2);
  const v = A.publicState(a, lg, { teamId: "t1", isAdmin: false });
  assert.strictEqual(v.myTeamId, "t1");
  assert.strictEqual(v.current.leaderTeamId, "t1");
  assert.strictEqual(v.current.minNext, 3);
  assert.strictEqual(v.teams[0].maxBid, 7, "a bid spends nothing until the player is sold");
  assert.ok(v.log.length > 0);
});

test("undoing a sale puts the player back on the block with the bids as they were", () => {
  const { lg, a, t1, t2 } = ready("open");
  A.start(a);
  const zed = a.pool[0];
  A.nextPlayer(a, zed.id);
  A.placeBid(a, t1, 2);
  A.placeBid(a, t2, 3);
  A.sell(a, lg);
  assert.strictEqual(A.teamState(a, t2).bought.length, 1);
  assert.ok(A.undoSale(a).ok);
  assert.strictEqual(zed.status, "pending");
  assert.strictEqual(A.teamState(a, t2).bought.length, 0);
  assert.strictEqual(A.currentLot(a).bid, 3);
  assert.strictEqual(A.currentLot(a).leaderTeamId, "t2");
  assert.ok(A.undoSale(a).error, "only once, and not while a player is on the block");
});

test("a sale cannot be undone after the next player goes up, after a pass, or when none happened", () => {
  const { lg, a, t1 } = ready("open");
  A.start(a);
  assert.ok(A.undoSale(a).error, "nothing sold yet");
  A.nextPlayer(a, a.pool[0].id);
  A.placeBid(a, t1, 2);
  A.sell(a, lg);
  A.nextPlayer(a, a.pool[1].id);
  A.pass(a);
  assert.ok(A.undoSale(a).error, "the next player went up and was passed");
});

function calledRoom() {
  const x = ready();
  assert.strictEqual(x.a.config.priceMode, "called", "called is the default");
  A.start(x.a);
  A.nextPlayer(x.a, x.a.pool[0].id);
  return x;
}

test("called mode: captains can only accept the price the auctioneer is calling", () => {
  const { a, t1, t2 } = calledRoom();
  assert.strictEqual(A.currentLot(a).ask, 2, "opens at the base price");
  const wrong = A.placeBid(a, t1, 3);
  assert.ok(wrong.error && wrong.stale, "bidding a different amount is refused");
  assert.ok(A.placeBid(a, t1, 2).ok);
  assert.strictEqual(A.currentLot(a).ask, 3, "by default the call goes up by the step");
  assert.ok(A.setAsk(a, 6).ok);
  assert.strictEqual(A.currentLot(a).ask, 6);
  assert.ok(A.placeBid(a, t2, 3).stale, "the old price is no longer on offer");
  assert.ok(A.placeBid(a, t2, 6).ok);
  assert.strictEqual(A.currentLot(a).bid, 6);
});

test("called mode: the auctioneer cannot call at or below the current bid, or an absurd price", () => {
  const { a, t1 } = calledRoom();
  A.placeBid(a, t1, 2);
  assert.ok(A.setAsk(a, 2).error);
  assert.ok(A.setAsk(a, 3).ok);
  assert.ok(A.setAsk(a, 0).error);
  assert.ok(A.setAsk(a, 999).error, "more than a whole budget");
  assert.ok(A.setAsk(a, "abc").error);
});

test("called mode: a team still cannot accept a price above what it can afford", () => {
  const { a, t1 } = calledRoom();
  A.setAsk(a, 8);
  const r = A.placeBid(a, t1, 8);
  assert.ok(r.error && /most/i.test(r.error), "t1 can bid up to 7");
});

test("undoing a bid puts the call back where it was", () => {
  const { a, t1 } = calledRoom();
  A.placeBid(a, t1, 2);
  A.setAsk(a, 5);
  A.undoBid(a);
  assert.strictEqual(A.currentLot(a).ask, 2);
});

test("open mode still offers the next price and lets captains jump", () => {
  const { a, t1 } = ready();
  assert.ok(A.updatePricing(a, { priceMode: "open" }).ok);
  A.start(a);
  A.nextPlayer(a, a.pool[0].id);
  assert.ok(A.setAsk(a, 5).error, "no calling in open mode");
  assert.ok(A.placeBid(a, t1, 5).ok, "a jump is allowed");
});

test("the bid step can be changed mid-auction and is checked", () => {
  const { a, t1 } = calledRoom();
  A.placeBid(a, t1, 2);
  assert.ok(A.updatePricing(a, { increment: 0 }).error);
  assert.ok(A.updatePricing(a, { increment: 2 }).ok);
  assert.strictEqual(a.config.increment, 2);
});
