const test = require("node:test");
const assert = require("node:assert");
const I = require("../src/images");
const J = require("../src/james");

const cfg = { apiKey: "sk-test", model: "m-gen", editModel: "m-edit", capUsd: 15, dailyLimit: 5 };
const okBody = (n) => ({ data: Array.from({ length: n }, (_, i) => ({ b64_json: "QUJD" + i })), usage: { input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 1000 } });
const fakeFetch = (status, body, spy) => async (url, opts) => { if (spy) spy.push({ url, opts }); return { ok: status < 300, status, json: async () => body }; };

test("image config defaults", () => {
  const c = I.config({});
  assert.deepStrictEqual([c.apiKey, c.model, c.editModel, c.capUsd, c.dailyLimit], ["", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", 15, 20]);
  const o = I.config({ OPENAI_API_KEY: " k ", OPENAI_IMAGE_MODEL: "x", JAMES_IMAGE_CAP_USD: "40", JAMES_DAILY_IMAGES: "9" });
  assert.deepStrictEqual([o.apiKey, o.model, o.capUsd, o.dailyLimit], ["k", "x", 40, 9]);
});

test("picture cost comes from the usage OpenAI reports, and errs high when it doesn't", () => {
  assert.ok(Math.abs(I.costUsd({ input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 1000 }, 1) - 0.0305) < 1e-9);
  assert.ok(Math.abs(I.costUsd({ input_tokens: 1100, input_tokens_details: { text_tokens: 100, image_tokens: 1000 }, output_tokens: 0 }, 1) - 0.0085) < 1e-9);
  assert.strictEqual(I.costUsd(null, 2), 0.4);
});

test("a brief with no photo goes to the generations endpoint as JSON; with photos to the edits endpoint", async () => {
  const spy = [];
  const r = await I.generate({ cfg, kind: "logo", prompt: "a red emblem", n: 9, fetchImpl: fakeFetch(200, okBody(3), spy) });
  assert.strictEqual(spy[0].url, "https://api.openai.com/v1/images/generations");
  const body = JSON.parse(spy[0].opts.body);
  assert.deepStrictEqual([body.model, body.n, body.background, body.output_format, body.size], ["m-gen", 3, "transparent", "png", "1024x1024"]);
  assert.strictEqual(spy[0].opts.headers.Authorization, "Bearer sk-test");
  assert.strictEqual(r.images.length, 3);
  assert.ok(r.images[0].startsWith("data:image/png;base64,"));
  const spy2 = [];
  const r2 = await I.generate({ cfg, kind: "kit_front", prompt: "a shirt", n: 1, refs: ["data:image/png;base64,QUJD", "javascript:1"], fetchImpl: fakeFetch(200, okBody(1), spy2) });
  assert.strictEqual(spy2[0].url, "https://api.openai.com/v1/images/edits");
  assert.strictEqual(spy2[0].opts.body.get("model"), "m-edit");
  assert.strictEqual(spy2[0].opts.body.getAll("image[]").length, 1);
  assert.ok(r2.images[0].startsWith("data:image/jpeg;base64,"));
});

test("image failures are explained in plain words", async () => {
  const run = (status, error) => I.generate({ cfg, kind: "logo", prompt: "x", n: 1, fetchImpl: fakeFetch(status, { error }) });
  await assert.rejects(() => I.generate({ cfg: { ...cfg, apiKey: "" }, kind: "logo", prompt: "x", n: 1 }), /OPENAI_API_KEY/);
  await assert.rejects(() => run(401, { message: "bad" }), /key was rejected/);
  await assert.rejects(() => run(403, { message: "Your organization must be verified" }), /verified/);
  await assert.rejects(() => run(400, { code: "moderation_blocked", message: "x" }), /wouldn't draw/);
  await assert.rejects(() => run(429, { message: "slow" }), /busy or out of credit/);
  await assert.rejects(() => I.generate({ cfg, kind: "logo", prompt: "x", n: 1, fetchImpl: async () => { throw new Error("down"); } }), /Couldn't reach/);
});

test("picture briefs from Claude are checked and trimmed", () => {
  const ctx = { leagues: [{ id: "L1", teams: [{ id: "T1", name: "Cyclones" }] }] };
  const plans = J.cleanImagePlans([
    { name: "plan_image", input: { kind: "logo", prompt: "A flat red emblem on a transparent background", leagueId: "L1", teamId: "T1", variants: 9, refPhotos: [0, 7, -1, "x"] } },
    { name: "plan_image", input: { kind: "kit_front", prompt: "short" } },
    { name: "plan_image", input: { kind: "poster", prompt: "A long enough prompt for the check" } },
    { name: "draft_messages", input: {} },
  ], ctx);
  assert.strictEqual(plans.length, 1);
  assert.deepStrictEqual([plans[0].variants, plans[0].teamName, plans[0].refPhotos], [3, "Cyclones", [0]]);
});

test("picture spending has its own monthly cap and daily count", () => {
  const now = Date.UTC(2026, 2, 10, 10);
  const u = { months: {}, days: {} };
  J.recordImageUsage(u, "ZG", 2, 3, now);
  const s = J.imageSummary(u, "ZG", { capUsd: 15, dailyLimit: 5 }, now);
  assert.deepStrictEqual([s.monthCostUsd, s.monthCount, s.todayCount], [2, 3, 3]);
  assert.throws(() => J.checkImageLimits(u, "ZG", { capUsd: 15, dailyLimit: 5 }, 3, now), /limit of 5/);
  J.checkImageLimits(u, "ID", { capUsd: 15, dailyLimit: 5 }, 3, now);
  J.recordImageUsage(u, "ID", 20, 1, now);
  assert.throws(() => J.checkImageLimits(u, "JN", { capUsd: 15, dailyLimit: 5 }, 1, now), /spending cap/);
});

test("a picture brief can ask Leo to start from the team's saved logo and kit", () => {
  const ctx = { leagues: [{ id: "L1", teams: [{ id: "T1", name: "Cyclones" }] }] };
  const [a] = J.cleanImagePlans([{ name: "plan_image", input: { kind: "kit_back", prompt: "The back of the same dark shirt, plain.", leagueId: "L1", teamId: "T1", useTeamImages: ["kit_front", "logo", "bogus", "logo", "kit_back", "logo"] } }], ctx);
  assert.deepStrictEqual(a.teamRefs, ["kit_front", "logo", "kit_back"]);
  const [b] = J.cleanImagePlans([{ name: "plan_image", input: { kind: "logo", prompt: "A bold emblem on transparent.", useTeamImages: ["logo"] } }], ctx);
  assert.deepStrictEqual(b.teamRefs, []);
});
