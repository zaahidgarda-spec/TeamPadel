#!/usr/bin/env node
// Re-checks the prediction model against the real finished matches, and says
// how much to trust it.
//
//   node scripts/backtest-predictions.js [siteUrl]        (default: https://teampadelsports.com)
//
// It downloads every league's public data, replays each finished match in
// date order, and for every match asks "what would each model have said
// using only what came before?". Models compared: plain Elo (the old
// predictions) and the Elo + seeding blend now in src/logic.js
// (SEED_BLEND_K / SEED_PRIOR_STEP). Then it resamples whole match nights
// 1000 times to show how much those results could move by chance.
//
// Run it again as the season goes on: with more matches the margins below
// shrink, and it will show whether the two settings should move.
const logic = require("../src/logic");
const SITE = (process.argv[2] || "https://teampadelsports.com").replace(/\/$/, "");
const E = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

async function getJson(path) {
  const res = await fetch(SITE + path);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

function predictions(leagues, params) {
  const out = [];
  leagues.forEach((league) => {
    const P = new Map();
    const get = (id) => { if (!P.has(id)) P.set(id, { r: 1500, n: 0, ss: 0, sn: 0 }); return P.get(id); };
    const teamMean = (tid) => { const t = league.teams.find((x) => x.id === tid); return t.players.reduce((s, p) => s + get(p.id).r, 0) / t.players.length; };
    logic.allRatableFixtures([league]).forEach(({ f }) => {
      (f.selectionA.pairs || []).forEach((pa, i) => {
        const pb = (f.selectionB.pairs || [])[i]; const r = f.rubbers[i];
        if (!pa || !pb || pa.some((x) => !x) || pb.some((x) => !x) || !r || r.forfeited) return;
        const w = logic.rubberWinner(r); if (!w) return; const y = w === "A" ? 1 : 0;
        const eff = (id, tid) => { const p = get(id); if (params.k === 0) return p.r; const wt = p.n / (p.n + params.k); const sbar = p.sn ? p.ss / p.sn : i + 1; return wt * p.r + (1 - wt) * (teamMean(tid) + (2.5 - sbar) * params.step); };
        const rA = (eff(pa[0], f.teamA) + eff(pa[1], f.teamA)) / 2, rB = (eff(pb[0], f.teamB) + eff(pb[1], f.teamB)) / 2;
        out.push({ fx: league.id + f.id, p: Math.min(0.97, Math.max(0.03, E(rA, rB))), y });
        const eA = E((get(pa[0]).r + get(pa[1]).r) / 2, (get(pb[0]).r + get(pb[1]).r) / 2);
        [[pa, y, eA], [pb, 1 - y, 1 - eA]].forEach(([pair, act, exp]) => pair.forEach((id) => { const q = get(id); const K = q.n < 5 ? 40 : 20; q.r += Math.round(K * (act - exp)); q.n++; q.ss += i + 1; q.sn++; }));
      });
    });
  });
  return out;
}
const loss = (x) => -(x.y * Math.log(x.p) + (1 - x.y) * Math.log(1 - x.p));
const mean = (pr, idx) => idx.reduce((s, i) => s + loss(pr[i]), 0) / idx.length;
const quant = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];

(async () => {
  const index = await getJson("/api/leagues");
  const leagues = [];
  for (const l of index) {
    const d = await getJson("/api/leagues/" + l.id);
    if (d.format === "teams" && (d.fixtures || []).some((f) => f.finalized)) leagues.push(d);
  }
  const current = { k: logic.SEED_BLEND_K, step: logic.SEED_PRIOR_STEP };
  const base = predictions(leagues, { k: 0, step: 0 });
  const blend = predictions(leagues, current);
  const N = base.length;
  if (N < 20) { console.log("Only " + N + " finished matches so far — too few to say anything."); return; }
  const fxs = [...new Set(base.map((x) => x.fx))];
  const byFx = new Map(fxs.map((f) => [f, []])); base.forEach((x, i) => byFx.get(x.fx).push(i));
  const all = [...Array(N).keys()];
  const acc = (pr, idx) => idx.reduce((s, i) => s + ((pr[i].p > 0.5) === (pr[i].y === 1) ? 1 : 0), 0) / idx.length;
  console.log(`${N} finished matches over ${fxs.length} match nights in ${leagues.length} leagues (${SITE})\n`);
  console.log(`Plain Elo:                 log-loss ${mean(base, all).toFixed(4)}   picks the winner ${(100 * acc(base, all)).toFixed(0)}%`);
  console.log(`Elo + seeding (k=${current.k}, ${current.step}/seed): log-loss ${mean(blend, all).toFixed(4)}   picks the winner ${(100 * acc(blend, all)).toFixed(0)}%      (coin flip: 0.6931 / 50%; lower log-loss is better)\n`);
  // Alternatives, and how often each would win the fit if the season had gone a little differently.
  const grid = [];
  [3, 6, 12, 20, 40].forEach((k) => [80, 120, 160, 200, 240].forEach((step) => grid.push({ k, step, pr: predictions(leagues, { k, step }) })));
  const best = grid.map((g) => ({ k: g.k, step: g.step, ll: mean(g.pr, all) })).sort((a, b) => a.ll - b.ll)[0];
  console.log(`Best settings on all results: k=${best.k}, step=${best.step} (log-loss ${best.ll.toFixed(4)}).`);
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const wins = {}; const gains = []; const hit = [];
  for (let b = 0; b < 1000; b++) {
    const idx = []; for (let j = 0; j < fxs.length; j++) idx.push(...byFx.get(fxs[Math.floor(rnd() * fxs.length)]));
    let bg = null, bl = 1e9; grid.forEach((g) => { const l = mean(g.pr, idx); if (l < bl) { bl = l; bg = g; } });
    const key = `k=${bg.k}, step=${bg.step}`; wins[key] = (wins[key] || 0) + 1;
    gains.push(mean(base, idx) - mean(blend, idx)); hit.push(acc(blend, idx));
  }
  console.log("Settings that come out best across 1000 resamples of match nights:");
  Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([k, v]) => console.log(`  ${k}: ${(v / 10).toFixed(0)}%`));
  console.log(`\nMargin of error (95%):`);
  console.log(`  improvement over plain Elo (log-loss): ${quant(gains, .5).toFixed(4)}  (range ${quant(gains, .025).toFixed(4)} to ${quant(gains, .975).toFixed(4)}); better in ${(gains.filter((g) => g > 0).length / 10).toFixed(0)}% of resamples`);
  console.log(`  picks the winner: ${(100 * quant(hit, .5)).toFixed(0)}%  (range ${(100 * quant(hit, .025)).toFixed(0)}-${(100 * quant(hit, .975)).toFixed(0)}%)`);
  console.log("\nWhen the favourite is given X%, how often they really won (95% margin):");
  const fav = blend.map((x) => (x.p >= 0.5 ? { p: x.p, y: x.y } : { p: 1 - x.p, y: 1 - x.y }));
  [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].forEach(([a, b]) => {
    const s = fav.filter((x) => x.p >= a && x.p < b); if (!s.length) return;
    const n = s.length, w = s.reduce((t, x) => t + x.y, 0) / n, said = s.reduce((t, x) => t + x.p, 0) / n;
    console.log(`  said ~${(said * 100).toFixed(0)}%: ${n} matches, won ${(w * 100).toFixed(0)}% ± ${(196 * Math.sqrt(w * (1 - w) / n)).toFixed(0)}`);
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
