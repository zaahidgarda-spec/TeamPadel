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

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.log("Email not sent (GMAIL_USER/GMAIL_APP_PASSWORD not set) — would have gone to " + to);
    return { sent: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({ from: process.env.GMAIL_USER, to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error("Email send failed:", e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendMail };
