// "Continue with Google / Facebook" — the provider side only: which providers
// are switched on, where to send someone to approve, and how to turn the code
// they come back with into a verified name + email. What happens to the
// person after that (finding or creating their account) lives in routes.js
// next to the rest of the account code.
//
// A provider is on only when its credentials are set, so nothing shows up in
// the UI (and nothing can be started) until they are:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   FACEBOOK_APP_ID  / FACEBOOK_APP_SECRET
const PROVIDERS = {
  google: {
    label: "Google",
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  facebook: {
    label: "Facebook",
    id: () => process.env.FACEBOOK_APP_ID,
    secret: () => process.env.FACEBOOK_APP_SECRET,
    authUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "email,public_profile",
  },
};

function isEnabled(name) {
  const p = PROVIDERS[name];
  return !!(p && p.id() && p.secret());
}
function enabledProviders() {
  return Object.keys(PROVIDERS).filter(isEnabled);
}
function label(name) { return PROVIDERS[name] ? PROVIDERS[name].label : name; }

function buildAuthUrl(name, { redirectUri, state }) {
  const p = PROVIDERS[name];
  const q = new URLSearchParams({ client_id: p.id(), redirect_uri: redirectUri, response_type: "code", scope: p.scope, state });
  if (name === "google") q.set("prompt", "select_account");
  return p.authUrl + "?" + q.toString();
}

async function json(res) {
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data) throw new Error("The sign-in provider didn't accept that. Please try again.");
  return data;
}

// Exchanges the one-time code for the person's profile. `emailVerified` is
// what the rest of the app relies on before it links a sign-in to an account
// that already exists under that email.
async function fetchProfile(name, { code, redirectUri }) {
  const p = PROVIDERS[name];
  if (name === "google") {
    const token = await json(await fetch(p.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: p.id(), client_secret: p.secret(), redirect_uri: redirectUri, grant_type: "authorization_code" }),
    }));
    const u = await json(await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + token.access_token } }));
    return { subject: String(u.sub), email: u.email || "", emailVerified: u.email_verified === true, name: u.name || "" };
  }
  const token = await json(await fetch(p.tokenUrl + "?" + new URLSearchParams({ client_id: p.id(), client_secret: p.secret(), redirect_uri: redirectUri, code })));
  const u = await json(await fetch("https://graph.facebook.com/me?" + new URLSearchParams({ fields: "id,name,email", access_token: token.access_token })));
  // Facebook only hands back an address it has itself confirmed, and leaves
  // it out entirely when the person hasn't shared one.
  return { subject: String(u.id), email: u.email || "", emailVerified: !!u.email, name: u.name || "" };
}

module.exports = { enabledProviders, isEnabled, label, buildAuthUrl, fetchProfile };
