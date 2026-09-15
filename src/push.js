const webpush = require("web-push");

// Lazily configured (not at module load) so a deploy that hasn't set the
// VAPID env vars yet just no-ops here, exactly like mailer.js already does
// when GMAIL_USER/GMAIL_APP_PASSWORD are missing — never a hard crash.
let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    "mailto:" + (process.env.GMAIL_USER || "support@teampadelsports.com"),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

// Sends the same payload to every subscription independently — one
// dead/expired subscription (the browser unsubscribed on its own end, the
// push service returns 404/410) never blocks the others. Deliberately takes
// a plain array of subscriptions rather than a team or league, so any future
// caller (an owner-facing subscription store, say) can reuse this without
// this function knowing anything about where subscriptions are stored.
// `errors` (any failure, keyed by endpoint) is separate from `deadEndpoints`
// (specifically 404/410 — gone, safe to prune) so notify()'s fire-and-forget
// send can keep ignoring ordinary errors exactly as before, while a caller
// that actually wants to know what went wrong (the push-test route, a
// deliberate one-off diagnostic) can surface them instead of them only ever
// reaching the server log.
async function sendPushToSubscriptions(subscriptions, payload) {
  if (!ensureConfigured() || !subscriptions || !subscriptions.length) return { deadEndpoints: [], errors: [] };
  const body = JSON.stringify(payload);
  const deadEndpoints = [];
  const errors = [];
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) deadEndpoints.push(sub.endpoint);
        else console.error("Push send failed:", e.message);
        errors.push({ endpoint: sub.endpoint, message: e.message });
      }
    })
  );
  return { deadEndpoints, errors };
}

function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

module.exports = { sendPushToSubscriptions, getVapidPublicKey };
