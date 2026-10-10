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
  function makeCtx(dry, images) {
    const leagues = new Map();
    const touched = new Set();
    const newLeagues = [];
    const removedLeagues = [];
    const deferred = [];
    let hub = null, hubTouched = false;
    return {
      dry, images: images || [], leagues, touched, deferred, newLeagues, removedLeagues,
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

  function leagueFor(ctx, id) {
    const l = ctx.league(String(id || ""));
    if (!l) throw err("I can't find that league.");
    if (d.hubExcludedLeague(l.name)) throw err(`${l.name} is outside the Note Machine, so James can't change it.`);
    return l;
  }
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
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
    pay_mark_team_paid: {
      label: "Payment",
      run(ctx, ch) {
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
        const l = leagueFor(ctx, ch.leagueId); needFee(l);
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
        const l = leagueFor(ctx, ch.leagueId);
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

  fixKinds.fix_match_schedule = {
    label: "Schedule",
    run(ctx, ch) {
      const l = leagueFor(ctx, ch.leagueId);
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

  // ---- leagues ------------------------------------------------------------
  const leagueKinds = {
    league_set_fee: {
      label: "League",
      run(ctx, ch) {
        const l = leagueFor(ctx, ch.leagueId);
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
        const league = d.newLeagueObj(name, email, "teams", false);
        ctx.newLeagues.push({ league, entry: { id: league.id, name: league.name, createdAt: league.createdAt, hidden: true } });
        return { leagueId: league.id, leagueName: name, text: `Create a new league "${name}" (hidden until you unhide it), admin email ${email}.`, undo: { leagueId: league.id }, after: "created" };
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
        const l = leagueFor(ctx, ch.leagueId);
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
      const l = leagueFor(ctx, ch.leagueId); const t = ch.teamId ? teamFor(l, ch.teamId) : teamByName(l, ch.teamName);
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

  // ---- players ------------------------------------------------------------
  const hasPlayed = (l, pid) => logic.allFixturesOf(l).some((f) => ((f.selectionA && f.selectionA.pairs) || []).flat().includes(pid) || ((f.selectionB && f.selectionB.pairs) || []).flat().includes(pid));
  const playerKinds = {
    player_add: {
      label: "Player",
      run(ctx, ch) {
        const l = leagueFor(ctx, ch.leagueId); const t = ch.teamId ? teamFor(l, ch.teamId) : teamByName(l, ch.teamName);
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
        const l = leagueFor(ctx, ch.leagueId);
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

  const KINDS = { ...payKinds, ...fixKinds, ...leagueKinds, ...playerKinds, ...noteKinds };
  const GROUP_OF = {};
  Object.keys(payKinds).forEach((k) => { GROUP_OF[k] = "payments"; });
  Object.keys(fixKinds).forEach((k) => { GROUP_OF[k] = "fixtures"; });
  Object.keys(leagueKinds).forEach((k) => { GROUP_OF[k] = "leagues"; });
  Object.keys(playerKinds).forEach((k) => { GROUP_OF[k] = "players"; });
  Object.keys(noteKinds).forEach((k) => { GROUP_OF[k] = "notes"; });
  const GROUP_NAME = { payments: "Payments", fixtures: "Fixtures", leagues: "Leagues", players: "Players", notes: "Notes" };

  // ---- the three entry points ---------------------------------------------
  function plan(changes, { dry, actor, perms, images }) {
    const ctx = makeCtx(dry, images);
    const results = changes.map((ch) => {
      const k = KINDS[ch && ch.kind];
      try {
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
  const publicResult = (r) => ({ ok: r.ok, kind: r.kind, label: r.label, text: r.text || "", warnings: r.warnings || [], error: r.error || null, leagueName: r.leagueName || "" });

  function preview(changes, opts) { return plan(changes, { ...opts, dry: true }).results.map(publicResult); }

  // All or nothing: every change must work, then everything is saved together.
  function apply(changes, { actor, request, perms, images }) {
    const { ctx, results } = plan(changes, { dry: false, actor, perms, images });
    if (results.some((r) => !r.ok)) return { ok: false, results: results.map(publicResult) };
    results.forEach((r) => {
      const l = r.leagueId && ctx.leagues.get(r.leagueId);
      if (l && ctx.touched.has(l.id)) d.audit(l, actor, `${r.text}`);
    });
    ctx.commit();
    const log = store.getJamesLog();
    log.sets = log.sets || [];
    const set = {
      id: logic.uid(), at: Date.now(), by: actor, request: clip(request, 300), status: "applied",
      changes: results.map((r) => ({ kind: r.kind, label: r.label, leagueId: r.leagueId || null, leagueName: r.leagueName || "", text: r.text, undo: r.undo, after: r.after })),
    };
    log.sets.unshift(set);
    log.sets = log.sets.slice(0, 100);
    // Old logos kept for undo are the only big thing in the log: only the newest few stay.
    let kept = 0;
    log.sets.forEach((st) => st.changes.forEach((c) => {
      if (c.kind !== "team_logo_set" || !c.undo) return;
      if (++kept > 5 && c.undo.prev) { c.undo.prev = ""; c.undo.expired = true; }
    }));
    store.saveJamesLog(log);
    return { ok: true, setId: set.id, results: results.map(publicResult) };
  }

  function undo(setId, { actor }) {
    const log = store.getJamesLog();
    const set = (log.sets || []).find((s) => s.id === setId);
    if (!set) throw err("I can't find that change.");
    if (set.status !== "applied") throw err("That change was already undone.");
    const ctx = makeCtx(false);
    const lines = [];
    set.changes.slice().reverse().forEach((c) => {
      const k = KINDS[c.kind];
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

  return { KINDS, GROUP_OF, GROUP_NAME, preview, apply, undo, recentLog, fmt, dayText };
};
