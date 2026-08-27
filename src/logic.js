const crypto = require("crypto");

function uid() {
  return crypto.randomUUID();
}

// A team rubber is 2 sets plus a match tie-break decider if they split. A
// Vibora (pairs) rubber instead plays a real 3rd set to decide a split —
// tb is unused there but kept present so shared code doesn't need to guard
// its existence.
function emptyRubber(setCount) {
  const n = setCount || 2;
  return { sets: Array.from({ length: n }, () => [null, null]), tb: [null, null] };
}
// seedCount is 4 for a team fixture (4 sub-matches/seeds a night) and 1 for
// a Vibora (pairs) fixture — a pair IS the line-up, so there's only ever
// one match to play.
function emptySelection(seedCount) {
  const n = seedCount || 4;
  return { submitted: false, pairs: Array.from({ length: n }, () => [null, null]) };
}
function emptyFixtureExtras(seedCount) {
  const n = seedCount || 4;
  return {
    date: "",
    venue: "",
    selectionA: emptySelection(n),
    selectionB: emptySelection(n),
    rubbers: Array.from({ length: n }, () => emptyRubber(n === 1 ? 3 : 2)),
    finalized: false,
    slotOrder: null, // once agreed: [seedIndex, ...] = play order for the night (team leagues only)
    courtOrderProposal: null, // { by: 'A'|'B', assignments: [{slot,court,seed}] } awaiting the other captain's response
    selectionUnlockRequest: null, // { by: 'A'|'B' } — that side asked to reopen their own (already-submitted) line-up, awaiting the other captain's (or admin's) approval
  };
}

function generateRoundRobin(teams, doubleRound, seedCount) {
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
        fixtures.push(Object.assign({ id: uid(), round: r + 1, stage: "regular", teamA: a, teamB: b }, emptyFixtureExtras(seedCount)));
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
      Object.assign({ id: uid(), round: f.round + rounds, stage: "regular", teamA: f.teamB, teamB: f.teamA }, emptyFixtureExtras(seedCount))
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
  if (rubber.sets.length >= 3) {
    // Vibora (pairs): best of 3 real sets, first to 2 — no match tie-break.
    let winsA = 0, winsB = 0;
    rubber.sets.forEach((s) => {
      const w = setWinner(s);
      if (w === "A") winsA++;
      else if (w === "B") winsB++;
    });
    if (winsA >= 2) return "A";
    if (winsB >= 2) return "B";
    return null;
  }
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
// e.g. "6-3, 6-4" or "6-4, 3-6, [10-7]" for a team split needing a super
// tie-break, or "6-4, 3-6, 6-2" for a pairs 3rd set — mirrors the client's
// rubberScoreText in app.js exactly, since next-matches needs the same
// notation server-side.
// `flip` reorders each set (and the tiebreak) so side B's number comes
// first — sets are always stored as [A, B], so a player-specific history
// (which may be looking at this from side B) needs its own score to lead,
// or a line marked "W" would read with the smaller number first.
function rubberScoreText(rubber, flip) {
  const setText = (s) => {
    if (s[0] === null || s[0] === "" || s[1] === null || s[1] === "") return null;
    return flip ? s[1] + "-" + s[0] : s[0] + "-" + s[1];
  };
  const parts = rubber.sets.map(setText).filter(Boolean);
  if (rubber.sets.length < 3 && needsTiebreak(rubber) && tiebreakWinner(rubber.tb)) {
    const tb = setText(rubber.tb);
    if (tb) parts.push("[" + tb + "]");
  }
  return parts.join(", ");
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
function requiredRubbersOk(f, allowDraw) {
  const { winsA, winsB, decided } = fixtureScore(f);
  // Regulation is 4 rubbers for a team fixture, 1 for a pairs fixture — a
  // knockout decider (only ever appended to team fixtures) sits beyond that,
  // so this stays correct for both without needing the league's format here.
  const regulation = f.rubbers.length > 4 ? 4 : f.rubbers.length;
  if (decided < regulation) {
    // A Vibora (pairs) match that splits its first two sets is allowed to
    // stand as a draw instead of being forced to a decider — playing the
    // 3rd set is optional there, unlike a team fixture's knockout decider.
    // A half-entered 3rd set doesn't count as "left unplayed" — that's an
    // incomplete score, not a settled draw.
    if (allowDraw && f.rubbers.length === 1) {
      const r = f.rubbers[0];
      const s1 = setWinner(r.sets[0]), s2 = setWinner(r.sets[1]);
      const thirdUntouched = r.sets.length < 3 || (r.sets[2][0] === null && r.sets[2][1] === null);
      if (s1 && s2 && s1 !== s2 && thirdUntouched) return true;
    }
    return false;
  }
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
  const isPairs = league.format === "pairs";
  const rows = league.teams.map((t) => {
    let played = 0, nightsWon = 0, nightsDrawn = 0, nightsLost = 0, rubbersWon = 0, rubbersLost = 0;
    let setsWon = 0, setsLost = 0;
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
        // A pairs match is decided over real sets (2-0 vs 2-1 both count as
        // one win in the table), so the table's tiebreaker needs the actual
        // set score, not just "won this match or not".
        if (isPairs) {
          f.rubbers[0].sets.forEach((s) => {
            const w = setWinner(s);
            if (!w) return;
            if ((w === "A") === isA) setsWon++; else setsLost++;
          });
        }
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
      setsWon,
      setsLost,
      diff: isPairs ? setsWon - setsLost : rubbersWon - rubbersLost,
      // A Vibora league scores like a round-robin table: 2 points for a win,
      // 1 for a draw. A team league instead awards a point per rubber won —
      // there's no such thing as a drawn night once the knockout decider
      // forces a winner.
      points: isPairs ? nightsWon * 2 + nightsDrawn : rubbersWon,
    };
  });
  // Points first, then the tiebreaker (set difference for pairs, rubber
  // difference for team leagues), then name as a last-resort stable order.
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
    if (!a || !b) return { error: "Every seed needs two players selected." };
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
// The schedule (date/venue/time) is keyed by this same string on
// league.schedule — mirrors the client's stageKeyFor in app.js exactly.
function stageKeyFor(f) {
  if (f.stage === "semi") return "semis";
  if (f.stage === "final") return "final";
  if (f.stage === "position") return "positions";
  return "r" + f.round;
}
function stageLabel(league, f) {
  if (f.stage === "semi") return "Semi finals";
  if (f.stage === "final") return "Final";
  if (f.stage === "position") return "Final spot playoff";
  const meta = league.roundMeta && league.roundMeta[f.round];
  return (meta && meta.label) || "Round " + f.round;
}

// Pair of the week: every specific partnership that actually took the court
// that round — one per seed per side — is eligible, identified by fixture +
// side + seed (not just the two player IDs, since in theory the same two
// names could be paired up more than once across seeds/fixtures).
function potwEligiblePairs(league, round) {
  const pairs = [];
  league.fixtures.filter((f) => f.round === round).forEach((f) => {
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    [["A", teamA, f.selectionA], ["B", teamB, f.selectionB]].forEach(([side, team, selection]) => {
      if (!team || !selection || !selection.submitted) return;
      selection.pairs.forEach((pair, seed) => {
        const [p1id, p2id] = pair || [];
        const p1 = team.players.find((p) => p.id === p1id);
        const p2 = team.players.find((p) => p.id === p2id);
        if (!p1 || !p2) return;
        pairs.push({
          key: `${f.id}:${side}:${seed}`,
          fixtureId: f.id,
          side,
          seed,
          teamId: team.id,
          teamName: team.name,
          playerAId: p1.id,
          playerAName: p1.name,
          playerBId: p2.id,
          playerBName: p2.name,
        });
      });
    });
  });
  return pairs;
}
// Public tally + winner for a round — vote counts and the winner are shared
// with everyone (so the crown can show), but who voted for whom stays
// server-side only, to keep captains from feeling pressured either way.
function potwTallyForRound(league, round) {
  const votes = (league.potwVotes && league.potwVotes[round]) || {};
  const counts = {};
  Object.values(votes).forEach((key) => { counts[key] = (counts[key] || 0) + 1; });
  const eligible = potwEligiblePairs(league, round);
  const tally = Object.keys(counts)
    .map((key) => {
      const p = eligible.find((x) => x.key === key);
      return p ? { ...p, votes: counts[key] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.votes - a.votes);
  // A tie at the top goes to everyone tied, not just whichever pair
  // happened to sort first — no votes means no winners at all.
  const topVotes = tally.length ? tally[0].votes : 0;
  const winners = topVotes > 0 ? tally.filter((p) => p.votes === topVotes) : [];
  return { tally, winners };
}

// Every not-yet-finalized fixture this player is selected into, both sides
// submitted — the "upcoming" half of a player's profile, mirroring
// playerMatchHistory's "played" half below almost exactly.
function findPlayerUpcoming(league, playerId) {
  const rows = [];
  allFixturesOf(league).forEach((f) => {
    if (f.finalized || !f.teamA || !f.teamB) return;
    if (!(f.selectionA.submitted && f.selectionB.submitted)) return;
    const teamA = league.teams.find((t) => t.id === f.teamA);
    const teamB = league.teams.find((t) => t.id === f.teamB);
    if (!teamA || !teamB) return;
    [["A", teamA, f.selectionA, teamB, f.selectionB], ["B", teamB, f.selectionB, teamA, f.selectionA]].forEach(
      ([, team, selection, oppTeam, oppSelection]) => {
        selection.pairs.forEach((pair, idx) => {
          if (!pair.includes(playerId)) return;
          const partnerId = pair[0] === playerId ? pair[1] : pair[0];
          const partner = team.players.find((p) => p.id === partnerId);
          const oppPair = oppSelection.pairs[idx] || [null, null];
          const oppNames = oppPair.map((pid) => { const p = oppTeam.players.find((x) => x.id === pid); return p ? p.name : null; }).filter(Boolean);
          const sched = (league.schedule && league.schedule[stageKeyFor(f)]) || {};
          rows.push({
            label: stageLabel(league, f),
            opponentTeam: oppTeam.name,
            opponentLogo: oppTeam.logo || "",
            opponentPlayers: oppNames,
            partner: partner ? partner.name : null,
            seed: idx + 1,
            date: sched.date || "",
            time: sched.time || "",
            venue: sched.venue || league.defaultVenue || "",
          });
        });
      }
    );
  });
  return rows;
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
      // A finalized team-league rubber always has a winner (finalize
      // requires it). A finalized pairs match can stand as a draw instead
      // — the split sets are real, played data, so it still belongs here.
      const played = setWinner(rubber.sets[0]) && setWinner(rubber.sets[1]);
      if (!winner && !played) return;
      rows.push({
        label: stageLabel(league, f),
        opponentTeam: oppTeam ? oppTeam.name : "?",
        opponentPlayers: oppNames,
        partner: partner ? partner.name : null,
        result: winner === null ? "D" : winner === mySide ? "W" : "L",
        // rubberScoreText already handles the split-sets super-tiebreak
        // (and filters out a pairs match's unplayed 3rd set on a draw) —
        // this used to duplicate that logic inline and left the
        // tiebreak score out entirely. Flipped when this player is side B,
        // so their own score always leads — otherwise a "W" row could read
        // with the smaller (opponent's) number shown first.
        score: rubberScoreText(rubber, mySide === "B"),
        seed: idx + 1,
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
      const losses = hist.filter((h) => h.result === "L").length;
      const draws = hist.length - wins - losses;
      rows.push({ id: p.id, name: p.name, team: t.name, played: hist.length, wins, losses, draws });
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

// A lightweight view of the league scoped to one Vibora group. Every
// standings/stats function already just operates on "the league's teams and
// fixtures" — scoping to a group means handing them a copy with only that
// group's teams and fixtures, rather than threading a groupId through each
// of them individually. Playoffs are never used by a pairs league, so
// filtering league.fixtures alone is enough — no separate playoffs field to
// restrict.
function restrictToGroup(league, groupId) {
  if (!groupId) return league;
  return {
    ...league,
    teams: league.teams.filter((t) => t.groupId === groupId),
    fixtures: league.fixtures.filter((f) => f.groupId === groupId),
  };
}

function computeLeagueStats(league) {
  const allF = allFixturesOf(league);
  const finalized = allF.filter((f) => f.finalized);
  let totalRubbers = 0, totalTiebreaks = 0;
  finalized.forEach((f) => {
    f.rubbers.forEach((r) => {
      const s1 = setWinner(r.sets[0]), s2 = setWinner(r.sets[1]);
      // Both sets decided means the match was played, whether or not it
      // ended with an outright winner — a Vibora draw still counts.
      if (s1 && s2) totalRubbers++;
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
  rubberScoreText,
  fixtureScore,
  requiredRubbersOk,
  matchWinner,
  computeStandings,
  validateSelection,
  playerMatchHistory,
  findPlayerUpcoming,
  potwEligiblePairs,
  potwTallyForRound,
  computeLeagueStats,
  restrictToGroup,
  allFixturesOf,
  stageKeyFor,
};
