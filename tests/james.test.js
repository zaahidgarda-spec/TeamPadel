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
  const none = J.permissions({ permissions: { write: { notes: false, payments: false, fixtures: false, leagues: false, players: false } } });
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
