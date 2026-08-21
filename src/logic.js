const crypto = require("crypto");

function uid() {
  return crypto.randomUUID();
}

function emptyRubber() {
  return { sets: [[null, null], [null, null]], tb: [null, null] };
}
function emptySelection() {
  return { submitted: false, pairs: [[null, null], [null, null], [null, null], [null, null]] };
}
function emptyFixtureExtras() {
  return {
    date: "",
    venue: "",
    selectionA: emptySelection(),
    selectionB: emptySelection(),
    rubbers: [emptyRubber(), emptyRubber(), emptyRubber(), emptyRubber()],
    finalized: false,
    slotOrder: null, // once agreed: [seedIndex, seedIndex, seedIndex, seedIndex] = play order for the night
    courtOrderProposal: null, // { by: 'A'|'B', assignments: [{slot,court,seed}] } awaiting the other captain's response
    selectionUnlockRequest: null, // { by: 'A'|'B' } — that side asked to reopen their own (already-submitted) line-up, awaiting the other captain's (or admin's) approval
  };
}

function generateRoundRobin(teams, doubleRound) {
  let list = teams.map((t) => t.id);
  const hasBye = list.length % 2 !== 0;
  if (hasBye) list.push("BYE");
  const n = list.length;
  const rounds = n - 1;
  const half = n / 2;
  let arr = list.slice();
  const fixtures = [];
  const byes = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a !== "BYE" && b !== "BYE") {
        fixtures.push(Object.assign({ id: uid(), round: r + 1, stage: "regular", teamA: a, teamB: b }, emptyFixtureExtras()));
      } else if (a === "BYE") {
        byes.push({ round: r + 1, teamId: b });
      } else if (b === "BYE") {
        byes.push({ round: r + 1, teamId: a });
      }
    }
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed].concat(rest);
  }
  if (doubleRound) {
    const second = fixtures.map((f) =>
      Object.assign({ id: uid(), round: f.round + rounds, stage: "regular", teamA: f.teamB, teamB: f.teamA }, emptyFixtureExtras())
    );
    fixtures.push(...second);
    byes.push(...byes.map((b) => ({ round: b.round + rounds, teamId: b.teamId })));
  }
  return { fixtures, byes };
}

function makeKnockoutFixture(stage, teamA, teamB) {
  const f = Object.assign({ id: uid(), round: 0, stage, teamA, teamB }, emptyFixtureExtras());
  f.rubbers.push(emptyRubber());
  return f;
}

function isValidSet(a, b) {
  if (a === null || b === null || a === "" || b === "" || a === undefined || b === undefined) return null;
  const av = Number(a), bv = Number(b);
  if (isNaN(av) || isNaN(bv)) return false;
  const hi = Math.max(av, bv), lo = Math.min(av, bv);
  if (hi === 6 && lo <= 4) return true;
  if (hi === 7 && (lo === 5 || lo === 6)) return true;
  return false;
}
function setWinner(set) {
  const [a, b] = set;
  if (a === null || b === null || a === "" || b === "") return null;
  const av = Number(a), bv = Number(b);
  if (av > bv) return "A";
  if (bv > av) return "B";
  return null;
}
function tiebreakWinner(tb) {
  const [a, b] = tb;
  if (a === null || b === null || a === "" || b === "") return null;
  const av = Number(a), bv = Number(b);
  if (av === bv) return null;
  if (Math.max(av, bv) < 10) return null;
  if (Math.abs(av - bv) < 2) return null;
  return av > bv ? "A" : "B";
}
function rubberWinner(rubber) {
  const s1 = setWinner(rubber.sets[0]);
  const s2 = setWinner(rubber.sets[1]);
  if (!s1 || !s2) return null;
  if (s1 === s2) return s1;
  return tiebreakWinner(rubber.tb);
}
function needsTiebreak(rubber) {
  const s1 = setWinner(rubber.sets[0]);
  const s2 = setWinner(rubber.sets[1]);
  return !!(s1 && s2 && s1 !== s2);
}
function fixtureScore(f) {
  let winsA = 0, winsB = 0, decided = 0;
  f.rubbers.slice(0, 4).forEach((r) => {
    const w = rubberWinner(r);
    if (w) {
      decided++;
      if (w === "A") winsA++;
      else winsB++;
    }
  });
  return { winsA, winsB, decided };
}
function requiredRubbersOk(f) {
  const { winsA, winsB, decided } = fixtureScore(f);
  if (decided < 4) return false;
  if (f.rubbers.length > 4 && winsA === winsB) return rubberWinner(f.rubbers[4]) !== null;
  return true;
}
function matchWinner(f) {
  const { winsA, winsB } = fixtureScore(f);
  if (winsA > winsB) return "A";
  if (winsB > winsA) return "B";
  if (f.rubbers.length > 4) return rubberWinner(f.rubbers[4]);
  return null;
}

// Admin-added rounds can be marked "knockout" (a decider, not part of the
// table) rather than "table" — round-robin rounds have no roundMeta entry
// at all and always count.
function roundCountsToTable(league, round) {
  const meta = league.roundMeta && league.roundMeta[round];
  return !meta || meta.type !== "knockout";
}

function computeStandings(league) {
  const rows = league.teams.map((t) => {
    let played = 0, nightsWon = 0, nightsDrawn = 0, nightsLost = 0, rubbersWon = 0, rubbersLost = 0;
    league.fixtures
      .filter((f) => f.finalized && (f.teamA === t.id || f.teamB === t.id) && roundCountsToTable(league, f.round))
      .forEach((f) => {
        const isA = f.teamA === t.id;
        const { winsA, winsB } = fixtureScore(f);
        const myWins = isA ? winsA : winsB, oppWins = isA ? winsB : winsA;
        played++;
        rubbersWon += myWins;
        rubbersLost += oppWins;
        if (myWins > oppWins) nightsWon++;
        else if (myWins < oppWins) nightsLost++;
        else nightsDrawn++;
      });
    return {
      id: t.id,
      name: t.name,
      logo: t.logo,
      played,
      nightsWon,
      nightsDrawn,
      nightsLost,
      rubbersWon,
      rubbersLost,
      diff: rubbersWon - rubbersLost,
      points: rubbersWon,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.diff - a.diff || a.name.localeCompare(b.name));
  return rows;
}

// A player can never be paired with themselves. A double-up (playing more
// than one rubber in the same night) is allowed, but only if the caller
// explicitly confirms it — otherwise we flag it and ask first.
function validateSelection(pairs, confirmDoubleUp) {
  const seen = new Set();
  let doubleUp = false;
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    if (!a || !b) return { error: "All 4 seeds need two players selected." };
    if (a === b) return { error: "A player can't be paired with themselves (seed " + (i + 1) + ")." };
    if (seen.has(a) || seen.has(b)) doubleUp = true;
    seen.add(a);
    seen.add(b);
  }
  if (doubleUp && !confirmDoubleUp) {
    return { error: "A player appears more than once tonight — confirm the double-up to submit.", needsConfirm: true };
  }
  return null;
}

function allFixturesOf(league) {
  if (!league.playoffs) return league.fixtures.slice();
  if (league.playoffs.format === "position") return league.fixtures.concat(league.playoffs.matches || []);
  return league.fixtures.concat([league.playoffs.semis[0], league.playoffs.semis[1], league.playoffs.final]);
}
function stageLabel(league, f) {
  if (f.stage === "semi") return "Semi finals";
  if (f.stage === "final") return "Final";
  if (f.stage === "position") return "Final spot playoff";
  const meta = league.roundMeta && league.roundMeta[f.round];
  return (meta && meta.label) || "Round " + f.round;
}

function playerMatchHistory(league, playerId) {
  const team = league.teams.find((t) => t.players.some((p) => p.id === playerId));
  if (!team) return [];
  const rows = [];
  allFixturesOf(league).forEach((f) => {
    if (!f.finalized || (f.teamA !== team.id && f.teamB !== team.id)) return;
    const mySide = f.teamA === team.id ? "A" : "B";
    const mySel = mySide === "A" ? f.selectionA : f.selectionB;
    const oppSel = mySide === "A" ? f.selectionB : f.selectionA;
    const oppTeam = league.teams.find((t) => t.id === (mySide === "A" ? f.teamB : f.teamA));
    mySel.pairs.forEach((pair, idx) => {
      if (!pair.includes(playerId)) return;
      const partnerId = pair[0] === playerId ? pair[1] : pair[0];
      const partner = team.players.find((p) => p.id === partnerId);
      const oppPair = oppSel.pairs[idx] || [null, null];
      const oppNames = oppPair.map((pid) => { const p = oppTeam && oppTeam.players.find((x) => x.id === pid); return p ? p.name : null; }).filter(Boolean);
      const rubber = f.rubbers[idx];
      const winner = rubberWinner(rubber);
      if (!winner) return;
      const setsStr = rubber.sets.map((s) => (s[0] ?? "?") + "-" + (s[1] ?? "?")).join(", ");
      rows.push({
        label: stageLabel(league, f),
        opponentTeam: oppTeam ? oppTeam.name : "?",
        opponentPlayers: oppNames,
        partner: partner ? partner.name : null,
        result: winner === mySide ? "W" : "L",
        score: setsStr,
      });
    });
  });
  return rows;
}

function teamTiebreakStats(league) {
  return league.teams
    .map((t) => {
      let played = 0, won = 0;
      allFixturesOf(league).forEach((f) => {
        if (!f.finalized || (f.teamA !== t.id && f.teamB !== t.id)) return;
        const mySide = f.teamA === t.id ? "A" : "B";
        f.rubbers.forEach((r) => {
          const s1 = setWinner(r.sets[0]), s2 = setWinner(r.sets[1]);
          if (s1 && s2 && s1 !== s2) {
            const w = tiebreakWinner(r.tb);
            if (!w) return;
            played++;
            if (w === mySide) won++;
          }
        });
      });
      return { name: t.name, played, won, lost: played - won, winPct: played ? Math.round((won / played) * 100) : 0 };
    })
    .filter((r) => r.played > 0)
    .sort((a, b) => b.winPct - a.winPct || b.played - a.played);
}

function topScorers(league, limit) {
  const rows = [];
  league.teams.forEach((t) => {
    t.players.forEach((p) => {
      const hist = playerMatchHistory(league, p.id);
      if (hist.length === 0) return;
      const wins = hist.filter((h) => h.result === "W").length;
      rows.push({ id: p.id, name: p.name, team: t.name, played: hist.length, wins, losses: hist.length - wins });
    });
  });
  rows.sort((a, b) => b.wins - a.wins || b.wins / b.played - a.wins / a.played);
  return rows.slice(0, limit || 5);
}

function bestPartnerships(league, minMatches, limit) {
  const map = {};
  league.teams.forEach((t) => {
    allFixturesOf(league).forEach((f) => {
      if (!f.finalized) return;
      const mySide = f.teamA === t.id ? "A" : f.teamB === t.id ? "B" : null;
      if (!mySide) return;
      const sel = mySide === "A" ? f.selectionA : f.selectionB;
      sel.pairs.forEach((pair, idx) => {
        if (!pair[0] || !pair[1]) return;
        const key = t.id + ":" + [pair[0], pair[1]].sort().join(",");
        const winner = rubberWinner(f.rubbers[idx]);
        if (!winner) return;
        if (!map[key]) {
          const p1 = t.players.find((p) => p.id === pair[0]);
          const p2 = t.players.find((p) => p.id === pair[1]);
          map[key] = { team: t.name, names: [p1 ? p1.name : "?", p2 ? p2.name : "?"], played: 0, won: 0 };
        }
        map[key].played++;
        if (winner === mySide) map[key].won++;
      });
    });
  });
  const rows = Object.values(map).filter((r) => r.played >= (minMatches || 2));
  rows.sort((a, b) => b.won / b.played - a.won / a.played || b.played - a.played);
  return rows.slice(0, limit || 5);
}

function winStreaks(league) {
  return league.teams
    .map((t) => {
      const finals = league.fixtures.filter((f) => f.finalized && (f.teamA === t.id || f.teamB === t.id)).sort((a, b) => a.round - b.round);
      let streak = 0, best = 0;
      finals.forEach((f) => {
        const isA = f.teamA === t.id;
        const { winsA, winsB } = fixtureScore(f);
        const myWins = isA ? winsA : winsB, oppWins = isA ? winsB : winsA;
        if (myWins > oppWins) { streak++; best = Math.max(best, streak); } else { streak = 0; }
      });
      return { name: t.name, streak: best };
    })
    .filter((x) => x.streak >= 2)
    .sort((a, b) => b.streak - a.streak);
}

// A "night" is every fixture sharing the same round (regular season) or the
// same knockout stage (semis/final/position playoffs) — teams play all of
// those together on one night. A night counts as played once every fixture
// in it is finalized.
function nightsPlayed(league) {
  const groups = {};
  allFixturesOf(league).forEach((f) => {
    const key = f.stage === "regular" ? "r" + f.round : f.stage;
    (groups[key] || (groups[key] = [])).push(f);
  });
  return Object.values(groups).filter((g) => g.every((f) => f.finalized)).length;
}

function computeLeagueStats(league) {
  const allF = allFixturesOf(league);
  const finalized = allF.filter((f) => f.finalized);
  let totalRubbers = 0, totalTiebreaks = 0;
  finalized.forEach((f) => {
    f.rubbers.forEach((r) => {
      if (rubberWinner(r)) totalRubbers++;
      const s1 = setWinner(r.sets[0]), s2 = setWinner(r.sets[1]);
      if (s1 && s2 && s1 !== s2 && tiebreakWinner(r.tb)) totalTiebreaks++;
    });
  });
  return {
    totals: {
      teams: league.teams.length,
      players: league.teams.reduce((sum, t) => sum + t.players.length, 0),
      nightsPlayed: nightsPlayed(league),
      totalRubbers,
      totalTiebreaks,
    },
    tiebreaks: teamTiebreakStats(league),
    topScorers: topScorers(league, 5),
    partnerships: bestPartnerships(league, 2, 5),
    streaks: winStreaks(league),
  };
}

module.exports = {
  uid,
  emptyRubber,
  emptySelection,
  emptyFixtureExtras,
  generateRoundRobin,
  makeKnockoutFixture,
  isValidSet,
  setWinner,
  tiebreakWinner,
  rubberWinner,
  needsTiebreak,
  fixtureScore,
  requiredRubbersOk,
  matchWinner,
  computeStandings,
  validateSelection,
  playerMatchHistory,
  computeLeagueStats,
};
