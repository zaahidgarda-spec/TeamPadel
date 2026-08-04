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
function avatarHtml(t) {
  if (t && t.logo) return `<img class="avatar" src="${t.logo}" alt="">`;
  const initial = t ? t.name.charAt(0).toUpperCase() : "?";
  return `<span class="avatar-fb">${escapeHtml(initial)}</span>`;
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
  const statusLabel = l.status === "active" ? "Active" : "In setup";
  const teams = l.teams || [];
  const maxShown = 8;
  const shown = teams.slice(0, maxShown);
  const overflow = teams.length - shown.length;
  const logos = shown.length
    ? `<div class="league-card-logos">${shown.map((t) => avatarHtml(t)).join("")}${overflow > 0 ? `<span class="avatar-fb">+${overflow}</span>` : ""}</div>`
    : "";
  return `<div class="league-card" data-id="${l.id}">
    <div class="league-card-top">
      <span class="league-card-name">${escapeHtml(l.name)}</span>
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
  const list = el("league-list");
  list.innerHTML = "";
  if (leaguesIndex.length === 0) { list.innerHTML = '<p class="empty">No leagues yet — create one above.</p>'; return; }
  const sorted = leaguesIndex.slice().sort((a, b) => b.createdAt - a.createdAt);
  const groups = [
    { key: "active", label: "Active leagues" },
    { key: "setup", label: "In setup" },
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
    card.onclick = () => openLeague(card.dataset.id);
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

/* ---------- Hub tabs (Leagues / Admin) ---------- */

document.querySelectorAll(".hub-tab-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".hub-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".hub-view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("hub-view-" + btn.dataset.hubview).classList.add("active");
  };
});

/* ---------- Site owner login (gates who can create leagues) ---------- */

async function refreshOwnerStatus() {
  const status = await api("/owner/me").catch(() => ({ isOwner: false }));
  isOwner = !!status.isOwner;
  el("create-league-card").style.display = isOwner ? "block" : "none";
  el("owner-login-card").style.display = isOwner ? "none" : "block";
  renderHub();
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
        <label class="note" style="display:flex;align-items:center;gap:6px;">Playoffs after the season:
          <select id="playoff-format-select">
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
    const fmtLabel = league.playoffFormat === "semis_final" ? "Semi-finals + Final" : league.playoffFormat === "position" ? "Final spot playoffs" : "None";
    c.innerHTML = `<p class="note">Playoff format for this season: <strong>${escapeHtml(fmtLabel)}</strong>. Reset the season below to change it.</p>`;
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
  head.appendChild(nameWrap);
  wrap.appendChild(head);

  const ul = document.createElement("ul"); ul.className = "plain";
  if (t.players.length === 0) ul.innerHTML = '<li class="empty" style="border:none;justify-content:center;">No players yet.</li>';
  t.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
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
    venueInput.style.cssText = "font-size:12px;padding:6px 8px;width:180px;";
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
    row.className = "notif-row" + (n.read ? "" : " unread");
    row.innerHTML = `<span class="notif-msg">${escapeHtml(n.message)}</span><time class="notif-time">${new Date(n.createdAt).toLocaleString()}</time>`;
    if (!n.read) {
      row.onclick = async () => {
        await api(`/leagues/${currentLeagueId}/notifications/${n.id}/read`, { method: "POST" });
        n.read = true; renderNotificationsList(); updateNotifTabLabel();
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
    grid.appendChild(selectionReveal(teamA, f.selectionA));
    grid.appendChild(selectionReveal(teamB, f.selectionB));
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
function timeSlotPanel(f, teamA, teamB) {
  const wrap = document.createElement("div");
  wrap.className = "card timeslot-panel";
  wrap.style.marginTop = "12px";

  const title = document.createElement("h3");
  title.className = "timeslot-title";
  title.textContent = "Time slots — playing order for the night";
  wrap.appendChild(title);

  const seedLabel = (i) => {
    const nameA = playerNamesFor(teamA, f.selectionA.pairs[i]);
    const nameB = playerNamesFor(teamB, f.selectionB.pairs[i]);
    return "Seed " + (i + 1) + ": " + nameA + " vs " + nameB;
  };

  if (f.slotOrder) {
    const list = document.createElement("div");
    list.className = "slot-order-list";
    f.slotOrder.forEach((seedIdx, slotIdx) => {
      const row = document.createElement("div");
      row.className = "slot-order-row";
      row.innerHTML = `<span class="slot-num">Slot ${slotIdx + 1}</span><span>${escapeHtml(seedLabel(seedIdx))}</span>`;
      list.appendChild(row);
    });
    wrap.appendChild(list);
    if (myRole === "admin") {
      const reset = document.createElement("button");
      reset.className = "link"; reset.style.marginTop = "8px"; reset.textContent = "Reset order";
      reset.onclick = async () => { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/timeslot/reset`, { method: "POST" }); await refreshLeague(); renderAll(); };
      wrap.appendChild(reset);
    }
    return wrap;
  }

  const myTeamSide = myRole === "captain" ? (myTeamId === f.teamA ? "A" : myTeamId === f.teamB ? "B" : null) : null;

  if (f.slotProposal) {
    const p = f.slotProposal;
    const proposerName = (p.by === "A" ? teamA : teamB).name;
    const list = document.createElement("div");
    list.className = "slot-order-list";
    p.order.forEach((seedIdx, slotIdx) => {
      const row = document.createElement("div");
      row.className = "slot-order-row";
      row.innerHTML = `<span class="slot-num">Slot ${slotIdx + 1}</span><span>${escapeHtml(seedLabel(seedIdx))}</span>`;
      list.appendChild(row);
    });
    wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: proposerName + " proposed this order:" }));
    wrap.appendChild(list);

    const canRespond = myRole === "admin" || (myTeamSide && myTeamSide !== p.by);
    if (canRespond) {
      const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "10px";
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "primary"; confirmBtn.textContent = "Confirm this order";
      confirmBtn.onclick = async () => { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/timeslot/confirm`, { method: "POST" }); await refreshLeague(); renderAll(); };
      const counterBtn = document.createElement("button");
      counterBtn.className = "secondary"; counterBtn.textContent = "Propose a different order";
      counterBtn.onclick = () => { wrap.innerHTML = ""; wrap.appendChild(title); wrap.appendChild(slotOrderPicker(f, seedLabel, p.order)); };
      row.appendChild(confirmBtn); row.appendChild(counterBtn);
      wrap.appendChild(row);
    } else if (myTeamSide === p.by) {
      wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", style: "margin-top:8px;", textContent: "Waiting for the other captain to confirm or counter." }));
    }
    return wrap;
  }

  if (myTeamSide || myRole === "admin") {
    if (myRole === "admin") {
      wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "Waiting for a captain to propose an order — admins can't propose, only confirm or reset." }));
    } else {
      wrap.appendChild(slotOrderPicker(f, seedLabel, null));
    }
  } else {
    wrap.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "Not set yet — the captains will agree a playing order here." }));
  }
  return wrap;
}
function slotOrderPicker(f, seedLabel, prefill) {
  const box = document.createElement("div");
  const localOrder = prefill ? prefill.slice() : [null, null, null, null];
  const err = document.createElement("div"); err.className = "error";
  const selects = [];
  function refreshOptions() {
    selects.forEach((select, slot) => {
      const usedElsewhere = localOrder.filter((v, i) => i !== slot && v !== null);
      const current = select.value;
      select.innerHTML = '<option value="">Choose seed…</option>' + [0, 1, 2, 3]
        .filter((i) => !usedElsewhere.includes(i))
        .map((i) => `<option value="${i}">${escapeHtml(seedLabel(i))}</option>`)
        .join("");
      select.value = current;
    });
  }
  for (let slot = 0; slot < 4; slot++) {
    const row = document.createElement("div"); row.className = "seed-row";
    row.innerHTML = `<span class="num">Slot ${slot + 1}</span>`;
    const select = document.createElement("select");
    select.onchange = () => { localOrder[slot] = select.value === "" ? null : Number(select.value); refreshOptions(); };
    selects.push(select);
    row.appendChild(select);
    box.appendChild(row);
  }
  selects.forEach((select, slot) => { select.value = localOrder[slot] === null ? "" : localOrder[slot]; });
  refreshOptions();
  const btn = document.createElement("button");
  btn.className = "primary"; btn.style.marginTop = "8px"; btn.textContent = "Propose this order";
  btn.onclick = async () => {
    const seen = new Set(localOrder);
    if (localOrder.includes(null) || seen.size !== 4) { err.textContent = "Assign each seed to exactly one slot."; return; }
    try {
      await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/timeslot/propose`, { method: "POST", body: { order: localOrder } });
      await refreshLeague(); renderAll();
    } catch (e) { err.textContent = e.message; }
  };
  box.appendChild(btn); box.appendChild(err);
  return box;
}
function selectionReveal(team, sel) {
  const div = document.createElement("div"); div.className = "selection-side";
  let html = `<h3>${avatarHtml(team)} ${escapeHtml(team.name)}</h3>`;
  sel.pairs.forEach((pair, i) => {
    const p1 = playerById(team, pair[0]), p2 = playerById(team, pair[1]);
    const names = [p1 ? p1.name : null, p2 ? p2.name : null].filter(Boolean).join(" & ") || "—";
    html += `<div class="seed-row"><span class="num">Seed ${i + 1}</span><span class="pair" style="flex:1;">${escapeHtml(names)}</span></div>`;
  });
  div.innerHTML = html;
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
  const localPairs = already ? sel.pairs.map((p) => p.slice()) : [[null, null], [null, null], [null, null], [null, null]];
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
      return '<option value="">Player…</option>' + team.players.map((p) => `<option value="${p.id}" ${p.id === otherVal ? "disabled" : ""}>${escapeHtml(p.name)}</option>`).join("");
    };
    [0, 1].forEach((slot) => {
      const select = document.createElement("select");
      select.innerHTML = optionsFor(slot);
      select.value = localPairs[seedIdx][slot] || "";
      select.disabled = already;
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

  if (already) {
    div.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "Submitted — waiting on the other team." }));
    if (myRole === "admin") {
      const unlock = document.createElement("button");
      unlock.className = "link"; unlock.style.marginTop = "6px"; unlock.textContent = "Unlock to edit";
      unlock.onclick = async () => { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/selection/unlock`, { method: "POST", body: { side } }); await refreshLeague(); renderAll(); };
      div.appendChild(unlock);
    }
  } else {
    const err = document.createElement("div"); err.className = "error";
    const btn = document.createElement("button");
    btn.className = "primary"; btn.style.marginTop = "8px"; btn.textContent = "Submit line-up";
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
  }
  return div;
}

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
        ? playerNamesFor(teamA, f.selectionA.pairs[seed]) + " v " + playerNamesFor(teamB, f.selectionB.pairs[seed])
        : null;
      const label = (teamA ? teamA.name : "TBD") + " vs " + (teamB ? teamB.name : "TBD") + " — Seed " + (seed + 1) + (pairLabel ? " (" + pairLabel + ")" : "");
      options.push({ fixtureId: f.id, seed, label, teamA, teamB, shortLabel: pairLabel || ("Seed " + (seed + 1)) });
    }
  });
  return options;
}
// One color per fixture (matchup), stable for as long as the round's fixture
// order doesn't change — every seed belonging to that fixture gets the same
// rectangle color, cycling if a round somehow has more fixtures than colors.
const COURT_SCHEDULE_PALETTE = [
  { border: "#2563EB", bg: "rgba(37,99,235,.10)" },
  { border: "#D97706", bg: "rgba(217,119,6,.10)" },
  { border: "#DB2777", bg: "rgba(219,39,119,.10)" },
  { border: "#0D9488", bg: "rgba(13,148,136,.10)" },
  { border: "#7C3AED", bg: "rgba(124,58,237,.10)" },
  { border: "#EA580C", bg: "rgba(234,88,12,.10)" },
  { border: "#16A34A", bg: "rgba(22,163,74,.10)" },
  { border: "#4F46E5", bg: "rgba(79,70,229,.10)" },
];
function fixtureColor(fixtureId, fixtures) {
  const idx = fixtures.findIndex((f) => f.id === fixtureId);
  return COURT_SCHEDULE_PALETTE[(idx < 0 ? 0 : idx) % COURT_SCHEDULE_PALETTE.length];
}
function renderCourtScheduleGrid(fixtures) {
  const card = el("court-schedule-card");
  if (!viewingKey || viewingKey.stage !== "regular" || fixtures.length === 0) { card.style.display = "none"; return; }
  card.style.display = "block";

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
  scroll.className = "court-schedule-scroll";
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
    for (let c = 0; c < courts; c++) {
      const td = document.createElement("td");
      const cell = savedGrid[s] && savedGrid[s][c];
      if (cell) {
        const color = fixtureColor(cell.fixtureId, fixtures);
        td.style.cssText = `border:2px solid ${color.border};border-radius:8px;background:${color.bg};`;
      }
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
          td.innerHTML = `<div class="cs-cell-teams">${avatarHtml(opt.teamA)}<span class="cs-vs">v</span>${avatarHtml(opt.teamB)}</div><div class="cs-cell-label">${escapeHtml(opt.shortLabel)}</div>`;
        } else {
          td.textContent = "—";
        }
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
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
          const nameA = [playerById(teamA, pairA[0]), playerById(teamA, pairA[1])].filter(Boolean).map((p) => p.name).join(" & ") || "—";
          const nameB = [playerById(teamB, pairB[0]), playerById(teamB, pairB[1])].filter(Boolean).map((p) => p.name).join(" & ") || "—";
          const w = rubberWinnerClient(f.rubbers[i]);
          const slotNum = f.slotOrder ? f.slotOrder.indexOf(i) + 1 : null;
          const seedLbl = "Seed " + (i + 1) + (slotNum ? " · Slot " + slotNum : "");
          html += `<div class="rubber-row"><span class="seed">${seedLbl}</span><span class="pair ${w === "A" ? "won" : ""}">${escapeHtml(nameA)}</span><span></span><span class="pair ${w === "B" ? "won" : ""}">${escapeHtml(nameB)}</span></div>`;
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

function renderResults() {
  renderRoundNav("round-nav-results");
  const c = el("results-container");
  c.innerHTML = "";
  const fixtures = fixturesForKey(viewingKey);
  el("results-poster-row").style.display = myRole === "admin" && fixtures.length > 0 ? "flex" : "none";
  renderPotwCard(fixtures);
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
    html += '<p class="note" style="margin-bottom:10px;">No votes yet — captains, cast yours below.</p>';
  }
  card.innerHTML = html;

  if (myRole === "captain") {
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
        await refreshLeague(); renderResults();
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
    const pairA = playerNamesFor(teamA, f.selectionA.pairs[idx]);
    const pairB = playerNamesFor(teamB, f.selectionB.pairs[idx]);
    const potwWinnerKey = league.potwByRound && league.potwByRound[f.round] && league.potwByRound[f.round].winner && league.potwByRound[f.round].winner.key;
    const isPotwPair = (side) => !isDecider && potwWinnerKey === `${f.id}:${side}:${idx}`;
    const pairADisplay = document.createElement("div"); pairADisplay.className = "pair" + (winner === "A" ? " won" : ""); pairADisplay.textContent = isDecider ? teamA.name : (isPotwPair("A") ? "👑 " : "") + pairA;
    const pairBDisplay = document.createElement("div"); pairBDisplay.className = "pair" + (winner === "B" ? " won" : ""); pairBDisplay.textContent = isDecider ? teamB.name : (isPotwPair("B") ? "👑 " : "") + pairB;

    const scores = document.createElement("div"); scores.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:2px;";
    const setLine = document.createElement("div"); setLine.className = "set-line";
    [0, 1].forEach((si) => {
      const pair = document.createElement("div"); pair.className = "set-pair";
      const inA = document.createElement("input"); inA.type = "number"; inA.min = "0"; inA.max = "7"; inA.disabled = !editable;
      inA.value = rubber.sets[si][0] === null ? "" : rubber.sets[si][0];
      const span = document.createElement("span"); span.textContent = "-";
      const inB = document.createElement("input"); inB.type = "number"; inB.min = "0"; inB.max = "7"; inB.disabled = !editable;
      inB.value = rubber.sets[si][1] === null ? "" : rubber.sets[si][1];
      const commit = async () => {
        const sets = rubber.sets.map((s) => s.slice());
        sets[si] = [inA.value === "" ? null : inA.value, inB.value === "" ? null : inB.value];
        try { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/rubbers/${idx}`, { method: "PUT", body: { sets } }); await refreshLeague(); renderResults(); }
        catch (e) { alert(e.message); }
      };
      inA.onchange = commit; inB.onchange = commit;
      pair.appendChild(inA); pair.appendChild(span); pair.appendChild(inB);
      setLine.appendChild(pair);
    });
    scores.appendChild(setLine);
    if (needsTiebreakClient(rubber)) {
      const tbWrap = document.createElement("div"); tbWrap.className = "tb-wrap";
      const tbLabel = document.createElement("div"); tbLabel.className = "tb-label"; tbLabel.textContent = "Super TB";
      const tbPair = document.createElement("div"); tbPair.className = "set-pair tb";
      const tA = document.createElement("input"); tA.type = "number"; tA.min = "0"; tA.max = "30"; tA.disabled = !editable;
      tA.value = rubber.tb[0] === null ? "" : rubber.tb[0];
      const tSpan = document.createElement("span"); tSpan.textContent = "-";
      const tB = document.createElement("input"); tB.type = "number"; tB.min = "0"; tB.max = "30"; tB.disabled = !editable;
      tB.value = rubber.tb[1] === null ? "" : rubber.tb[1];
      const commitTb = async () => {
        try { await api(`/leagues/${currentLeagueId}/fixtures/${f.id}/rubbers/${idx}`, { method: "PUT", body: { tb: [tA.value === "" ? null : tA.value, tB.value === "" ? null : tB.value] } }); await refreshLeague(); renderResults(); }
        catch (e) { alert(e.message); }
      };
      tA.onchange = commitTb; tB.onchange = commitTb;
      tbPair.appendChild(tA); tbPair.appendChild(tSpan); tbPair.appendChild(tB);
      tbWrap.appendChild(tbLabel); tbWrap.appendChild(tbPair);
      scores.appendChild(tbWrap);
    }
    [0, 1].forEach((si) => {
      const valid = isValidSetClient(rubber.sets[si][0], rubber.sets[si][1]);
      if (valid === false) { const w = document.createElement("div"); w.className = "warn"; w.textContent = "Set " + (si + 1) + ": not a real padel score"; scores.appendChild(w); }
    });
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
function fitText(ctx, text, maxWidth, startSize, weight, family) {
  let size = startSize;
  const apply = () => { ctx.font = weight + " " + size + "px " + family; };
  apply();
  while (size > 18 && ctx.measureText(text).width > maxWidth) { size -= 2; apply(); }
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
  const pairRowH = 34, pairsTopPad = 8, pairsBottomPad = 10;
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
        ctx.fillStyle = "#64748B";
        ctx.font = "500 15px Oswald, sans-serif";
        ctx.fillText("S" + (i + 1), W / 2, py + 5);

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
async function openPosterModal(mode) {
  el("poster-modal-title").textContent = mode === "results" ? "Results poster" : "Fixtures poster";
  el("poster-preview-img").style.display = "none";
  el("poster-modal-loading").style.display = "block";
  el("poster-modal-backdrop").classList.add("open");
  const canvas = await generatePosterCanvas(mode);
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
      ? t.players.map((p) => `<button class="player-chip" data-pid="${p.id}" data-pname="${escapeHtml(p.name)}">${escapeHtml(p.name)}${canManage ? ' <span class="chip-remove" data-remove-pid="' + p.id + '">&times;</span>' : ""}</button>`).join("")
      : '<span class="note">No players added yet.</span>';
    card.innerHTML = `${avatar}<div class="team-name-wrap"><div class="team-name">${escapeHtml(t.name)}</div><div class="player-count">${t.players.length} player${t.players.length === 1 ? "" : "s"}</div></div><div class="player-chips">${chips}</div>`;
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
    <div class="stat-tile"><div class="stat-num">${t.matchesPlayed}</div><div class="stat-lbl">Nights played</div></div>
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

  const by = el("stats-byes");
  by.innerHTML = stats.byes.length === 0 ? '<p class="empty">No byes yet.</p>' :
    stats.byes.map((b) => `<div class="stat-row"><span>${escapeHtml(b.name)}</span><span class="pts">${b.byes}</span></div>`).join("");
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.log("Service worker registration failed:", e));
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
