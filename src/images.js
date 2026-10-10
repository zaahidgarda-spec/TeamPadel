/* global FormData, Blob */
// The image maker behind James: OpenAI's image models draw logos and kit designs.
//
// Claude stays in charge. He understands the request, looks at the league data and
// writes the brief; this file only turns a brief the admin has seen (and may have
// edited) into pictures. Nothing here touches the league's data. Choosing one of
// the pictures to use is a separate step that goes through James's confirm, log
// and undo.

const GENERATE_URL = "https://api.openai.com/v1/images/generations";
const EDIT_URL = "https://api.openai.com/v1/images/edits";

// US dollars per million tokens (OpenAI's published rates for the gpt-image-2.5 models).
const RATES = { textIn: 5, imageIn: 8, out: 30 };
const FALLBACK_PER_IMAGE = 0.2; // used only if OpenAI doesn't report usage; errs high

function config(env = process.env) {
  const cap = Number(env.JAMES_IMAGE_CAP_USD);
  const daily = Number(env.JAMES_DAILY_IMAGES);
  return {
    apiKey: String(env.OPENAI_API_KEY || "").trim(),
    model: String(env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare").trim(),
    editModel: String(env.OPENAI_IMAGE_EDIT_MODEL || "gpt-image-2.5-sunburst").trim(),
    capUsd: Number.isFinite(cap) && cap > 0 ? cap : 15,
    dailyLimit: Number.isFinite(daily) && daily > 0 ? Math.floor(daily) : 20,
  };
}

function costUsd(usage, n) {
  if (!usage || (!usage.output_tokens && !usage.input_tokens)) return FALLBACK_PER_IMAGE * Math.max(1, n || 1);
  const d = usage.input_tokens_details || {};
  const imgIn = d.image_tokens || 0;
  const txtIn = d.text_tokens !== undefined ? d.text_tokens : Math.max(0, (usage.input_tokens || 0) - imgIn);
  return (txtIn * RATES.textIn + imgIn * RATES.imageIn + (usage.output_tokens || 0) * RATES.out) / 1e6;
}

class ImageError extends Error {
  constructor(message, status) { super(message); this.status = status || 502; }
}

const KINDS = {
  logo: { size: "1024x1024", background: "transparent", format: "png" },
  kit_front: { size: "1024x1536", background: "opaque", format: "jpeg" },
  kit_back: { size: "1024x1536", background: "opaque", format: "jpeg" },
  artwork: { size: "1024x1024", background: "auto", format: "jpeg" },
};

// One request to OpenAI. `refs` are the admin's own photos (data URLs) used as a
// starting point, which switches to the editing endpoint. `fetchImpl` is injectable for tests.
async function generate({ cfg, kind, prompt, n, refs, fetchImpl = fetch, timeoutMs = 120000 }) {
  if (!cfg.apiKey) throw new ImageError("The image maker isn't connected yet. Add OPENAI_API_KEY to your host's Secrets, then publish.", 503);
  const k = KINDS[kind] || KINDS.artwork;
  const count = Math.max(1, Math.min(3, Math.floor(n) || 1));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    if (refs && refs.length) {
      const form = new FormData();
      form.append("model", cfg.editModel);
      form.append("prompt", prompt);
      form.append("n", String(count));
      form.append("size", k.size);
      form.append("output_format", k.format);
      if (k.format === "jpeg") form.append("output_compression", "85");
      refs.forEach((r, i) => {
        const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(r);
        if (!m) return;
        form.append("image[]", new Blob([Buffer.from(m[2], "base64")], { type: m[1] }), `ref${i}.${m[1].split("/")[1] === "jpeg" ? "jpg" : m[1].split("/")[1]}`);
      });
      res = await fetchImpl(EDIT_URL, { method: "POST", headers: { Authorization: "Bearer " + cfg.apiKey }, body: form, signal: ctl.signal });
    } else {
      const body = { model: cfg.model, prompt, n: count, size: k.size, background: k.background, output_format: k.format };
      if (k.format === "jpeg") body.output_compression = 85;
      res = await fetchImpl(GENERATE_URL, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + cfg.apiKey }, body: JSON.stringify(body), signal: ctl.signal });
    }
  } catch (e) {
    throw new ImageError(e && e.name === "AbortError" ? "The image maker took too long. Try again." : "Couldn't reach the image maker. Check the connection and try again.", 504);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? String(data.error.message) : "";
    const code = data && data.error && (data.error.code || data.error.type) ? String(data.error.code || data.error.type) : "";
    if (res.status === 401) throw new ImageError("The image maker's API key was rejected. Check OPENAI_API_KEY.", 502);
    if (res.status === 403 || /verif/i.test(msg)) throw new ImageError("OpenAI needs your organisation verified before it will make images. Do that in the OpenAI developer console, then try again.", 502);
    if (/moderation|safety|content_policy/i.test(code + " " + msg)) throw new ImageError("The image maker wouldn't draw that. Change the wording and try again.", 400);
    if (res.status === 429) throw new ImageError("The image maker is busy or out of credit. Try again in a minute, or top up the OpenAI account.", 503);
    throw new ImageError(`The image maker returned an error (${res.status}). ${msg.slice(0, 160)}`.trim(), 502);
  }
  const mime = k.format === "png" ? "image/png" : "image/jpeg";
  const images = ((data && data.data) || []).filter((d) => d && typeof d.b64_json === "string").map((d) => `data:${mime};base64,${d.b64_json}`);
  if (!images.length) throw new ImageError("The image maker didn't return a picture. Try again.", 502);
  return { images, usage: (data && data.usage) || null, cost: costUsd(data && data.usage, images.length), model: refs && refs.length ? cfg.editModel : cfg.model };
}

module.exports = { config, costUsd, generate, ImageError, KINDS, RATES };
