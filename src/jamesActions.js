// What James is allowed to change, and how each change is checked, applied and
// taken back.
//
// Every change goes through the same steps:
//   1. preview: tried on a COPY of the data, nothing saved, so the admin sees
//      exactly what would happen (or why it can't);
//   2. apply: when the admin confirms, the whole set is tried again on fresh
//      copies and only saved if every change in it works;
//   3. record: each applied set is written to James's log with what it takes to
//      undo it, and a line goes into each league's audit log;
//   4. undo: puts things back, but only if nothing has changed them since
//      (otherwise it refuses, so it can never wipe out newer work).
//
// The functions the app already uses for the same jobs (recording a payment,
// moving a player) are passed in, so James can't behave differently from the
// admin's own buttons.

module.exports = function createJamesActions(d) {
  const { store, logic } = d;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const err = (m) => Object.assign(new Error(m), { userFacing: true });
  const clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

  const fmt = (cents) => {
    const [whole, dec] = (Math.abs(cents) / 100).toFixed(2).split(".");
    return (cents < 0 ? "-" : "") + "R" + whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "." + dec;
  };
  const dayText = (date, time) => {
    if (!date) return "no date yet";
    const t = new Date(date + "T12:00:00Z");
    if (Number.isNaN(t.getTime())) return date;
    return t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) + (time ? " " + time : "");
  };

  // ---- working on copies --------------------------------------------------
  function makeCtx(dry, images, actor) {
    const leagues = new Map();
    const touched = new Set();
    const newLeagues = [];
    const removedLeagues = [];
    const deferred = [];
    let hub = null, hubTouched = false;
    return {
      dry, actor: actor || "Admin", images: images || [], leagues, touched, deferred, newLeagues, removedLeagues,
      league(id) {
        if (!leagues.has(id)) { const l = store.getLeague(id); leagues.set(id, l ? clone(l) : null); }
        return leagues.get(id);
      },
      touch(id) { touched.add(id); },
      hub() { if (!hub) hub = clone(store.getAdminHub()); return hub; },
      touchHub() { hubTouched = true; },
      commit() {
        touched.forEach((id) => { const l = leagues.get(id); if (l) store.saveLeague(id, l); });
        newLeagues.forEach((n) => {
          store.saveLeague(n.league.id, n.league);
          const index = store.getIndex(); index.push(n.entry); store.saveIndex(index);
        });
        removedLeagues.forEach((id) => {
          store.deleteLeague(id);
          store.saveIndex(store.getIndex().filter((e) => e.id !== id));
        });
        if (hubTouched) store.saveAdminHub(hub);
        deferred.forEach((fn) => fn());
      },
    };
  }

  function leagueFor(ctx, id, name) {
    let l = null;
    if (id) l = ctx.league(String(id));
    else if (name) {
      // A league made earlier in the same set, or one that already exists, found by name.
      const n = clip(name, 80).toLowerCase();
      const made = ctx.newLeagues.find((x) => x.league.name.toLowerCase() === n);
      if (made) l = made.league;
      else { const e = store.getIndex().find((x) => x.name.toLowerCase() === n); if (e) l = ctx.league(e.id); }
    }
    if (!l) throw err("I can't find that league.");
    if (d.hubExcludedLeague(l.name)) throw err(`${l.name} is outside the Note Machine, so James can't change it.`);
    return l;
  }
  const leagueRef = (ctx, ch) => leagueFor(ctx, ch.leagueId, ch.leagueName);
  const teamFor = (l, id) => l.teams.find((t) => t.id === id) || (() => { throw err(`I can't find that team in ${l.name}.`); })();
  const teamByName = (l, name) => {
    const n = clip(name, 60).toLowerCase();
    const t = n && l.teams.find((x) => x.name.toLowerCase() === n);
    if (!t) throw err(n ? `I can't find a team called ${clip(name, 60)} in ${l.name}.` : `Which team in ${l.name}?`);
    return t;
  };
  const playerFor = (t, id) => t.players.find((p) => p.id === id) || (() => { throw err(`I can't find that player on ${t.name}.`); })();
  const needFee = (l) => { if (!l.registrationFeeCents) throw err(`${l.name} has no fee set yet, so there's nothing to pay.`); };
  const rands = (v) => {
    const n = Number(v);
    if (v === "" || v == null || !Number.isFinite(n) || n < 0 || n > 100000) throw err("That amount doesn't look right.");
    return Math.round(n * 100);
  };

  // ---- payments -----------------------------------------------------------
  const PAY_TEAM = d.RESET_PAYMENT_FIELDS.concat(["discountCents", "discountNote"]);
  const PAY_PLAYER = d.RESET_PAYMENT_FIELDS.concat(["discountCents", "discountNote", "customShareCents"]);
  const pick = (o, fields) => { const r = {}; fields.forEach((k) => { if (o[k] !== undefined) r[k] = clone(o[k]); }); return r; };
  const paySnap = (t) => ({ team: pick(t, PAY_TEAM), players: t.players.map((p) => ({ id: p.id, f: pick(p, PAY_PLAYER) })) });
  const payKey = (t) => JSON.stringify(paySnap(t));
  function payRestore(t, snap) {
    PAY_TEAM.forEach((k) => { delete t[k]; });
    Object.assign(t, clone(snap.team));
    snap.players.forEach((sp) => {
      const p = t.players.find((x) => x.id === sp.id);
      if (!p) return;
      PAY_PLAYER.forEach((k) => { delete p[k]; });
      Object.assign(p, clone(sp.f));
    });
  }
  const payCheck = (ctx, c) => {
    const l = leagueFor(ctx, c.leagueId);
    const t = l.teams.find((x) => x.id === c.undo.teamId);
    if (!t || payKey(t) !== c.after) throw err(`${t ? t.name : "A team"}'s payments have changed since James made this change, so it can't be undone safely. Fix it by hand.`);
  };
  const payRevert = (ctx, c) => {
    const l = leagueFor(ctx, c.leagueId);
    payRestore(l.teams.find((x) => x.id === c.undo.teamId), c.undo.snap);
    ctx.touch(l.id);
  };
  const payResult = (l, t, before, text, extra) => ({ leagueId: l.id, leagueName: l.name, text, undo: { teamId: t.id, snap: before }, after: payKey(t), ...extra });
  const reconcileAll = (l, t) => { t.players.forEach((p) => d.reconcilePlayerStatus(l, t, p)); d.reconcileTeamPayment(l, t); };

  const payKinds = {
    pay_record: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId), p = playerFor(t, ch.playerId);
        const cents = rands(ch.amountRands);
        if (cents <= 0) throw err("Say how much was paid.");
        const owed = d.playerOwedCents(l, t, p);
        if (owed <= 0) throw err(`${p.name} doesn't owe anything.`);
        if (cents > owed) throw err(`${p.name} only owes ${fmt(owed)}, not ${fmt(cents)}.`);
        const before = paySnap(t);
        d.addPlayerPayment(l, t, p, cents, "manual", null, Date.now()); ctx.touch(l.id);
        return payResult(l, t, before, `Record ${fmt(cents)} paid by ${p.name} (${t.name}, ${l.name}). Still owed ${fmt(owed)} → ${fmt(owed - cents)}.`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_mark_player_paid: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId), p = playerFor(t, ch.playerId);
        if (p.paymentStatus === "paid") throw err(`${p.name} is already marked paid.`);
        const left = d.playerOwedCents(l, t, p);
        const before = paySnap(t);
        if (left > 0) d.addPlayerPayment(l, t, p, left, "manual", null, Date.now());
        else { p.paymentStatus = "paid"; d.reconcileTeamPayment(l, t); }
        ctx.touch(l.id);
        return payResult(l, t, before, `Mark ${p.name} as paid (${t.name}, ${l.name}). Records ${fmt(left)}.`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_team_record: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = ch.teamId ? teamFor(l, ch.teamId) : teamByName(l, ch.teamName);
        if (t.paymentStatus === "paid") throw err(`${t.name} has already paid in full.`);
        const cents = rands(ch.amountRands);
        if (cents <= 0) throw err("Say how much the team paid.");
        const owed = d.teamBalanceCents(l, t);
        if (cents > owed) throw err(`${t.name} only owes ${fmt(owed)}, not ${fmt(cents)}.`);
        const before = paySnap(t);
        const r = d.recordTeamPayment(l, t, cents, "manual", ctx.actor, clip(ch.note, 120) || null);
        ctx.touch(l.id);
        return payResult(l, t, before, r.settled ? `Record ${fmt(cents)} paid by the team ${t.name} (${l.name}). That settles the team fee, so ${t.name} is paid in full and its players are covered.` : `Record ${fmt(cents)} paid by the team ${t.name} (${l.name}), as a team payment. Still owed ${fmt(owed)} → ${fmt(owed - cents)}.`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_mark_team_paid: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId);
        if (t.paymentStatus === "paid") throw err(`${t.name} is already marked paid.`);
        const left = d.teamBalanceCents(l, t);
        const before = paySnap(t);
        t.paymentStatus = "paid"; t.paymentMethod = "manual"; t.paidAt = Date.now();
        d.coverTeamPlayers(t, "manual", null, t.paidAt);
        ctx.touch(l.id);
        return payResult(l, t, before, `Mark ${t.name} (${l.name}) as paid in full. Still owed ${fmt(left)} → R0.00.`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_discount_player: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId), p = playerFor(t, ch.playerId);
        const cents = rands(ch.amountRands);
        const base = d.playerBaseShareFor(l, t, p);
        if (cents > base) throw err(`A discount can't be more than ${p.name}'s share (${fmt(base)}).`);
        const before = paySnap(t), was = d.playerShareCents(l, t, p);
        if (cents) { p.discountCents = cents; p.discountNote = clip(ch.note, 120) || null; } else { delete p.discountCents; delete p.discountNote; }
        d.reconcilePlayerStatus(l, t, p); d.reconcileTeamPayment(l, t); ctx.touch(l.id);
        return payResult(l, t, before, cents ? `Discount ${p.name} (${t.name}, ${l.name}) by ${fmt(cents)}${p.discountNote ? " for " + p.discountNote : ""}. Their share ${fmt(was)} → ${fmt(d.playerShareCents(l, t, p))}.` : `Remove ${p.name}'s discount (${t.name}, ${l.name}).`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_discount_team: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId);
        const cents = rands(ch.amountRands);
        if (cents > l.registrationFeeCents) throw err(`A discount can't be more than the team fee (${fmt(l.registrationFeeCents)}).`);
        const before = paySnap(t), was = d.teamFeeCents(l, t);
        if (cents) { t.discountCents = cents; t.discountNote = clip(ch.note, 120) || null; } else { delete t.discountCents; delete t.discountNote; }
        reconcileAll(l, t); ctx.touch(l.id);
        return payResult(l, t, before, cents ? `Discount ${t.name} (${l.name}) by ${fmt(cents)}${t.discountNote ? " for " + t.discountNote : ""}. Team fee ${fmt(was)} → ${fmt(d.teamFeeCents(l, t))}.` : `Remove ${t.name}'s team discount (${l.name}).`);
      },
      check: payCheck, revert: payRevert,
    },
    pay_set_share: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); needFee(l);
        const t = teamFor(l, ch.teamId), p = playerFor(t, ch.playerId);
        const before = paySnap(t), was = d.playerShareCents(l, t, p), feeWas = d.teamFeeCents(l, t);
        const clear = ch.amountRands === null || ch.amountRands === undefined || ch.amountRands === "";
        if (clear) delete p.customShareCents; else p.customShareCents = rands(ch.amountRands);
        reconcileAll(l, t); ctx.touch(l.id);
        const now = d.playerShareCents(l, t, p), feeNow = d.teamFeeCents(l, t);
        const warnings = feeNow > feeWas + 1 ? [`The team now owes ${fmt(feeNow)}, more than before (${fmt(feeWas)}).`] : [];
        return payResult(l, t, before, clear ? `Put ${p.name} back on the even split (${t.name}, ${l.name}). Their share ${fmt(was)} → ${fmt(now)}.` : `${p.name} pays ${fmt(now)} (was ${fmt(was)}) on ${t.name}, ${l.name}. The others on the team split the rest.`, { warnings });
      },
      check: payCheck, revert: payRevert,
    },
  };

  // ---- fixtures -----------------------------------------------------------
  const roundKey = (l, round) => {
    if (["semis", "final", "positions"].includes(round)) return { key: round, label: { semis: "Semi finals", final: "The final", positions: "Position playoffs" }[round] };
    const n = Number(round);
    if (!Number.isInteger(n) || n < 1) throw err("Which round do you mean?");
    if (!l.fixtures.some((f) => f.round === n)) throw err(`${l.name} has no round ${n}.`);
    const played = l.fixtures.filter((f) => f.round === n && f.finalized).length;
    if (played) throw err(`Round ${n} in ${l.name} already has ${played} finished match${played === 1 ? "" : "es"}, so I won't move it.`);
    return { key: "r" + n, label: "Round " + n };
  };
  const schedDesc = (e) => (e && (e.date || e.time || e.venue) ? [dayText(e.date, e.time), e.venue].filter(Boolean).join(" · ") : "not set");
  const fixKinds = {
    fix_round_schedule: {
      label: "Schedule",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch);
        const { key, label } = roundKey(l, ch.round);
        if (ch.date === undefined && ch.time === undefined && ch.venue === undefined) throw err("Tell me the new date, time or venue.");
        const entry = { date: "", venue: "", time: "", ...(l.schedule && l.schedule[key] ? clone(l.schedule[key]) : {}) };
        const before = l.schedule && l.schedule[key] ? clone(l.schedule[key]) : null;
        const warnings = [];
        if (ch.date !== undefined) {
          if (ch.date !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(ch.date) || Number.isNaN(new Date(ch.date + "T12:00:00Z").getTime()))) throw err("That date doesn't look right.");
          entry.date = ch.date;
          if (ch.date && ch.date < new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10)) warnings.push("That date is in the past.");
        }
        if (ch.time !== undefined) {
          if (ch.time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(ch.time)) throw err("That time doesn't look right (use 24-hour, like 19:30).");
          entry.time = ch.time;
        }
        if (ch.venue !== undefined) entry.venue = clip(ch.venue, 120);
        if (!l.schedule) l.schedule = {};
        l.schedule[key] = entry; ctx.touch(l.id);
        return { leagueId: l.id, leagueName: l.name, warnings, text: `${l.name}, ${label}: ${schedDesc(before)} → ${schedDesc(entry)}.`, undo: { key, before }, after: JSON.stringify(entry) };
      },
      check(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        if (JSON.stringify((l.schedule || {})[c.undo.key]) !== c.after) throw err(`The schedule for ${l.name} has been changed since James moved it, so it can't be undone safely.`);
      },
      revert(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        if (!l.schedule) l.schedule = {};
        if (c.undo.before) l.schedule[c.undo.key] = clone(c.undo.before); else delete l.schedule[c.undo.key];
        ctx.touch(l.id);
      },
    },
  };

  // Every round on a weekly rhythm in one go: "Wednesdays from 4 Feb at 18:00".
  fixKinds.fix_weekly_schedule = {
    label: "Schedule",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ch.firstDate || "")) || Number.isNaN(new Date(ch.firstDate + "T12:00:00Z").getTime())) throw err("What date does round 1 start? (a day like 2026-02-04)");
      if (ch.time !== undefined && ch.time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(ch.time)) throw err("That time doesn't look right (use 24-hour, like 18:00).");
      const every = ch.everyDays === undefined ? 7 : Number(ch.everyDays);
      if (!Number.isInteger(every) || every < 1 || every > 31) throw err("Rounds can be 1 to 31 days apart.");
      const rounds = Array.from(new Set(l.fixtures.map((f) => f.round))).sort((a, b) => a - b);
      if (!rounds.length) throw err(`${l.name} has no rounds yet. The season has to be started first.`);
      const played = rounds.filter((n) => l.fixtures.some((f) => f.round === n && f.finalized));
      if (!l.schedule) l.schedule = {};
      const before = {}, set = [];
      rounds.forEach((n, i) => {
        if (played.includes(n)) return;
        const key = "r" + n;
        before[key] = l.schedule[key] ? clone(l.schedule[key]) : null;
        const dt = new Date(ch.firstDate + "T12:00:00Z"); dt.setUTCDate(dt.getUTCDate() + i * every);
        const date = dt.toISOString().slice(0, 10);
        const entry = { date: "", venue: "", time: "", ...(l.schedule[key] || {}), date };
        if (ch.time !== undefined) entry.time = ch.time;
        if (ch.venue !== undefined) entry.venue = clip(ch.venue, 120);
        l.schedule[key] = entry; set.push(key);
      });
      if (!set.length) throw err("Every round already has finished matches.");
      ctx.touch(l.id);
      const first = l.schedule[set[0]], last = l.schedule[set[set.length - 1]];
      const warnings = [];
      if (played.length) warnings.push(`Rounds ${played.join(", ")} already have finished matches, so they keep their dates.`);
      if (first.date < new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10)) warnings.push("The first date is in the past.");
      const day = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
      return { leagueId: l.id, leagueName: l.name, warnings, text: `${l.name}: ${set.length} round${set.length === 1 ? "" : "s"} every ${every === 7 ? "week" : every + " days"}, ${dayText(first.date)} to ${dayText(last.date)}${first.time ? " at " + first.time : ""}${first.venue ? ", " + first.venue : ""}. (Round 1 is a ${day(first.date)}.)`, undo: { before }, after: JSON.stringify(set.map((k) => l.schedule[k])) };
    },
    check(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      const now = Object.keys(c.undo.before).map((k) => l.schedule && l.schedule[k]);
      if (JSON.stringify(now) !== c.after) throw err(`${l.name}'s round dates have been changed since, so it can't be undone safely.`);
    },
    revert(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      Object.entries(c.undo.before).forEach(([k, v]) => { if (v) l.schedule[k] = clone(v); else delete l.schedule[k]; });
      ctx.touch(l.id);
    },
  };
  fixKinds.fix_match_schedule = {
    label: "Schedule",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch);
      const f = logic.allFixturesOf(l).find((x) => x && x.id === ch.fixtureId);
      if (!f) throw err("I can't find that match.");
      if (f.finalized) throw err("That match has already been played, so I won't move it.");
      const name = (id) => (l.teams.find((t) => t.id === id) || {}).name || "?";
      const label = `${name(f.teamA)} v ${name(f.teamB)}`;
      const before = f.scheduleOverride ? clone(f.scheduleOverride) : null;
      const was = logic.scheduleOf(l, f);
      const warnings = [];
      if (ch.clear === true || ch.clear === "true") {
        if (!before) throw err("That match isn't moved. It's on its round's schedule already.");
        delete f.scheduleOverride;
      } else {
        if (ch.date === undefined && ch.time === undefined && ch.venue === undefined) throw err("Tell me the new date, time or venue.");
        const o = { ...(before || {}) };
        if (ch.date !== undefined) {
          if (ch.date !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(ch.date) || Number.isNaN(new Date(ch.date + "T12:00:00Z").getTime()))) throw err("That date doesn't look right.");
          o.date = ch.date;
          if (ch.date && ch.date < new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10)) warnings.push("That date is in the past.");
        }
        if (ch.time !== undefined) {
          if (ch.time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(ch.time)) throw err("That time doesn't look right (use 24-hour, like 19:30).");
          o.time = ch.time;
        }
        if (ch.venue !== undefined) o.venue = clip(ch.venue, 120);
        Object.keys(o).forEach((k) => { if (!o[k]) delete o[k]; });
        if (Object.keys(o).length) f.scheduleOverride = o; else delete f.scheduleOverride;
      }
      const now = logic.scheduleOf(l, f);
      if (JSON.stringify(now) === JSON.stringify(was)) throw err("It's already like that.");
      ctx.touch(l.id);
      return { leagueId: l.id, leagueName: l.name, warnings, text: `${l.name}, ${f.round ? "Round " + f.round + ", " : ""}${label}: ${schedDesc(was)} → ${schedDesc(now)}. Only this match moves.`, undo: { fixtureId: f.id, before }, after: JSON.stringify(f.scheduleOverride || null) };
    },
    check(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
      if (f && JSON.stringify(f.scheduleOverride || null) !== c.after) throw err("That match has been moved again since, so it can't be undone safely.");
    },
    revert(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
      if (!f) return;
      if (c.undo.before) f.scheduleOverride = clone(c.undo.before); else delete f.scheduleOverride;
      ctx.touch(l.id);
    },
  };

  // ---- scores and Live Court Control --------------------------------------
  // Both work on one seed (one court's match) of a fixture, exactly as the admin's own
  // buttons do: the same functions finish a match, put it back, and tell the captains.
  function seedOf(ctx, ch) {
    const l = leagueRef(ctx, ch);
    const f = logic.allFixturesOf(l).find((x) => x && x.id === ch.fixtureId);
    if (!f) throw err("I can't find that match.");
    const idx = Number(ch.seed) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= f.rubbers.length) throw err(`That match has ${f.rubbers.length} seeds, so seed ${ch.seed} doesn't exist.`);
    if (!f.selectionA.submitted || !f.selectionB.submitted) throw err("Both line-ups have to be in first.");
    if (f.finalized) throw err("That fixture is finalized, so I won't change it. Unlock it first.");
    return { l, f, idx, r: f.rubbers[idx] };
  }
  const tname = (l, id) => (l.teams.find((t) => t.id === id) || {}).name || "?";
  function pairText(l, f, side, idx) {
    const t = l.teams.find((x) => x.id === (side === "A" ? f.teamA : f.teamB));
    const sel = side === "A" ? f.selectionA : f.selectionB;
    return ((sel.pairs && sel.pairs[idx]) || []).map((pid) => ((t && t.players.find((p) => p.id === pid)) || {}).name || "?").join(" & ");
  }
  const seedLabel = (l, f, idx) => `${l.name}, ${f.round ? "Round " + f.round + ", " : ""}${tname(l, f.teamA)} v ${tname(l, f.teamB)}, seed ${idx + 1} (${pairText(l, f, "A", idx)} v ${pairText(l, f, "B", idx)})`;
  const rubKey = (r) => JSON.stringify([r.sets, r.tb, r.startedAt || null, r.completedAt || null, r.forfeited || null, r.live || null, r.scoreBy || null, r.pace || null]);
  const rubSnap = (l, idx, f) => ({ rubber: clone(f.rubbers[idx]), stats: clone(l.courtDurationStats || {}), logLen: (l.courtMatchLog || []).length });
  const rubResult = (l, f, idx, snap, text, extra) => ({ leagueId: l.id, leagueName: l.name, text, undo: { fixtureId: f.id, idx, snap, afterLogLen: (l.courtMatchLog || []).length }, after: rubKey(f.rubbers[idx]), ...extra });
  const rubCheck = (ctx, c) => {
    const l = leagueFor(ctx, c.leagueId);
    const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
    if (!f) return;
    if (f.finalized) throw err("That fixture has been finalized since, so this can't be undone. Unlock it first.");
    if (rubKey(f.rubbers[c.undo.idx]) !== c.after) throw err("That match has been changed since James changed it, so it can't be undone safely.");
  };
  const rubRevert = (ctx, c) => {
    const l = leagueFor(ctx, c.leagueId);
    const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
    if (!f) return;
    const r = f.rubbers[c.undo.idx];
    Object.keys(r).forEach((k) => { delete r[k]; });
    Object.assign(r, clone(c.undo.snap.rubber));
    // The court timing data only goes back if no other match was finished in the meantime.
    if ((l.courtMatchLog || []).length === c.undo.afterLogLen) { if (l.courtMatchLog) l.courtMatchLog.length = c.undo.snap.logLen; l.courtDurationStats = clone(c.undo.snap.stats); }
    ctx.touch(l.id);
  };
  const gameNum = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 99) throw err("Games have to be whole numbers between 0 and 99.");
    return n;
  };
  const pairNums = (pr) => { if (!Array.isArray(pr) || pr.length !== 2) throw err("Each set needs two numbers, like 6 and 4."); return [gameNum(pr[0]), gameNum(pr[1])]; };
  // Sets as the rubber stores them: as many as it has, with anything not given left empty.
  function setsFor(r, given) {
    const out = r.sets.map(() => [null, null]);
    if (!Array.isArray(given)) return out;
    if (given.length > r.sets.length) throw err(r.sets.length === 0 ? "That seed is a single tie-break, so give the tie-break score (tb), not sets." : r.sets.length === 2 ? "A seed is two sets, and if they split one set each it goes to a match tie-break (tb, first to 10). There's no third set." : `That seed has ${r.sets.length} sets at most.`);
    given.forEach((pr, i) => { out[i] = pairNums(pr); });
    return out;
  }
  const plausibleSet = ([a, b]) => a === null || b === null || (Math.max(a, b) === 6 && Math.min(a, b) <= 4) || (Math.max(a, b) === 7 && (Math.min(a, b) === 5 || Math.min(a, b) === 6));
  const winnerName = (l, f, r) => { const w = logic.rubberWinner(r); return w === "A" ? tname(l, f.teamA) : w === "B" ? tname(l, f.teamB) : ""; };

  const scoreKinds = {
    score_set: {
      label: "Score",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        const sets = ch.sets !== undefined ? setsFor(r, ch.sets) : null;
        const tb = ch.tb !== undefined ? pairNums(ch.tb) : null;
        if (!sets && !tb) throw err("Tell me the score.");
        const before = { sets: clone(r.sets), tb: clone(r.tb) };
        const snap = rubSnap(l, idx, f);
        if (sets) r.sets = sets;
        if (tb) r.tb = tb;
        if (JSON.stringify(before) === JSON.stringify({ sets: r.sets, tb: r.tb })) throw err("That's already the score.");
        if (r.forfeited) r.forfeited = null;
        delete r.live;
        r.scoreBy = "admin";
        if (!r.completedAt && logic.rubberWinner(r)) d.completeRubberNow(l, f, idx);
        d.auditFixture(l, f, ctx.actor, "score_edit", { seedIdx: idx, before, after: { sets: clone(r.sets), tb: clone(r.tb) }, wasFinalized: false });
        ctx.touch(l.id);
        const warnings = [];
        (sets || []).forEach((st) => { if (!plausibleSet(st)) warnings.push(`${st[0]}–${st[1]} isn't a normal finished set. Check it.`); });
        if (tb && tb[0] !== null && tb[1] !== null && !(Math.max(tb[0], tb[1]) >= 10 && Math.abs(tb[0] - tb[1]) >= 2)) warnings.push(`${tb[0]}–${tb[1]} isn't a finished match tie-break (first to 10, win by 2).`);
        const w = winnerName(l, f, r);
        if (!w) warnings.push("Nobody has won this seed yet, so it stays open.");
        return rubResult(l, f, idx, snap, `Enter ${logic.rubberScoreText(r) || "that score"} for ${seedLabel(l, f, idx)}.${w ? " " + w + " win it." : ""}`, { warnings });
      },
      check: rubCheck, revert: rubRevert,
    },
    score_forfeit: {
      label: "Score",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        const w = ch.winner;
        if (w !== "A" && w !== "B" && w !== "double") throw err("Say which side gets the walkover, or that both sides forfeited.");
        const snap = rubSnap(l, idx, f);
        if (w !== "double") {
          if (r.sets.length === 0) r.tb = w === "A" ? [10, 0] : [0, 10];
          else { r.sets = r.sets.map((_, si) => (si < 2 ? (w === "A" ? [6, 0] : [0, 6]) : [null, null])); r.tb = [null, null]; }
        }
        r.forfeited = w; r.startedAt = Date.now(); r.completedAt = r.startedAt;
        const label = d.fixtureLabel(l, f);
        const seedWord = f.rubbers.length === 1 ? "The match" : idx === 4 && f.selectionA.pairs.length === 5 ? "The Singles" : "Seed " + (idx + 1);
        const msg = w === "double" ? `${seedWord} for ${label} was forfeited by both sides — no result, no points to either team.`
          : `${seedWord} for ${label} was forfeited — ${w === "A" ? tname(l, f.teamA) : tname(l, f.teamB)} awarded a ${r.sets.length === 0 ? "10-0" : "6-0, 6-0"} walkover over ${w === "A" ? tname(l, f.teamB) : tname(l, f.teamA)}.`;
        ctx.deferred.push(() => { d.notifyLater(l.id, f.teamA, "forfeit", msg, { round: f.round }); d.notifyLater(l.id, f.teamB, "forfeit", msg, { round: f.round }); });
        d.auditFixture(l, f, ctx.actor, "forfeit", { seedIdx: idx, winner: w });
        ctx.touch(l.id);
        return rubResult(l, f, idx, snap, `${w === "double" ? "Record a double forfeit" : `Forfeit: ${w === "A" ? tname(l, f.teamA) : tname(l, f.teamB)} get a walkover`} for ${seedLabel(l, f, idx)}. Both captains are notified, and that notification can't be taken back.`);
      },
      check: rubCheck, revert: rubRevert,
    },
  };
  const courtKinds = {
    court_start: {
      label: "Court",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        if (r.completedAt) throw err("That match is already finished.");
        if (r.startedAt) throw err("That match has already started.");
        const snap = rubSnap(l, idx, f);
        r.startedAt = Date.now(); ctx.touch(l.id);
        return rubResult(l, f, idx, snap, `Start the clock on ${seedLabel(l, f, idx)}.`);
      },
      check: rubCheck, revert: rubRevert,
    },
    court_pace: {
      label: "Court",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        if (r.startedAt) throw err("That match has already started.");
        const pace = ch.pace === "quick" || ch.pace === "long" ? ch.pace : null;
        if ((r.pace || null) === pace) throw err("It's already set like that.");
        const snap = rubSnap(l, idx, f);
        if (pace) r.pace = pace; else delete r.pace;
        ctx.touch(l.id);
        return rubResult(l, f, idx, snap, `Mark ${seedLabel(l, f, idx)} as ${pace ? "a " + pace + " match" : "no pace call (the app guesses)"}.`);
      },
      check: rubCheck, revert: rubRevert,
    },
    court_live_score: {
      label: "Court",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        const sets = setsFor(r, ch.sets);
        const tb = ch.tb !== undefined ? pairNums(ch.tb) : r.tb.slice();
        const empty = sets.every((s) => s[0] === null && s[1] === null) && !tb[0] && !tb[1];
        const snap = rubSnap(l, idx, f);
        if (empty) delete r.live;
        else {
          r.live = { sets, tb, updatedAt: Date.now() };
          if (!r.completedAt && logic.rubberWinner({ ...r, sets, tb })) d.completeRubberNow(l, f, idx);
        }
        ctx.touch(l.id);
        const warnings = [];
        sets.forEach((st) => { if (!plausibleSet(st) && !(st[0] !== null && st[1] !== null && Math.max(st[0], st[1]) < 6)) warnings.push(`${st[0]}–${st[1]} isn't a normal set score.`); });
        const txt = sets.filter((s) => s[0] !== null || s[1] !== null).map((s) => `${s[0] === null ? 0 : s[0]}–${s[1] === null ? 0 : s[1]}`).join(", ") || "no score";
        return rubResult(l, f, idx, snap, `Live score on the court board for ${seedLabel(l, f, idx)}: ${txt}. This is courtside only; it isn't the official result.`, { warnings });
      },
      check: rubCheck, revert: rubRevert,
    },
    court_complete: {
      label: "Court",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        if (!r.startedAt) throw err("That match hasn't been started yet.");
        if (r.completedAt) throw err("That match is already finished.");
        const snap = rubSnap(l, idx, f);
        d.completeRubberNow(l, f, idx); ctx.touch(l.id);
        return rubResult(l, f, idx, snap, `Mark ${seedLabel(l, f, idx)} as finished.`);
      },
      check: rubCheck, revert: rubRevert,
    },
    court_reopen: {
      label: "Court",
      run(ctx, ch) {
        const { l, f, idx, r } = seedOf(ctx, ch);
        if (!r.completedAt) throw err("That match isn't marked finished.");
        const snap = rubSnap(l, idx, f);
        d.reopenRubberNow(l, f, idx); ctx.touch(l.id);
        return rubResult(l, f, idx, snap, `Put ${seedLabel(l, f, idx)} back on court (not finished).`);
      },
      check: rubCheck, revert: rubRevert,
    },
  };

  // Finalizing locks a result and sets off emails and the round wrap-up, so it only ever happens
  // as a step of its own, after the admin has been asked and has said yes (see the apply route).
  const finalizeKinds = {
    fixture_finalize: {
      label: "Finalize",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch);
        const f = logic.allFixturesOf(l).find((x) => x && x.id === ch.fixtureId);
        if (!f) throw err("I can't find that match.");
        if (f.finalized) throw err("That fixture is already finalized.");
        if (!f.selectionA.submitted || !f.selectionB.submitted) throw err("Both line-ups have to be in first.");
        const singles = l.singlesDecider && f.stage === "regular" && f.rubbers.length === 5 ? 5 : undefined;
        if (!logic.requiredRubbersOk(f, l.format === "pairs", singles)) throw err("Not every seed has a full score yet, so it can't be finalized.");
        ctx.deferred.push(() => { try { d.finalizeLater(l.id, f.id, ctx.actor); } catch (e) { console.error("James finalize failed:", e); } });
        const label = `${l.name}, ${f.round ? "Round " + f.round + ", " : ""}${tname(l, f.teamA)} v ${tname(l, f.teamB)}`;
        return {
          leagueId: l.id, leagueName: l.name, needsConfirm: true,
          confirmText: "I understand this locks the result and emails players, and I want to finalize it.",
          text: `Finalize ${label}.`,
          warnings: ["This locks the result and updates the table and ratings. Players are emailed to rate their opponents, and if the round is complete the wrap-up post and notifications go out. Undo can reopen the fixture, but it can't unsend those."],
          undo: { fixtureId: f.id }, after: "finalized",
        };
      },
      check(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
        if (f && !f.finalized) throw err("That fixture has been unlocked since, so there's nothing to undo.");
      },
      revert(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        const f = logic.allFixturesOf(l).find((x) => x && x.id === c.undo.fixtureId);
        if (f) { f.finalized = false; ctx.touch(l.id); }
      },
    },
  };

  // ---- leagues ------------------------------------------------------------
  const leagueKinds = {
    league_set_fee: {
      label: "League",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch);
        const cents = rands(ch.amountRands), was = l.registrationFeeCents || 0;
        l.registrationFeeCents = cents; ctx.touch(l.id);
        const warnings = was && cents !== was && l.teams.some((t) => t.paymentStatus === "paid" || (t.lumpCents || 0) > 0 || t.players.some((p) => (p.paidCents || 0) > 0)) ? ["Some payments are already recorded. They stay as recorded; only what's owed changes."] : [];
        return { leagueId: l.id, leagueName: l.name, warnings, text: `${l.name}: team fee ${fmt(was)} → ${fmt(cents)}.`, undo: { was }, after: String(cents) };
      },
      check(ctx, c) { const l = leagueFor(ctx, c.leagueId); if (String(l.registrationFeeCents || 0) !== c.after) throw err(`The fee for ${l.name} has been changed since, so it can't be undone safely.`); },
      revert(ctx, c) { const l = leagueFor(ctx, c.leagueId); l.registrationFeeCents = c.undo.was; ctx.touch(l.id); },
    },
    league_create: {
      label: "League",
      run(ctx, ch) {
        const name = clip(ch.name, 80), email = clip(ch.adminEmail, 120);
        if (name.length < 2) throw err("What should the league be called?");
        if (!email.includes("@")) throw err("I need an admin email address for the new league. Tell me which one to use.");
        if (store.getIndex().some((e) => e.name.toLowerCase() === name.toLowerCase())) throw err(`There's already a league called ${name}.`);
        if (d.hubExcludedLeague(name)) throw err("That name belongs to a league outside the Note Machine.");
        const format = ch.format === "pairs" ? "pairs" : "teams";
        const league = d.newLeagueObj(name, email, format, format === "teams" && ch.singlesDecider === true);
        ctx.newLeagues.push({ league, entry: { id: league.id, name: league.name, createdAt: league.createdAt, hidden: true } });
        ctx.leagues.set(league.id, league);
        return { leagueId: league.id, leagueName: name, text: `Create a new ${format === "pairs" ? "Vibora (pairs)" : "team"} league "${name}"${league.singlesDecider ? " with the singles decider (Ormonde rules)" : ""}, hidden until you publish it. Admin email ${email}.`, undo: { leagueId: league.id }, after: "created" };
      },
      check(ctx, c) {
        const l = ctx.league(c.undo.leagueId);
        if (!l) return;
        if (l.fixtures.length || l.teams.some((t) => t.players.length)) throw err(`${l.name} already has teams, players or fixtures, so I won't remove it. Delete it yourself if you're sure.`);
      },
      revert(ctx, c) { if (ctx.league(c.undo.leagueId)) ctx.removedLeagues.push(c.undo.leagueId); },
    },
    team_add: {
      label: "League",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch);
        const name = clip(ch.name, 60);
        if (!name) throw err("What's the team called?");
        if (l.format === "pairs") throw err("That's a Vibora (pairs) league, so it has no teams.");
        if (d.leagueStatus(l) !== "setup") throw err("Teams are locked once the season has started.");
        if (l.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw err(`${l.name} already has a team called ${name}.`);
        const logo = uploadedLogo(ctx, ch);
        const team = { id: logic.uid(), name, code: d.genTeamCode(l), logo: logo && logo !== "(preview)" ? logo : "", notifyEmail: "", players: [], groupId: null };
        l.teams.push(team); ctx.touch(l.id);
        return { leagueId: l.id, leagueName: l.name, text: `Add the team "${name}" to ${l.name}${logo ? ", with the logo you uploaded" : ""}.`, undo: { teamId: team.id }, after: "added" };
      },
      check(ctx, c) {
        const l = leagueFor(ctx, c.leagueId); const t = l.teams.find((x) => x.id === c.undo.teamId);
        if (t && (t.players.length || l.fixtures.length)) throw err(`${t.name} now has players or the season has fixtures, so I won't remove it.`);
      },
      revert(ctx, c) { const l = leagueFor(ctx, c.leagueId); l.teams = l.teams.filter((x) => x.id !== c.undo.teamId); ctx.touch(l.id); },
    },
  };

  // A team's logo, set from a design the admin chose. The old logo is kept in the
  // undo record (only for the last few, so the log stays small).
  const LOGO_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
  // The uploaded logo for a change: the admin's own image (sent along when they confirm).
  // While only previewing, the image isn't there yet, so a valid number is enough.
  function uploadedLogo(ctx, ch) {
    if (!Number.isInteger(ch.logoImage)) return null;
    const img = ctx.images[ch.logoImage];
    if (img === undefined || img === null) { if (ctx.dry) return "(preview)"; throw err("I need the logo photo again. Attach it and ask once more."); }
    if (!LOGO_RE.test(img) || img.length > 400000) throw err("That logo image isn't usable. Try a smaller one.");
    return img;
  }
  const logoKey = (img) => `${(img || "").length}:${(img || "").slice(-48)}`;
  const MAX_LOGO = 400000;
  leagueKinds.team_logo_set = {
    label: "Logo",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch); const t = ch.teamId ? teamFor(l, ch.teamId) : teamByName(l, ch.teamName);
      const up = uploadedLogo(ctx, ch);
      const img = up || String(ch.image || "");
      if (!up && (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(img) || img.length > MAX_LOGO)) throw err("That logo image isn't usable.");
      const prev = t.logo || "";
      if (prev.length > MAX_LOGO) throw err(`${t.name}'s current logo is too large for me to keep a backup of, so I won't replace it. Change it by hand.`);
      t.logo = img === "(preview)" ? t.logo : img; ctx.touch(l.id);
      return { leagueId: l.id, leagueName: l.name, text: `Set ${t.name}'s logo (${l.name}) to ${up ? "the photo you uploaded" : "the new design"}${prev ? ". The old logo is kept so this can be undone" : ""}.`, undo: { teamId: t.id, prev }, after: logoKey(t.logo) };
    },
    check(ctx, c) {
      const l = leagueFor(ctx, c.leagueId); const t = l.teams.find((x) => x.id === c.undo.teamId);
      if (c.undo.expired) throw err("That logo change is too old to undo. Change the logo by hand.");
      if (t && logoKey(t.logo) !== c.after) throw err(`${t.name}'s logo has been changed since, so it can't be undone safely.`);
    },
    revert(ctx, c) {
      const l = leagueFor(ctx, c.leagueId); const t = l.teams.find((x) => x.id === c.undo.teamId);
      if (t) { t.logo = c.undo.prev || ""; ctx.touch(l.id); }
    },
  };

  // ---- setting a league up: its settings, going public, starting the season, the weekly times ----
  const SETTING_FIELDS = ["courtCount", "slotCount", "courtNames", "defaultVenue", "playoffFormat"];
  leagueKinds.league_settings = {
    label: "League",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch);
      const before = {}; SETTING_FIELDS.forEach((k) => { before[k] = l[k] === undefined ? null : clone(l[k]); });
      const bits = [], warnings = [];
      if (ch.courtCount !== undefined || ch.slotCount !== undefined) {
        const cc = ch.courtCount !== undefined ? Number(ch.courtCount) : (l.courtCount || 4), sc = ch.slotCount !== undefined ? Number(ch.slotCount) : (l.slotCount || 3);
        if (!Number.isInteger(cc) || cc < 1 || cc > 12) throw err("Courts must be between 1 and 12.");
        if (!Number.isInteger(sc) || sc < 1 || sc > 10) throw err("Time slots a night must be between 1 and 10.");
        l.courtCount = cc; l.slotCount = sc; bits.push(`${cc} court${cc === 1 ? "" : "s"} and ${sc} time slot${sc === 1 ? "" : "s"} a night`);
        if (l.format !== "pairs" && l.teams.length > 1 && Math.floor(l.teams.length / 2) > cc * sc) warnings.push(`${l.teams.length} teams need ${Math.floor(l.teams.length / 2)} matches a night, more than ${cc * sc} court slots.`);
      }
      if (ch.courtNames !== undefined) {
        const names = (Array.isArray(ch.courtNames) ? ch.courtNames : []).slice(0, 12).map((n) => clip(n, 30));
        l.courtNames = names; bits.push(names.length ? `court names ${names.join(", ")}` : "no court names");
      }
      if (ch.defaultVenue !== undefined) { l.defaultVenue = clip(ch.defaultVenue, 120); bits.push(l.defaultVenue ? `venue ${l.defaultVenue}` : "no default venue"); }
      if (ch.playoffFormat !== undefined) {
        if (!["none", "semis_final", "position"].includes(ch.playoffFormat)) throw err("Playoffs can be none, semis and final, or a final-spot playoff.");
        if (l.format === "pairs" && ch.playoffFormat !== "none") throw err("Playoffs aren't available for a Vibora league yet.");
        if (l.playoffs) throw err("The playoffs have already been built, so the format can't change here.");
        l.playoffFormat = ch.playoffFormat; bits.push({ none: "no playoffs", semis_final: "semi-finals and a final", position: "a final-spot playoff" }[ch.playoffFormat]);
      }
      if (!bits.length) throw err("Tell me which setting to change.");
      ctx.touch(l.id);
      const after = {}; SETTING_FIELDS.forEach((k) => { after[k] = l[k] === undefined ? null : clone(l[k]); });
      return { leagueId: l.id, leagueName: l.name, warnings, text: `${l.name}: ${bits.join(", ")}.`, undo: { before }, after: JSON.stringify(after) };
    },
    check(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      const now = {}; SETTING_FIELDS.forEach((k) => { now[k] = l[k] === undefined ? null : clone(l[k]); });
      if (JSON.stringify(now) !== c.after) throw err(`${l.name}'s settings have been changed since, so it can't be undone safely.`);
    },
    revert(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      SETTING_FIELDS.forEach((k) => { if (c.undo.before[k] === null) delete l[k]; else l[k] = clone(c.undo.before[k]); });
      ctx.touch(l.id);
    },
  };
  // Hidden leagues can't be found by players. Publishing one puts it on the Leagues page, so it asks for a tick.
  const indexEntry = (id) => store.getIndex().find((e) => e.id === id);
  leagueKinds.league_visibility = {
    label: "League",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch);
      const made = ctx.newLeagues.find((x) => x.league.id === l.id);
      const e = made ? made.entry : indexEntry(l.id);
      if (!e) throw err("I can't find that league.");
      const hide = ch.hidden !== false && ch.hidden !== "false";
      if (!!e.hidden === hide) throw err(hide ? `${l.name} is already hidden.` : `${l.name} is already public.`);
      const was = !!e.hidden;
      if (made) e.hidden = hide; else ctx.deferred.push(() => { const idx = store.getIndex(); const x = idx.find((y) => y.id === l.id); if (x) { x.hidden = hide; store.saveIndex(idx); } });
      return { leagueId: l.id, leagueName: l.name, needsConfirm: !hide, confirmText: "I understand this puts the league on the public Leagues page, where anyone can find it.", warnings: hide ? [] : ["Anyone can then find the league and its teams on the public Leagues page."], text: hide ? `Hide ${l.name} from the public.` : `Publish ${l.name} on the public Leagues page.`, undo: { was }, after: hide ? "hidden" : "public" };
    },
    check(ctx, c) { const e = indexEntry(c.leagueId); if (!e) return; if ((c.after === "hidden") !== !!e.hidden) throw err("The league's visibility has been changed since, so it can't be undone safely."); },
    revert(ctx, c) { ctx.deferred.push(() => { const idx = store.getIndex(); const x = idx.find((y) => y.id === c.leagueId); if (x) { x.hidden = c.undo.was; store.saveIndex(idx); } }); },
  };
  // Starting the season builds every fixture and locks the teams, so it asks for a tick of its own.
  const fixtureShape = (l) => JSON.stringify([l.status || null, l.playoffFormat || null, !!l.singlesDecider, (l.fixtures || []).length, (l.byes || []).length]);
  leagueKinds.season_start = {
    label: "Season",
    run(ctx, ch) {
      const l = leagueRef(ctx, ch);
      if (d.leagueStatus(l) !== "setup") throw err(`${l.name}'s season has already started.`);
      const isPairs = l.format === "pairs";
      if (isPairs && l.teams.some((t) => t.players.length !== 2)) throw err("Every pair needs exactly 2 players before the season can start.");
      if (l.teams.length < 3) throw err(`${l.name} needs at least 3 ${isPairs ? "pairs" : "teams"} before the season can start (it has ${l.teams.length}).`);
      if (isPairs && (l.groups || []).length) throw err("Leagues with groups have to be started by hand.");
      const before = { status: l.status === undefined ? null : l.status, playoffFormat: l.playoffFormat === undefined ? null : l.playoffFormat, singlesDecider: !!l.singlesDecider, fixtures: clone(l.fixtures || []), byes: clone(l.byes || []) };
      const warnings = [];
      if (!isPairs) l.teams.filter((t) => t.players.length < 4).forEach((t) => warnings.push(`${t.name} has only ${t.players.length} player${t.players.length === 1 ? "" : "s"}. A match night needs 4 to pick from.`));
      if (ch.playoffFormat !== undefined) {
        if (!["none", "semis_final", "position"].includes(ch.playoffFormat)) throw err("Playoffs can be none, semis and final, or a final-spot playoff.");
        if (isPairs && ch.playoffFormat !== "none") throw err("Playoffs aren't available for a Vibora league yet.");
      }
      if (!isPairs && ch.singlesDecider !== undefined) l.singlesDecider = ch.singlesDecider === true;
      const gen = logic.generateRoundRobin(l.teams, ch.doubleRound === true, isPairs ? 1 : (l.singlesDecider ? 5 : 4));
      if (isPairs) {
        const byId = {}; l.teams.forEach((t) => { byId[t.id] = t; });
        gen.fixtures.forEach((f) => {
          const a = byId[f.teamA], b = byId[f.teamB];
          if (a) f.selectionA = { submitted: true, pairs: [[a.players[0].id, a.players[1].id]] };
          if (b) f.selectionB = { submitted: true, pairs: [[b.players[0].id, b.players[1].id]] };
        });
      }
      l.fixtures = gen.fixtures; l.byes = gen.byes;
      l.playoffFormat = isPairs ? "none" : (ch.playoffFormat || l.playoffFormat || "none");
      l.status = "active";
      ctx.touch(l.id);
      const rounds = new Set(gen.fixtures.map((f) => f.round)).size;
      return {
        leagueId: l.id, leagueName: l.name, needsConfirm: true, warnings,
        confirmText: "I understand this builds every fixture and locks the teams for the season, and I want to start it.",
        text: `Start ${l.name}'s season: ${l.teams.length} ${isPairs ? "pairs" : "teams"}, ${gen.fixtures.length} fixtures over ${rounds} round${rounds === 1 ? "" : "s"}${ch.doubleRound === true ? " (home and away)" : " (everyone plays everyone once)"}${l.singlesDecider ? ", with the singles decider" : ""}, ${{ none: "no playoffs", semis_final: "semi-finals and a final", position: "a final-spot playoff" }[l.playoffFormat]}. Teams are locked from then on.`,
        undo: { before }, after: fixtureShape(l),
      };
    },
    check(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      if (fixtureShape(l) !== c.after) throw err(`${l.name}'s season has changed since it was started, so I can't undo the start.`);
      const touched = (l.fixtures || []).some((f) => f.finalized || (f.selectionA && f.selectionA.submitted && l.format !== "pairs") || (f.selectionB && f.selectionB.submitted && l.format !== "pairs") || (f.rubbers || []).some((r) => r.startedAt || r.completedAt || r.forfeited || (r.sets || []).some((st) => st[0] !== null && st[0] !== undefined) || (r.tb && (r.tb[0] || r.tb[1]))));
      if (touched) throw err(`${l.name} already has line-ups or scores in, so I won't wipe its fixtures.`);
    },
    revert(ctx, c) {
      const l = leagueFor(ctx, c.leagueId);
      l.fixtures = clone(c.undo.before.fixtures); l.byes = clone(c.undo.before.byes);
      l.singlesDecider = c.undo.before.singlesDecider;
      if (c.undo.before.status === null) delete l.status; else l.status = c.undo.before.status;
      if (c.undo.before.playoffFormat === null) delete l.playoffFormat; else l.playoffFormat = c.undo.before.playoffFormat;
      if (l.schedule) Object.keys(l.schedule).filter((k) => /^r\d+$/.test(k)).forEach((k) => { delete l.schedule[k]; });
      ctx.touch(l.id);
    },
  };

  // ---- players ------------------------------------------------------------
  const hasPlayed = (l, pid) => logic.allFixturesOf(l).some((f) => ((f.selectionA && f.selectionA.pairs) || []).flat().includes(pid) || ((f.selectionB && f.selectionB.pairs) || []).flat().includes(pid));
  const playerKinds = {
    player_add: {
      label: "Player",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch); const t = ch.teamId ? teamFor(l, ch.teamId) : teamByName(l, ch.teamName);
        const list = (Array.isArray(ch.names) && ch.names.length ? ch.names : [ch.name]).map((n) => clip(n, 60)).filter(Boolean);
        if (!list.length) throw err("What's the player's name?");
        const seen = new Set(t.players.map((p) => p.name.toLowerCase()));
        const added = [], skipped = [];
        list.forEach((name) => {
          if (seen.has(name.toLowerCase())) { skipped.push(name); return; }
          seen.add(name.toLowerCase());
          const p = { id: logic.uid(), name };
          t.players.push(p); added.push(p);
        });
        if (!added.length) throw err(list.length === 1 ? `${t.name} already has a player called ${list[0]}.` : `${t.name} already has all of those players.`);
        ctx.touch(l.id);
        return { leagueId: l.id, leagueName: l.name, warnings: skipped.length ? [`Already on ${t.name}, so left out: ${skipped.join(", ")}.`] : [], text: `Add ${added.length === 1 ? added[0].name : added.length + " players (" + added.map((p) => p.name).join(", ") + ")"} to ${t.name} (${l.name}).`, undo: { teamId: t.id, playerIds: added.map((p) => p.id) }, after: "added" };
      },
      check(ctx, c) {
        const l = leagueFor(ctx, c.leagueId); const t = l.teams.find((x) => x.id === c.undo.teamId);
        (c.undo.playerIds || [c.undo.playerId]).forEach((id) => {
          const p = t && t.players.find((x) => x.id === id);
          if (p && (hasPlayed(l, p.id) || (p.paidCents || 0) > 0)) throw err(`${p.name} has played or paid since, so I won't remove them.`);
        });
      },
      revert(ctx, c) { const l = leagueFor(ctx, c.leagueId); const t = l.teams.find((x) => x.id === c.undo.teamId); const ids = c.undo.playerIds || [c.undo.playerId]; if (t) t.players = t.players.filter((x) => !ids.includes(x.id)); ctx.touch(l.id); },
    },
    player_move: {
      label: "Player",
      run(ctx, ch) {
        const l = leagueRef(ctx, ch);
        if (l.format === "pairs") throw err("Moving players between teams isn't available for a Vibora league.");
        if (d.leagueStatus(l) !== "setup") throw err("Players can be moved between seasons, before the new season starts.");
        const from = ch.fromTeamId ? teamFor(l, ch.fromTeamId) : null;
        const player = from ? playerFor(from, ch.playerId) : (l.freeAgents || []).find((p) => p.id === ch.playerId);
        if (!player) throw err("I can't find that player.");
        const to = ch.toTeamId ? teamFor(l, ch.toTeamId) : null;
        if (!to && !from) throw err("He isn't on a team, so there's nowhere to move him from.");
        if (to && from && to.id === from.id) throw err(`${player.name} is already on ${to.name}.`);
        if (to && to.players.some((p) => p.name.toLowerCase() === player.name.toLowerCase())) throw err(`${to.name} already has a player called ${player.name}.`);
        const snap = clone(player);
        d.movePlayerRecord(l, player, from, to); ctx.touch(l.id);
        if (to) ctx.deferred.push(() => d.followPlayerToTeam(l, player, to));
        const text = to ? `${from ? "Move" : "Put"} ${player.name} ${from ? "from " + from.name + " to" : "on"} ${to.name} (${l.name}). Last season's payment record doesn't follow him.` : `Take ${player.name} off ${from.name} (${l.name}). He goes to the "no team yet" list with his history kept.`;
        return { leagueId: l.id, leagueName: l.name, text, undo: { playerId: player.id, fromTeamId: from ? from.id : null, toTeamId: to ? to.id : null, snap }, after: to ? to.id : "free" };
      },
      check(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        const where = c.undo.toTeamId ? (l.teams.find((t) => t.id === c.undo.toTeamId) || { players: [] }).players.some((p) => p.id === c.undo.playerId) : (l.freeAgents || []).some((p) => p.id === c.undo.playerId);
        if (!where) throw err(`${c.undo.snap.name} has been moved again since, so it can't be undone safely.`);
        if (c.undo.fromTeamId && !l.teams.some((t) => t.id === c.undo.fromTeamId)) throw err("The team he came from no longer exists.");
      },
      revert(ctx, c) {
        const l = leagueFor(ctx, c.leagueId);
        const cur = c.undo.toTeamId ? l.teams.find((t) => t.id === c.undo.toTeamId) : null;
        const orig = c.undo.fromTeamId ? l.teams.find((t) => t.id === c.undo.fromTeamId) : null;
        const player = cur ? cur.players.find((p) => p.id === c.undo.playerId) : (l.freeAgents || []).find((p) => p.id === c.undo.playerId);
        d.movePlayerRecord(l, player, cur, orig);
        Object.keys(player).forEach((k) => { delete player[k]; });
        Object.assign(player, clone(c.undo.snap));
        ctx.touch(l.id);
        const leagueId = l.id, pid = player.id, snap = c.undo.snap;
        ctx.deferred.push(() => {
          if (orig) d.followPlayerToTeam({ id: leagueId }, { id: pid }, orig);
          else if (snap.removedFromTeamId) d.setPlayerClaimsTeam(leagueId, pid, snap.removedFromTeamId);
        });
      },
    },
  };

  // ---- notes --------------------------------------------------------------
  const NOTE_FIELDS = ["status", "doneBy", "doneAt", "priority", "categoryId", "dueDate", "pinned", "updatedAt", "updatedBy"];
  const noteKinds = {
    note_update: {
      label: "Note",
      run(ctx, ch, actor) {
        const hub = ctx.hub();
        const item = (hub.items || []).find((i) => i.id === ch.noteId);
        if (!item) throw err("I can't find that note.");
        if (item.leagueId && d.hubExcludedLeagueIds().has(item.leagueId)) throw err("That note belongs to a league outside the Note Machine.");
        const body = {};
        ["status", "priority", "categoryId", "dueDate", "pinned"].forEach((k) => { if (ch[k] !== undefined) body[k] = ch[k]; });
        if (!Object.keys(body).length) throw err("Tell me what to change on the note.");
        if (body.status !== undefined && !["open", "done"].includes(body.status)) throw err("A note is either open or done.");
        if (body.priority !== undefined && !d.HUB_PRIORITIES.includes(body.priority)) throw err("That isn't a priority.");
        if (body.categoryId && !d.hubCategories(hub).some((c) => c.id === body.categoryId)) throw err("That category doesn't exist.");
        if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) throw err("That due date doesn't look right.");
        const before = pick(item, NOTE_FIELDS);
        const was = { status: item.status, priority: item.priority || "normal", categoryId: item.categoryId || null, dueDate: item.dueDate || null, pinned: !!item.pinned };
        d.applyHubFields(item, body, null, actor);
        item.updatedAt = Date.now(); item.updatedBy = actor;
        ctx.touchHub();
        const bits = [];
        if (body.status !== undefined && body.status !== was.status) bits.push(body.status === "done" ? "mark done" : "reopen");
        if (body.priority !== undefined && body.priority !== was.priority) bits.push(`priority ${was.priority} → ${item.priority}`);
        if (body.categoryId !== undefined && (body.categoryId || null) !== was.categoryId) bits.push(`category → ${item.categoryId ? (d.hubCategories(hub).find((c) => c.id === item.categoryId) || {}).name : "none"}`);
        if (body.dueDate !== undefined && (body.dueDate || null) !== was.dueDate) bits.push(`due ${was.dueDate || "none"} → ${item.dueDate || "none"}`);
        if (body.pinned !== undefined && !!body.pinned !== was.pinned) bits.push(item.pinned ? "pin" : "unpin");
        if (!bits.length) throw err("The note is already like that.");
        return { leagueId: null, leagueName: "", text: `Note "${clip(item.title, 60)}": ${bits.join(", ")}.`, undo: { noteId: item.id, before }, after: JSON.stringify(pick(item, NOTE_FIELDS)) };
      },
      check(ctx, c) {
        const item = (ctx.hub().items || []).find((i) => i.id === c.undo.noteId);
        if (item && JSON.stringify(pick(item, NOTE_FIELDS)) !== c.after) throw err(`The note "${clip(item.title, 40)}" has been changed since, so it can't be undone safely.`);
      },
      revert(ctx, c) {
        const item = (ctx.hub().items || []).find((i) => i.id === c.undo.noteId);
        if (!item) return;
        NOTE_FIELDS.forEach((k) => { delete item[k]; });
        Object.assign(item, clone(c.undo.before));
        ctx.touchHub();
      },
    },
  };

  const KINDS = { ...payKinds, ...fixKinds, ...leagueKinds, ...playerKinds, ...noteKinds, ...scoreKinds, ...courtKinds, ...finalizeKinds };
  const GROUP_OF = {};
  Object.keys(payKinds).forEach((k) => { GROUP_OF[k] = "payments"; });
  Object.keys(fixKinds).forEach((k) => { GROUP_OF[k] = "fixtures"; });
  Object.keys(leagueKinds).forEach((k) => { GROUP_OF[k] = "leagues"; });
  Object.keys(playerKinds).forEach((k) => { GROUP_OF[k] = "players"; });
  Object.keys(noteKinds).forEach((k) => { GROUP_OF[k] = "notes"; });
  Object.keys(scoreKinds).forEach((k) => { GROUP_OF[k] = "scores"; });
  Object.keys(finalizeKinds).forEach((k) => { GROUP_OF[k] = "scores"; });
  Object.keys(courtKinds).forEach((k) => { GROUP_OF[k] = "court"; });
  const GROUP_NAME = { payments: "Payments", fixtures: "Fixtures", leagues: "Leagues", players: "Players", notes: "Notes", scores: "Scores", court: "Court control", images: "Pictures" };

  // Steps that can't be undone cleanly or that go public are always a set of their own, after the admin has said yes.
  const ALONE = new Set(["fixture_finalize", "season_start", "league_visibility"]);

  // ---- the three entry points ---------------------------------------------
  function plan(changes, { dry, actor, perms, images }) {
    const ctx = makeCtx(dry, images, actor);
    const hasAlone = changes.some((c) => c && ALONE.has(c.kind));
    const results = changes.map((ch) => {
      const k = KINDS[ch && ch.kind];
      try {
        if (hasAlone && changes.length > 1) throw err("That step has to be on its own. Do the other changes first, then do it.");
        if (!k) throw err("I don't know how to do that one.");
        if (!perms.write[GROUP_OF[ch.kind]]) throw err(`${GROUP_NAME[GROUP_OF[ch.kind]]} changes are switched off in James's permissions.`);
        const r = k.run(ctx, ch, actor);
        return { ok: true, kind: ch.kind, label: k.label, warnings: [], ...r };
      } catch (e) {
        if (!e.userFacing) { console.error("James change failed:", e); return { ok: false, kind: ch && ch.kind, label: k ? k.label : "Change", error: "Something went wrong preparing this change." }; }
        return { ok: false, kind: ch && ch.kind, label: k ? k.label : "Change", error: e.message };
      }
    });
    return { ctx, results };
  }
  // What the admin sees: no snapshots.
  const publicResult = (r) => ({ ok: r.ok, needsConfirm: !!r.needsConfirm, confirmText: r.confirmText || "", kind: r.kind, label: r.label, text: r.text || "", warnings: r.warnings || [], error: r.error || null, leagueName: r.leagueName || "" });

  function preview(changes, opts) { return plan(changes, { ...opts, dry: true }).results.map(publicResult); }

  // Writes one set of changes to James's log. Old pictures kept for undo are the only
  // big things in it, so only the newest few are kept.
  function recordSet({ actor, request, changes }) {
    const log = store.getJamesLog();
    log.sets = log.sets || [];
    const set = { id: logic.uid(), at: Date.now(), by: actor, request: clip(request, 300), status: "applied", changes };
    log.sets.unshift(set);
    log.sets = log.sets.slice(0, 100);
    let kept = 0;
    log.sets.forEach((st) => st.changes.forEach((c) => {
      if ((c.kind !== "team_logo_set" && c.kind !== "team_kit_set") || !c.undo) return;
      if (++kept > 5 && c.undo.prev) { c.undo.prev = ""; c.undo.expired = true; }
    }));
    store.saveJamesLog(log);
    return set;
  }

  // All or nothing: every change must work, then everything is saved together.
  function apply(changes, { actor, request, perms, images, confirmed }) {
    const { ctx, results } = plan(changes, { dry: false, actor, perms, images });
    if (results.some((r) => !r.ok)) return { ok: false, results: results.map(publicResult) };
    // Nothing has been saved yet: steps that need the admin's own OK stop here without it.
    if (results.some((r) => r.needsConfirm) && !confirmed) return { ok: false, needsConfirm: true, results: results.map(publicResult) };
    results.forEach((r) => {
      const l = r.leagueId && ctx.leagues.get(r.leagueId);
      if (l && ctx.touched.has(l.id)) d.audit(l, actor, `${r.text}`);
    });
    ctx.commit();
    const set = recordSet({ actor, request, changes: results.map((r) => ({ kind: r.kind, label: r.label, leagueId: r.leagueId || null, leagueName: r.leagueName || "", text: r.text, undo: r.undo, after: r.after })) });
    return { ok: true, setId: set.id, results: results.map(publicResult) };
  }

  function undo(setId, { actor }) {
    const log = store.getJamesLog();
    const set = (log.sets || []).find((s) => s.id === setId);
    if (!set) throw err("I can't find that change.");
    if (set.status !== "applied") throw err("That change was already undone.");
    const ctx = makeCtx(false, [], actor);
    const lines = [];
    set.changes.slice().reverse().forEach((c) => {
      const k = KINDS[c.kind];
      if (!k) throw err("This change can't be undone from here.");
      k.check(ctx, c);
      k.revert(ctx, c);
      lines.push(c);
    });
    lines.forEach((c) => { const l = c.leagueId && ctx.leagues.get(c.leagueId); if (l && ctx.touched.has(l.id)) d.audit(l, actor, `Undid: ${c.text}`); });
    ctx.commit();
    set.status = "undone"; set.undoneAt = Date.now(); set.undoneBy = actor;
    store.saveJamesLog(log);
    return { ok: true };
  }

  function recentLog(limit = 30) {
    return (store.getJamesLog().sets || []).slice(0, limit).map((s) => ({
      id: s.id, at: s.at, by: s.by, request: s.request, status: s.status, undoneAt: s.undoneAt || null, undoneBy: s.undoneBy || null,
      changes: s.changes.map((c) => ({ label: c.label, text: c.text, leagueName: c.leagueName })),
    }));
  }

  return { KINDS, GROUP_OF, GROUP_NAME, preview, apply, undo, recordSet, recentLog, fmt, dayText };
};
