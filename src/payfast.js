const crypto = require("crypto");
const https = require("https");
const querystring = require("querystring");

// PayFast publishes this exact merchant id/key/passphrase for sandbox
// testing — no signup needed, and sandbox transactions can never touch
// real money. Used as the default so the whole checkout+notify flow works
// with zero configuration; verified end-to-end against PayFast's real
// sandbox (a genuine 302 to a live sandbox checkout page) while building
// this — the passphrase is required, not optional, despite some
// third-party docs omitting it. A real league only goes live once BOTH
// real credentials are set AND sandbox mode is explicitly turned off.
const SANDBOX_MERCHANT_ID = "10000100";
const SANDBOX_MERCHANT_KEY = "46f0cd694581a";
const SANDBOX_PASSPHRASE = "jt7NOE43FZPn";

function config() {
  const hasRealCreds = !!(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY);
  const explicitlyLive = process.env.PAYFAST_SANDBOX === "false";
  // Missing either real credentials or the explicit live opt-in falls back
  // to the sandbox — a half-configured env can never accidentally go live.
  const sandbox = !(hasRealCreds && explicitlyLive);
  return {
    sandbox,
    merchantId: hasRealCreds ? process.env.PAYFAST_MERCHANT_ID : SANDBOX_MERCHANT_ID,
    merchantKey: hasRealCreds ? process.env.PAYFAST_MERCHANT_KEY : SANDBOX_MERCHANT_KEY,
    passphrase: hasRealCreds ? (process.env.PAYFAST_PASSPHRASE || "") : SANDBOX_PASSPHRASE,
    processUrl: sandbox ? "https://sandbox.payfast.co.za/eng/process" : "https://www.payfast.co.za/eng/process",
    validateUrl: sandbox ? "https://sandbox.payfast.co.za/eng/query/validate" : "https://www.payfast.co.za/eng/query/validate",
  };
}

// PayFast's own server regenerates this signature with PHP's urlencode(),
// which escapes ! ' ( ) * ~ that JS's encodeURIComponent leaves as literal
// unreserved characters — those five plus space-as-"+" are the only gap
// between the two encoders for URL-safe input, but a single unescaped one
// anywhere in a name/item description is enough to break the whole
// signature match, so it has to be patched here explicitly.
function phpUrlEncode(str) {
  return encodeURIComponent(str)
    .replace(/%20/g, "+")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A")
    .replace(/~/g, "%7E");
}
// PayFast's signature: MD5 of every non-empty field urlencoded (PHP-style,
// see phpUrlEncode) as key=value&key=value in the order given (not
// alphabetical — insertion order is what PayFast itself signs), passphrase
// appended last only if one is configured.
function sign(fields, passphrase) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${phpUrlEncode(String(v).trim())}`);
  let str = parts.join("&");
  if (passphrase) str += `&passphrase=${phpUrlEncode(passphrase.trim())}`;
  return crypto.createHash("md5").update(str).digest("hex");
}

// Everything a <form method="post"> needs to redirect the browser to
// PayFast's own hosted checkout page — PayFast requires an actual browser
// form submission here, not a server-side API call.
function buildCheckout({ amountRands, itemName, returnUrl, cancelUrl, notifyUrl, customStr1, customStr2, customStr3 }) {
  const cfg = config();
  const fields = {
    merchant_id: cfg.merchantId,
    merchant_key: cfg.merchantKey,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    amount: amountRands.toFixed(2),
    item_name: itemName,
    custom_str1: customStr1,
    custom_str2: customStr2,
    custom_str3: customStr3,
  };
  const signature = sign(fields, cfg.passphrase);
  return { action: cfg.processUrl, sandbox: cfg.sandbox, fields: { ...fields, signature } };
}

// Recomputes the signature over the fields PayFast actually posted to the
// notify_url (everything except "signature" itself) and compares.
function verifySignature(fields) {
  const cfg = config();
  const { signature, ...rest } = fields;
  return !!signature && sign(rest, cfg.passphrase) === signature;
}

// PayFast's own documented anti-spoofing step: post the exact raw ITN body
// straight back to their validate endpoint and require the literal string
// "VALID" — confirms this notification really came from PayFast, not
// something forged to look like one.
function validateWithPayfast(rawBody) {
  return new Promise((resolve) => {
    const cfg = config();
    const url = new URL(cfg.validateUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(rawBody) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data.trim() === "VALID"));
      }
    );
    req.on("error", () => resolve(false));
    req.write(rawBody);
    req.end();
  });
}

function parseItnBody(rawBody) {
  return querystring.parse(rawBody.toString("utf8"));
}

module.exports = { config, buildCheckout, verifySignature, validateWithPayfast, parseItnBody };
