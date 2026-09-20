const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  // Short timeouts: on a host that blocks outgoing mail connections the
  // default (minutes) leaves the request hanging until the gateway gives up
  // with a generic error, instead of us reporting what actually happened.
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

// True when this server can actually send — lets the app say "email isn't
// set up here" instead of pretending a test went out.
function isConfigured() {
  return !!process.env.EMAIL_DRY_RUN || !!process.env.BREVO_API_KEY || !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

// Sending through Brevo's web API (plain HTTPS, like any other request the
// server makes) instead of an SMTP connection. Some hosts — this one, it
// turned out — don't let a server open outgoing mail connections at all, so
// Gmail-over-SMTP can never work there whatever the password. Used whenever
// BREVO_API_KEY is set; the sender is EMAIL_FROM, or GMAIL_USER if that's
// all that's set, and must be a sender verified in the Brevo account.
async function sendViaBrevo({ to, subject, text, html }) {
  const from = process.env.EMAIL_FROM || process.env.GMAIL_USER;
  if (!from) return { sent: false, code: "BREVO_NO_SENDER", reason: "no sender address set" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Team Padel", email: from }, to: [{ email: to }], subject, textContent: text, ...(html ? { htmlContent: html } : {}) }),
      signal: controller.signal,
    });
    if (res.ok) return { sent: true };
    let detail = "";
    try { detail = ((await res.json()) || {}).message || ""; } catch { /* no body */ }
    console.error("Email send failed (Brevo):", res.status, detail);
    return { sent: false, code: res.status === 401 ? "BREVO_AUTH" : /sender/i.test(detail) ? "BREVO_SENDER" : "BREVO_" + res.status, reason: detail || "HTTP " + res.status };
  } catch (e) {
    console.error("Email send failed (Brevo):", e.message);
    return { sent: false, code: "ETIMEDOUT", reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMail({ to, subject, text, html }) {
  // EMAIL_DRY_RUN=1 logs what would be sent instead of sending it — for
  // trying things out locally without emailing anyone real.
  if (process.env.EMAIL_DRY_RUN) {
    console.log(`[email dry-run] to=${to} subject=${JSON.stringify(subject)}`);
    return { sent: true, dryRun: true };
  }
  if (process.env.BREVO_API_KEY) return sendViaBrevo({ to, subject, text, html });
  const t = getTransporter();
  if (!t) {
    console.log("Email not sent (GMAIL_USER/GMAIL_APP_PASSWORD not set) — would have gone to " + to);
    return { sent: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({ from: `"Team Padel" <${process.env.GMAIL_USER}>`, to, subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error("Email send failed:", e.code || "", e.message);
    return { sent: false, reason: e.message, code: e.code || "" };
  }
}

const SITE_URL = (process.env.PUBLIC_URL || "https://teampadelsports.com").replace(/\/$/, "");

// What each kind of notification is called in a subject line — the raw type
// ("selection_unlock") is an internal name, not something to put in front
// of a person.
const EMAIL_TYPE_LABELS = {
  selection: "Line-ups",
  selection_unlock: "Line-up change request",
  timeslot: "Court & playing order",
  lineup_reminder: "Line-up due",
  news: "News room",
  potw: "Pair of the Week",
  forfeit: "Forfeit",
  test: "Test email",
};
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// The subject, plain text and HTML for one notification email. The link
// opens straight into the league it's about.
function buildNotificationEmail({ leagueName, leagueId, type, message, teamName }) {
  const label = EMAIL_TYPE_LABELS[type] || String(type || "Update").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const link = leagueId ? `${SITE_URL}/#league/${leagueId}` : SITE_URL;
  const subject = `${leagueName} · ${label}`;
  const text = `${message}\n\nOpen Team Padel: ${link}\n\nYou get these because you manage ${teamName || "a team"} on Team Padel. Turn them off any time in My Profile → Notifications.`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F3F5F9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#12203A;">
<tr><td style="background:#0B1424;padding:16px 22px;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:.12em;">TEAM PADEL</td></tr>
<tr><td style="padding:24px 22px 8px;">
<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;">${escapeHtml(leagueName)} &middot; ${escapeHtml(label)}</div>
<p style="font-size:16px;line-height:1.5;margin:10px 0 0;">${escapeHtml(message)}</p>
</td></tr>
<tr><td style="padding:18px 22px 26px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px;">Open Team Padel</a></td></tr>
<tr><td style="padding:14px 22px;border-top:1px solid #E3E9F4;font-size:11.5px;line-height:1.5;color:#64748B;">You get these because you manage ${escapeHtml(teamName || "a team")} on Team Padel. Turn them off any time in My Profile &rarr; Notifications.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

// A plain-English reason for a failed send, for the person who pressed
// "Send test email" — so the fix is obvious from the screen.
function explainSendFailure(result) {
  const code = (result && result.code) || "";
  const why = String((result && result.reason) || "");
  if (code === "BREVO_AUTH") {
    const detail = /ip/i.test(why) ? " Brevo says the server's address isn't on its allowed list — in Brevo, open Security → Authorised IPs and turn the restriction off." : why ? " Brevo says: " + why.slice(0, 160) : "";
    return "The email service refused the API key." + detail + " Also check BREVO_API_KEY on the server: it must be the API key (starts xkeysib-), pasted whole, with no spaces.";
  }
  if (code === "BREVO_SENDER" || code === "BREVO_NO_SENDER") return "The email service doesn't accept that sender address yet. Verify it in Brevo (Senders) and check EMAIL_FROM matches it exactly.";
  if (code === "EAUTH" || /535|Invalid login|Username and Password/i.test(why)) return "Gmail refused the login. The Gmail app password saved on the server is wrong or has been revoked — make a new one and update it.";
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code) || /timeout|timed out|ECONN|getaddrinfo/i.test(why)) return process.env.BREVO_API_KEY ? "The server couldn't reach the email service just now. Nothing was sent — try again in a minute." : "The server couldn't reach Gmail — the hosting may be blocking outgoing email. Nothing was sent.";
  return "The email couldn't be sent (" + (code || why.slice(0, 80) || "unknown reason") + ").";
}

module.exports = { sendMail, isConfigured, buildNotificationEmail, explainSendFailure };
