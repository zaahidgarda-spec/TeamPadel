// Player auction: every team arrives with some retained players, a fixed
// budget, and the open spots get filled by bidding. Pure functions only: no
// storage, no HTTP, so every rule here can be tested on its own. The routes
// (routes.js) load a league's auction state, call one of these, and save.
//
// State shape (stored per league, separately from the league record so a bid
// never rewrites the whole league):
//   status    "setup" | "live" | "paused" | "done"
//   config    { purse, squadSize, minBid, increment }
//   retained  { [teamId]: [{ playerId, name, price }] }   players a team keeps
//   pool      [{ id, name, basePrice, status: "pending"|"sold"|"unsold", teamId, price }]
//   current   null | { poolId, bids: [{ teamId, amount, at }] }
//   log       newest first, capped
//   version   bumped on every change, so the room can poll cheaply

// priceMode: "called" = the auctioneer calls each price and captains accept it
// (the way a live auction runs); "open" = the app offers the next price up and
// captains can also jump.
const DEFAULT_CONFIG = { purse: 100, squadSize: 8, minBid: 1, increment: 1, priceMode: "called" };
const LOG_CAP = 80;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function isPosInt(n) {
  return Number.isInteger(n) && n > 0;
}

function newAuction(league) {
  const retained = {};
  league.teams.forEach((t) => {
    retained[t.id] = t.players.map((p) => ({ playerId: p.id, name: p.name, price: 0 }));
  });
  return {
    status: "setup",
    config: { ...DEFAULT_CONFIG },
    retained,
    pool: [],
    current: null,
    log: [],
    version: 1,
    createdAt: Date.now(),
    applied: false,
  };
}

function bump(a, text, type, extra) {
  a.version = (a.version || 0) + 1;
  if (text) {
    a.log.unshift({ at: Date.now(), type: type || "info", text, ...(extra || {}) });
    if (a.log.length > LOG_CAP) a.log.length = LOG_CAP;
  }
}

// Where a team stands right now: what it keeps, what it has bought, how much
// is left, how many spots are open, and the most it may bid on this player.
// The cap leaves enough for the minimum bid on every OTHER open spot, so a
// team can never spend its way into a squad it cannot finish.
function teamState(a, team) {
  const retained = a.retained[team.id] || [];
  const bought = a.pool.filter((p) => p.status === "sold" && p.teamId === team.id);
  const spent = retained.reduce((s, r) => s + (r.price || 0), 0) + bought.reduce((s, p) => s + (p.price || 0), 0);
  const purseLeft = a.config.purse - spent;
  const slotsLeft = Math.max(0, a.config.squadSize - retained.length - bought.length);
  const maxBid = slotsLeft > 0 ? Math.max(0, purseLeft - a.config.minBid * (slotsLeft - 1)) : 0;
  return { retained, bought, spent, purseLeft, slotsLeft, maxBid };
}

function currentLot(a) {
  if (!a.current) return null;
  const item = a.pool.find((p) => p.id === a.current.poolId);
  if (!item) return null;
  const last = a.current.bids[a.current.bids.length - 1] || null;
  const minNext = last ? last.amount + a.config.increment : item.basePrice;
  // The price being asked for right now. In called mode that is whatever the
  // auctioneer last called; in open mode it is simply the next price up.
  const ask = a.config.priceMode === "called" && a.current.ask ? a.current.ask : minNext;
  return {
    item,
    bid: last ? last.amount : null,
    leaderTeamId: last ? last.teamId : null,
    minNext,
    ask,
  };
}

// ---- setup (only while status is "setup") ----

function validateConfig(c) {
  const out = {
    purse: Number(c.purse), squadSize: Number(c.squadSize), minBid: Number(c.minBid), increment: Number(c.increment),
    priceMode: c.priceMode === "open" ? "open" : "called",
  };
  if (!isPosInt(out.purse) || out.purse > 100000) return { error: "The budget has to be a whole number above zero." };
  if (!isPosInt(out.squadSize) || out.squadSize > 40) return { error: "The squad size has to be a whole number between 1 and 40." };
  if (!isPosInt(out.minBid) || out.minBid > out.purse) return { error: "The lowest bid has to be a whole number, no more than the budget." };
  if (!isPosInt(out.increment) || out.increment > out.purse) return { error: "The bid step has to be a whole number above zero." };
  return { config: out };
}

// `retainedInput`: { [teamId]: [{ playerId, price }] } — who each team keeps
// and what keeping them costs. Only players really on that team's roster can
// be kept.
function setupAuction(a, league, configInput, retainedInput) {
  if (a.status !== "setup") return { error: "The auction has started. Settings can't change now." };
  const v = validateConfig(configInput || a.config);
  if (v.error) return v;
  const retained = {};
  for (const team of league.teams) {
    const wanted = (retainedInput && retainedInput[team.id]) || null;
    const roster = new Map(team.players.map((p) => [p.id, p]));
    const list = [];
    if (wanted) {
      for (const r of wanted) {
        const p = roster.get(r.playerId);
        if (!p) continue;
        const price = Number(r.price || 0);
        if (!Number.isInteger(price) || price < 0) return { error: `The price for ${p.name} has to be a whole number, zero or more.` };
        list.push({ playerId: p.id, name: p.name, price });
      }
    } else {
      list.push(...(a.retained[team.id] || []));
    }
    if (list.length > v.config.squadSize) return { error: `${team.name} keeps ${list.length} players, more than the squad size of ${v.config.squadSize}.` };
    const cost = list.reduce((s, r) => s + r.price, 0);
    if (cost > v.config.purse) return { error: `${team.name}'s kept players cost ${cost}, more than the budget of ${v.config.purse}.` };
    retained[team.id] = list;
  }
  a.config = v.config;
  a.retained = retained;
  bump(a, "Settings saved", "info");
  return { ok: true };
}

function cleanName(n) {
  return String(n || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function addToPool(a, names, basePrice) {
  if (a.status === "done") return { error: "This auction is finished." };
  const base = basePrice === undefined || basePrice === null || basePrice === "" ? a.config.minBid : Number(basePrice);
  if (!isPosInt(base)) return { error: "The base price has to be a whole number above zero." };
  const clean = (Array.isArray(names) ? names : []).map(cleanName).filter(Boolean);
  if (!clean.length) return { error: "Enter at least one name." };
  if (a.pool.length + clean.length > 300) return { error: "That's more than 300 players in the pool." };
  clean.forEach((name) => a.pool.push({ id: uid(), name, basePrice: base, status: "pending", teamId: null, price: null }));
  bump(a, `${clean.length} player${clean.length === 1 ? "" : "s"} added to the pool`, "info");
  return { ok: true, added: clean.length };
}

function updatePoolItem(a, poolId, patch) {
  const item = a.pool.find((p) => p.id === poolId);
  if (!item) return { error: "Player not found." };
  if (item.status === "sold") return { error: "That player has already been sold." };
  if (a.current && a.current.poolId === poolId) return { error: "That player is on the block right now." };
  if (patch.name !== undefined) {
    const n = cleanName(patch.name);
    if (!n) return { error: "A name is needed." };
    item.name = n;
  }
  if (patch.basePrice !== undefined) {
    const b = Number(patch.basePrice);
    if (!isPosInt(b)) return { error: "The base price has to be a whole number above zero." };
    item.basePrice = b;
  }
  bump(a);
  return { ok: true };
}

function removeFromPool(a, poolId) {
  const item = a.pool.find((p) => p.id === poolId);
  if (!item) return { error: "Player not found." };
  if (item.status === "sold") return { error: "That player has already been sold." };
  if (a.current && a.current.poolId === poolId) return { error: "That player is on the block right now." };
  a.pool = a.pool.filter((p) => p.id !== poolId);
  bump(a);
  return { ok: true };
}

// ---- running the room ----

function start(a) {
  if (a.status !== "setup") return { error: "The auction is already open." };
  if (!a.pool.some((p) => p.status === "pending")) return { error: "Add at least one player to the pool first." };
  a.status = "live";
  bump(a, "The auction is open", "start");
  return { ok: true };
}

function setPaused(a, paused) {
  if (a.status !== "live" && a.status !== "paused") return { error: "The auction isn't running." };
  a.status = paused ? "paused" : "live";
  bump(a, paused ? "Auction paused" : "Auction resumed", "info");
  return { ok: true };
}

// Puts the next player on the block: the one chosen, else a random player
// still waiting, else (when everyone has had a turn) a random unsold one.
function nextPlayer(a, poolId, randomFn) {
  if (a.status !== "live") return { error: a.status === "paused" ? "The auction is paused." : "The auction isn't running." };
  if (a.current) return { error: "A player is already on the block. Sell or pass first." };
  let item = null;
  if (poolId) {
    item = a.pool.find((p) => p.id === poolId && p.status !== "sold");
    if (!item) return { error: "That player isn't available." };
  } else {
    let list = a.pool.filter((p) => p.status === "pending");
    if (!list.length) list = a.pool.filter((p) => p.status === "unsold");
    if (!list.length) return { error: "No players left to auction." };
    item = list[Math.floor((randomFn || Math.random)() * list.length)];
  }
  item.status = "pending";
  a.lastSold = null;
  a.current = { poolId: item.id, bids: [], ask: item.basePrice };
  bump(a, `${item.name} is on the block (from ${item.basePrice})`, "next");
  return { ok: true };
}

function placeBid(a, team, amount, now) {
  if (a.status !== "live") return { error: a.status === "paused" ? "The auction is paused." : "The auction isn't open." };
  const lot = currentLot(a);
  if (!lot) return { error: "No player is on the block right now." };
  const st = teamState(a, team);
  if (st.slotsLeft <= 0) return { error: "Your squad is full." };
  if (lot.leaderTeamId === team.id) return { error: "You already have the highest bid." };
  const n = Number(amount);
  if (!Number.isInteger(n)) return { error: "Enter a whole-number bid." };
  if (a.config.priceMode === "called" && n !== lot.ask) return { error: `The price is now ${lot.ask}.`, stale: true };
  if (n < lot.minNext) return { error: `Someone just bid. The lowest bid now is ${lot.minNext}.`, stale: true };
  if (n > st.maxBid) {
    return { error: st.maxBid < lot.minNext ? `You can't afford this one. Your most is ${st.maxBid}.` : `Your most on this player is ${st.maxBid}.` };
  }
  a.current.bids.push({ teamId: team.id, amount: n, at: now || Date.now() });
  // In called mode the auctioneer decides the next price; until they change it,
  // it simply goes up by the bid step.
  a.current.ask = n + a.config.increment;
  bump(a, `${team.name} bid ${n} for ${lot.item.name}`, "bid", { teamId: team.id, amount: n });
  return { ok: true };
}

function undoBid(a) {
  if (!a.current || !a.current.bids.length) return { error: "There is no bid to remove." };
  const removed = a.current.bids.pop();
  a.current.ask = removed.amount;
  bump(a, `Last bid of ${removed.amount} removed`, "info");
  return { ok: true };
}

function sell(a, league) {
  const lot = currentLot(a);
  if (!lot) return { error: "No player is on the block." };
  if (!lot.leaderTeamId) return { error: "Nobody has bid. Pass on this player instead." };
  const team = league.teams.find((t) => t.id === lot.leaderTeamId);
  lot.item.status = "sold";
  lot.item.teamId = lot.leaderTeamId;
  lot.item.price = lot.bid;
  a.lastSold = { poolId: lot.item.id, bids: a.current.bids.slice() };
  a.current = null;
  bump(a, `SOLD: ${lot.item.name} to ${team ? team.name : "a team"} for ${lot.bid}`, "sold", { teamId: lot.leaderTeamId, amount: lot.bid, name: lot.item.name });
  return { ok: true };
}

function pass(a) {
  const lot = currentLot(a);
  if (!lot) return { error: "No player is on the block." };
  lot.item.status = "unsold";
  a.lastSold = null;
  a.current = null;
  bump(a, `${lot.item.name} went unsold`, "unsold");
  return { ok: true };
}

// A mis-tap on Sold: puts the player back on the block with the bids as they
// were, so the room carries on. Only the most recent sale, and only until the
// next player goes up or the auction ends.
function undoSale(a) {
  if (a.status !== "live" && a.status !== "paused") return { error: "The auction isn't running." };
  if (a.current) return { error: "A player is on the block. Sell or pass first." };
  if (!a.lastSold) return { error: "There is no sale to undo." };
  const item = a.pool.find((p) => p.id === a.lastSold.poolId);
  if (!item || item.status !== "sold") { a.lastSold = null; return { error: "There is no sale to undo." }; }
  const name = item.name;
  item.status = "pending";
  item.teamId = null;
  item.price = null;
  const lastBid = a.lastSold.bids[a.lastSold.bids.length - 1];
  a.current = { poolId: item.id, bids: a.lastSold.bids, ask: lastBid ? lastBid.amount + a.config.increment : item.basePrice };
  a.lastSold = null;
  bump(a, `Sale undone: ${name} is back on the block`, "info");
  return { ok: true };
}

// Called mode: the auctioneer names the price captains can now accept. It has
// to be higher than the current bid (or at least the base price to open).
function setAsk(a, amount) {
  if (a.config.priceMode !== "called") return { error: "This auction is in open-bidding mode, where the app offers the next price." };
  if (a.status !== "live") return { error: a.status === "paused" ? "The auction is paused." : "The auction isn't running." };
  const lot = currentLot(a);
  if (!lot) return { error: "No player is on the block." };
  const n = Number(amount);
  if (!isPosInt(n)) return { error: "Enter a whole-number price." };
  const floor = lot.bid != null ? lot.bid + 1 : lot.item.basePrice;
  if (n < floor) return { error: `The price has to be at least ${floor}.` };
  if (n > a.config.purse) return { error: "That is more than a team's whole budget." };
  a.current.ask = n;
  bump(a, `Auctioneer calls ${n}`, "ask", { amount: n });
  return { ok: true };
}

// The bid step and who sets the price can change at any point, even mid-auction.
function updatePricing(a, input) {
  if (a.status === "done") return { error: "This auction is finished." };
  const inc = Number(input.increment !== undefined ? input.increment : a.config.increment);
  if (!isPosInt(inc) || inc > a.config.purse) return { error: "The bid step has to be a whole number above zero." };
  const mode = input.priceMode === "open" ? "open" : input.priceMode === "called" ? "called" : a.config.priceMode;
  a.config.increment = inc;
  a.config.priceMode = mode;
  if (a.current) {
    const lot = currentLot(a);
    if (!a.current.ask || a.current.ask < lot.minNext && a.current.bids.length) a.current.ask = lot.minNext;
  }
  bump(a, `Price settings changed: step ${inc}, ${mode === "called" ? "auctioneer calls the price" : "open bidding"}`, "info");
  return { ok: true };
}

// ---- finishing ----

// Writes the result into the teams: each bought player joins that team's
// roster. A kept-list is the squad the team arrived with, so a player the
// team did NOT keep leaves the roster, unless a fixture already uses them, in
// which case nothing is changed and the admin is told who.
// Players a team did not keep who are already named in a match line-up. They
// cannot be removed from the roster without breaking that line-up.
function rosterBlockers(a, league) {
  const used = new Set();
  const allFixtures = (league.fixtures || []).concat(league.playoffs && league.playoffs.matches ? league.playoffs.matches : []);
  allFixtures.forEach((f) => {
    [f.selectionA, f.selectionB].forEach((sel) => {
      if (sel && sel.pairs) sel.pairs.forEach((pair) => (pair || []).forEach((id) => id && used.add(id)));
    });
  });
  const blocked = [];
  league.teams.forEach((team) => {
    const keep = new Set((a.retained[team.id] || []).map((r) => r.playerId));
    team.players.forEach((p) => { if (!keep.has(p.id) && used.has(p.id)) blocked.push(`${p.name} (${team.name})`); });
  });
  return blocked;
}
function applyToRosters(a, league) {
  if (a.applied) return { error: "The results are already in the team rosters." };
  const blocked = rosterBlockers(a, league);
  if (blocked.length) return { error: `These players are already in match line-ups and can't be released: ${blocked.join(", ")}.` };
  league.teams.forEach((team) => {
    const keep = new Set((a.retained[team.id] || []).map((r) => r.playerId));
    team.players = team.players.filter((p) => keep.has(p.id));
    a.pool.filter((p) => p.status === "sold" && p.teamId === team.id).forEach((p) => {
      team.players.push({ id: uid() + uid(), name: p.name, paymentStatus: "unpaid", auctionPrice: p.price });
    });
  });
  a.applied = true;
  bump(a, "Players added to the team rosters", "info");
  return { ok: true };
}

function finish(a) {
  if (a.status === "setup") return { error: "The auction hasn't started." };
  if (a.status === "done") return { error: "The auction is already finished." };
  if (a.current) return { error: "A player is on the block. Sell or pass first." };
  a.status = "done";
  a.lastSold = null;
  bump(a, "The auction is finished", "done");
  return { ok: true };
}

// What every viewer is allowed to see. Nothing private lives in an auction,
// so this is one shape for everyone, plus who the viewer is.
function publicState(a, league, viewer) {
  const lot = currentLot(a);
  const teams = league.teams.map((t) => {
    const s = teamState(a, t);
    return {
      id: t.id, name: t.name, logo: t.logo || "",
      retained: s.retained.map((r) => ({ playerId: r.playerId, name: r.name, price: r.price })),
      bought: s.bought.map((p) => ({ name: p.name, price: p.price })),
      spent: s.spent, purseLeft: s.purseLeft, slotsLeft: s.slotsLeft, maxBid: s.maxBid,
    };
  });
  return {
    exists: true,
    status: a.status,
    applied: !!a.applied,
    config: a.config,
    teams,
    pool: a.pool.map((p) => ({ id: p.id, name: p.name, basePrice: p.basePrice, status: p.status, teamId: p.teamId, price: p.price })),
    current: lot ? {
      poolId: lot.item.id, name: lot.item.name, basePrice: lot.item.basePrice,
      bid: lot.bid, leaderTeamId: lot.leaderTeamId, minNext: lot.minNext, ask: lot.ask,
      bids: a.current.bids.slice(-6).reverse().map((b) => ({ teamId: b.teamId, amount: b.amount })),
    } : null,
    lastSold: a.lastSold ? (() => { const it = a.pool.find((p) => p.id === a.lastSold.poolId); return it ? { name: it.name, teamId: it.teamId, price: it.price } : null; })() : null,
    log: a.log.slice(0, 30),
    version: a.version,
    myTeamId: viewer.teamId || null,
    isAdmin: !!viewer.isAdmin,
    serverTime: Date.now(),
  };
}

module.exports = {
  DEFAULT_CONFIG, newAuction, teamState, currentLot, validateConfig, setupAuction, addToPool, updatePoolItem, removeFromPool,
  start, setPaused, nextPlayer, placeBid, setAsk, updatePricing, undoBid, sell, undoSale, pass, finish, rosterBlockers, applyToRosters, publicState,
};
