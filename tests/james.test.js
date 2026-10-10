const test = require("node:test");
const assert = require("node:assert");
const J = require("../src/james");

const cfg = { apiKey: "sk-test", model: "claude-sonnet-5-5", capUsd: 25, dailyLimit: 3 };
const ctx = {
  categories: [{ id: "tasks", name: "Tasks" }],
  leagues: [{ id: "L1", name: "Lonehill VA", teams: [{ id: "T1", name: "Cyclones" }] }],
};
const fakeFetch = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("config defaults and overrides", () => {
  const d = J.config({});
  assert.strictEqual(d.apiKey, "");
  assert.strictEqual(d.capUsd, 25);
  assert.strictEqual(d.dailyLimit, 100);
  const o = J.config({ ANTHROPIC_API_KEY: " k ", JAMES_MONTHLY_CAP_USD: "60", JAMES_DAILY_LIMIT: "40", JAMES_MODEL: "claude-haiku-4-5-20251001" });
  assert.deepStrictEqual([o.apiKey, o.capUsd, o.dailyLimit, o.model], ["k", 60, 40, "claude-haiku-4-5-20251001"]);
});

test("cost is per million tokens and unknown models are priced high", () => {
  assert.ok(Math.abs(J.costUsd("claude-sonnet-5-5", { input_tokens: 2000, output_tokens: 200 }) - 0.006) < 1e-9);
  assert.ok(Math.abs(J.costUsd("claude-haiku-4-5-20251001", { input_tokens: 1e6, output_tokens: 1e6 }) - 6) < 1e-9);
  assert.ok(J.costUsd("some-new-model", { input_tokens: 1e6 }) > J.costUsd("claude-sonnet-5-5", { input_tokens: 1e6 }));
});

test("usage is tracked per month and per person per day, and limits bite", () => {
  const now = Date.UTC(2026, 2, 10, 10, 0, 0);
  const u = { months: {}, days: {} };
  J.recordUsage(u, "ZG", 1.5, now);
  J.recordUsage(u, "ID", 0.5, now);
  const s = J.usageSummary(u, "ZG", cfg, now);
  assert.strictEqual(s.monthCostUsd, 2);
  assert.strictEqual(s.todayCount, 1);
  J.checkLimits(u, "ZG", cfg, now);
  J.recordUsage(u, "ZG", 0, now); J.recordUsage(u, "ZG", 0, now);
  assert.throws(() => J.checkLimits(u, "ZG", cfg, now), /today's limit/);
  J.checkLimits(u, "JN", cfg, now);
  J.recordUsage(u, "JN", 30, now);
  assert.throws(() => J.checkLimits(u, "JN", cfg, now), /spending cap/);
});

test("South African time decides the day", () => {
  assert.strictEqual(J.saNow(Date.UTC(2026, 2, 10, 23, 30)).day, "2026-03-11");
});

test("callClaude reads text and tool calls, and reports usage", async () => {
  const body = { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Done." }, { type: "tool_use", name: "propose_notes", input: { notes: [] } }] };
  const r = await J.callClaude({ cfg, system: [], messages: [], fetchImpl: fakeFetch(200, body) });
  assert.strictEqual(r.text, "Done.");
  assert.strictEqual(r.toolUses[0].name, "propose_notes");
  assert.strictEqual(r.usage.output_tokens, 5);
});

test("callClaude turns failures into friendly errors", async () => {
  await assert.rejects(() => J.callClaude({ cfg: { ...cfg, apiKey: "" }, system: [], messages: [] }), /ANTHROPIC_API_KEY/);
  await assert.rejects(() => J.callClaude({ cfg, system: [], messages: [], fetchImpl: fakeFetch(401, { error: { message: "bad" } }) }), /key was rejected/);
  await assert.rejects(() => J.callClaude({ cfg, system: [], messages: [], fetchImpl: fakeFetch(529, {}) }), /busy/);
  await assert.rejects(() => J.callClaude({ cfg, system: [], messages: [], fetchImpl: async () => { throw new Error("down"); } }), /couldn't reach/);
});

test("proposals keep only things that really exist", () => {
  const out = J.cleanProposals([
    { name: "propose_notes", input: { notes: [
      { title: "Ask Cyclones captain", type: "followup", priority: "urgent", categoryId: "tasks", leagueId: "L1", teamId: "T1", amountRands: 1200, dueDate: "2026-03-20", concerns: ["Amount unclear"] },
      { title: "Odd", type: "bogus", priority: "???", categoryId: "nope", leagueId: "nope", teamId: "T1", amountRands: -5, dueDate: "friday" },
      { title: "  ", type: "note", priority: "low" },
    ] } },
    { name: "draft_messages", input: { messages: [{ to: "Scorpions", text: "Hi" }, { to: "x", text: "" }] } },
  ], ctx);
  assert.strictEqual(out.notes.length, 2);
  assert.deepStrictEqual([out.notes[0].leagueId, out.notes[0].teamId, out.notes[0].categoryId, out.notes[0].amountRands], ["L1", "T1", "tasks", 1200]);
  const odd = out.notes[1];
  assert.deepStrictEqual([odd.type, odd.priority, odd.categoryId, odd.leagueId, odd.teamId, odd.amountRands, odd.dueDate], ["note", "normal", null, null, null, null, null]);
  assert.strictEqual(out.messages.length, 1);
});

test("history is trimmed to strictly alternating turns ending with the new message", () => {
  const t = J.cleanHistory([{ role: "assistant", content: "hi" }, { role: "user", content: "a" }, { role: "user", content: "b" }, { role: "assistant", content: "c" }], "now");
  assert.deepStrictEqual(t.map((x) => x.role), ["user", "assistant", "user"]);
  assert.strictEqual(t[0].content, "a\nb");
  assert.strictEqual(t[2].content, "now");
});

test("permissions default to everything on and can be switched off one at a time", () => {
  const all = J.permissions({});
  assert.ok(Object.values(all.read).every(Boolean) && Object.values(all.write).every(Boolean));
  const next = J.mergePermissions({}, { write: { payments: false }, read: { rosters: false }, junk: 1 });
  const p = J.permissions(next);
  assert.strictEqual(p.write.payments, false);
  assert.strictEqual(p.write.notes, true);
  assert.strictEqual(p.read.rosters, false);
  assert.strictEqual(p.read.payments, true);
});

test("the changes tool only offers kinds that are switched on", () => {
  const perms = J.permissions(J.mergePermissions({}, { write: { payments: false } }));
  const kinds = J.changesTool(perms).input_schema.properties.changes.items.properties.kind.enum;
  assert.ok(!kinds.some((k) => k.startsWith("pay_")));
  assert.ok(kinds.includes("fix_round_schedule") && kinds.includes("player_move"));
  const none = J.permissions({ permissions: { write: { notes: false, payments: false, fixtures: false, leagues: false, players: false, scores: false, court: false, images: false } } });
  assert.strictEqual(J.changesTool(none), null);
});

test("proposed changes are trimmed to known fields and allowed kinds", () => {
  const perms = J.permissions(J.mergePermissions({}, { write: { leagues: false } }));
  const out = J.cleanChanges([
    { kind: "pay_record", leagueId: "L1", teamId: "T1", playerId: "P1", amountRands: "200", evil: "x", why: "paid cash" },
    { kind: "league_set_fee", leagueId: "L1", amountRands: 10 },
    { kind: "delete_everything" },
    { kind: "fix_round_schedule", leagueId: "L1", round: "semis", date: "2026-03-26" },
    { kind: "pay_set_share", leagueId: "L1", teamId: "T1", playerId: "P1", amountRands: null },
    null,
  ], perms);
  assert.deepStrictEqual(out.map((c) => c.kind), ["pay_record", "fix_round_schedule", "pay_set_share"]);
  assert.strictEqual(out[0].amountRands, 200);
  assert.strictEqual(out[0].evil, undefined);
  assert.strictEqual(out[1].round, "semis");
  assert.strictEqual(out[2].amountRands, null);
  assert.strictEqual(J.cleanChanges(new Array(40).fill({ kind: "pay_record" }), perms).length, J.MAX_CHANGES);
});

test("attached photos are checked and put ahead of the words in the newest message", () => {
  const ok = { mediaType: "image/jpeg", data: "QUJD" };
  const imgs = J.cleanImages([ok, { mediaType: "image/svg+xml", data: "QUJD" }, { mediaType: "image/png", data: "not base64!" }, { mediaType: "image/png", data: "A".repeat(2900000) }, ok, ok, ok]);
  assert.strictEqual(imgs.length, 3);
  assert.deepStrictEqual(imgs[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  const turns = J.withImages([{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "read this" }], imgs, "read this");
  assert.strictEqual(turns.length, 3);
  assert.strictEqual(turns[2].content[0].type, "image");
  assert.deepStrictEqual(turns[2].content[turns[2].content.length - 1], { type: "text", text: "read this" });
  assert.strictEqual(turns[0].content, "earlier");
  assert.deepStrictEqual(J.withImages([{ role: "user", content: "hi" }], [], "hi"), [{ role: "user", content: "hi" }]);
});

test("a logo drawing is rebuilt from a short allow-list and anything risky is refused", () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2432f"/><stop offset="1" stop-color="#2b0714"/></linearGradient></defs><circle cx="256" cy="256" r="240" fill="url(#g)"/><text x="256" y="310" font-size="170" font-family="Arial, Helvetica, sans-serif" font-weight="700" text-anchor="middle" fill="#fff">CY</text></svg>';
  const clean = J.cleanSvg(ok);
  assert.ok(clean && clean.startsWith("<svg xmlns=") && clean.includes("<linearGradient") && clean.includes(">CY</text>"));
  const bad = {
    script: ok.replace("<defs>", "<script>alert(1)</script><defs>"),
    handler: ok.replace("<circle", '<circle onload="x()"'),
    image: ok.replace("<defs>", '<image href="http://x/y.png"/><defs>'),
    foreign: ok.replace("<defs>", "<foreignObject><div/></foreignObject><defs>"),
    externalUrl: ok.replace("url(#g)", "url(http://evil/x)"),
    style: ok.replace("<defs>", "<style>*{}</style><defs>"),
    stray: ok.replace("<defs>", "hello<defs>"),
    doctype: "<!DOCTYPE svg>" + ok,
    js: ok.replace("#fff", "javascript:1"),
    unclosed: ok.replace("</text>", ""),
    noViewBox: ok.replace(' viewBox="0 0 512 512"', ""),
    link: ok.replace("<circle", '<circle xlink:href="#g"'),
    styleAttr: ok.replace("<circle", '<circle style="fill:url(http://x)"'),
    use: ok.replace("<defs>", '<use href="#g"/><defs>'),
    entity: ok.replace("CY", "&xxe;"),
    nested: ok.replace("<defs>", '<svg viewBox="0 0 1 1"></svg><defs>'),
  };
  Object.entries(bad).forEach(([k, v]) => assert.strictEqual(J.cleanSvg(v), null, k));
  const sets = J.cleanLogoSets([{ name: "design_logos", input: { leagueId: "L1", teamId: "T1", options: [{ name: "A", svg: ok }, { name: "B", svg: bad.script }] } }], { leagues: [{ id: "L1", teams: [{ id: "T1", name: "Cyclones" }] }] });
  assert.strictEqual(sets[0].options.length, 1);
  assert.strictEqual(sets[0].dropped, 1);
  assert.strictEqual(sets[0].teamName, "Cyclones");
});

test("a logo photo and a team list come through as changes James can propose", () => {
  const perms = J.permissions({});
  const out = J.cleanChanges([
    { kind: "team_add", leagueId: "L1", name: "Falcons", logoImage: 0 },
    { kind: "player_add", leagueId: "L1", teamName: "Falcons", names: [" Ann ", "Bo", "", 7] },
    { kind: "team_logo_set", leagueId: "L1", teamId: "T1", logoImage: 2 },
    { kind: "team_logo_set", leagueId: "L1", teamId: "T1", image: "data:image/png;base64,AAAA" },
    { kind: "team_logo_set", leagueId: "L1", teamId: "T1", logoImage: 9 },
  ], perms);
  assert.deepStrictEqual(out.map((c) => c.kind), ["team_add", "player_add", "team_logo_set"]);
  assert.strictEqual(out[0].logoImage, 0);
  assert.deepStrictEqual(out[1].names, ["Ann", "Bo", "7"]);
  assert.strictEqual(out[1].teamName, "Falcons");
  assert.strictEqual(out[2].logoImage, 2);
  assert.strictEqual(out[2].image, undefined);
});

test("score and court changes keep only well-formed numbers and sides", () => {
  const perms = J.permissions({});
  const out = J.cleanChanges([
    { kind: "score_set", leagueId: "L1", fixtureId: "F1", seed: 2, sets: [[6, 4], ["3", 6], [1, 1], [9, 9]], tb: [10, null] },
    { kind: "score_forfeit", leagueId: "L1", fixtureId: "F1", seed: 3, winner: "A" },
    { kind: "score_forfeit", leagueId: "L1", fixtureId: "F1", seed: 3, winner: "C" },
    { kind: "court_pace", leagueId: "L1", fixtureId: "F1", seed: 1, pace: "long" },
    { kind: "court_pace", leagueId: "L1", fixtureId: "F1", seed: 1, pace: null },
    { kind: "court_start", leagueId: "L1", fixtureId: "F1", seed: 99 },
    { kind: "finalize_fixture", leagueId: "L1", fixtureId: "F1" },
  ], perms);
  assert.deepStrictEqual(out.map((c) => c.kind), ["score_set", "score_forfeit", "score_forfeit", "court_pace", "court_pace", "court_start"]);
  assert.deepStrictEqual(out[0].sets, [[6, 4], [3, 6], [1, 1]]);
  assert.deepStrictEqual(out[0].tb, [10, null]);
  assert.strictEqual(out[1].winner, "A");
  assert.strictEqual(out[2].winner, undefined);
  assert.strictEqual(out[3].pace, "long");
  assert.strictEqual(out[4].pace, null);
  assert.strictEqual(out[5].seed, undefined);
  const off = J.permissions(J.mergePermissions({}, { write: { scores: false, court: false } }));
  assert.deepStrictEqual(J.cleanChanges([{ kind: "score_set", leagueId: "L1", fixtureId: "F1", seed: 1 }, { kind: "court_start", leagueId: "L1", fixtureId: "F1", seed: 1 }], off), []);
});

test("finalizing is its own change kind, controlled by the scores switch", () => {
  const perms = J.permissions({});
  const out = J.cleanChanges([{ kind: "fixture_finalize", leagueId: "L1", fixtureId: "F1", why: "all in" }], perms);
  assert.deepStrictEqual(out, [{ kind: "fixture_finalize", leagueId: "L1", fixtureId: "F1", why: "all in" }]);
  const off = J.permissions(J.mergePermissions({}, { write: { scores: false } }));
  assert.deepStrictEqual(J.cleanChanges([{ kind: "fixture_finalize", leagueId: "L1", fixtureId: "F1" }], off), []);
  const kinds = J.changesTool(perms).input_schema.properties.changes.items.properties.kind.enum;
  assert.ok(kinds.includes("fixture_finalize"));
});
