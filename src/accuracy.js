// Keeps an eye on how good the match predictions actually are, by itself.
//
// Every so often the server replays every finished match in date order, asks
// "what would each model have said using only what came before?", and
// compares that with what really happened: plain Elo against the Elo + seeding
// blend the app uses (logic.blendedStrength). It then resamples whole match
// nights to work out how much of that could just be luck — the margin of
// error — and saves a snapshot, so the Admin tab can show how accuracy and
// confidence change as the season goes on.
//
// The number crunching runs on a worker thread (this same file), so a few
// seconds of resampling never holds up anyone using the site. Nothing here
// changes the model: it reports; changing SEED_BLEND_K / SEED_PRIOR_STEP in
// logic.js stays a person's decision.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const logic = require("./logic");

const E = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
const clamp = (p) => Math.min(0.97, Math.max(0.03, p));

// Only what the replay reads, so a league's logos and kit photos don't get
// copied across to the worker.
function trimLeague(l) {
  return {
    id: l.id, format: l.format, createdAt: l.createdAt, schedule: l.schedule || {},
    teams: (l.teams || []).map((t) => ({ id: t.id, players: (t.players || []).map((p) => ({ id: p.id })) })),
    fixtures: l.fixtures || [],
    playoffs: l.playoffs,
    seasonHistory: (l.seasonHistory || []).map(trimLeague),
  };
}
function trimLeagues(leagues) {
  return leagues.filter((l) => l.format !== "pairs" && logic.allFixturesOf(l).some((f) => f.finalized)).map(trimLeague);
}

// Every decided match, in order, with what each model would have said.
function replay(leagues, params) {
  const out = [];
  leagues.forEach((league) => {
    const P = new Map();
    const get = (id) => { if (!P.has(id)) P.set(id, { r: 1500, n: 0, ss: 0, sn: 0 }); return P.get(id); };
    const teamMean = (tid) => { const t = league.teams.find((x) => x.id === tid); return t && t.players.length ? t.players.reduce((s, p) => s + get(p.id).r, 0) / t.players.length : 1500; };
    logic.allRatableFixtures([league]).forEach(({ f }) => {
      (f.selectionA.pairs || []).forEach((pa, i) => {
        const pb = (f.selectionB.pairs || [])[i]; const r = f.rubbers[i];
        if (!pa || !pb || pa.some((x) => !x) || pb.some((x) => !x) || !r || r.forfeited) return;
        const w = logic.rubberWinner(r); if (!w) return;
        const y = w === "A" ? 1 : 0;
        const eff = (id, tid) => {
          const p = get(id); if (params.k === 0) return p.r;
          const wt = p.n / (p.n + params.k); const sbar = p.sn ? p.ss / p.sn : i + 1;
          return wt * p.r + (1 - wt) * (teamMean(tid) + (2.5 - sbar) * params.step);
        };
        const rA = (eff(pa[0], f.teamA) + eff(pa[1], f.teamA)) / 2, rB = (eff(pb[0], f.teamB) + eff(pb[1], f.teamB)) / 2;
        out.push({ fx: league.id + ":" + f.id, p: clamp(E(rA, rB)), y });
        const eA = E((get(pa[0]).r + get(pa[1]).r) / 2, (get(pb[0]).r + get(pb[1]).r) / 2);
        [[pa, y, eA], [pb, 1 - y, 1 - eA]].forEach(([pair, act, exp]) => pair.forEach((id) => {
          const q = get(id); const K = q.n < logic.ELO_PROVISIONAL_GAMES ? 40 : 20;
          q.r += Math.round(K * (act - exp)); q.n++; q.ss += i + 1; q.sn++;
        }));
      });
    });
  });
  return out;
}
const loss = (x) => -(x.y * Math.log(x.p) + (1 - x.y) * Math.log(1 - x.p));
const meanLoss = (pr, idx) => idx.reduce((s, i) => s + loss(pr[i]), 0) / idx.length;
const hitRate = (pr, idx) => idx.reduce((s, i) => s + ((pr[i].p > 0.5) === (pr[i].y === 1) ? 1 : 0), 0) / idx.length;
const quant = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];

const MIN_MATCHES = 30;
function computeReport(leagues) {
  const current = { k: logic.SEED_BLEND_K, step: logic.SEED_PRIOR_STEP };
  const base = replay(leagues, { k: 0, step: 0 });
  const N = base.length;
  if (N < MIN_MATCHES) return { generatedAt: Date.now(), n: N, tooFew: true, minMatches: MIN_MATCHES };
  const blend = replay(leagues, current);
  const fxs = [...new Set(base.map((x) => x.fx))];
  const byFx = new Map(fxs.map((f) => [f, []])); base.forEach((x, i) => byFx.get(x.fx).push(i));
  const all = [...Array(N).keys()];
  const grid = [];
  [3, 6, 12, 20, 40].forEach((k) => [80, 120, 160, 200, 240].forEach((step) => grid.push({ k, step, pr: replay(leagues, { k, step }) })));
  const best = grid.map((g) => ({ k: g.k, step: g.step, ll: meanLoss(g.pr, all) })).sort((a, b) => a.ll - b.ll)[0];
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const B = 400; const wins = {}; const gains = []; const hits = []; let currentBestCount = 0;
  for (let b = 0; b < B; b++) {
    const idx = []; for (let j = 0; j < fxs.length; j++) idx.push(...byFx.get(fxs[Math.floor(rnd() * fxs.length)]));
    let bg = null, bl = 1e9; grid.forEach((g) => { const l = meanLoss(g.pr, idx); if (l < bl) { bl = l; bg = g; } });
    wins[bg.k + "/" + bg.step] = (wins[bg.k + "/" + bg.step] || 0) + 1;
    if (bg.k === current.k && bg.step === current.step) currentBestCount++;
    gains.push(meanLoss(base, idx) - meanLoss(blend, idx)); hits.push(hitRate(blend, idx));
  }
  const fav = blend.map((x) => (x.p >= 0.5 ? { p: x.p, y: x.y } : { p: 1 - x.p, y: 1 - x.y }));
  const bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([a, b]) => {
    const s = fav.filter((x) => x.p >= a && x.p < b); if (!s.length) return null;
    const n = s.length, won = s.reduce((t, x) => t + x.y, 0) / n, said = s.reduce((t, x) => t + x.p, 0) / n;
    return { said: Math.round(said * 100), n, won: Math.round(won * 100), margin: Math.round(196 * Math.sqrt(won * (1 - won) / n)) };
  }).filter(Boolean);
  const topSettings = Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, v]) => { const [k, step] = key.split("/").map(Number); return { k, step, share: Math.round((v / B) * 100) }; });
  return {
    generatedAt: Date.now(), n: N, nights: fxs.length, leagues: leagues.length, current,
    plain: { logloss: meanLoss(base, all), hit: hitRate(base, all) },
    blend: { logloss: meanLoss(blend, all), hit: hitRate(blend, all), hitLo: quant(hits, 0.025), hitHi: quant(hits, 0.975) },
    improvement: { median: quant(gains, 0.5), lo: quant(gains, 0.025), hi: quant(gains, 0.975), betterShare: Math.round((100 * gains.filter((g) => g > 0).length) / B) },
    best: { k: best.k, step: best.step }, currentBestShare: Math.round((100 * currentBestCount) / B),
    topSettings, bands,
  };
}

// ---- worker side ----
if (!isMainThread && workerData && workerData.leagues) {
  try { parentPort.postMessage({ ok: true, report: computeReport(workerData.leagues) }); }
  catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
}

// ---- main-thread side ----
function runInWorker(leagues) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { leagues } });
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    w.on("message", (m) => (m.ok ? finish(resolve, m.report) : finish(reject, new Error(m.error))));
    w.on("error", (e) => finish(reject, e));
    w.on("exit", (code) => finish(reject, new Error("accuracy worker exited with code " + code)));
    setTimeout(() => { w.terminate(); finish(reject, new Error("accuracy check took too long")); }, 120000).unref();
  });
}
function finishedMatchCount(leagues) {
  return leagues.reduce((n, l) => n + logic.allRatableFixtures([l]).reduce((m, { f }) => m + (f.rubbers || []).filter((r, i) => r && !r.forfeited && logic.rubberWinner(r) && f.selectionA.pairs && f.selectionA.pairs[i] && f.selectionB.pairs && f.selectionB.pairs[i]).length, 0), 0);
}

const HISTORY_LIMIT = 400;
const DAY = 24 * 60 * 60 * 1000;
let running = null;
// Recomputes and saves a snapshot. `force` skips the "nothing new" shortcut.
// Never throws: a failed check just leaves the last snapshot as it was.
function refresh(store, opts) {
  if (running) return running;
  // `running` is set from outside the async function on purpose: a check that
  // finishes without awaiting anything (nothing new to do) would otherwise
  // clear the flag before it was set, and leave it stuck on.
  const p = doRefresh(store, opts || {});
  running = p;
  p.finally(() => { if (running === p) running = null; });
  return p;
}
async function doRefresh(store, { force = false }) {
  try {
    const saved = store.getPredictionAccuracy();
    const leagues = store.getIndex().map((e) => store.getLeague(e.id)).filter(Boolean);
    const trimmed = trimLeagues(leagues);
    const matches = finishedMatchCount(trimmed);
    const latest = saved.latest;
    if (!force && latest && latest.n === matches && Date.now() - latest.generatedAt < 7 * DAY) return latest;
    // The whole check takes a fraction of a second on today's data, so if a
    // host ever refuses to start a worker thread it just runs right here.
    let report;
    try { report = await runInWorker(trimmed); }
    catch (e) { console.error("Accuracy worker unavailable, running inline:", e.message); report = computeReport(trimmed); }
    const next = { latest: report, history: saved.history.slice() };
    // At most one history point per day, replaced if the same day is re-run.
    const today = new Date(report.generatedAt).toISOString().slice(0, 10);
    const point = report.tooFew ? null : { date: today, n: report.n, nights: report.nights, hit: report.blend.hit, hitLo: report.blend.hitLo, hitHi: report.blend.hitHi, plainHit: report.plain.hit, logloss: report.blend.logloss, plainLogloss: report.plain.logloss };
    if (point) {
      const last = next.history[next.history.length - 1];
      if (last && last.date === today) next.history[next.history.length - 1] = point; else next.history.push(point);
      if (next.history.length > HISTORY_LIMIT) next.history = next.history.slice(-HISTORY_LIMIT);
    }
    store.savePredictionAccuracy(next);
    return report;
  } catch (e) {
    console.error("Prediction accuracy check failed:", e.message);
    return null;
  }
}
function isRunning() { return !!running; }

// Runs a minute after start-up (so a redeploy gets a fresh look without
// slowing boot) and then every six hours; each run does nothing unless there
// are new results or the last snapshot is a week old.
function start(store) {
  setTimeout(() => refresh(store), 60 * 1000).unref();
  setInterval(() => refresh(store), 6 * 60 * 60 * 1000).unref();
}

module.exports = { computeReport, trimLeagues, refresh, isRunning, start, finishedMatchCount };
