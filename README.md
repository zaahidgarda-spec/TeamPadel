# Padel League App

A real, self-hosted web app for running team padel leagues: fixtures, a
blind seed-selection room, results entry with proper padel scoring rules,
a league table, knockout stage, team rosters with logos, and a news room.

Unlike the earlier prototype, this has a real backend: passwords are
hashed with bcrypt, sessions are server-side, and "blind" selections are
actually hidden by the server, not just by the UI. Data is stored as
JSON files on disk under `/data` for local development, or in
[Upstash Redis](https://upstash.com) when `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are set — see "Keeping your data safe in
production" below.

## Run it locally first

You'll need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd padel-app
npm install
cp .env.example .env      # then edit SESSION_SECRET to something random
npm start
```

Open `http://localhost:3000`. Create a league, register as admin with
the email you gave it, and go from there.

**Test it thoroughly locally before you rely on it for a real league.**
I wrote and syntax-checked this code but couldn't run it end-to-end
myself in this environment — there's a reasonable chance something needs
a small fix once it's actually exercised. Come back with any error
messages and I'll fix them.

## Deploying it for real

This is a normal Node.js + Express app, so it needs a host that can run
a persistent Node process — not the kind of "upload some HTML" hosting
that domain registrars usually sell by default.

### If you want to stay with GoDaddy

Basic GoDaddy "Web Hosting" plans are built for static sites and PHP,
not Node. To run this app on GoDaddy you'd need either:

- A GoDaddy **VPS or Dedicated Server** plan, where you install Node
  yourself and run the app much like you did locally (typically behind
  a process manager like `pm2` and a reverse proxy like `nginx` for
  HTTPS), or
- A shared hosting plan that specifically offers **cPanel's "Setup
  Node.js App"** tool (not all GoDaddy plans include this — check
  before buying). If it's available, you'd upload this project, point
  cPanel's Node app at `server.js`, set the environment variables from
  `.env.example` in its settings panel, and run `npm install` from its
  built-in terminal.

Either way, you already own the domain — you'd just point its DNS at
wherever the app ends up running.

### Easier alternatives

If GoDaddy's Node support turns out to be a hassle, these are simpler
for exactly this kind of app and still let you keep your GoDaddy domain
(you just point the domain's DNS at them instead):

- **Railway** or **Render** — connect a GitHub repo, both auto-detect
  Node apps, give you a live URL in a couple of minutes, and have free
  tiers for something this size.
- A cheap **VPS** (DigitalOcean, Linode, Hetzner) if you want full
  control — more setup work, same idea as the GoDaddy VPS option above.

Whichever you pick, the steps are the same: get the code onto the
server, run `npm install`, set `SESSION_SECRET` and `NODE_ENV=production`
as environment variables, and start it with `npm start` (a process
manager like `pm2` will keep it running and restart it if it crashes).

### Keeping your data safe in production

By default, data is stored as JSON files on the server's own disk. On
many hosts (including ones that build your app fresh from git each
time, like GoDaddy Airo) that disk gets wiped on every redeploy or
restart — meaning any league you create can vanish the next time you
ship a code change.

To avoid that, set these two environment variables on your host (both,
not just one):

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Get them free from [upstash.com](https://upstash.com): sign up, create
a Redis database, and copy the REST URL and token it gives you. Once
both are set, the app automatically stores and loads league data there
instead of local disk — no code changes needed, and this survives
redeploys. Locally, with those variables unset, it keeps using the
`/data` folder as before, so local dev needs no signup.

## Installing it as an app on your phone

This is a real installable PWA now — no App Store needed for this part.

- **iPhone (Safari)**: open the site, tap the Share icon, tap "Add to Home Screen."
- **Android (Chrome)**: open the site, tap the ⋮ menu, tap "Install app" (or "Add to Home Screen").

It'll get a real icon, open full-screen without browser chrome, and cache
its own interface for fast loading — but it always talks to your live
server for actual league data, so scores and selections are never stale.

This only works once the site is reachable at a stable address (your
phone on the same WiFi via your laptop's local IP, or once it's properly
deployed). If you later want it listed in the App Store or Play Store
directly, the next step is wrapping this same code with a tool called
Capacitor — nothing here needs to be rebuilt for that.

## What's in here

```
server.js          Express app entry point
src/store.js        JSON file read/write helpers
src/auth.js          Password hashing + session middleware
src/logic.js         Fixture generation, scoring rules, validation
src/routes.js         All API endpoints
public/               Frontend (plain HTML/CSS/JS, no build step)
data/                 Created automatically — your league data lives here
```

## Features in this version

- Real bcrypt-hashed passwords; register once per email, then log in
- Multiple leagues, each independently admin-managed
- Round-by-round Selection Room, locked until the previous round is
  finalized, with server-enforced blind submission
- A player can't be paired with themselves, and can't appear in more
  than one rubber in the same night (both rejected server-side)
- Real padel set scoring (6-0 to 6-4, 7-5, 7-6) with a super tie-break
  decider, flagged if a score doesn't match a real pattern
- Knockout stage (semis + final) once the regular season is complete,
  with an automatic decider rubber if a knockout match ties 2-2
- Team rosters with player names and an uploaded, auto-resized logo
- A news room for admin announcements, visible to everyone
- Distinct visual accent per role (admin / captain / guest) so it's
  obvious at a glance which "face" of the site you're looking at
