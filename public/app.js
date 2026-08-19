let leaguesIndex = [];
let currentLeagueId = null;
let league = null;
let myRole = "guest";
let myTeamId = null;
let viewingKey = null;
let myNotifications = [];
let isOwner = false;

function el(id) { return document.getElementById(id); }
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str == null ? "" : str; return d.innerHTML; }
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
}
function fmtTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "";
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + String(m).padStart(2, "0") + " " + period;
}
function teamById(id) { return league.teams.find((t) => t.id === id); }
function playerById(team, id) { return team ? team.players.find((p) => p.id === id) : null; }
// Matches a league's name against the two branded leagues (Premier League,
// Business Class) so their header/logo/card styling stays in sync wherever
// the league name is edited — no separate "brand" field to keep up to date.
function leagueBrand(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("premier league")) return { logo: "/images/league-premier-league.png", theme: "league-theme-premier", alt: "Team Padel Premier League" };
  if (n.includes("business class")) return { logo: "/images/league-business-class.png", theme: "league-theme-business", alt: "Team Padel Business Class" };
  return null;
}
function avatarHtml(t) {
  if (t && t.logo) return `<img class="avatar" src="${t.logo}" alt="">`;
  const initial = t ? t.name.charAt(0).toUpperCase() : "?";
  return `<span class="avatar-fb">${escapeHtml(initial)}</span>`;
}
function isGoldPlayer(p) { return !!(league && league.tieringEnabled && p && p.gold); }
function goldPrefix(p) { return isGoldPlayer(p) ? "★ " : ""; }
function goldNameHtml(p) {
  if (!p) return "";
  return isGoldPlayer(p) ? `<span class="gold-name">★ ${escapeHtml(p.name)}</span>` : escapeHtml(p.name);
}
function pairNamesGoldHtml(team, pair) {
  if (!pair) return "—";
  const html = [playerById(team, pair[0]), playerById(team, pair[1])].filter(Boolean).map((p) => goldNameHtml(p)).join(" & ");
  return html || "—";
}
function playerNamesForGold(team, pair) {
  if (!pair) return "—";
  const names = [playerById(team, pair[0]), playerById(team, pair[1])].filter(Boolean).map((p) => goldPrefix(p) + p.name).join(" & ");
  return names || "—";
}

async function api(path, opts) {
  const res = await fetch("/api" + path, {
    method: (opts && opts.method) || "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || "Something went wrong.");
    if (data && data.needsConfirm) err.needsConfirm = true;
    throw err;
  }
  return data;
}

async function boot() {
  leaguesIndex = await api("/leagues").catch(() => []);
  el("loading").style.display = "none";
  el("app").style.display = "block";
  const m = window.location.hash.match(/^#league\/(.+)$/);
  if (m && leaguesIndex.find((l) => l.id === m[1])) {
    await openLeague(m[1]);
  } else {
    showHub();
  }
}

function showHub() {
  currentLeagueId = null; league = null; myRole = "guest"; myTeamId = null;
  window.location.hash = "";
  el("view-hub").style.display = "block";
  el("view-league").style.display = "none";
  document.body.className = "role-guest";
  refreshOwnerStatus();
  renderHub();
}
function leagueCardHtml(l) {
  // Setup-phase leagues are a teaser for the public — visible, but only the
  // owner (who's actually building it) can click through.
  const locked = l.status === "setup" && !isOwner;
  const statusLabel = l.status === "active" ? "Active" : locked ? "Coming soon" : "In setup";
  const teams = l.teams || [];
  const maxShown = 8;
  const shown = teams.slice(0, maxShown);
  const overflow = teams.length - shown.length;
  const logos = shown.length
    ? `<div class="league-card-logos">${shown.map((t) => avatarHtml(t)).join("")}${overflow > 0 ? `<span class="avatar-fb">+${overflow}</span>` : ""}</div>`
    : "";
  const brand = leagueBrand(l.name);
  const nameHtml = brand
    ? `<img class="league-card-logo" src="${brand.logo}" alt="${brand.alt}">`
    : `<span class="league-card-name">${escapeHtml(l.name)}</span>`;
  return `<div class="league-card${brand ? " " + brand.theme : ""}${locked ? " league-card-locked" : ""}" data-id="${l.id}"${locked ? ' data-locked="1"' : ""}>
    <div class="league-card-top">
      ${nameHtml}
      <span class="tag league-status-${l.status}">${statusLabel}</span>
    </div>
    ${logos}
    <div class="league-card-meta">
      <span>${l.teamCount} team${l.teamCount === 1 ? "" : "s"}</span>
      <span>Created ${new Date(l.createdAt).toLocaleDateString()}</span>
    </div>
    ${isOwner ? '<button class="link league-copy-codes-btn" type="button">Copy codes</button>' : ""}
  </div>`;
}
function renderHub() {
  renderInterestLeagueOptions();
  const list = el("league-list");
  list.innerHTML = "";
  if (leaguesIndex.length === 0) { list.innerHTML = '<p class="empty">No leagues yet — create one above.</p>'; return; }
  const sorted = leaguesIndex.slice().sort((a, b) => b.createdAt - a.createdAt);
  const groups = [
    { key: "active", label: "Active leagues" },
    { key: "setup", label: isOwner ? "In setup" : "Coming soon" },
  ];
  groups.forEach((g) => {
    const items = sorted.filter((l) => l.status === g.key);
    if (items.length === 0) return;
    const section = document.createElement("div");
    section.className = "league-group";
    section.innerHTML = `<h3 class="league-group-title">${g.label}</h3><div class="league-grid">${items.map(leagueCardHtml).join("")}</div>`;
    list.appendChild(section);
  });
  list.querySelectorAll(".league-card").forEach((card) => {
    if (!card.dataset.locked) card.onclick = () => openLeague(card.dataset.id);
    const copyBtn = card.querySelector(".league-copy-codes-btn");
    if (copyBtn) {
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        const full = await api(`/leagues/${card.dataset.id}`).catch(() => null);
        if (!full || full.teams.length === 0) return;
        const text = full.teams.map((t) => t.name + ": " + (t.code || "—")).join("\n");
        navigator.clipboard.writeText(text).then(() => {
          const original = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = original; }, 1500);
        }).catch(() => alert("Couldn't copy — your browser may be blocking clipboard access."));
      };
    }
  });
}
el("create-league-btn").onclick = async () => {
  const name = el("new-league-name").value.trim();
  const email = el("new-league-admin-email").value.trim();
  if (!name) return alert("Give the league a name.");
  if (!email || !email.includes("@")) return alert("Enter a valid email.");
  try {
    const { id } = await api("/leagues", { method: "POST", body: { name, adminEmail: email } });
    el("new-league-name").value = ""; el("new-league-admin-email").value = "";
    leaguesIndex = await api("/leagues");
    await openLeague(id);
  } catch (e) { alert(e.message); }
};
el("back-to-hub").onclick = async () => { leaguesIndex = await api("/leagues").catch(() => leaguesIndex); showHub(); };

/* ---------- "Interested in joining a league?" signup form ---------- */

function renderInterestLeagueOptions() {
  const select = el("interest-league");
  const current = select.value;
  select.innerHTML = '<option value="">Which league?</option>' +
    leaguesIndex.map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join("") +
    '<option value="Not sure / new league">Not sure / new league</option>';
  select.value = current;
}
el("interest-submit-btn").onclick = async () => {
  const name = el("interest-name").value.trim();
  const contactNumber = el("interest-contact").value.trim();
  const email = el("interest-email").value.trim();
  const playtomicLevel = el("interest-playtomic-level").value.trim();
  const league_ = el("interest-league").value;
  const joinAs = el("interest-join-as").value;
  el("interest-error").textContent = "";
  el("interest-success").style.display = "none";
  try {
    await api("/interest", { method: "POST", body: { name, contactNumber, email, playtomicLevel, league: league_, joinAs } });
    el("interest-name").value = ""; el("interest-contact").value = ""; el("interest-email").value = "";
    el("interest-playtomic-level").value = ""; el("interest-league").value = ""; el("interest-join-as").value = "";
    el("interest-success").style.display = "block";
  } catch (e) { el("interest-error").textContent = e.message; }
};

/* ---------- Hub tabs (Leagues / Admin) ---------- */

document.querySelectorAll(".hub-tab-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".hub-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".hub-view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("hub-view-" + btn.dataset.hubview).classList.add("active");
  };
});

/* ---------- Captain login from the home page (no need to find your league first) ---------- */

el("hub-captain-login-btn").onclick = async () => {
  const code = el("hub-captain-code").value;
  const email = el("hub-captain-email").value;
  try {
    const { leagueId } = await api("/captain-login", { method: "POST", body: { code, email } });
    el("hub-captain-code").value = ""; el("hub-captain-email").value = ""; el("hub-captain-error").textContent = "";
    await openLeague(leagueId);
  } catch (e) { el("hub-captain-error").textContent = e.message; }
};

/* ---------- Site owner login (gates who can create leagues) ---------- */

async function refreshOwnerStatus() {
  const status = await api("/owner/me").catch(() => ({ isOwner: false }));
  isOwner = !!status.isOwner;
  el("create-league-card").style.display = isOwner ? "block" : "none";
  el("owner-login-card").style.display = isOwner ? "none" : "block";
  el("interest-signups-card").style.display = isOwner ? "block" : "none";
  if (isOwner) renderInterestSignups();
  renderHub();
}
async function renderInterestSignups() {
  const signups = await api("/interest").catch(() => []);
  const c = el("interest-signups-list");
  if (signups.length === 0) { c.innerHTML = '<p class="empty">No signups yet.</p>'; return; }
  c.innerHTML = signups.map((s) => `
    <div class="notif-row" data-id="${s.id}">
      <div>
        <strong>${escapeHtml(s.name)}</strong> — ${s.joinAs === "team" ? "Full team" : "Individual player"}${s.league ? " · " + escapeHtml(s.league) : ""}
        <div class="note">${escapeHtml(s.contactNumber || "—")} · ${escapeHtml(s.email || "—")}${s.playtomicLevel ? " · Playtomic " + escapeHtml(s.playtomicLevel) : ""}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <time class="notif-time">${new Date(s.createdAt).toLocaleString()}</time>
        <button class="link interest-remove-btn" type="button">Remove</button>
      </div>
    </div>
  `).join("");
  c.querySelectorAll(".interest-remove-btn").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest(".notif-row").dataset.id;
      await api(`/interest/${id}`, { method: "DELETE" }).catch(() => {});
      renderInterestSignups();
    };
  });
}
el("owner-login-btn").onclick = async () => {
  const username = el("owner-username").value, pin = el("owner-pin").value;
  try {
    await api("/owner/login", { method: "POST", body: { username, pin } });
    el("owner-username").value = ""; el("owner-pin").value = ""; el("owner-error").textContent = "";
    await refreshOwnerStatus();
  } catch (e) { el("owner-error").textContent = e.message; }
};
el("owner-logout-btn").onclick = async () => {
  await api("/owner/logout", { method: "POST" });
  await refreshOwnerStatus();
};

async function openLeague(id) {
  currentLeagueId = id;
  window.location.hash = "league/" + id;
  el("view-hub").style.display = "none";
  el("view-league").style.display = "block";
  await refreshMe();
  await refreshLeague();
  buildTabs();
  switchTab(myRole === "admin" ? "admin" : myRole === "captain" ? "selection" : "fixtures");
  initViewingKey();
  renderAll();
}
async function refreshMe() {
  const me = await api(`/leagues/${currentLeagueId}/me`).catch(() => ({ role: "guest" }));
  myRole = me.role; myTeamId = me.teamId || null;
  document.body.className = "role-" + myRole;
}
async function refreshLeague() {
  league = await api(`/leagues/${currentLeagueId}`);
}

/* ---------- Auth ---------- */

el("auth-toggle").onclick = async () => {
  if (myRole !== "guest") {
    await api("/logout", { method: "POST" });
    myRole = "guest"; myTeamId = null;
    document.body.className = "role-guest";
    buildTabs(); switchTab("fixtures"); renderAll();
    return;
  }
  el("auth-panel").classList.toggle("open");
  el("auth-toggle").textContent = el("auth-panel").classList.contains("open") ? "Close" : "Log in";
};
el("show-admin-login").onclick = () => {
  el("auth-team-panel").style.display = "none";
  el("auth-admin-panel").style.display = "block";
  el("auth-error").textContent = "";
};
el("show-team-login").onclick = () => {
  el("auth-admin-panel").style.display = "none";
  el("auth-team-panel").style.display = "block";
  el("auth-error").textContent = "";
};
el("captain-login-btn").onclick = async () => {
  const code = el("captain-code").value;
  const email = el("captain-email").value;
  try {
    const r = await api(`/leagues/${currentLeagueId}/captain-login`, { method: "POST", body: { code, email } });
    myRole = r.role; myTeamId = r.teamId || null;
    document.body.className = "role-" + myRole;
    el("auth-panel").classList.remove("open"); el("auth-error").textContent = "";
    el("captain-code").value = ""; el("captain-email").value = "";
    await refreshLeague(); buildTabs(); switchTab("selection"); renderAll();
  } catch (e) { el("auth-error").textContent = e.message; }
};
el("login-btn").onclick = async () => {
  const email = el("login-email").value, password = el("login-password").value;
  try {
    const r = await api(`/leagues/${currentLeagueId}/login`, { method: "POST", body: { email, password } });
    myRole = r.role; myTeamId = r.teamId || null;
    document.body.className = "role-" + myRole;
    el("auth-panel").classList.remove("open"); el("auth-error").textContent = "";
    el("login-email").value = ""; el("login-password").value = "";
    await refreshLeague(); buildTabs(); switchTab(myRole === "admin" ? "admin" : "selection"); renderAll();
  } catch (e) { el("auth-error").textContent = e.message; }
};
el("register-btn").onclick = async () => {
  const email = el("login-email").value, password = el("login-password").value;
  try {
    const r = await api(`/leagues/${currentLeagueId}/register`, { method: "POST", body: { email, password } });
    myRole = r.role; myTeamId = r.teamId || null;
    document.body.className = "role-" + myRole;
    el("auth-panel").classList.remove("open"); el("auth-error").textContent = "";
    el("login-email").value = ""; el("login-password").value = "";
    await refreshLeague(); buildTabs(); switchTab(myRole === "admin" ? "admin" : "selection"); renderAll();
  } catch (e) { el("auth-error").textContent = e.message; }
};

/* ---------- Tabs ---------- */

function tabDefs() {
  const defs = [];
  if (myRole === "admin") defs.push({ key: "admin", label: "Admin" });
  if (myRole === "admin" || myRole === "captain") defs.push({ key: "selection", label: "Selection room" });
  defs.push({ key: "fixtures", label: "Fixtures" });
  defs.push({ key: "results", label: "Results" });
  defs.push({ key: "table", label: "Table" });
  defs.push({ key: "stats", label: "Stats" });
  defs.push({ key: "awards", label: "Awards" });
  defs.push({ key: "roster", label: "Team roster" });
  defs.push({ key: "news", label: "News room" });
  if (myRole === "captain") {
    const unread = myNotifications.filter((n) => !n.read).length;
    defs.push({ key: "notifications", label: unread ? `Notifications (${unread})` : "Notifications" });
  }
  return defs;
}
function buildTabs() {
  const nav = el("tabs");
  nav.innerHTML = "";
  tabDefs().forEach((d) => {
    const btn = document.createElement("button");
    btn.textContent = d.label; btn.dataset.view = d.key;
    btn.onclick = () => switchTab(d.key);
    nav.appendChild(btn);
  });
  el("role-flag").style.display = myRole === "guest" ? "none" : "inline-block";
  el("role-flag").textContent = myRole === "admin" ? "Admin view" : myRole === "captain" ? "Captain view" : "";
  const myTeam = myRole === "captain" ? teamById(myTeamId) : null;
  const logoFlag = el("team-logo-flag");
  if (myTeam && myTeam.logo) {
    logoFlag.src = myTeam.logo;
    logoFlag.style.display = "inline-block";
  } else {
    logoFlag.style.display = "none";
  }
}
function switchTab(key) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === key));
  document.querySelectorAll("#view-league .view").forEach((v) => v.classList.remove("active"));
  const v = el("view-" + key);
  if (v) v.classList.add("active");
}

/* ---------- Round navigation ---------- */

function roundLabel(r) {
  const meta = league.roundMeta && league.roundMeta[r];
  return (meta && meta.label) || "Round " + r;
}
function getRoundsList() {
  const regRounds = [...new Set(league.fixtures.map((f) => f.round))].sort((a, b) => a - b);
  const list = regRounds.map((r) => ({ key: "r" + r, label: roundLabel(r), stage: "regular", round: r }));
  if (league.playoffs) {
    if (league.playoffs.format === "position") {
      list.push({ key: "positions", label: "Final spot playoffs", stage: "position" });
    } else {
      list.push({ key: "semis", label: "Semi finals", stage: "semi" });
      list.push({ key: "final", label: "Final", stage: "final" });
    }
  }
  return list;
}
function fixturesForKey(key) {
  if (!key) return [];
  if (key.stage === "regular") return league.fixtures.filter((f) => f.round === key.round);
  if (key.stage === "semi") return league.playoffs ? league.playoffs.semis : [];
  if (key.stage === "final") return league.playoffs ? [league.playoffs.final] : [];
  if (key.stage === "position") return league.playoffs ? league.playoffs.matches : [];
  return [];
}
function isRoundOpen(key) {
  if (!key) return false;
  if (key.stage === "regular") {
    if (key.round === 1) return true;
    const prev = league.fixtures.filter((f) => f.round === key.round - 1);
    return prev.length > 0 && prev.every((f) => f.finalized);
  }
  if (key.stage === "semi" || key.stage === "position") return true;
  if (key.stage === "final") { const f = league.playoffs && league.playoffs.final; return !!(f && f.teamA && f.teamB); }
  return false;
}
function initViewingKey() {
  const list = getRoundsList();
  if (list.length === 0) { viewingKey = null; return; }
  viewingKey = list.find((k) => fixturesForKey(k).some((f) => !f.finalized)) || list[list.length - 1];
}
function syncViewingKey() {
  const list = getRoundsList();
  if (list.length === 0) { viewingKey = null; return; }
  if (!viewingKey || !list.find((k) => k.key === viewingKey.key)) viewingKey = list[0];
}
function renderRoundNav(containerId) {
  const c = el(containerId);
  const list = getRoundsList();
  if (list.length === 0) { c.innerHTML = ""; return; }
  const idx = list.findIndex((k) => k.key === viewingKey.key);
  c.innerHTML = "";
  const nav = document.createElement("div");
  nav.className = "round-nav";
  const prev = document.createElement("button");
  prev.textContent = "‹"; prev.disabled = idx <= 0;
  prev.onclick = () => { viewingKey = list[idx - 1]; renderAll(); };
  const label = document.createElement("div");
  label.className = "label"; label.textContent = list[idx].label;
  const next = document.createElement("button");
  next.textContent = "›"; next.disabled = idx >= list.length - 1;
  next.onclick = () => { viewingKey = list[idx + 1]; renderAll(); };
  nav.appendChild(prev); nav.appendChild(label); nav.appendChild(next);
  c.appendChild(nav);

  const sched = scheduleFor(viewingKey.key);
  const venue = effectiveVenue(viewingKey.key);
  if (sched.date || sched.time || venue) {
    const banner = document.createElement("div");
    banner.className = "matchday-banner";
    banner.innerHTML = (sched.date ? `<span class="matchday-date">${fmtDate(sched.date)}</span>` : "") + (sched.time ? `<span class="matchday-time">${fmtTime(sched.time)}</span>` : "") + (venue ? `<span class="matchday-venue">${escapeHtml(venue)}</span>` : "");
    c.appendChild(banner);
  }
  if (viewingKey.stage === "regular") {
    const byes = (league.byes || []).filter((b) => b.round === viewingKey.round);
    if (byes.length) {
      const note = document.createElement("div"); note.className = "bye-note";
      note.textContent = "Bye: " + byes.map((b) => { const t = teamById(b.teamId); return t ? t.name : "?"; }).join(", ");
      c.appendChild(note);
    }
  }
}

/* ---------- Master render ---------- */

function renderAll() {
  syncViewingKey();
  el("league-name").value = league.name;
  el("league-name").disabled = myRole !== "admin";
  const brand = leagueBrand(league.name);
  const brandHeader = document.querySelector("#view-league .site-header");
  brandHeader.classList.remove("league-theme-premier", "league-theme-business");
  const brandLogo = el("league-brand-logo");
  if (brand) { brandHeader.classList.add(brand.theme); brandLogo.src = brand.logo; brandLogo.alt = brand.alt; }
  else { brandLogo.src = "/images/logo-dark.png"; brandLogo.alt = "Team Padel"; }
  const status = league.status;
  const auth = el("auth-status");
  if (myRole === "admin") auth.textContent = "Signed in as Admin";
  else if (myRole === "captain") { const t = teamById(myTeamId); auth.textContent = "Signed in as " + (t ? t.name : "captain") + " captain"; }
  else auth.textContent = "Viewing only — log in to enter scores";
  el("auth-toggle").textContent = myRole === "guest" ? "Log in" : "Log out";

  if (myRole === "admin") renderAdmin();
  renderSelection();
  renderFixtures();
  renderResults();
  renderTable();
  renderRoster();
  renderStats();
  renderAwards();
  renderNews();
  renderSponsorStrip();
  renderNotificationsList();
  refreshNotifications().then(() => { updateNotifTabLabel(); renderNotificationsList(); });
  el("team-count-label").textContent = `${league.teams.length} team${league.teams.length === 1 ? "" : "s"} · ${league.fixtures.length} fixture${league.fixtures.length === 1 ? "" : "s"}`;
}
el("league-name").addEventListener("change", async (e) => {
  if (myRole !== "admin") return;
  try { await api(`/leagues/${currentLeagueId}/name`, { method: "PUT", body: { name: e.target.value } }); await refreshLeague(); }
  catch (err) { alert(err.message); }
});

/* ---------- Admin tab ---------- */

function renderAdmin() {
  const status = league.status;
  const seasonCard = el("season-card");
  if (status === "setup") {
    seasonCard.innerHTML = `<h2 class="section-title">Start season</h2><p class="note">Every team plays every other team, 4 pairs a side. Add teams and rosters below, and set your rules in League Rules above, first — at least 3 teams.</p>
      <div class="row" style="margin-top:14px;"><button class="primary" id="start-season-btn">Start season</button></div>`;
    el("start-season-btn").onclick = async () => {
      try {
        await api(`/leagues/${currentLeagueId}/season/start`, { method: "POST", body: { doubleRound: el("double-round-toggle").checked, playoffFormat: el("playoff-format-select").value } });
        await refreshLeague(); initViewingKey(); renderAll();
      } catch (e) { alert(e.message); }
    };
  } else {
    seasonCard.innerHTML = `<h2 class="section-title">Season in progress</h2><p class="note">Team list is locked. Head to League Rules above to reset the season or delete this league.</p>`;
  }
  renderRulesCard();
  el("tiering-enabled-toggle").checked = !!league.tieringEnabled;
  el("tiering-count-row").style.display = league.tieringEnabled ? "flex" : "none";
  el("gold-tier-count-input").value = league.goldTierCount || 1;
  el("add-team-row").style.display = status === "setup" ? "flex" : "none";
  el("bulk-add-details").style.display = status === "setup" ? "block" : "none";
  el("add-round-card").style.display = status === "setup" ? "none" : "block";
  if (status !== "setup") renderNewRoundMatches();

  const list = el("admin-team-list");
  list.innerHTML = "";
  if (league.teams.length === 0) list.innerHTML = '<li class="empty" style="border:none;justify-content:center;">No teams yet.</li>';
  league.teams.forEach((t) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name-tag">${avatarHtml(t)}${escapeHtml(t.name)}</span>`;
    const right = document.createElement("span");
    right.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const codeTag = document.createElement("span");
    codeTag.className = "tag"; codeTag.textContent = "Code: " + (t.code || "—");
    right.appendChild(codeTag);
    const copyBtn = document.createElement("button");
    copyBtn.className = "link"; copyBtn.textContent = "Copy";
    copyBtn.onclick = () => { navigator.clipboard.writeText(t.code || "").catch(() => {}); };
    right.appendChild(copyBtn);
    const reset = document.createElement("button");
    reset.className = "link"; reset.textContent = "New code";
    reset.onclick = async () => {
      if (!confirm("Generate a new code for " + t.name + "? Their old code will stop working.")) return;
      await api(`/leagues/${currentLeagueId}/teams/${t.id}/reset-code`, { method: "POST" });
      await refreshLeague(); renderAll();
    };
    right.appendChild(reset);
    if (status === "setup") {
      const del = document.createElement("button");
      del.className = "ghost"; del.innerHTML = "&times;"; del.title = "Remove team";
      del.onclick = async () => {
        if (!confirm("Remove " + t.name + "?")) return;
        await api(`/leagues/${currentLeagueId}/teams/${t.id}`, { method: "DELETE" });
        await refreshLeague(); renderAll();
      };
      right.appendChild(del);
    }
    li.appendChild(right); list.appendChild(li);
  });

  renderAdminRoster();
  renderAdminFixtures();
  renderAdminSponsors();
}
el("copy-all-codes-btn").onclick = () => {
  if (league.teams.length === 0) return;
  const text = league.teams.map((t) => t.name + ": " + (t.code || "—")).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const btn = el("copy-all-codes-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => alert("Couldn't copy — your browser may be blocking clipboard access."));
};
el("add-team-btn").onclick = async () => {
  const name = el("new-team-name").value.trim();
  if (!name) return;
  try {
    const { code } = await api(`/leagues/${currentLeagueId}/teams`, { method: "POST", body: { name } });
    el("new-team-name").value = "";
    await refreshLeague(); renderAll();
    alert(name + " added — their code is " + code + ". You can copy it any time from the Teams list below.");
  } catch (e) { alert(e.message); }
};
el("bulk-add-btn").onclick = async () => {
  const text = el("bulk-team-input").value;
  if (!text.trim()) return;
  const { teams } = await api(`/leagues/${currentLeagueId}/teams/bulk`, { method: "POST", body: { text } });
  el("bulk-team-input").value = "";
  await refreshLeague(); renderAll();
  if (teams && teams.length) alert(teams.length + " team" + (teams.length === 1 ? "" : "s") + " added:\n" + teams.map((t) => t.name + ": " + t.code).join("\n"));
};

let draftDoubleRound = false;
let draftPlayoffFormat = "none";
function renderRulesCard() {
  const c = el("rules-body");
  const status = league.status;
  if (status === "setup") {
    c.innerHTML = `
      <div class="row" style="align-items:center;">
        <label class="note" style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="double-round-toggle"> Home and away (double round)</label>
      </div>
      <div class="row" style="align-items:center;margin-top:10px;">
        <label class="note" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">Playoffs after the season:
          <select id="playoff-format-select" style="flex:1;min-width:220px;">
            <option value="none">None — the table decides the winner</option>
            <option value="semis_final">Semi-finals + Final (top 4)</option>
            <option value="position">Final spot playoffs (1v2, 3v4, 5v6…)</option>
          </select>
        </label>
      </div>`;
    el("double-round-toggle").checked = draftDoubleRound;
    el("double-round-toggle").onchange = () => { draftDoubleRound = el("double-round-toggle").checked; };
    el("playoff-format-select").value = draftPlayoffFormat;
    el("playoff-format-select").onchange = () => { draftPlayoffFormat = el("playoff-format-select").value; };
  } else {
    c.innerHTML = `
      <div class="row" style="align-items:center;">
        <label class="note" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">Playoffs after the season:
          <select id="playoff-format-live-select" style="flex:1;min-width:220px;">
            <option value="none">None — the table decides the winner</option>
            <option value="semis_final">Semi-finals + Final (top 4)</option>
            <option value="position">Final spot playoffs (1v2, 3v4, 5v6…)</option>
          </select>
        </label>
      </div>
      <p class="note" style="margin-top:8px;">Change this any time before playoff results are entered — no season reset needed.</p>`;
    el("playoff-format-live-select").value = league.playoffFormat || "none";
    el("playoff-format-live-select").onchange = async (e) => {
      const format = e.target.value;
      try {
        await api(`/leagues/${currentLeagueId}/playoff-format`, { method: "PUT", body: { format } });
        await refreshLeague(); renderAll();
      } catch (err) {
        alert(err.message);
        e.target.value = league.playoffFormat || "none";
      }
    };
  }

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "row";
  actionsWrap.style.cssText = "margin-top:16px;padding-top:14px;border-top:1px dashed var(--line);";

  const exportBtn = document.createElement("button");
  exportBtn.className = "secondary"; exportBtn.textContent = "Export league data (backup)";
  exportBtn.onclick = async () => {
    try {
      const data = await api(`/leagues/${currentLeagueId}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = (league.name || "league").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `${safeName}-backup-${dateStr}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert("Export failed: " + e.message); }
  };
  actionsWrap.appendChild(exportBtn);

  const importInput = document.createElement("input");
  importInput.type = "file"; importInput.accept = "application/json,.json"; importInput.style.display = "none";
  importInput.onchange = async () => {
    const file = importInput.files[0];
    importInput.value = "";
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { alert("That file isn't valid JSON."); return; }
    if (!confirm(`Restore "${league.name}" from this backup? This overwrites all current teams, fixtures, results and settings for this league. This cannot be undone.`)) return;
    try {
      await api(`/leagues/${currentLeagueId}/import`, { method: "POST", body: data });
      await refreshLeague(); initViewingKey(); renderAll();
      alert("League restored from backup.");
    } catch (e) { alert("Import failed: " + e.message); }
  };
  const importBtn = document.createElement("button");
  importBtn.className = "secondary"; importBtn.textContent = "Import backup (restore)";
  importBtn.onclick = () => importInput.click();
  actionsWrap.appendChild(importBtn);
  actionsWrap.appendChild(importInput);

  if (status !== "setup") {
    const resetBtn = document.createElement("button");
    resetBtn.className = "danger"; resetBtn.textContent = "Reset season";
    resetBtn.onclick = async () => {
      if (!confirm("This clears the schedule, results and knockout stage. Continue?")) return;
      await api(`/leagues/${currentLeagueId}/season/reset`, { method: "POST" });
      await refreshLeague(); initViewingKey(); renderAll();
    };
    actionsWrap.appendChild(resetBtn);
  }
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "danger"; deleteBtn.textContent = "Delete this league";
  deleteBtn.onclick = async () => {
    if (!confirm("Permanently delete this league and all its data? This cannot be undone.")) return;
    await api(`/leagues/${currentLeagueId}`, { method: "DELETE" });
    leaguesIndex = await api("/leagues");
    showHub();
  };
  actionsWrap.appendChild(deleteBtn);
  c.appendChild(actionsWrap);
}

function renderAdminRoster() {
  const c = el("admin-roster");
  c.innerHTML = "";
  if (league.teams.length === 0) { c.innerHTML = '<p class="empty">Add teams first.</p>'; return; }
  league.teams.forEach((t) => c.appendChild(adminRosterBlock(t)));
}
function adminRosterBlock(t) {
  const wrap = document.createElement("div");
  wrap.className = "roster-team";
  const head = document.createElement("div");
  head.className = "roster-head";
  head.innerHTML = avatarHtml(t);
  const nameWrap = document.createElement("div");
  nameWrap.innerHTML = `<div style="font-family:'Oswald',sans-serif;font-size:15px;text-transform:uppercase;">${escapeHtml(t.name)}</div>`;
  const uploadLabel = document.createElement("label");
  uploadLabel.className = "logo-label"; uploadLabel.textContent = t.logo ? "Change logo" : "Add logo";
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
  fileInput.onchange = () => {
    if (!fileInput.files[0]) return;
    resizeImageToDataUrl(fileInput.files[0], 128, async (dataUrl) => {
      await api(`/leagues/${currentLeagueId}/teams/${t.id}`, { method: "PUT", body: { logo: dataUrl } });
      await refreshLeague(); renderAdminRoster(); renderRoster();
    });
  };
  uploadLabel.appendChild(fileInput);
  nameWrap.appendChild(uploadLabel);
  if (league.tieringEnabled) {
    const goldCount = t.players.filter((p) => p.gold).length;
    const goldTag = document.createElement("div");
    goldTag.className = "note"; goldTag.style.marginTop = "4px";
    goldTag.textContent = `Gold tier: ${goldCount}/${league.goldTierCount}`;
    nameWrap.appendChild(goldTag);
  }
  head.appendChild(nameWrap);
  wrap.appendChild(head);

  const ul = document.createElement("ul"); ul.className = "plain";
  if (t.players.length === 0) ul.innerHTML = '<li class="empty" style="border:none;justify-content:center;">No players yet.</li>';
  t.players.forEach((p) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.innerHTML = goldNameHtml(p);
    li.appendChild(nameSpan);
    if (league.tieringEnabled) {
      const goldBtn = document.createElement("button");
      goldBtn.className = "link gold-toggle"; goldBtn.style.marginLeft = "8px";
      goldBtn.textContent = p.gold ? "★ Gold" : "☆ Mark gold";
      goldBtn.onclick = async () => {
        try {
          await api(`/leagues/${currentLeagueId}/teams/${t.id}/players/${p.id}/tier`, { method: "PUT", body: { gold: !p.gold } });
          await refreshLeague(); renderAdminRoster(); renderRoster();
        } catch (e) { alert(e.message); }
      };
      li.appendChild(goldBtn);
    }
    const del = document.createElement("button");
    del.className = "ghost"; del.innerHTML = "&times;";
    del.onclick = async () => { await api(`/leagues/${currentLeagueId}/teams/${t.id}/players/${p.id}`, { method: "DELETE" }); await refreshLeague(); renderAdminRoster(); };
    li.appendChild(del); ul.appendChild(li);
  });
  wrap.appendChild(ul);

  const addRow = document.createElement("div");
  addRow.className = "row"; addRow.style.marginTop = "10px";
  const addInput = document.createElement("input");
  addInput.type = "text"; addInput.placeholder = "Add player name";
  const addBtn = document.createElement("button");
  addBtn.className = "secondary"; addBtn.textContent = "Add player";
  addBtn.onclick = async () => {
    const name = addInput.value.trim();
    if (!name) return;
    await api(`/leagues/${currentLeagueId}/teams/${t.id}/players`, { method: "POST", body: { name } });
    addInput.value = ""; await refreshLeague(); renderAdminRoster();
  };
  addRow.appendChild(addInput); addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  const bulkDetails = document.createElement("details");
  bulkDetails.style.marginTop = "8px";
  const bulkSummary = document.createElement("summary");
  bulkSummary.className = "note"; bulkSummary.style.cursor = "pointer"; bulkSummary.textContent = "Add several players at once";
  const bulkTextarea = document.createElement("textarea");
  bulkTextarea.rows = 4; bulkTextarea.style.marginTop = "8px"; bulkTextarea.placeholder = "One player name per line";
  const bulkBtn = document.createElement("button");
  bulkBtn.className = "secondary"; bulkBtn.textContent = "Add these players"; bulkBtn.style.marginTop = "8px";
  bulkBtn.onclick = async () => {
    const text = bulkTextarea.value;
    if (!text.trim()) return;
    await api(`/leagues/${currentLeagueId}/teams/${t.id}/players/bulk`, { method: "POST", body: { text } });
    bulkTextarea.value = ""; bulkDetails.open = false; await refreshLeague(); renderAdminRoster();
  };
  bulkDetails.appendChild(bulkSummary); bulkDetails.appendChild(bulkTextarea); bulkDetails.appendChild(bulkBtn);
  wrap.appendChild(bulkDetails);
  return wrap;
}
function resizeImageToDataUrl(file, maxSize, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if (w > h) { if (w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; } }
      else { if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function stageKeyFor(f) {
  if (f.stage === "semi") return "semis";
  if (f.stage === "final") return "final";
  if (f.stage === "position") return "positions";
  return "r" + f.round;
}
function scheduleFor(key) {
  return (league.schedule && league.schedule[key]) || { date: "", venue: "", time: "" };
}
function effectiveVenue(key) {
  const s = scheduleFor(key);
  return s.venue || league.defaultVenue || "";
}
el("default-venue-input").addEventListener("change", async (e) => {
  await api(`/leagues/${currentLeagueId}/default-venue`, { method: "PUT", body: { venue: e.target.value } });
  await refreshLeague(); renderAll();
});
async function saveCourtSettings() {
  const courtCount = Number(el("court-count-input").value);
  const slotCount = Number(el("slot-count-input").value);
  if (!courtCount || !slotCount) return;
  try {
    await api(`/leagues/${currentLeagueId}/court-settings`, { method: "PUT", body: { courtCount, slotCount } });
    await refreshLeague(); renderAll();
  } catch (e) { alert(e.message); }
}
el("court-count-input").addEventListener("change", saveCourtSettings);
el("slot-count-input").addEventListener("change", saveCourtSettings);
el("tiering-enabled-toggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  el("tiering-count-row").style.display = enabled ? "flex" : "none";
  const goldTierCount = Number(el("gold-tier-count-input").value) || 1;
  if (enabled) el("gold-tier-count-input").value = goldTierCount;
  try {
    await api(`/leagues/${currentLeagueId}/tiering`, { method: "PUT", body: { enabled, goldTierCount } });
    await refreshLeague(); renderAll();
  } catch (err) {
    alert(err.message);
    e.target.checked = !enabled;
    el("tiering-count-row").style.display = !enabled ? "flex" : "none";
  }
});
el("gold-tier-count-input").addEventListener("change", async () => {
  const goldTierCount = Number(el("gold-tier-count-input").value);
  if (!goldTierCount || goldTierCount < 1) return;
  try {
    await api(`/leagues/${currentLeagueId}/tiering`, { method: "PUT", body: { enabled: true, goldTierCount } });
    await refreshLeague(); renderAll();
  } catch (e) { alert(e.message); }
});
function renderAdminFixtures() {
  el("default-venue-input").value = league.defaultVenue || "";
  el("court-count-input").value = league.courtCount || 4;
  el("slot-count-input").value = league.slotCount || 3;
  const c = el("admin-fixtures");
  c.innerHTML = "";
  const allFixtures = league.fixtures.slice();
  if (league.playoffs) {
    if (league.playoffs.format === "position") allFixtures.push(...league.playoffs.matches);
    else allFixtures.push(...league.playoffs.semis, league.playoffs.final);
  }
  if (allFixtures.length === 0) { c.innerHTML = '<p class="empty">No fixtures yet — start the season above.</p>'; return; }

  const seen = new Set();
  const weeks = [];
  allFixtures.forEach((f) => {
    const key = stageKeyFor(f);
    if (seen.has(key)) return;
    seen.add(key);
    const label = f.stage === "semi" ? "Semi finals" : f.stage === "final" ? "Final" : f.stage === "position" ? "Final spot playoffs" : roundLabel(f.round);
    const order = f.stage === "semi" ? 9000 : f.stage === "final" ? 9001 : f.stage === "position" ? 9002 : f.round;
    weeks.push({ key, label, order });
  });
  weeks.sort((a, b) => a.order - b.order);

  weeks.forEach((w) => {
    const sched = scheduleFor(w.key);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid var(--line);font-size:13px;flex-wrap:wrap;";
    const label = document.createElement("span");
    label.style.cssText = "flex:1;min-width:100px;font-family:'Oswald',sans-serif;text-transform:uppercase;font-size:12px;color:var(--text-dim);";
    label.textContent = w.label;
    const dateInput = document.createElement("input");
    dateInput.type = "date"; dateInput.value = sched.date || ""; dateInput.style.cssText = "font-size:12px;padding:6px 8px;";
    dateInput.onchange = async () => { await api(`/leagues/${currentLeagueId}/schedule/${w.key}`, { method: "PUT", body: { date: dateInput.value } }); await refreshLeague(); };
    const timeInput = document.createElement("input");
    timeInput.type = "time"; timeInput.value = sched.time || ""; timeInput.style.cssText = "font-size:12px;padding:6px 8px;";
    timeInput.onchange = async () => { await api(`/leagues/${currentLeagueId}/schedule/${w.key}`, { method: "PUT", body: { time: timeInput.value } }); await refreshLeague(); };
    const venueInput = document.createElement("input");
    venueInput.type = "text"; venueInput.placeholder = "Default: " + (league.defaultVenue || "not set"); venueInput.value = sched.venue || "";
    venueInput.style.cssText = "font-size:12px;padding:6px 8px;flex:1;min-width:140px;max-width:260px;";
    venueInput.onchange = async () => { await api(`/leagues/${currentLeagueId}/schedule/${w.key}`, { method: "PUT", body: { venue: venueInput.value } }); await refreshLeague(); };
    row.appendChild(label); row.appendChild(dateInput); row.appendChild(timeInput); row.appendChild(venueInput);
    c.appendChild(row);
  });
}

/* ---------- Add a round (extra fixtures outside the round robin) ---------- */

let draftRoundMatches = [{ teamA: "", teamB: "" }];
function renderNewRoundMatches() {
  const c = el("new-round-matches");
  c.innerHTML = "";
  draftRoundMatches.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.cssText = "gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap;";
    const teamOptions = (selected) => '<option value="">Team</option>' + league.teams.map((t) => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
    const selA = document.createElement("select");
    selA.innerHTML = teamOptions(m.teamA);
    selA.onchange = () => { draftRoundMatches[i].teamA = selA.value; };
    const vs = document.createElement("span"); vs.className = "vs"; vs.textContent = "vs";
    const selB = document.createElement("select");
    selB.innerHTML = teamOptions(m.teamB);
    selB.onchange = () => { draftRoundMatches[i].teamB = selB.value; };
    row.appendChild(selA); row.appendChild(vs); row.appendChild(selB);
    if (draftRoundMatches.length > 1) {
      const rm = document.createElement("button");
      rm.className = "ghost"; rm.innerHTML = "&times;"; rm.title = "Remove this fixture";
      rm.onclick = () => { draftRoundMatches.splice(i, 1); renderNewRoundMatches(); };
      row.appendChild(rm);
    }
    c.appendChild(row);
  });
}
el("new-round-add-match-btn").onclick = () => { draftRoundMatches.push({ teamA: "", teamB: "" }); renderNewRoundMatches(); };
el("new-round-create-btn").onclick = async () => {
  const name = el("new-round-name").value.trim();
  const type = el("new-round-type").value;
  const matches = draftRoundMatches.filter((m) => m.teamA && m.teamB).map((m) => ({ teamA: m.teamA, teamB: m.teamB }));
  if (!name) return alert("Give the round a name.");
  if (matches.length === 0) return alert("Add at least one fixture.");
  try {
    await api(`/leagues/${currentLeagueId}/rounds`, { method: "POST", body: { name, type, matches } });
    el("new-round-name").value = "";
    draftRoundMatches = [{ teamA: "", teamB: "" }];
    await refreshLeague(); initViewingKey(); renderAll();
  } catch (e) { alert(e.message); }
};

/* ---------- Sponsors ---------- */

let pendingSponsorImage = null;
el("sponsor-file").addEventListener("change", () => {
  const file = el("sponsor-file").files[0];
  if (!file) return;
  el("sponsor-file-name").textContent = file.name;
  resizeImageToDataUrl(file, 240, (dataUrl) => { pendingSponsorImage = dataUrl; });
});
el("add-sponsor-btn").onclick = async () => {
  if (!pendingSponsorImage) return alert("Choose a logo image first.");
  const name = el("sponsor-name").value.trim();
  const link = el("sponsor-link").value.trim();
  try {
    await api(`/leagues/${currentLeagueId}/sponsors`, { method: "POST", body: { name, link, image: pendingSponsorImage } });
    el("sponsor-name").value = ""; el("sponsor-link").value = ""; el("sponsor-file").value = ""; el("sponsor-file-name").textContent = "";
    pendingSponsorImage = null;
    await refreshLeague(); renderAdmin(); renderSponsorStrip();
  } catch (e) { alert(e.message); }
};
function renderAdminSponsors() {
  const c = el("admin-sponsor-list");
  const sponsors = league.sponsors || [];
  if (sponsors.length === 0) { c.innerHTML = '<p class="empty">No sponsors added yet.</p>'; return; }
  c.innerHTML = "";
  sponsors.forEach((s) => {
    const row = document.createElement("div");
    row.className = "sponsor-admin-row";
    row.innerHTML = `<img src="${s.image}" alt=""><span style="font-size:13px;">${escapeHtml(s.name || "Untitled")}</span><span class="link">${escapeHtml(s.link || "")}</span>`;
    const del = document.createElement("button");
    del.className = "ghost"; del.innerHTML = "&times;";
    del.onclick = async () => {
      if (!confirm("Remove this sponsor?")) return;
      await api(`/leagues/${currentLeagueId}/sponsors/${s.id}`, { method: "DELETE" });
      await refreshLeague(); renderAdmin(); renderSponsorStrip();
    };
    row.appendChild(del);
    c.appendChild(row);
  });
}
function renderSponsorStrip() {
  const c = el("sponsor-strip");
  const sponsors = league.sponsors || [];
  if (sponsors.length === 0) { c.innerHTML = ""; return; }
  const logos = sponsors
    .map((s) => {
      const img = `<img src="${s.image}" alt="${escapeHtml(s.name || "")}">`;
      return s.link ? `<a href="${escapeHtml(s.link)}" target="_blank" rel="noopener">${img}</a>` : img;
    })
    .join("");
  c.innerHTML = `<span class="sponsor-strip-label">Sponsored by</span>${logos}`;
}

/* ---------- Notifications ---------- */

async function refreshNotifications() {
  if (myRole !== "captain") { myNotifications = []; return; }
  myNotifications = await api(`/leagues/${currentLeagueId}/notifications`).catch(() => []);
}
function updateNotifTabLabel() {
  const btn = document.querySelector('#tabs button[data-view="notifications"]');
  if (!btn) return;
  const unread = myNotifications.filter((n) => !n.read).length;
  btn.textContent = unread ? `Notifications (${unread})` : "Notifications";
}
function renderNotifyEmailCard() {
  const card = el("notify-email-input").closest(".card");
  if (myRole !== "captain") { card.style.display = "none"; return; }
  card.style.display = "block";
  const team = teamById(myTeamId);
  el("notify-email-input").value = (team && team.notifyEmail) || "";
  el("notify-email-status").textContent = "";
}
el("notify-email-save-btn").onclick = async () => {
  const email = el("notify-email-input").value.trim();
  try {
    await api(`/leagues/${currentLeagueId}/teams/${myTeamId}/notify-email`, { method: "PUT", body: { email } });
    el("notify-email-status").textContent = email ? "Saved — notifications will be emailed to " + email + "." : "Saved — email notifications are off.";
    await refreshLeague();
  } catch (e) { el("notify-email-status").textContent = e.message; }
};
function renderNotificationsList() {
  renderNotifyEmailCard();
  const c = el("notifications-list");
  if (!c) return;
  if (myRole !== "captain") { c.innerHTML = '<p class="empty">Notifications are for team captains.</p>'; return; }
  if (myNotifications.length === 0) { c.innerHTML = '<p class="empty">No notifications yet.</p>'; return; }
  c.innerHTML = "";
  myNotifications.forEach((n) => {
    const row = document.createElement("div");
    // Pair of the Week notifications carry the round they're about — clicking
    // one jumps straight to that round's Awards page instead of leaving the
    // captain to go find it themselves.
    const goToRound = n.type === "potw" && Number.isInteger(n.round) ? getRoundsList().find((k) => k.stage === "regular" && k.round === n.round) : null;
    row.className = "notif-row" + (n.read ? "" : " unread") + (goToRound ? " notif-clickable" : "");
    row.innerHTML = `<span class="notif-msg">${escapeHtml(n.message)}</span><time class="notif-time">${new Date(n.createdAt).toLocaleString()}</time>`;
    if (!n.read || goToRound) {
      row.onclick = async () => {
        if (!n.read) {
          await api(`/leagues/${currentLeagueId}/notifications/${n.id}/read`, { method: "POST" });
          n.read = true; updateNotifTabLabel();
        }
        if (goToRound) {
          viewingKey = goToRound;
          switchTab("awards");
          renderAll();
        } else {
          renderNotificationsList();
        }
      };
    }
    c.appendChild(row);
  });
}
el("mark-all-read-btn").onclick = async () => {
  await api(`/leagues/${currentLeagueId}/notifications/read-all`, { method: "POST" });
  myNotifications.forEach((n) => { n.read = true; });
  renderNotificationsList(); updateNotifTabLabel();
};

function renderSelection() {
  if (myRole !== "admin" && myRole !== "captain") return;
  renderRoundNav("round-nav-selection");
  const c = el("selection-container");
  c.innerHTML = "";
  let fixtures = fixturesForKey(viewingKey);
  if (myRole === "captain") fixtures = fixtures.filter((f) => f.teamA === myTeamId || f.teamB === myTeamId);
  if (fixtures.length === 0) {
    c.innerHTML = myRole === "captain"
      ? '<div class="card"><p class="empty">Your team isn\'t playing this round.</p></div>'
      : '<div class="card"><p class="empty">No fixtures this round yet.</p></div>';
    return;
  }
  if (myRole !== "admin" && !isRoundOpen(viewingKey)) { c.innerHTML = '<div class="card"><p class="empty">This round opens once the previous round is finalized.</p></div>'; return; }
  fixtures.forEach((f) => c.appendChild(selectionCard(f)));
}
function selectionCard(f) {
  const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
  const card = document.createElement("div"); card.className = "fixture-card";
  card.innerHTML = `<div class="fixture-head"><div class="fixture-title">${teamA ? avatarHtml(teamA) : ""} ${escapeHtml(teamA ? teamA.name : "TBD")} <span class="vs">vs</span> ${escapeHtml(teamB ? teamB.name : "TBD")} ${teamB ? avatarHtml(teamB) : ""}</div></div>`;
  if (!teamA || !teamB) { card.appendChild(Object.assign(document.createElement("p"), { className: "empty", textContent: "Waiting on the semi-final results." })); return card; }
  const both = f.selectionA.submitted && f.selectionB.submitted;
  const grid = document.createElement("div"); grid.className = "selection-grid";
  if (both) {
    grid.appendChild(selectionReveal(f, teamA, f.selectionA, "A"));
    grid.appendChild(selectionReveal(f, teamB, f.selectionB, "B"));
    card.appendChild(grid);
    card.appendChild(Object.assign(document.createElement("p"), { className: "note", style: "margin-top:10px;", textContent: "Both line-ups are in — agree a playing order below, then head to Results to enter scores." }));
    card.appendChild(timeSlotPanel(f, teamA, teamB));
  } else {
    grid.appendChild(selectionForm(f, teamA, "A"));
    grid.appendChild(selectionForm(f, teamB, "B"));
    card.appendChild(grid);
  }
  return card;
}
// Shows the courts/slots the auto-rotation already reserved for this match
// (styled like the real Court schedule grid — same colors, same "2 courts"
// double badge) and lets whoever's in the match rearrange which of their 4
// pairs sits in which reserved spot. Either captain can save changes right
// away — no proposing/waiting on the other captain — since they're only
// ever rearranging seats already set aside for this one shared match.
function timeSlotPanel(f, teamA, teamB) {
  const wrap = document.createElement("div");
  wrap.className = "card timeslot-panel";
  wrap.style.marginTop = "12px";

  const title = document.createElement("h3");
  title.className = "timeslot-title";
  title.textContent = "Court & playing order";
  wrap.appendChild(title);

  const seedLabel = (i) => "Seed " + (i + 1) + " — " + playerNamesForGold(teamA, f.selectionA.pairs[i]) + " vs " + playerNamesForGold(teamB, f.selectionB.pairs[i]);

  const slots = league.slotCount || 3, courts = league.courtCount || 4;
  const savedGrid = Array.from({ length: slots }, (_, s) => Array.from({ length: courts }, (_, c) =>
    (league.courtSchedule && league.courtSchedule[f.round] && league.courtSchedule[f.round][s] && league.courtSchedule[f.round][s][c]) || null
  ));
  const ownedCells = [];
  savedGrid.forEach((row, s) => row.forEach((cell, c) => { if (cell && cell.fixtureId === f.id) ownedCells.push({ slot: s, court: c, seed: cell.seed }); }));

  const myTeamSide = myRole === "captain" ? (myTeamId === f.teamA ? "A" : myTeamId === f.teamB ? "B" : null) : null;
  const canEdit = myRole === "admin" || !!myTeamSide;

  if (ownedCells.length === 0) {
    wrap.appendChild(Object.assign(document.createElement("p"), {
      className: "note",
      textContent: myRole === "admin"
        ? "This match doesn't have a court or time yet — use Auto-fill rotation on the Fixtures tab."
        : "Court and time aren't set for this match yet — check back once the admin publishes the schedule.",
    }));
    return wrap;
  }

  const usedSlots = [...new Set(ownedCells.map((c) => c.slot))].sort((a, b) => a - b);
  const usedCourts = [...new Set(ownedCells.map((c) => c.court))].sort((a, b) => a - b);
  const courtNames = league.courtNames || [];
  const roundFixtures = league.fixtures.filter((x) => x.round === f.round);
  const color = fixtureColor(f.id, roundFixtures);

  const seedAtFromCells = (cells) => {
    const m = {};
    cells.forEach((c) => { m[c.slot + ":" + c.court] = c.seed; });
    return m;
  };
  const assignmentsFrom = (seedAt) => Object.keys(seedAt).map((key) => {
    const [slot, court] = key.split(":").map(Number);
    return { slot, court, seed: seedAt[key] };
  });

  // Renders the courts-as-columns grid. `seedAt` maps "slot:court" -> seed.
  // When `editable`, cells are selects wired to swap-on-pick (every spot
  // always holds one of the 4 seeds, so picking a seed that's sitting
  // elsewhere swaps the two rather than leaving a duplicate or a gap).
  function renderGrid(seedAt, editable) {
    const table = document.createElement("table");
    table.className = "timeslot-order-table";
    table.innerHTML = "<thead><tr><th></th>" + usedCourts.map((c) => `<th>${escapeHtml(courtNames[c] || ("Court " + (c + 1)))}</th>`).join("") + "</tr></thead>";
    const tbody = document.createElement("tbody");
    const selectsByKey = {};
    function refreshOptions() {
      Object.keys(selectsByKey).forEach((key) => {
        const select = selectsByKey[key];
        const current = seedAt[key];
        select.innerHTML = [0, 1, 2, 3].map((i) => `<option value="${i}" ${i === current ? "selected" : ""}>${escapeHtml(seedLabel(i))}</option>`).join("");
      });
    }
    usedSlots.forEach((s) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = "Match " + (s + 1);
      tr.appendChild(th);
      const rowCount = ownedCells.filter((oc) => oc.slot === s).length;
      usedCourts.forEach((c) => {
        const key = s + ":" + c;
        const td = document.createElement("td");
        if (!(key in seedAt)) { td.textContent = "—"; tr.appendChild(td); return; }
        td.style.cssText = `background:${color.bg};`;
        if (rowCount > 1) {
          const badge = document.createElement("div");
          badge.className = "cs-double-badge";
          badge.textContent = "2 courts";
          td.appendChild(badge);
        }
        if (editable) {
          const select = document.createElement("select");
          selectsByKey[key] = select;
          select.onchange = () => {
            const newSeed = Number(select.value);
            const oldSeed = seedAt[key];
            const swapKey = Object.keys(seedAt).find((k) => k !== key && seedAt[k] === newSeed);
            seedAt[key] = newSeed;
            if (swapKey) seedAt[swapKey] = oldSeed;
            refreshOptions();
          };
          td.appendChild(select);
        } else {
          td.appendChild(document.createTextNode(seedLabel(seedAt[key])));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    if (editable) refreshOptions();
    return table;
  }

  // Editable grid + a save/propose button. Admin applies straight away
  // (they already have unilateral control from the Fixtures tab); a
  // captain's click sends it to their opponent to confirm instead.
  function renderProposeUI(initialSeedAt) {
    const box = document.createElement("div");
    const seedAt = Object.assign({}, initialSeedAt);
    box.appendChild(renderGrid(seedAt, true));
    const err = document.createElement("div"); err.className = "error";
    const btn = document.createElement("button");
    btn.className = "primary"; btn.style.marginTop = "10px";
    btn.textContent = myRole === "admin" ? "Save order" : "Propose this order";
    btn.onclick = async () => {
      const endpoint = myRole === "admin" ? "court-order" : "court-order/propose";
      try {
        await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/${endpoint}`, { method: "POST", body: { assignments: assignmentsFrom(seedAt) } });
        await refreshLeague(); renderAll();
      } catch (e) { err.textContent = e.message; }
    };
    box.appendChild(btn); box.appendChild(err);
    return box;
  }

  const proposal = f.courtOrderProposal;

  if (proposal && proposal.by !== myTeamSide) {
    // Someone else proposed a change (for admin, "someone else" is always
    // true since admin isn't on either side) — show it and let the other
    // side respond.
    const proposerTeam = proposal.by === "A" ? teamA : teamB;
    wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", style: "margin-bottom:10px;", textContent: (proposerTeam ? proposerTeam.name : "Your opponent") + " proposed this order:" }));
    wrap.appendChild(renderGrid(seedAtFromCells(proposal.assignments), false));

    const canRespond = myRole === "admin" || (myTeamSide && myTeamSide !== proposal.by);
    if (canRespond) {
      const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "10px";
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "primary"; confirmBtn.textContent = "Confirm this order";
      confirmBtn.onclick = async () => {
        try { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/court-order/confirm`, { method: "POST" }); await refreshLeague(); renderAll(); }
        catch (e) { alert(e.message); }
      };
      row.appendChild(confirmBtn);
      if (myTeamSide) {
        const counterBtn = document.createElement("button");
        counterBtn.className = "secondary"; counterBtn.textContent = "Propose a different order";
        counterBtn.onclick = () => { wrap.innerHTML = ""; wrap.appendChild(title); wrap.appendChild(renderProposeUI(seedAtFromCells(proposal.assignments))); };
        row.appendChild(counterBtn);
      }
      wrap.appendChild(row);
    }
    return wrap;
  }

  if (proposal && proposal.by === myTeamSide) {
    wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", style: "margin-bottom:10px;", textContent: "Waiting for the other captain to confirm or counter." }));
    wrap.appendChild(renderGrid(seedAtFromCells(proposal.assignments), false));
    return wrap;
  }

  if (!canEdit) {
    wrap.appendChild(renderGrid(seedAtFromCells(ownedCells), false));
    return wrap;
  }

  wrap.appendChild(renderProposeUI(seedAtFromCells(ownedCells)));
  return wrap;
}
function selectionReveal(f, team, sel, side) {
  const div = document.createElement("div"); div.className = "selection-side";
  let html = `<h3>${avatarHtml(team)} ${escapeHtml(team.name)}</h3>`;
  sel.pairs.forEach((pair, i) => {
    html += `<div class="seed-row"><span class="num">Seed ${i + 1}</span><span class="pair" style="flex:1;">${pairNamesGoldHtml(team, pair)}</span></div>`;
  });
  div.innerHTML = html;
  const canEdit = myRole === "admin" || (myRole === "captain" && myTeamId === team.id);
  if (myRole === "admin") {
    const reset = document.createElement("button");
    reset.className = "link"; reset.style.marginTop = "6px"; reset.textContent = "Unlock to edit";
    reset.onclick = async () => {
      if (!confirm(`Unlock ${team.name}'s lineup so they can make changes? Their current pairs stay in place, ready to edit — nothing is wiped. If match scores have already been entered for this fixture, they'll stay tied to the seed number, not the specific players — so changing the pairing afterward changes who gets credit.`)) return;
      try {
        await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/selection/unlock`, { method: "POST", body: { side } });
        await refreshLeague(); renderAll();
      } catch (e) { alert(e.message); }
    };
    div.appendChild(reset);
  }
  if (canEdit && !f.finalized) {
    const sub = document.createElement("button");
    sub.className = "link"; sub.style.marginTop = "6px"; sub.style.marginLeft = myRole === "admin" ? "12px" : "0"; sub.textContent = "Substitute a player";
    sub.onclick = () => openSubModal(f, team, side, sel);
    div.appendChild(sub);
  }
  return div;
}
function selectionForm(f, team, side) {
  const div = document.createElement("div"); div.className = "selection-side";
  const selField = side === "A" ? "selectionA" : "selectionB";
  const sel = f[selField];
  const canEdit = myRole === "admin" || (myRole === "captain" && myTeamId === team.id);
  const already = sel.submitted;
  div.innerHTML = `<h3>${avatarHtml(team)} ${escapeHtml(team.name)}</h3>`;
  if (!canEdit) {
    div.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: already ? "Submitted — waiting on the other team." : "Waiting for " + team.name + "'s captain." }));
    return div;
  }
  if (team.players.length < 2) {
    div.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "Add at least 2 players to this team's roster in the Admin tab first." }));
    return div;
  }
  // sel.pairs already holds the right starting point either way — empty
  // arrays if nothing's ever been picked, or whatever was there before an
  // admin unlock (unlocking only flips `submitted`, it never clears pairs)
  // — so the captain edits from where they left off instead of starting over.
  const localPairs = sel.pairs.map((p) => p.slice());
  const doubleUpNote = document.createElement("div");
  doubleUpNote.className = "note";
  doubleUpNote.style.cssText = "display:none;margin:8px 0;padding:10px;background:rgba(226,84,43,.1);border:1px solid var(--clay);border-radius:8px;color:var(--text);";
  const doubleUpCheckbox = document.createElement("input");
  doubleUpCheckbox.type = "checkbox"; doubleUpCheckbox.id = "dbl-" + f.id + "-" + side;
  const doubleUpLabel = document.createElement("label");
  doubleUpLabel.htmlFor = doubleUpCheckbox.id;
  doubleUpLabel.style.cssText = "display:flex;gap:8px;align-items:flex-start;cursor:pointer;";
  doubleUpLabel.appendChild(doubleUpCheckbox);
  const doubleUpText = document.createElement("span");
  doubleUpText.textContent = "A player is selected twice tonight — are you sure you're requesting a double-up?";
  doubleUpLabel.appendChild(doubleUpText);
  doubleUpNote.appendChild(doubleUpLabel);

  function findDuplicate() {
    const seen = new Set();
    for (const pair of localPairs) {
      for (const id of pair) {
        if (!id) continue;
        if (seen.has(id)) return true;
        seen.add(id);
      }
    }
    return false;
  }
  function refreshDoubleUpNote() {
    doubleUpNote.style.display = findDuplicate() ? "block" : "none";
    if (!findDuplicate()) doubleUpCheckbox.checked = false;
  }

  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div"); row.className = "seed-row";
    row.innerHTML = `<span class="num">Seed ${i + 1}</span>`;
    const seedIdx = i;
    const selects = [];
    // A player picked in one slot is disabled in the other slot of the same
    // pair — you can't be your own partner, so this rules it out before
    // it's ever submitted rather than erroring after the fact.
    const optionsFor = (mySlot) => {
      const otherVal = localPairs[seedIdx][mySlot === 0 ? 1 : 0];
      return '<option value="">Player…</option>' + team.players.map((p) => `<option value="${p.id}" ${p.id === otherVal ? "disabled" : ""}>${goldPrefix(p)}${escapeHtml(p.name)}</option>`).join("");
    };
    [0, 1].forEach((slot) => {
      const select = document.createElement("select");
      select.innerHTML = optionsFor(slot);
      select.value = localPairs[seedIdx][slot] || "";
      select.onchange = () => {
        localPairs[seedIdx][slot] = select.value || null;
        const other = selects[slot === 0 ? 1 : 0];
        const otherVal = other.value;
        other.innerHTML = optionsFor(slot === 0 ? 1 : 0);
        other.value = otherVal;
        refreshDoubleUpNote();
      };
      selects.push(select);
      row.appendChild(select);
    });
    div.appendChild(row);
  }
  div.appendChild(doubleUpNote);
  refreshDoubleUpNote();

  // Blind selection means the other captain can't see this until they've
  // also submitted, so there's nothing unfair about editing it right up to
  // that point — no admin unlock needed here. It only truly locks once
  // both sides are in, at which point this whole form is replaced by the
  // read-only reveal view (with its own admin "Unlock to edit" control).
  if (already) {
    div.appendChild(Object.assign(document.createElement("p"), { className: "note", style: "margin-bottom:8px;", textContent: "Submitted — you can still make changes until the other team submits too." }));
  }
  const err = document.createElement("div"); err.className = "error";
  const btn = document.createElement("button");
  btn.className = "primary"; btn.style.marginTop = "8px"; btn.textContent = already ? "Update line-up" : "Submit line-up";
  btn.onclick = async () => {
    if (findDuplicate() && !doubleUpCheckbox.checked) {
      err.textContent = "Tick the double-up checkbox above to confirm, or fix the selection.";
      return;
    }
    try {
      await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/selection`, { method: "POST", body: { side, pairs: localPairs, confirmDoubleUp: doubleUpCheckbox.checked } });
      await refreshLeague(); renderAll();
    } catch (e) {
      err.textContent = e.message;
      if (e.needsConfirm) doubleUpNote.style.display = "block";
    }
  };
  div.appendChild(btn); div.appendChild(err);
  return div;
}
// Swaps one player out of an already-locked-in line-up — for when someone
// drops out after selection closes. Staged locally like the score modal;
// only committed to the server on Confirm.
function openSubModal(f, team, side, sel) {
  const state = { outPlayerId: "", mode: "existing", inPlayerId: "", newName: "" };
  el("sub-modal-title").textContent = "Substitute a player — " + team.name;
  el("sub-modal-error").textContent = "";
  const usedIds = new Set(sel.pairs.flat().filter(Boolean));
  const usedPlayers = Array.from(usedIds).map((id) => playerById(team, id)).filter(Boolean);
  function render() {
    const body = el("sub-modal-body");
    let html = `<div class="row" style="flex-direction:column;align-items:stretch;gap:10px;">`;
    html += `<label class="note">Player going out<select id="sub-out-select" style="width:100%;margin-top:4px;"><option value="">Choose…</option>${usedPlayers.map((p) => `<option value="${p.id}" ${state.outPlayerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label>`;
    html += `<label class="note">Bringing in<select id="sub-mode-select" style="width:100%;margin-top:4px;">
      <option value="existing" ${state.mode === "existing" ? "selected" : ""}>An existing player on this team</option>
      <option value="new" ${state.mode === "new" ? "selected" : ""}>A new player</option>
    </select></label>`;
    if (state.mode === "existing") {
      // Anyone else already playing tonight can still come in — that's a
      // deliberate double-up (one player covering two pairs), not a
      // mistake, so it's offered rather than hidden — just labelled
      // clearly so it's an informed choice. The one exception: whoever's
      // already partnering the outgoing player can't come in for them —
      // that'd pair that seed with itself.
      const partnersOfOut = new Set(
        sel.pairs.filter((pair) => pair.includes(state.outPlayerId)).map((pair) => pair.find((pid) => pid !== state.outPlayerId)).filter(Boolean)
      );
      const inOptions = team.players.filter((p) => p.id !== state.outPlayerId && !partnersOfOut.has(p.id));
      html += `<label class="note">Player coming in<select id="sub-in-select" style="width:100%;margin-top:4px;"><option value="">Choose…</option>${inOptions.map((p) => `<option value="${p.id}" ${state.inPlayerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}${usedIds.has(p.id) ? " (double up)" : ""}</option>`).join("")}</select></label>`;
    } else {
      html += `<label class="note">New player's name<input type="text" id="sub-new-name" value="${escapeHtml(state.newName)}" placeholder="Full name" style="width:100%;margin-top:4px;"></label>`;
    }
    html += `</div>`;
    body.innerHTML = html;
    el("sub-out-select").onchange = (e) => { state.outPlayerId = e.target.value; state.inPlayerId = ""; render(); };
    el("sub-mode-select").onchange = (e) => { state.mode = e.target.value; render(); };
    if (state.mode === "existing") el("sub-in-select").onchange = (e) => { state.inPlayerId = e.target.value; };
    else el("sub-new-name").oninput = (e) => { state.newName = e.target.value; };
  }
  render();
  el("sub-modal-backdrop").classList.add("open");
  el("sub-modal-save").onclick = async () => {
    if (!state.outPlayerId) { el("sub-modal-error").textContent = "Choose who's coming out."; return; }
    const body = { side, outPlayerId: state.outPlayerId };
    if (state.mode === "existing") {
      if (!state.inPlayerId) { el("sub-modal-error").textContent = "Choose who's coming in."; return; }
      body.inPlayerId = state.inPlayerId;
    } else {
      if (!state.newName.trim()) { el("sub-modal-error").textContent = "Enter the new player's name."; return; }
      body.newPlayerName = state.newName.trim();
    }
    try {
      await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/selection/substitute`, { method: "POST", body });
      el("sub-modal-backdrop").classList.remove("open");
      await refreshLeague(); renderAll();
    } catch (e) { el("sub-modal-error").textContent = e.message; }
  };
}
el("sub-modal-close").onclick = () => el("sub-modal-backdrop").classList.remove("open");
el("sub-modal-cancel").onclick = () => el("sub-modal-backdrop").classList.remove("open");
el("sub-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "sub-modal-backdrop") el("sub-modal-backdrop").classList.remove("open"); });

/* ---------- Fixtures (read-only) ---------- */

function courtScheduleOptions(fixtures) {
  const options = [];
  fixtures.forEach((f) => {
    const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
    const revealed = f.selectionA.submitted && f.selectionB.submitted;
    for (let seed = 0; seed < 4; seed++) {
      // Once revealed, still keep the team names + seed number in the select
      // option (not just the player pair) — otherwise, with two fixtures'
      // lineups both revealed, the dropdown is just a flat list of player
      // names with no way to tell which match each one belongs to.
      const pairLabel = revealed
        ? playerNamesForGold(teamA, f.selectionA.pairs[seed]) + " v " + playerNamesForGold(teamB, f.selectionB.pairs[seed])
        : null;
      const label = "Seed " + (seed + 1) + " — " + (teamA ? teamA.name : "TBD") + " vs " + (teamB ? teamB.name : "TBD") + (pairLabel ? " (" + pairLabel + ")" : "");
      options.push({ fixtureId: f.id, seed, label, teamA, teamB, shortLabel: pairLabel || ("Seed " + (seed + 1)) });
    }
  });
  return options;
}
// One color per fixture (matchup), stable for as long as the round's fixture
// order doesn't change — every seed belonging to that fixture gets the same
// rectangle color, cycling if a round somehow has more fixtures than colors.
const COURT_SCHEDULE_PALETTE = [
  { border: "#2563EB", bg: "rgba(37,99,235,.18)" },
  { border: "#D97706", bg: "rgba(217,119,6,.18)" },
  { border: "#DB2777", bg: "rgba(219,39,119,.18)" },
  { border: "#0D9488", bg: "rgba(13,148,136,.18)" },
  { border: "#7C3AED", bg: "rgba(124,58,237,.18)" },
  { border: "#EA580C", bg: "rgba(234,88,12,.18)" },
  { border: "#16A34A", bg: "rgba(22,163,74,.18)" },
  { border: "#4F46E5", bg: "rgba(79,70,229,.18)" },
];
function fixtureColor(fixtureId, fixtures) {
  const idx = fixtures.findIndex((f) => f.id === fixtureId);
  return COURT_SCHEDULE_PALETTE[(idx < 0 ? 0 : idx) % COURT_SCHEDULE_PALETTE.length];
}
// Counts, per team per slot, how many times that team has had a "double"
// (two rubbers on two courts at once) across every round with a saved court
// schedule — lets the admin see the auto-fill's rotation is actually fair
// without checking every round by hand.
function computeDoubleTally() {
  const slots = league.slotCount || 3;
  const fixturesById = {};
  league.fixtures.forEach((f) => { fixturesById[f.id] = f; });
  const tally = {};
  Object.values(league.courtSchedule || {}).forEach((grid) => {
    (grid || []).forEach((row, s) => {
      const counts = {};
      (row || []).forEach((cell) => { if (cell) counts[cell.fixtureId] = (counts[cell.fixtureId] || 0) + 1; });
      Object.keys(counts).forEach((fid) => {
        if (counts[fid] < 2) return;
        const f = fixturesById[fid];
        if (!f) return;
        [f.teamA, f.teamB].forEach((teamId) => {
          if (!tally[teamId]) tally[teamId] = Array(slots).fill(0);
          tally[teamId][s]++;
        });
      });
    });
  });
  return tally;
}
function courtBalanceStrip() {
  const tally = computeDoubleTally();
  const teamIds = Object.keys(tally);
  const wrap = document.createElement("div");
  if (teamIds.length === 0) return wrap;
  const slots = league.slotCount || 3;
  wrap.className = "cs-balance";
  const title = document.createElement("h3");
  title.className = "cs-balance-title";
  title.textContent = "Season balance — who's had the double, by slot";
  wrap.appendChild(title);
  let html = `<table class="log"><thead><tr><th>Team</th>${Array.from({ length: slots }, (_, i) => `<th class="num">Slot ${i + 1}</th>`).join("")}<th class="num">Spread</th></tr></thead><tbody>`;
  teamIds.forEach((teamId) => {
    const team = league.teams.find((t) => t.id === teamId);
    const counts = tally[teamId];
    const spread = Math.max(...counts) - Math.min(...counts);
    html += `<tr><td>${escapeHtml(team ? team.name : "?")}</td>${counts.map((v) => `<td class="num">${v}</td>`).join("")}<td class="num" style="color:${spread <= 1 ? "var(--accent)" : "var(--clay)"};">${spread}</td></tr>`;
  });
  html += "</tbody></table>";
  const tableWrap = document.createElement("div");
  tableWrap.innerHTML = html;
  wrap.appendChild(tableWrap.firstElementChild);
  return wrap;
}
function renderCourtScheduleGrid(fixtures) {
  const card = el("court-schedule-card");
  if (!viewingKey || viewingKey.stage !== "regular" || fixtures.length === 0) { card.style.display = "none"; return; }
  card.style.display = "block";
  el("court-schedule-poster-row").style.display = myRole === "admin" ? "flex" : "none";
  el("court-schedule-generate-row").style.display = myRole === "admin" ? "flex" : "none";

  const round = viewingKey.round;
  const courts = league.courtCount || 4;
  const slots = league.slotCount || 3;
  // Resize to the current court/slot counts on read, same as the server
  // does on write — otherwise a saved grid from before a count change would
  // display with stale, misaligned cells until the next edit re-saves it.
  const rawGrid = (league.courtSchedule && league.courtSchedule[round]) || [];
  const savedGrid = Array.from({ length: slots }, (_, s) => Array.from({ length: courts }, (_, c) => (rawGrid[s] && rawGrid[s][c]) || null));
  const options = courtScheduleOptions(fixtures);
  const usedKeys = new Set();
  savedGrid.forEach((row) => (row || []).forEach((cell) => { if (cell) usedKeys.add(cell.fixtureId + ":" + cell.seed); }));

  const wrap = el("court-schedule-grid");
  wrap.innerHTML = "";

  const legend = document.createElement("div");
  legend.className = "cs-legend";
  legend.innerHTML = fixtures.map((f) => {
    const color = fixtureColor(f.id, fixtures);
    const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
    return `<div class="cs-legend-item"><span class="cs-swatch" style="background:${color.border}"></span>${avatarHtml(teamA)}<span class="cs-vs">v</span>${avatarHtml(teamB)}<span>${escapeHtml(teamA ? teamA.name : "TBD")} vs ${escapeHtml(teamB ? teamB.name : "TBD")}</span></div>`;
  }).join("");
  wrap.appendChild(legend);

  const scroll = document.createElement("div");
  scroll.className = "court-schedule-scroll hscroll";
  const table = document.createElement("table");
  table.className = "court-schedule-table";
  const courtNames = league.courtNames || [];
  const thead = document.createElement("thead");
  if (myRole === "admin") {
    thead.innerHTML = "<tr><th></th>" + Array.from({ length: courts }, (_, c) =>
      `<th><input type="text" class="court-name-input" placeholder="Court ${c + 1}" value="${escapeHtml(courtNames[c] || "")}"></th>`
    ).join("") + "</tr>";
    thead.querySelectorAll(".court-name-input").forEach((input) => {
      input.onchange = async () => {
        const names = Array.from(thead.querySelectorAll(".court-name-input")).map((i) => i.value.trim());
        try {
          await api(`/leagues/${currentLeagueId}/court-names`, { method: "PUT", body: { names } });
          await refreshLeague(); renderAll();
        } catch (e) { alert(e.message); }
      };
    });
  } else {
    thead.innerHTML = "<tr><th></th>" + Array.from({ length: courts }, (_, c) => `<th>${escapeHtml(courtNames[c] || ("Court " + (c + 1)))}</th>`).join("") + "</tr>";
  }
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (let s = 0; s < slots; s++) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = "Match " + (s + 1);
    tr.appendChild(th);
    // A "double" is a fixture that appears twice in this slot row — two of
    // its rubbers running on two different courts at the same time.
    const rowCounts = {};
    (savedGrid[s] || []).forEach((cell) => { if (cell) rowCounts[cell.fixtureId] = (rowCounts[cell.fixtureId] || 0) + 1; });
    const isDouble = (cell) => !!(cell && rowCounts[cell.fixtureId] > 1);
    const doubleBadge = (text) => { const b = document.createElement("div"); b.className = "cs-double-badge"; b.textContent = text; return b; };

    for (let c = 0; c < courts; c++) {
      const cell = savedGrid[s] && savedGrid[s][c];
      // Read-only view: merge two adjacent columns holding the same
      // fixture's double into one cell, so it reads as one connected match
      // instead of two coincidentally same-colored cells.
      if (myRole !== "admin" && isDouble(cell)) {
        const next = savedGrid[s] && savedGrid[s][c + 1];
        if (next && next.fixtureId === cell.fixtureId) {
          const td = document.createElement("td");
          td.colSpan = 2;
          const color = fixtureColor(cell.fixtureId, fixtures);
          td.style.cssText = `border-radius:8px;background:${color.bg};`;
          td.appendChild(doubleBadge("2 courts at once"));
          const row = document.createElement("div");
          row.className = "cs-double-row";
          [cell, next].forEach((c2) => {
            const opt = options.find((o) => o.fixtureId === c2.fixtureId && o.seed === c2.seed);
            const half = document.createElement("div");
            half.className = "cs-double-half";
            half.innerHTML = opt ? `<div class="cs-cell-teams">${avatarHtml(opt.teamA)}<span class="cs-vs">v</span>${avatarHtml(opt.teamB)}</div><div class="cs-cell-label">${escapeHtml(opt.shortLabel)}</div>` : "—";
            row.appendChild(half);
          });
          td.appendChild(row);
          tr.appendChild(td);
          c++;
          continue;
        }
      }
      const td = document.createElement("td");
      if (cell) {
        const color = fixtureColor(cell.fixtureId, fixtures);
        td.style.cssText = `border-radius:8px;background:${color.bg};`;
      }
      if (isDouble(cell)) td.appendChild(doubleBadge("2 courts"));
      if (myRole === "admin") {
        const select = document.createElement("select");
        const usable = options.filter((o) => !usedKeys.has(o.fixtureId + ":" + o.seed) || (cell && cell.fixtureId === o.fixtureId && cell.seed === o.seed));
        select.innerHTML = '<option value="">— empty —</option>' + usable
          .map((o) => `<option value="${o.fixtureId}:${o.seed}" ${cell && cell.fixtureId === o.fixtureId && cell.seed === o.seed ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
          .join("");
        select.onchange = async () => {
          const val = select.value;
          const body = val ? { slot: s, court: c, fixtureId: val.split(":")[0], seed: Number(val.split(":")[1]) } : { slot: s, court: c, fixtureId: null };
          try {
            await api(`/leagues/${currentLeagueId}/court-schedule/${round}/assign`, { method: "POST", body });
            await refreshLeague(); renderAll();
          } catch (e) { alert(e.message); }
        };
        if (cell) select.style.background = "transparent";
        const opt = cell ? options.find((o) => o.fixtureId === cell.fixtureId && o.seed === cell.seed) : null;
        if (opt) {
          const preview = document.createElement("div");
          preview.className = "cs-cell-preview";
          preview.innerHTML = `${avatarHtml(opt.teamA)}<span class="cs-vs">v</span>${avatarHtml(opt.teamB)}`;
          td.appendChild(preview);
        }
        td.appendChild(select);
      } else {
        const opt = cell ? options.find((o) => o.fixtureId === cell.fixtureId && o.seed === cell.seed) : null;
        if (opt) {
          const box = document.createElement("div");
          box.innerHTML = `<div class="cs-cell-teams">${avatarHtml(opt.teamA)}<span class="cs-vs">v</span>${avatarHtml(opt.teamB)}</div><div class="cs-cell-label">${escapeHtml(opt.shortLabel)}</div>`;
          td.appendChild(box);
        } else {
          td.appendChild(document.createTextNode("—"));
        }
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  if (myRole === "admin") wrap.appendChild(courtBalanceStrip());
}
function renderFixtures() {
  renderRoundNav("round-nav-fixtures");
  const c = el("fixtures-container");
  c.innerHTML = "";
  const fixtures = fixturesForKey(viewingKey);
  el("fixtures-poster-row").style.display = myRole === "admin" && fixtures.length > 0 ? "flex" : "none";
  renderCourtScheduleGrid(fixtures);
  if (fixtures.length === 0) { c.innerHTML = '<div class="card"><p class="empty">No fixtures this round yet.</p></div>'; return; }
  fixtures.forEach((f) => {
    const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
    const card = document.createElement("div"); card.className = "fixture-card";
    const { winsA, winsB } = fixtureScoreClient(f);
    const both = f.selectionA.submitted && f.selectionB.submitted;
    let html = `<div class="fixture-head"><div class="fixture-title">${teamA ? avatarHtml(teamA) : ""} ${escapeHtml(teamA ? teamA.name : "TBD")} <span class="vs">vs</span> ${escapeHtml(teamB ? teamB.name : "TBD")} ${teamB ? avatarHtml(teamB) : ""}</div><div><span class="night-score">${winsA} - ${winsB}</span> <span class="badge ${f.finalized ? "done" : "pending"}">${f.finalized ? "Final" : "Pending"}</span></div></div>`;
    const sched = scheduleFor(stageKeyFor(f));
    const venue = effectiveVenue(stageKeyFor(f));
    if (sched.date || sched.time || venue) html += `<div class="fixture-sub">${sched.date ? "<span>" + fmtDate(sched.date) + "</span>" : ""}${sched.time ? "<span>" + fmtTime(sched.time) + "</span>" : ""}${venue ? "<span>" + escapeHtml(venue) + "</span>" : ""}</div>`;
    if (teamA && teamB) {
      if (both) {
        html += '<div class="rubbers">';
        f.selectionA.pairs.forEach((pairA, i) => {
          const pairB = f.selectionB.pairs[i];
          const nameA = pairNamesGoldHtml(teamA, pairA);
          const nameB = pairNamesGoldHtml(teamB, pairB);
          const w = rubberWinnerClient(f.rubbers[i]);
          const slotNum = f.slotOrder ? f.slotOrder.indexOf(i) + 1 : null;
          const seedLbl = "Seed " + (i + 1) + (slotNum ? " · Slot " + slotNum : "");
          html += `<div class="rubber-row"><span class="seed">${seedLbl}</span><span class="pair ${w === "A" ? "won" : ""}">${nameA}</span><span></span><span class="pair ${w === "B" ? "won" : ""}">${nameB}</span></div>`;
        });
        html += "</div>";
      } else {
        html += '<p class="note" style="margin-top:8px;">Line-ups not yet revealed — check Selection Room.</p>';
      }
    }
    card.innerHTML = html;
    c.appendChild(card);
  });
}

/* ---------- Results ---------- */

function isValidSetClient(a, b) {
  if (a === null || b === null || a === "" || b === "") return null;
  const av = Number(a), bv = Number(b);
  if (isNaN(av) || isNaN(bv)) return false;
  const hi = Math.max(av, bv), lo = Math.min(av, bv);
  if (hi === 6 && lo <= 4) return true;
  if (hi === 7 && (lo === 5 || lo === 6)) return true;
  return false;
}
function setWinnerClient(set) {
  const [a, b] = set;
  if (a === null || b === null || a === "" || b === "") return null;
  const av = Number(a), bv = Number(b);
  if (av > bv) return "A"; if (bv > av) return "B"; return null;
}
function tiebreakWinnerClient(tb) {
  const [a, b] = tb;
  if (a === null || b === null || a === "" || b === "") return null;
  const av = Number(a), bv = Number(b);
  if (av === bv) return null;
  if (Math.max(av, bv) < 10) return null;
  if (Math.abs(av - bv) < 2) return null;
  return av > bv ? "A" : "B";
}
function rubberWinnerClient(r) {
  const s1 = setWinnerClient(r.sets[0]), s2 = setWinnerClient(r.sets[1]);
  if (!s1 || !s2) return null;
  if (s1 === s2) return s1;
  return tiebreakWinnerClient(r.tb);
}
function needsTiebreakClient(r) {
  const s1 = setWinnerClient(r.sets[0]), s2 = setWinnerClient(r.sets[1]);
  return !!(s1 && s2 && s1 !== s2);
}
function fixtureScoreClient(f) {
  let winsA = 0, winsB = 0, decided = 0;
  f.rubbers.slice(0, 4).forEach((r) => { const w = rubberWinnerClient(r); if (w) { decided++; if (w === "A") winsA++; else winsB++; } });
  return { winsA, winsB, decided };
}
// e.g. "6-3, 6-4" or "6-4, 3-6, [10-7]" for a split needing a super
// tie-break — same "6-0 to 6-4, 7-5, or 7-6" notation used everywhere else.
function rubberScoreText(r) {
  const parts = [];
  const setText = (s) => (s[0] !== null && s[0] !== "" && s[1] !== null && s[1] !== "") ? s[0] + "-" + s[1] : null;
  const s0 = setText(r.sets[0]), s1 = setText(r.sets[1]);
  if (s0) parts.push(s0);
  if (s1) parts.push(s1);
  if (needsTiebreakClient(r)) {
    const tb = setText(r.tb);
    if (tb) parts.push("[" + tb + "]");
  }
  return parts.join(", ");
}

function renderResults() {
  renderRoundNav("round-nav-results");
  const c = el("results-container");
  c.innerHTML = "";
  const fixtures = fixturesForKey(viewingKey);
  el("results-poster-row").style.display = myRole === "admin" && fixtures.length > 0 ? "flex" : "none";
  if (fixtures.length === 0) { c.innerHTML = '<div class="card"><p class="empty">No fixtures this round yet.</p></div>'; return; }
  fixtures.forEach((f) => c.appendChild(resultsCard(f)));
}
// Every specific partnership that played this round — one per seed per
// side — as vote options. Mirrors potwEligiblePairs() server-side; the
// server re-validates on submit so this is just for building the dropdown.
function potwEligiblePairsClient(fixtures) {
  const pairs = [];
  fixtures.forEach((f) => {
    const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
    if (!(f.selectionA.submitted && f.selectionB.submitted)) return;
    [["A", teamA, f.selectionA], ["B", teamB, f.selectionB]].forEach(([side, team, selection]) => {
      if (!team) return;
      selection.pairs.forEach((pair, seed) => {
        const p1 = playerById(team, pair[0]), p2 = playerById(team, pair[1]);
        if (!p1 || !p2) return;
        pairs.push({ key: `${f.id}:${side}:${seed}`, teamName: team.name, playerAName: p1.name, playerBName: p2.name });
      });
    });
  });
  return pairs;
}
function renderPotwCard(fixtures) {
  const card = el("potw-card");
  if (!viewingKey || viewingKey.stage !== "regular" || fixtures.length === 0 || !fixtures.every((f) => f.finalized)) {
    card.style.display = "none";
    return;
  }
  const round = viewingKey.round;
  const data = (league.potwByRound && league.potwByRound[round]) || { tally: [], winner: null };
  card.style.display = "block";

  const pairLabel = (p) => `${p.playerAName} & ${p.playerBName}`;
  let html = '<h2 class="section-title">Pair of the week</h2>';
  if (data.winner) {
    html += `<p class="note" style="margin-bottom:10px;">👑 Leading: <strong style="color:var(--accent);">${escapeHtml(pairLabel(data.winner))}</strong> <span class="note">(${escapeHtml(data.winner.teamName)})</span> — ${data.winner.votes} vote${data.winner.votes === 1 ? "" : "s"}</p>`;
    if (data.tally.length > 1) {
      html += '<div class="potw-tally">' + data.tally.map((t, i) => `<div class="potw-tally-row"><span>${i === 0 ? "👑 " : ""}${escapeHtml(pairLabel(t))} <span class="note">(${escapeHtml(t.teamName)})</span></span><span class="tag">${t.votes}</span></div>`).join("") + "</div>";
    }
  } else {
    html += '<p class="note" style="margin-bottom:10px;">No votes yet — cast yours below.</p>';
  }
  card.innerHTML = html;

  if (myRole === "captain" || myRole === "admin") {
    const eligible = potwEligiblePairsClient(fixtures);
    const voteWrap = document.createElement("div");
    voteWrap.className = "row";
    voteWrap.style.marginTop = "12px";
    const select = document.createElement("select");
    select.innerHTML = '<option value="">Choose a pair…</option>' + eligible.map((p) => `<option value="${p.key}">${escapeHtml(pairLabel(p))} (${escapeHtml(p.teamName)})</option>`).join("");
    const myVote = league.myPotwVote && league.myPotwVote[round];
    if (myVote) select.value = myVote;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = myVote ? "Change vote" : "Vote";
    btn.onclick = async () => {
      const pairKey = select.value;
      if (!pairKey) return;
      try {
        await api(`/leagues/${currentLeagueId}/pair-of-week/${round}/vote`, { method: "POST", body: { pairKey } });
        await refreshLeague(); renderAwards();
      } catch (e) { alert(e.message); }
    };
    voteWrap.appendChild(select); voteWrap.appendChild(btn);
    card.appendChild(voteWrap);
  }
}
function resultsCard(f) {
  const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
  const card = document.createElement("div"); card.className = "fixture-card";
  const { winsA, winsB, decided } = fixtureScoreClient(f);
  card.innerHTML = `<div class="fixture-head"><div class="fixture-title">${teamA ? avatarHtml(teamA) : ""} ${escapeHtml(teamA ? teamA.name : "TBD")} <span class="vs">vs</span> ${escapeHtml(teamB ? teamB.name : "TBD")} ${teamB ? avatarHtml(teamB) : ""}</div><div><span class="night-score">${winsA} - ${winsB}</span> <span class="badge ${f.finalized ? "done" : "pending"}">${f.finalized ? "Final" : decided + "/4 matches"}</span></div></div>`;
  if (!teamA || !teamB) { card.appendChild(Object.assign(document.createElement("p"), { className: "empty", textContent: "Waiting on the semi-final results." })); return card; }
  if (!(f.selectionA.submitted && f.selectionB.submitted)) { card.appendChild(Object.assign(document.createElement("p"), { className: "empty", textContent: "Waiting for both teams to submit their line-up in Selection Room." })); return card; }

  const editable = myRole === "admin" || (!f.finalized && myRole === "captain" && (myTeamId === f.teamA || myTeamId === f.teamB));
  const rubbersWrap = document.createElement("div"); rubbersWrap.className = "rubbers";

  f.rubbers.forEach((rubber, idx) => {
    const isDecider = idx === 4;
    if (isDecider) { const { winsA: wa, winsB: wb } = fixtureScoreClient(f); if (wa !== wb) return; }
    const row = document.createElement("div"); row.className = "rubber-row";
    const winner = rubberWinnerClient(rubber);
    const seedTag = document.createElement("div"); seedTag.className = "seed";
    const slotNum = f.slotOrder ? f.slotOrder.indexOf(idx) + 1 : null;
    seedTag.textContent = isDecider ? "Decider" : "Seed " + (idx + 1) + (slotNum ? " · Slot " + slotNum : "");
    const pairAHtml = pairNamesGoldHtml(teamA, f.selectionA.pairs[idx]);
    const pairBHtml = pairNamesGoldHtml(teamB, f.selectionB.pairs[idx]);
    const potwWinnerKey = league.potwByRound && league.potwByRound[f.round] && league.potwByRound[f.round].winner && league.potwByRound[f.round].winner.key;
    const isPotwPair = (side) => !isDecider && potwWinnerKey === `${f.id}:${side}:${idx}`;
    const pairADisplay = document.createElement("div"); pairADisplay.className = "pair" + (winner === "A" ? " won" : ""); pairADisplay.innerHTML = isDecider ? escapeHtml(teamA.name) : (isPotwPair("A") ? "👑 " : "") + pairAHtml;
    const pairBDisplay = document.createElement("div"); pairBDisplay.className = "pair" + (winner === "B" ? " won" : ""); pairBDisplay.innerHTML = isDecider ? escapeHtml(teamB.name) : (isPotwPair("B") ? "👑 " : "") + pairBHtml;

    const scores = document.createElement("div"); scores.className = "score-summary-wrap";
    const scoreText = document.createElement("div"); scoreText.className = "score-summary-text" + (winner ? " done" : "");
    scoreText.textContent = rubberScoreText(rubber) || "Not played yet";
    scores.appendChild(scoreText);
    [0, 1].forEach((si) => {
      const valid = isValidSetClient(rubber.sets[si][0], rubber.sets[si][1]);
      if (valid === false) { const w = document.createElement("div"); w.className = "warn"; w.textContent = "Set " + (si + 1) + ": not a real padel score"; scores.appendChild(w); }
    });
    if (editable) {
      const editBtn = document.createElement("button"); editBtn.className = "secondary score-edit-btn";
      editBtn.textContent = rubberScoreText(rubber) ? "Edit score" : "Enter score";
      editBtn.onclick = () => openScoreModal(f, idx, rubber, teamA, teamB, isDecider, pairAHtml, pairBHtml);
      scores.appendChild(editBtn);
    }
    row.appendChild(seedTag); row.appendChild(pairADisplay); row.appendChild(scores); row.appendChild(pairBDisplay);
    rubbersWrap.appendChild(row);
  });
  card.appendChild(rubbersWrap);

  const footer = document.createElement("div"); footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
  if (editable && !f.finalized) {
    const saveBtn = document.createElement("button"); saveBtn.className = "secondary"; saveBtn.textContent = "Finalize";
    saveBtn.onclick = async () => {
      try { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/finalize`, { method: "POST" }); await refreshLeague(); renderAll(); }
      catch (e) { alert(e.message); }
    };
    footer.appendChild(saveBtn);
  } else if (myRole === "admin" && f.finalized) {
    const unlockBtn = document.createElement("button"); unlockBtn.className = "secondary"; unlockBtn.textContent = "Unlock to edit";
    unlockBtn.onclick = async () => { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/unlock`, { method: "POST" }); await refreshLeague(); renderAll(); };
    footer.appendChild(unlockBtn);
  }
  card.appendChild(footer);
  return card;
}
// Scorecard-style entry: one column per set (plus a Super TB column once
// sets are split), one row per pair, real number cells you tap and type
// into. Edits are staged locally until Save so one PUT covers sets +
// tie-break together instead of firing per keystroke. Cells commit on
// blur/change rather than on every keystroke — re-rendering on each
// keypress would rebuild the DOM and kick focus out of the field, making
// it impossible to type a 2-digit tie-break score.
function openScoreModal(f, idx, rubber, teamA, teamB, isDecider, pairAHtml, pairBHtml) {
  const state = {
    sets: rubber.sets.map((s) => [s[0] === null || s[0] === "" ? null : Number(s[0]), s[1] === null || s[1] === "" ? null : Number(s[1])]),
    tb: [rubber.tb[0] === null || rubber.tb[0] === "" ? 0 : Number(rubber.tb[0]), rubber.tb[1] === null || rubber.tb[1] === "" ? 0 : Number(rubber.tb[1])],
  };
  const slotNum = f.slotOrder ? f.slotOrder.indexOf(idx) + 1 : null;
  el("score-modal-title").textContent = isDecider ? "Decider score" : "Seed " + (idx + 1) + " score" + (slotNum ? " · Slot " + slotNum : "");
  const nameA = isDecider ? escapeHtml(teamA.name) : pairAHtml;
  const nameB = isDecider ? escapeHtml(teamB.name) : pairBHtml;
  const needsTb = () => {
    const s1 = setWinnerClient(state.sets[0]), s2 = setWinnerClient(state.sets[1]);
    return !!(s1 && s2 && s1 !== s2);
  };
  function render() {
    const body = el("score-modal-body");
    const tb = needsTb();
    const cols = tb ? 4 : 3;
    const w0 = setWinnerClient(state.sets[0]), w1 = setWinnerClient(state.sets[1]);
    const wtb = tb ? tiebreakWinnerClient(state.tb) : null;
    const winCls = (won) => won ? " won" : "";
    let html = `<div class="score-table" style="grid-template-columns:1fr repeat(${cols - 1},var(--score-col-w,48px));">`;
    html += `<div class="score-th"></div><div class="score-th">Set 1</div><div class="score-th">Set 2</div>${tb ? '<div class="score-th">Super TB</div>' : ""}`;
    html += `<div class="score-team-cell">${avatarHtml(teamA)}<span>${nameA}</span></div>`;
    html += `<input class="score-cell-input${winCls(w0 === "A")}" type="text" inputmode="numeric" data-set="0" data-side="0" value="${state.sets[0][0] === null ? "" : state.sets[0][0]}">`;
    html += `<input class="score-cell-input${winCls(w1 === "A")}" type="text" inputmode="numeric" data-set="1" data-side="0" value="${state.sets[1][0] === null ? "" : state.sets[1][0]}">`;
    if (tb) html += `<input class="score-cell-input tb${winCls(wtb === "A")}" type="text" inputmode="numeric" data-tb="0" value="${state.tb[0]}">`;
    html += `<div class="score-row-divider" style="grid-column:1/-1;"></div>`;
    html += `<div class="score-team-cell">${avatarHtml(teamB)}<span>${nameB}</span></div>`;
    html += `<input class="score-cell-input${winCls(w0 === "B")}" type="text" inputmode="numeric" data-set="0" data-side="1" value="${state.sets[0][1] === null ? "" : state.sets[0][1]}">`;
    html += `<input class="score-cell-input${winCls(w1 === "B")}" type="text" inputmode="numeric" data-set="1" data-side="1" value="${state.sets[1][1] === null ? "" : state.sets[1][1]}">`;
    if (tb) html += `<input class="score-cell-input tb${winCls(wtb === "B")}" type="text" inputmode="numeric" data-tb="1" value="${state.tb[1]}">`;
    html += `</div>`;
    const warnings = [0, 1]
      .filter((si) => isValidSetClient(state.sets[si][0], state.sets[si][1]) === false)
      .map((si) => `<div class="warn">Set ${si + 1}: not a real padel score</div>`);
    if (warnings.length) html += `<div class="score-warnings">${warnings.join("")}</div>`;
    body.innerHTML = html;
    body.querySelectorAll(".score-cell-input[data-set]").forEach((inp) => {
      inp.onchange = () => {
        const si = Number(inp.dataset.set), side = Number(inp.dataset.side);
        const v = inp.value.trim();
        state.sets[si][side] = v === "" ? null : Math.max(0, Math.min(7, parseInt(v, 10) || 0));
        render();
      };
    });
    body.querySelectorAll(".score-cell-input[data-tb]").forEach((inp) => {
      inp.onchange = () => {
        const side = Number(inp.dataset.tb);
        const v = inp.value.trim();
        state.tb[side] = v === "" ? 0 : Math.max(0, parseInt(v, 10) || 0);
        render();
      };
    });
  }
  render();
  el("score-modal-backdrop").classList.add("open");
  el("score-modal-clear").onclick = () => { state.sets = [[null, null], [null, null]]; state.tb = [0, 0]; render(); };
  el("score-modal-save").onclick = async () => {
    const body = { sets: state.sets };
    if (needsTb()) body.tb = state.tb;
    try {
      await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/rubbers/${idx}`, { method: "PUT", body });
      el("score-modal-backdrop").classList.remove("open");
      await refreshLeague(); renderResults();
    } catch (e) { alert(e.message); }
  };
}
el("score-modal-close").onclick = () => el("score-modal-backdrop").classList.remove("open");
el("score-modal-cancel").onclick = () => el("score-modal-backdrop").classList.remove("open");
el("score-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "score-modal-backdrop") el("score-modal-backdrop").classList.remove("open"); });
function playerNamesFor(team, pair) {
  if (!pair) return "—";
  const names = [playerById(team, pair[0]), playerById(team, pair[1])].filter(Boolean).map((p) => p.name).join(" & ");
  return names || "—";
}

/* ---------- Poster generator (fixtures & results, drawn client-side) ---------- */

function loadImageAsync(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// Shrinks font size to fit maxWidth (down to a floor), then hard-truncates
// with an ellipsis if it still doesn't fit — team names are admin-entered
// free text with no length limit, so both guards are needed.
function fitText(ctx, text, maxWidth, startSize, weight, family, floor) {
  floor = floor || 18;
  let size = startSize;
  const apply = () => { ctx.font = weight + " " + size + "px " + family; };
  apply();
  while (size > floor && ctx.measureText(text).width > maxWidth) { size -= 2; apply(); }
  let out = text;
  while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) { out = out.slice(0, -1); }
  return out.length < text.length ? out + "…" : out;
}
async function drawTeamLogo(ctx, team, cx, cy, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const img = team && team.logo ? await loadImageAsync(team.logo) : null;
  if (img) {
    const scale = Math.max((radius * 2) / img.width, (radius * 2) / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = "#EEF2F9";
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }
  ctx.restore();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#2563EB";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (!img) {
    ctx.fillStyle = "#64748B";
    ctx.font = "700 " + Math.round(radius) + "px Oswald, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(team ? team.name.charAt(0).toUpperCase() : "?", cx, cy + 3);
    ctx.textBaseline = "alphabetic";
  }
}
async function generatePosterCanvas(mode) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const fixtures = fixturesForKey(viewingKey).slice(0, 8);
  const sponsors = (league.sponsors || []).slice(0, 5);
  const W = 1080;
  const topY = 300, footerH = 70, rowGap = 16;
  const headerBlockH = 108;
  // Results mode needs a second, taller line per seed row to fit the set
  // score under the "SEED N" label, alongside the pair names.
  const pairRowH = mode === "results" ? 46 : 34, pairsTopPad = 8, pairsBottomPad = 10;
  const logoRadius = 40;
  const sponsorZoneH = sponsors.length ? 140 : 0;

  // Player pairs are only known once both captains have submitted their
  // line-up — before that there's nothing to show, so those fixtures just
  // get the compact team-vs-team header block, same as before this feature.
  const fixtureMeta = fixtures.map((f) => {
    const revealed = f.selectionA.submitted && f.selectionB.submitted;
    const blockH = headerBlockH + (revealed ? pairsTopPad + 4 * pairRowH + pairsBottomPad : 0);
    return { f, revealed, blockH };
  });
  const totalFixturesH = fixtureMeta.reduce((sum, m) => sum + m.blockH + rowGap, 0);
  const H = Math.max(1350, topY + totalFixturesH + sponsorZoneH + footerH);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0B1730");
  bg.addColorStop(1, "#16294D");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "#2563EB";
  ctx.font = "700 32px Oswald, sans-serif";
  ctx.fillText((league.name || "").toUpperCase(), W / 2, 96);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 68px Oswald, sans-serif";
  ctx.fillText(mode === "results" ? "RESULTS" : "FIXTURES", W / 2, 168);

  ctx.fillStyle = "#8FA9B4";
  ctx.font = "500 28px Oswald, sans-serif";
  ctx.fillText((viewingKey ? viewingKey.label : "").toUpperCase(), W / 2, 210);

  const sched = viewingKey ? scheduleFor(viewingKey.key) : {};
  const venue = viewingKey ? effectiveVenue(viewingKey.key) : "";
  const subParts = [];
  if (sched.date) subParts.push(fmtDate(sched.date));
  if (sched.time) subParts.push(fmtTime(sched.time));
  if (venue) subParts.push(venue);
  if (subParts.length) {
    ctx.fillStyle = "#DCE3F0";
    ctx.font = "400 24px Inter, sans-serif";
    ctx.fillText(subParts.join("   ·   "), W / 2, 248);
  }

  let y = topY;
  for (const { f, revealed, blockH } of fixtureMeta) {
    const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRectPath(ctx, 56, y, W - 112, blockH, 18);
    ctx.fill();

    const headerMidY = y + headerBlockH / 2;
    await drawTeamLogo(ctx, teamA, 56 + 40 + logoRadius, headerMidY, logoRadius);
    await drawTeamLogo(ctx, teamB, W - 56 - 40 - logoRadius, headerMidY, logoRadius);

    // Results mode draws a wider score (e.g. "10 - 8" at 42px) in the
    // middle than fixtures mode's small "VS", so it needs more clearance
    // to avoid the team name running into it.
    const nameMaxWidth = W / 2 - (mode === "results" ? 280 : 220);
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    const nameA = fitText(ctx, teamA ? teamA.name : "TBD", nameMaxWidth, 30, "600", "Oswald, sans-serif");
    ctx.fillText(nameA, 56 + 90 + logoRadius, headerMidY + 10);

    ctx.textAlign = "right";
    const nameB = fitText(ctx, teamB ? teamB.name : "TBD", nameMaxWidth, 30, "600", "Oswald, sans-serif");
    ctx.fillText(nameB, W - 56 - 90 - logoRadius, headerMidY + 10);

    ctx.textAlign = "center";
    if (mode === "results" && f.finalized) {
      const { winsA, winsB } = fixtureScoreClient(f);
      ctx.fillStyle = "#2563EB";
      ctx.font = "700 42px Oswald, sans-serif";
      ctx.fillText(winsA + " - " + winsB, W / 2, headerMidY + 15);
    } else {
      ctx.fillStyle = "#8FA9B4";
      ctx.font = "600 20px Oswald, sans-serif";
      ctx.fillText("VS", W / 2, headerMidY + 7);
    }

    if (revealed) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(80, y + headerBlockH);
      ctx.lineTo(W - 80, y + headerBlockH);
      ctx.stroke();

      const pairMaxWidth = W / 2 - 140;
      let py = y + headerBlockH + pairsTopPad + pairRowH / 2;
      for (let i = 0; i < 4; i++) {
        const namesA = playerNamesFor(teamA, f.selectionA.pairs[i]);
        const namesB = playerNamesFor(teamB, f.selectionB.pairs[i]);
        const winner = f.finalized ? rubberWinnerClient(f.rubbers[i]) : null;

        ctx.textAlign = "left";
        ctx.fillStyle = winner === "A" ? "#5B9CFF" : "#C6D2E3";
        const fittedA = fitText(ctx, namesA, pairMaxWidth, 20, winner === "A" ? "700" : "400", "Inter, sans-serif");
        ctx.fillText(fittedA, 90, py + 6);

        ctx.textAlign = "right";
        ctx.fillStyle = winner === "B" ? "#5B9CFF" : "#C6D2E3";
        const fittedB = fitText(ctx, namesB, pairMaxWidth, 20, winner === "B" ? "700" : "400", "Inter, sans-serif");
        ctx.fillText(fittedB, W - 90, py + 6);

        ctx.textAlign = "center";
        if (mode === "results" && f.finalized) {
          ctx.fillStyle = "#64748B";
          ctx.font = "500 12px Oswald, sans-serif";
          ctx.fillText("SEED " + (i + 1), W / 2, py - 9);
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "600 18px Oswald, sans-serif";
          ctx.fillText(rubberScoreText(f.rubbers[i]) || "—", W / 2, py + 14);
        } else {
          ctx.fillStyle = "#64748B";
          ctx.font = "500 15px Oswald, sans-serif";
          ctx.fillText("S" + (i + 1), W / 2, py + 5);
        }

        py += pairRowH;
      }
    }

    y += blockH + rowGap;
  }

  if (sponsors.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#8FA9B4";
    ctx.font = "500 20px Oswald, sans-serif";
    ctx.fillText("SPONSORED BY", W / 2, y + 26);

    const loadedLogos = (await Promise.all(sponsors.map((s) => loadImageAsync(s.image)))).filter(Boolean);
    if (loadedLogos.length) {
      const maxRowWidth = W - 160;
      const gap = 40;
      let logoH = 60;
      let widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
      let totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      if (totalW > maxRowWidth) {
        logoH *= maxRowWidth / totalW;
        widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
        totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      }
      let sx = W / 2 - totalW / 2;
      const sy = y + 52;
      loadedLogos.forEach((img, i) => {
        ctx.drawImage(img, sx, sy, widths[i], logoH);
        sx += widths[i] + gap;
      });
    }
  }

  ctx.fillStyle = "#64748B";
  ctx.font = "500 22px Oswald, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("TEAM PADEL", W / 2, H - 34);

  return canvas;
}
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
async function generateCourtSchedulePosterCanvas() {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const fixtures = fixturesForKey(viewingKey);
  const sponsors = (league.sponsors || []).slice(0, 5);
  const round = viewingKey.round;
  const courts = league.courtCount || 4;
  const slots = league.slotCount || 3;
  const rawGrid = (league.courtSchedule && league.courtSchedule[round]) || [];
  const grid = Array.from({ length: slots }, (_, s) => Array.from({ length: courts }, (_, c) => (rawGrid[s] && rawGrid[s][c]) || null));
  const options = courtScheduleOptions(fixtures);
  const courtNames = league.courtNames || [];

  const marginX = 56;
  const firstColW = 150;
  const courtColW = 264;
  const W = Math.max(1080, marginX * 2 + firstColW + courts * courtColW);

  const topY = 300;
  const legendItemH = 42;
  const legendH = fixtures.length ? 20 + fixtures.length * legendItemH + 24 : 0;
  const headerRowH = 76;
  // Tall enough for two full lines of player names (one per pair) stacked
  // vertically — a single "PairA v PairB" line doesn't fit real names in a
  // column this narrow, so each pair gets the full cell width to itself.
  const matchRowH = 176;
  const footerH = 70;
  const sponsorZoneH = sponsors.length ? 140 : 0;
  const H = topY + legendH + headerRowH + slots * matchRowH + sponsorZoneH + footerH + 40;

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0B1730");
  bg.addColorStop(1, "#16294D");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "#2563EB";
  ctx.font = "700 32px Oswald, sans-serif";
  ctx.fillText((league.name || "").toUpperCase(), W / 2, 96);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 58px Oswald, sans-serif";
  ctx.fillText("COURT SCHEDULE", W / 2, 168);

  ctx.fillStyle = "#8FA9B4";
  ctx.font = "500 28px Oswald, sans-serif";
  ctx.fillText((viewingKey ? viewingKey.label : "").toUpperCase(), W / 2, 210);

  const sched = viewingKey ? scheduleFor(viewingKey.key) : {};
  const venue = viewingKey ? effectiveVenue(viewingKey.key) : "";
  const subParts = [];
  if (sched.date) subParts.push(fmtDate(sched.date));
  if (sched.time) subParts.push(fmtTime(sched.time));
  if (venue) subParts.push(venue);
  if (subParts.length) {
    ctx.fillStyle = "#DCE3F0";
    ctx.font = "400 24px Inter, sans-serif";
    ctx.fillText(subParts.join("   ·   "), W / 2, 248);
  }

  let y = topY;

  if (fixtures.length) {
    let ly = y + 24;
    for (const f of fixtures) {
      const color = fixtureColor(f.id, fixtures);
      const teamA = teamById(f.teamA), teamB = teamById(f.teamB);
      ctx.fillStyle = color.border;
      roundRectPath(ctx, marginX, ly - 8, 16, 16, 4);
      ctx.fill();
      await drawTeamLogo(ctx, teamA, marginX + 42, ly, 14);
      await drawTeamLogo(ctx, teamB, marginX + 78, ly, 14);
      ctx.textAlign = "left";
      ctx.fillStyle = "#DCE3F0";
      ctx.font = "500 20px Inter, sans-serif";
      const label = (teamA ? teamA.name : "TBD") + " vs " + (teamB ? teamB.name : "TBD");
      ctx.fillText(fitText(ctx, label, W - marginX - 102, 20, "500", "Inter, sans-serif"), marginX + 102, ly + 6);
      ly += legendItemH;
    }
    y += legendH;
  }

  ctx.textAlign = "center";
  for (let c = 0; c < courts; c++) {
    const cx = marginX + firstColW + c * courtColW + courtColW / 2;
    ctx.fillStyle = "#8FA9B4";
    ctx.font = "600 22px Oswald, sans-serif";
    const label = (courtNames[c] || ("COURT " + (c + 1))).toUpperCase();
    ctx.fillText(fitText(ctx, label, courtColW - 24, 22, "600", "Oswald, sans-serif"), cx, y + headerRowH / 2 + 8);
  }
  y += headerRowH;

  for (let s = 0; s < slots; s++) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#8FA9B4";
    ctx.font = "600 20px Oswald, sans-serif";
    ctx.fillText("MATCH " + (s + 1), marginX, y + matchRowH / 2 + 7);

    for (let c = 0; c < courts; c++) {
      const cellX = marginX + firstColW + c * courtColW + 8;
      const cellW = courtColW - 16;
      const cellY = y + 8;
      const cellH = matchRowH - 16;
      const cell = grid[s][c];
      if (cell) {
        const color = fixtureColor(cell.fixtureId, fixtures);
        ctx.fillStyle = hexToRgba(color.border, 0.22);
        roundRectPath(ctx, cellX, cellY, cellW, cellH, 12);
        ctx.fill();
        ctx.strokeStyle = color.border;
        ctx.lineWidth = 2;
        roundRectPath(ctx, cellX, cellY, cellW, cellH, 12);
        ctx.stroke();

        const opt = options.find((o) => o.fixtureId === cell.fixtureId && o.seed === cell.seed);
        const fixture = fixtures.find((f) => f.id === cell.fixtureId);
        const revealed = fixture && fixture.selectionA.submitted && fixture.selectionB.submitted;
        const midX = cellX + cellW / 2;
        await drawTeamLogo(ctx, opt ? opt.teamA : null, midX - 24, cellY + 28, 15);
        ctx.textAlign = "center";
        ctx.fillStyle = "#8FA9B4";
        ctx.font = "500 13px Oswald, sans-serif";
        ctx.fillText("v", midX, cellY + 33);
        await drawTeamLogo(ctx, opt ? opt.teamB : null, midX + 24, cellY + 28, 15);

        if (revealed && opt) {
          // Each pair gets its own full-width line — showing every player's
          // name, not just team names, is the whole point of this poster.
          const pairA = playerNamesForGold(opt.teamA, fixture.selectionA.pairs[cell.seed]);
          const pairB = playerNamesForGold(opt.teamB, fixture.selectionB.pairs[cell.seed]);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(fitText(ctx, pairA, cellW - 16, 17, "600", "Inter, sans-serif", 12), midX, cellY + 66);
          ctx.fillStyle = "#8FA9B4";
          ctx.font = "500 12px Oswald, sans-serif";
          ctx.fillText("VS", midX, cellY + 86);
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(fitText(ctx, pairB, cellW - 16, 17, "600", "Inter, sans-serif", 12), midX, cellY + 110);
        } else {
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "500 18px Inter, sans-serif";
          ctx.fillText("Seed " + (cell.seed + 1), midX, cellY + 70);
        }
      } else {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.font = "400 20px Inter, sans-serif";
        ctx.fillText("—", cellX + cellW / 2, cellY + cellH / 2 + 7);
      }
    }
    y += matchRowH;
  }

  if (sponsors.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#8FA9B4";
    ctx.font = "500 20px Oswald, sans-serif";
    ctx.fillText("SPONSORED BY", W / 2, y + 26);

    const loadedLogos = (await Promise.all(sponsors.map((s) => loadImageAsync(s.image)))).filter(Boolean);
    if (loadedLogos.length) {
      const maxRowWidth = W - 160;
      const gap = 40;
      let logoH = 60;
      let widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
      let totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      if (totalW > maxRowWidth) {
        logoH *= maxRowWidth / totalW;
        widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
        totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      }
      let sx = W / 2 - totalW / 2;
      const sy = y + 52;
      loadedLogos.forEach((img, i) => {
        ctx.drawImage(img, sx, sy, widths[i], logoH);
        sx += widths[i] + gap;
      });
    }
  }

  ctx.fillStyle = "#64748B";
  ctx.font = "500 22px Oswald, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("TEAM PADEL", W / 2, H - 34);

  return canvas;
}
async function generateTablePosterCanvas() {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const rows = computeStandingsClient();
  const sponsors = (league.sponsors || []).slice(0, 5);
  const W = 1080;
  const topY = 300;
  const headerRowH = 56;
  const rowH = 84, rowGap = 10;
  const footerH = 70;
  const sponsorZoneH = sponsors.length ? 140 : 0;
  const H = Math.max(1080, topY + headerRowH + rows.length * (rowH + rowGap) + sponsorZoneH + footerH);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0B1730");
  bg.addColorStop(1, "#16294D");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "#2563EB";
  ctx.font = "700 32px Oswald, sans-serif";
  ctx.fillText((league.name || "").toUpperCase(), W / 2, 96);

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "700 68px Oswald, sans-serif";
  ctx.fillText("STANDINGS", W / 2, 168);

  ctx.fillStyle = "#8FA9B4";
  ctx.font = "500 24px Oswald, sans-serif";
  ctx.fillText("SEASON TABLE", W / 2, 210);

  const marginX = 56;
  const rankColW = 60;
  const logoR = 26;
  const nameX = marginX + rankColW + 20 + logoR * 2 + 16;
  const statCols = ["P", "WON", "LOST", "DIFF", "PTS"];
  const statColW = 90;
  const statsStartX = W - marginX - statCols.length * statColW;

  let y = topY;
  ctx.textAlign = "center";
  ctx.fillStyle = "#8FA9B4";
  ctx.font = "600 18px Oswald, sans-serif";
  statCols.forEach((label, i) => ctx.fillText(label, statsStartX + i * statColW + statColW / 2, y + headerRowH / 2 + 6));
  y += headerRowH;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isLeader = i === 0 && r.played > 0;
    ctx.fillStyle = isLeader ? "rgba(37,99,235,0.16)" : "rgba(255,255,255,0.06)";
    roundRectPath(ctx, marginX, y, W - marginX * 2, rowH, 14);
    ctx.fill();
    if (isLeader) {
      ctx.strokeStyle = "#2563EB";
      ctx.lineWidth = 2;
      roundRectPath(ctx, marginX, y, W - marginX * 2, rowH, 14);
      ctx.stroke();
    }

    const midY = y + rowH / 2;

    ctx.textAlign = "center";
    ctx.fillStyle = isLeader ? "#2563EB" : "#8FA9B4";
    ctx.font = "700 26px Oswald, sans-serif";
    ctx.fillText(String(i + 1), marginX + rankColW / 2, midY + 9);

    await drawTeamLogo(ctx, r, marginX + rankColW + 20 + logoR, midY, logoR);

    ctx.textAlign = "left";
    ctx.fillStyle = "#FFFFFF";
    const nameMaxWidth = statsStartX - nameX - 20;
    ctx.fillText(fitText(ctx, r.name.toUpperCase(), nameMaxWidth, 24, "600", "Oswald, sans-serif"), nameX, midY + 9);

    const values = [r.played, r.rubbersWon, r.rubbersLost, (r.diff > 0 ? "+" : "") + r.diff, r.points];
    ctx.textAlign = "center";
    values.forEach((v, ci) => {
      ctx.fillStyle = ci === 4 ? "#2563EB" : "#DCE3F0";
      ctx.font = ci === 4 ? "700 26px Oswald, sans-serif" : "500 22px Oswald, sans-serif";
      ctx.fillText(String(v), statsStartX + ci * statColW + statColW / 2, midY + 8);
    });

    y += rowH + rowGap;
  }

  if (sponsors.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#8FA9B4";
    ctx.font = "500 20px Oswald, sans-serif";
    ctx.fillText("SPONSORED BY", W / 2, y + 26);

    const loadedLogos = (await Promise.all(sponsors.map((s) => loadImageAsync(s.image)))).filter(Boolean);
    if (loadedLogos.length) {
      const maxRowWidth = W - 160;
      const gap = 40;
      let logoH = 60;
      let widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
      let totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      if (totalW > maxRowWidth) {
        logoH *= maxRowWidth / totalW;
        widths = loadedLogos.map((img) => (logoH / img.height) * img.width);
        totalW = widths.reduce((a, b) => a + b, 0) + gap * (loadedLogos.length - 1);
      }
      let sx = W / 2 - totalW / 2;
      const sy = y + 52;
      loadedLogos.forEach((img, i) => {
        ctx.drawImage(img, sx, sy, widths[i], logoH);
        sx += widths[i] + gap;
      });
    }
  }

  ctx.fillStyle = "#64748B";
  ctx.font = "500 22px Oswald, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("TEAM PADEL", W / 2, H - 34);

  return canvas;
}
async function openPosterModal(mode) {
  const titles = { results: "Results poster", "court-schedule": "Court schedule poster", table: "Table poster", fixtures: "Fixtures poster" };
  el("poster-modal-title").textContent = titles[mode] || "Fixtures poster";
  el("poster-preview-img").style.display = "none";
  el("poster-modal-loading").style.display = "block";
  el("poster-modal-backdrop").classList.add("open");
  const canvas = mode === "court-schedule" ? await generateCourtSchedulePosterCanvas() : mode === "table" ? await generateTablePosterCanvas() : await generatePosterCanvas(mode);
  const dataUrl = canvas.toDataURL("image/png");
  el("poster-preview-img").src = dataUrl;
  el("poster-preview-img").style.display = "inline-block";
  el("poster-modal-loading").style.display = "none";
  el("poster-download-btn").onclick = () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    const safeName = (league.name || "poster").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    a.download = safeName + "-" + mode + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
}
el("poster-modal-close").onclick = () => el("poster-modal-backdrop").classList.remove("open");
el("generate-fixtures-poster-btn").onclick = () => openPosterModal("fixtures");
el("generate-results-poster-btn").onclick = () => openPosterModal("results");
el("generate-court-schedule-poster-btn").onclick = () => openPosterModal("court-schedule");
el("generate-table-poster-btn").onclick = () => openPosterModal("table");
el("generate-court-rotation-btn").onclick = async () => {
  if (!confirm("This fills in the court schedule for every round that hasn't been played yet, replacing anything already set for those rounds. Continue?")) return;
  try {
    await api(`/leagues/${currentLeagueId}/court-schedule/generate`, { method: "POST" });
    await refreshLeague(); renderAll();
  } catch (e) { alert(e.message); }
};

/* ---------- Table ---------- */

function roundCountsToTable(round) {
  const meta = league.roundMeta && league.roundMeta[round];
  return !meta || meta.type !== "knockout";
}
function computeStandingsClient() {
  const rows = league.teams.map((t) => {
    let played = 0, nightsWon = 0, nightsDrawn = 0, nightsLost = 0, rubbersWon = 0, rubbersLost = 0;
    league.fixtures.filter((f) => f.finalized && (f.teamA === t.id || f.teamB === t.id) && roundCountsToTable(f.round)).forEach((f) => {
      const isA = f.teamA === t.id;
      const { winsA, winsB } = fixtureScoreClient(f);
      const myWins = isA ? winsA : winsB, oppWins = isA ? winsB : winsA;
      played++; rubbersWon += myWins; rubbersLost += oppWins;
      if (myWins > oppWins) nightsWon++; else if (myWins < oppWins) nightsLost++; else nightsDrawn++;
    });
    return { ...t, played, nightsWon, nightsDrawn, nightsLost, rubbersWon, rubbersLost, diff: rubbersWon - rubbersLost, points: rubbersWon };
  });
  rows.sort((a, b) => b.points - a.points || b.diff - a.diff || a.name.localeCompare(b.name));
  return rows;
}
function matchWinnerClient(f) {
  const { winsA, winsB } = fixtureScoreClient(f);
  if (winsA > winsB) return "A"; if (winsB > winsA) return "B";
  if (f.rubbers.length > 4) return rubberWinnerClient(f.rubbers[4]);
  return null;
}
function renderTable() {
  const rows = computeStandingsClient();
  const c = el("log-container");
  el("table-poster-row").style.display = myRole === "admin" && league.teams.length > 0 ? "flex" : "none";
  if (league.teams.length === 0) { c.innerHTML = '<p class="empty">Add teams to see the table.</p>'; }
  else {
    let html = `<table class="log"><thead><tr><th>#</th><th>Team</th><th class="num">P</th><th class="num">Won</th><th class="num">Lost</th><th class="num">Diff</th><th class="num">Pts</th></tr></thead><tbody>`;
    rows.forEach((r, i) => {
      html += `<tr class="${i === 0 && r.played > 0 ? "rank1" : ""}"><td>${i + 1}</td><td><div class="team-cell">${avatarHtml(r)}${escapeHtml(r.name)}</div></td><td class="num">${r.played}</td><td class="num">${r.rubbersWon}</td><td class="num">${r.rubbersLost}</td><td class="num">${r.diff > 0 ? "+" : ""}${r.diff}</td><td class="num pts">${r.points}</td></tr>`;
    });
    html += "</tbody></table>";
    c.innerHTML = html;
  }
  const koCard = el("knockout-card");
  const allDone = league.fixtures.length > 0 && league.fixtures.every((f) => f.finalized);
  const formatOk = league.playoffFormat === "semis_final" || league.playoffFormat === "position";
  const minTeamsOk = league.playoffFormat === "semis_final" ? league.teams.length >= 4 : league.teams.length >= 2;
  if (myRole === "admin" && allDone && !league.playoffs && formatOk && minTeamsOk) {
    koCard.style.display = "block";
    const desc = league.playoffFormat === "semis_final"
      ? "Regular season complete. Generate semi-finals (1st v 4th, 2nd v 3rd) and a final."
      : "Regular season complete. Generate final spot playoffs (1st v 2nd, 3rd v 4th, 5th v 6th…) to decide final placings.";
    koCard.innerHTML = `<h2 class="section-title">Playoffs</h2><p class="note">${desc}</p><div class="row" style="margin-top:12px;"><button class="primary" id="gen-ko-btn">Generate playoffs</button></div>`;
    el("gen-ko-btn").onclick = async () => {
      try { await api(`/leagues/${currentLeagueId}/knockout/generate`, { method: "POST" }); await refreshLeague(); initViewingKey(); renderAll(); }
      catch (e) { alert(e.message); }
    };
  } else if (league.playoffs && league.playoffs.format === "position") {
    koCard.style.display = "block";
    let html = `<h2 class="section-title">Final spot playoffs</h2><div class="bracket-grid">`;
    league.playoffs.matches.forEach((m, i) => {
      html += matchCardHtml(ordinal(i * 2 + 1) + " v " + ordinal(i * 2 + 2), m.teamA, m.teamB, m);
    });
    html += `</div>`;
    koCard.innerHTML = html;
  } else if (league.playoffs) {
    koCard.style.display = "block";
    const [s0, s1] = league.playoffs.semis, fin = league.playoffs.final;
    const champion = fin.finalized ? teamById(matchWinnerClient(fin) === "A" ? fin.teamA : fin.teamB) : null;
    koCard.innerHTML = `<h2 class="section-title">Knockout stage</h2>
      <div class="bracket-grid bracket-semis">
        ${matchCardHtml("Semi 1", s0.teamA, s0.teamB, s0)}
        ${matchCardHtml("Semi 2", s1.teamA, s1.teamB, s1)}
      </div>
      <div class="bracket-final-wrap">${matchCardHtml("Final", fin.teamA, fin.teamB, fin)}</div>
      ${champion ? `<p class="note" style="margin-top:10px;text-align:center;">Champion: <strong style="color:var(--accent);">${escapeHtml(champion.name)}</strong></p>` : ""}`;
  } else { koCard.style.display = "none"; }
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function matchCardHtml(label, teamAId, teamBId, f) {
  const teamA = teamAId ? teamById(teamAId) : null;
  const teamB = teamBId ? teamById(teamBId) : null;
  const { winsA, winsB } = f ? fixtureScoreClient(f) : { winsA: 0, winsB: 0 };
  const hasScore = f && (winsA > 0 || winsB > 0 || f.finalized);
  const aWon = f && f.finalized && winsA > winsB;
  const bWon = f && f.finalized && winsB > winsA;
  return `<div class="bracket-match">
    <div class="bracket-match-label">${escapeHtml(label)}</div>
    <div class="bracket-team ${aWon ? "winner" : ""}">${avatarHtml(teamA)}<span>${escapeHtml(teamA ? teamA.name : "TBD")}</span></div>
    <div class="bracket-vs">vs</div>
    <div class="bracket-team ${bWon ? "winner" : ""}">${avatarHtml(teamB)}<span>${escapeHtml(teamB ? teamB.name : "TBD")}</span></div>
    <div class="bracket-status">${hasScore ? `<span class="night-score" style="font-size:15px;">${winsA} - ${winsB}</span>` : ""}${f ? `<span class="badge ${f.finalized ? "done" : "pending"}">${f.finalized ? "Final" : "Pending"}</span>` : ""}</div>
  </div>`;
}

/* ---------- Roster (read-only, except a captain can manage their own team) ---------- */

function renderRoster() {
  const c = el("roster-container");
  if (league.teams.length === 0) { c.innerHTML = '<div class="card"><p class="empty">No teams yet.</p></div>'; return; }
  const grid = document.createElement("div");
  grid.className = "roster-grid";
  league.teams.forEach((t) => {
    const card = document.createElement("div");
    card.className = "roster-card";
    const avatar = t.logo
      ? `<img class="avatar-big" src="${t.logo}" alt="">`
      : `<span class="avatar-big-fb">${escapeHtml(t.name.charAt(0).toUpperCase())}</span>`;
    const canManage = myRole === "captain" && myTeamId === t.id;
    let chips = t.players.length
      ? t.players.map((p) => `<button class="player-chip${isGoldPlayer(p) ? " gold-chip" : ""}" data-pid="${p.id}" data-pname="${escapeHtml(p.name)}">${isGoldPlayer(p) ? "★ " : ""}${escapeHtml(p.name)}${canManage ? ' <span class="chip-remove" data-remove-pid="' + p.id + '">&times;</span>' : ""}</button>`).join("")
      : '<span class="note">No players added yet.</span>';
    card.innerHTML = `${avatar}<div class="team-name-wrap"><div class="team-name">${escapeHtml(t.name)}</div><div class="player-count">${t.players.length} player${t.players.length === 1 ? "" : "s"}${league.tieringEnabled ? " · Gold: " + t.players.filter((p) => p.gold).length + "/" + league.goldTierCount : ""}</div></div><div class="player-chips">${chips}</div>`;
    if (canManage) card.appendChild(ownRosterEditControls(t));
    grid.appendChild(card);
  });
  c.innerHTML = "";
  c.appendChild(grid);
  grid.querySelectorAll(".player-chip").forEach((btn) => {
    btn.onclick = (e) => {
      if (e.target.dataset.removePid) return;
      openPlayerHistory(btn.dataset.pid, btn.dataset.pname);
    };
  });
  grid.querySelectorAll(".chip-remove").forEach((span) => {
    span.onclick = async (e) => {
      e.stopPropagation();
      const pid = span.dataset.removePid;
      await api(`/leagues/${currentLeagueId}/teams/${myTeamId}/players/${pid}`, { method: "DELETE" });
      await refreshLeague(); renderRoster();
    };
  });
}
function ownRosterEditControls(t) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "width:100%;margin-top:12px;";

  const addRow = document.createElement("div");
  addRow.className = "row";
  const addInput = document.createElement("input");
  addInput.type = "text"; addInput.placeholder = "Add player name";
  const addBtn = document.createElement("button");
  addBtn.className = "secondary"; addBtn.textContent = "Add player";
  addBtn.onclick = async () => {
    const name = addInput.value.trim();
    if (!name) return;
    await api(`/leagues/${currentLeagueId}/teams/${t.id}/players`, { method: "POST", body: { name } });
    addInput.value = ""; await refreshLeague(); renderRoster();
  };
  addRow.appendChild(addInput); addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  const bulkDetails = document.createElement("details");
  bulkDetails.style.marginTop = "8px";
  const bulkSummary = document.createElement("summary");
  bulkSummary.className = "note"; bulkSummary.style.cursor = "pointer"; bulkSummary.textContent = "Add several players at once";
  const bulkTextarea = document.createElement("textarea");
  bulkTextarea.rows = 4; bulkTextarea.style.marginTop = "8px"; bulkTextarea.placeholder = "One player name per line";
  const bulkBtn = document.createElement("button");
  bulkBtn.className = "secondary"; bulkBtn.textContent = "Add these players"; bulkBtn.style.marginTop = "8px";
  bulkBtn.onclick = async () => {
    const text = bulkTextarea.value;
    if (!text.trim()) return;
    await api(`/leagues/${currentLeagueId}/teams/${t.id}/players/bulk`, { method: "POST", body: { text } });
    bulkTextarea.value = ""; bulkDetails.open = false; await refreshLeague(); renderRoster();
  };
  bulkDetails.appendChild(bulkSummary); bulkDetails.appendChild(bulkTextarea); bulkDetails.appendChild(bulkBtn);
  wrap.appendChild(bulkDetails);

  if (league.tieringEnabled && t.players.length) {
    const goldWrap = document.createElement("div");
    goldWrap.style.cssText = "margin-top:14px;padding-top:12px;border-top:1px dashed var(--line);";
    const goldCount = t.players.filter((p) => p.gold).length;
    const title = document.createElement("div");
    title.className = "note"; title.style.marginBottom = "8px";
    title.textContent = `Gold tier (${goldCount}/${league.goldTierCount}) — mark your strongest player${league.goldTierCount === 1 ? "" : "s"}:`;
    goldWrap.appendChild(title);
    t.players.forEach((p) => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !!p.gold;
      cb.disabled = !p.gold && goldCount >= league.goldTierCount;
      cb.onchange = async () => {
        try {
          await api(`/leagues/${currentLeagueId}/teams/${t.id}/players/${p.id}/tier`, { method: "PUT", body: { gold: cb.checked } });
          await refreshLeague(); renderRoster();
        } catch (e) { alert(e.message); cb.checked = !cb.checked; }
      };
      const label = document.createElement("span");
      label.textContent = p.name;
      row.appendChild(cb); row.appendChild(label);
      goldWrap.appendChild(row);
    });
    wrap.appendChild(goldWrap);
  }
  return wrap;
}

/* ---------- Player match history modal ---------- */

function potwWinCountForPlayer(playerId) {
  if (!league.potwByRound) return 0;
  return Object.values(league.potwByRound).filter((d) => d.winner && (d.winner.playerAId === playerId || d.winner.playerBId === playerId)).length;
}
async function openPlayerHistory(playerId, playerName) {
  el("player-modal-name").textContent = playerName;
  el("player-modal-body").innerHTML = '<p class="empty">Loading…</p>';
  el("player-modal-backdrop").classList.add("open");
  const rows = await api(`/leagues/${currentLeagueId}/players/${playerId}/history`).catch(() => []);
  const potwWins = potwWinCountForPlayer(playerId);
  const crownLine = potwWins > 0 ? `<p class="note" style="margin-bottom:10px;">👑 <span class="potw-crown-count">Pair of the Week × ${potwWins}</span></p>` : "";
  if (rows.length === 0) { el("player-modal-body").innerHTML = crownLine + '<p class="empty">No completed matches yet.</p>'; return; }
  const wins = rows.filter((r) => r.result === "W").length;
  let html = crownLine + `<p class="note" style="margin-bottom:12px;">${rows.length} matches played · ${wins}W ${rows.length - wins}L</p>`;
  rows.forEach((r) => {
    html += `<div class="history-row"><div class="history-top"><span class="history-badge ${r.result === "W" ? "win" : "loss"}">${r.result}</span><span class="history-label">${escapeHtml(r.label)} vs ${escapeHtml(r.opponentTeam)}</span></div><div class="history-detail">${r.partner ? "with " + escapeHtml(r.partner) + " · " : ""}vs ${escapeHtml(r.opponentPlayers.join(" & ") || "?")} · ${escapeHtml(r.score)}</div></div>`;
  });
  el("player-modal-body").innerHTML = html;
}
el("player-modal-close").onclick = () => el("player-modal-backdrop").classList.remove("open");
el("player-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "player-modal-backdrop") el("player-modal-backdrop").classList.remove("open"); });

/* ---------- Stats ---------- */

async function renderStats() {
  const stats = await api(`/leagues/${currentLeagueId}/stats`).catch(() => null);
  if (!stats) return;
  const t = stats.totals;
  el("stats-totals").innerHTML = `
    <div class="stat-tile"><div class="stat-num">${t.teams}</div><div class="stat-lbl">Teams</div></div>
    <div class="stat-tile"><div class="stat-num">${t.players}</div><div class="stat-lbl">Players</div></div>
    <div class="stat-tile"><div class="stat-num">${t.nightsPlayed}</div><div class="stat-lbl">Nights played</div></div>
    <div class="stat-tile"><div class="stat-num">${t.totalRubbers}</div><div class="stat-lbl">Matches played</div></div>
    <div class="stat-tile"><div class="stat-num">${t.totalTiebreaks}</div><div class="stat-lbl">Super tie-breaks</div></div>
  `;

  const tb = el("stats-tiebreaks");
  tb.innerHTML = stats.tiebreaks.length === 0 ? '<p class="empty">No super tie-breaks played yet.</p>' :
    `<table class="log"><thead><tr><th>Team</th><th class="num">Played</th><th class="num">Won</th><th class="num">Lost</th><th class="num">Win%</th></tr></thead><tbody>${
      stats.tiebreaks.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td><td class="num pts">${r.winPct}%</td></tr>`).join("")
    }</tbody></table>`;

  const sc = el("stats-scorers");
  sc.innerHTML = stats.topScorers.length === 0 ? '<p class="empty">No results yet.</p>' :
    stats.topScorers.map((p, i) => `<div class="stat-row"><span>${i + 1}. ${escapeHtml(p.name)} <span class="note">(${escapeHtml(p.team)})</span></span><span class="pts">${p.wins}W ${p.losses}L</span></div>`).join("");

  const pt = el("stats-partnerships");
  pt.innerHTML = stats.partnerships.length === 0 ? '<p class="empty">Need at least 2 matches together to qualify.</p>' :
    stats.partnerships.map((p) => `<div class="stat-row"><span>${escapeHtml(p.names.join(" & "))} <span class="note">(${escapeHtml(p.team)})</span></span><span class="pts">${p.won}/${p.played}</span></div>`).join("");

  const st = el("stats-streaks");
  st.innerHTML = stats.streaks.length === 0 ? '<p class="empty">No active streaks of 2+ yet.</p>' :
    stats.streaks.map((s) => `<div class="stat-row"><span>${escapeHtml(s.name)}</span><span class="pts">${s.streak} in a row</span></div>`).join("");
}

/* ---------- Awards ---------- */

function renderAwards() {
  renderRoundNav("round-nav-awards");
  renderPotwCard(fixturesForKey(viewingKey));

  const c = el("awards-potw");
  if (!c) return;
  const byRound = league.potwByRound || {};
  // Only rounds where voting was actually possible (every fixture in that
  // round finalized) — matches the same gate the Results page's own
  // Pair of the Week card uses, so a round in progress doesn't show up
  // here as a false "no votes yet".
  const rounds = Object.keys(byRound).map(Number).filter((r) => {
    const roundFixtures = league.fixtures.filter((f) => f.round === r);
    return roundFixtures.length > 0 && roundFixtures.every((f) => f.finalized);
  }).sort((a, b) => b - a);

  if (rounds.length === 0) { c.innerHTML = '<p class="empty">No rounds finalized yet — Pair of the Week winners will show up here once a round is complete.</p>'; return; }

  c.innerHTML = rounds.map((r) => {
    const data = byRound[r];
    const label = escapeHtml(roundLabel(r));
    if (!data || !data.winner) {
      return `<div class="stat-row"><span>${label}</span><span class="note">No votes yet</span></div>`;
    }
    const w = data.winner;
    const team = teamById(w.teamId);
    const pairHtml = pairNamesGoldHtml(team, [w.playerAId, w.playerBId]);
    return `<div class="stat-row"><span>${label}</span><span>👑 ${pairHtml} <span class="note">(${escapeHtml(w.teamName)})</span></span></div>`;
  }).join("");
}

/* ---------- News ---------- */

async function renderNews() {
  el("news-post-card").style.display = myRole === "admin" ? "block" : "none";
  const posts = await api(`/leagues/${currentLeagueId}/news`).catch(() => []);
  const c = el("news-list");
  if (posts.length === 0) { c.innerHTML = '<p class="empty">No updates posted yet.</p>'; return; }
  c.innerHTML = "";
  posts.forEach((p) => {
    const div = document.createElement("div"); div.className = "news-post";
    div.innerHTML = `<h3>${escapeHtml(p.title)}</h3><time>${new Date(p.createdAt).toLocaleString()}</time>${p.body ? `<p>${escapeHtml(p.body)}</p>` : ""}`;
    if (myRole === "admin") {
      const del = document.createElement("button"); del.className = "link"; del.textContent = "Delete"; del.style.marginTop = "8px";
      del.onclick = async () => { await api(`/leagues/${currentLeagueId}/news/${p.id}`, { method: "DELETE" }); renderNews(); };
      div.appendChild(del);
    }
    c.appendChild(div);
  });
}
el("news-post-btn").onclick = async () => {
  const title = el("news-title").value.trim(), body = el("news-body").value.trim();
  if (!title) return alert("Give the update a title.");
  try {
    await api(`/leagues/${currentLeagueId}/news`, { method: "POST", body: { title, body } });
    el("news-title").value = ""; el("news-body").value = "";
    renderNews();
  } catch (e) {
    alert("Couldn't post: " + e.message);
  }
};

boot();

// A deploy landing while someone already has the page open (installed PWA,
// a tab left open for days) doesn't help them until something tells them a
// newer version exists — network-first fetching in sw.js fixes the *next*
// load, but this banner covers the tab that's already sitting there.
function showUpdateBanner() {
  el("update-banner").style.display = "flex";
}
el("update-refresh-btn").onclick = () => window.location.reload();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Captured once, before any install/claim can happen during *this*
    // load — skipWaiting()+clients.claim() in sw.js mean a first-ever
    // install can end up with a controller by the time "installed" fires,
    // which would otherwise make every fresh visit look like an update.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (reg.waiting && hadController) showUpdateBanner();
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && hadController) showUpdateBanner();
          });
        });
        setInterval(() => reg.update(), 30 * 60 * 1000);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update();
        });
      })
      .catch((e) => console.log("Service worker registration failed:", e));
  });
}

/* ---------- Install (PWA) prompt ---------- */

(function () {
  const banner = document.getElementById("install-banner");
  const dismissKey = "padel-install-dismissed";
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferredPrompt = null;

  if (isStandalone || localStorage.getItem(dismissKey) === "true") return;

  document.getElementById("install-dismiss").onclick = () => {
    banner.style.display = "none";
    localStorage.setItem(dismissKey, "true");
  };

  if (isIOS) {
    // Safari never fires beforeinstallprompt — there's no programmatic
    // install, so just point people at the manual Share-sheet step.
    document.getElementById("install-instructions").textContent = "Tap the Share icon, then \"Add to Home Screen.\"";
    banner.style.display = "flex";
    return;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    banner.style.display = "flex";
    document.getElementById("install-btn").style.display = "inline-block";
  });

  document.getElementById("install-btn").onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    banner.style.display = "none";
  };

  window.addEventListener("appinstalled", () => {
    banner.style.display = "none";
    localStorage.setItem(dismissKey, "true");
  });
})();
