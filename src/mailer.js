const nodemailer = require("nodemailer");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

// True when this server can actually send — lets the app say "email isn't
// set up here" instead of pretending a test went out.
function isConfigured() {
  return !!process.env.EMAIL_DRY_RUN || !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function sendMail({ to, subject, text, html }) {
  // EMAIL_DRY_RUN=1 logs what would be sent instead of sending it — for
  // trying things out locally without emailing anyone real.
  if (process.env.EMAIL_DRY_RUN) {
    console.log(`[email dry-run] to=${to} subject=${JSON.stringify(subject)}`);
    return { sent: true, dryRun: true };
  }
  const t = getTransporter();
  if (!t) {
    console.log("Email not sent (GMAIL_USER/GMAIL_APP_PASSWORD not set) — would have gone to " + to);
    return { sent: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({ from: `"Team Padel" <${process.env.GMAIL_USER}>`, to, subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error("Email send failed:", e.message);
    return { sent: false, reason: e.message };
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

module.exports = { sendMail, isConfigured, buildNotificationEmail };
