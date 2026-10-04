// Made-up players, teams and logos for practising — nothing here is real.
// Used by the "Create a test league" and "Dummy import" buttons.

const TEAMS = [
  { name: "Tridents", colors: ["#0B3D91", "#E8B34C"] },
  { name: "Goats", colors: ["#B3261E", "#F5F5F5"] },
  { name: "Sharks", colors: ["#0E7C86", "#FFFFFF"] },
  { name: "Falcons", colors: ["#3B2A6B", "#F2C94C"] },
  { name: "Vipers", colors: ["#1E7B3A", "#0B0B0F"] },
  { name: "Rhinos", colors: ["#444B57", "#E2432F"] },
  { name: "Wolves", colors: ["#111827", "#9CA3AF"] },
  { name: "Comets", colors: ["#E2432F", "#FFE08A"] },
];
const FIRST = ["Ayaan", "Bianca", "Callum", "Dineo", "Ethan", "Fatima", "Gareth", "Hannah", "Imran", "Jade", "Kabelo", "Lerato", "Marcus", "Naledi", "Oscar", "Priya", "Quinn", "Riaan", "Sipho", "Thandi", "Umar", "Vusi", "Wendy", "Xola", "Yusuf", "Zinhle", "Andile", "Brett", "Chloe", "Dylan"];
const LAST = ["Abrahams", "Botha", "Chetty", "Dlamini", "Eksteen", "Ferreira", "Govender", "Hlongwane", "Isaacs", "Jacobs", "Khumalo", "Louw", "Mokoena", "Naidoo", "Olivier", "Pillay", "Radebe", "Smit", "Tshabalala", "Venter"];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A simple shield with the team's initial — an SVG data URL, so it shows
// anywhere a normal uploaded logo does.
function logoFor(team) {
  const [c1, c2] = team.colors;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 4 90 18v30c0 26-17 40-40 48C27 88 10 74 10 48V18z" fill="${c1}" stroke="${c2}" stroke-width="5"/><text x="50" y="62" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="44" fill="${c2}">${team.name[0]}</text></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// Every combination of first and last name, shuffled, so no name repeats.
function namePool() {
  const all = [];
  for (const f of FIRST) for (const l of LAST) all.push(`${f} ${l}`);
  return shuffle(all);
}

// Teams (with logos and six players each) for a brand-new test league.
function buildTeams({ uid, genCode }) {
  const names = namePool();
  const codes = new Set();
  const uniqueCode = () => { let c; do { c = genCode(); } while (codes.has(c)); codes.add(c); return c; };
  return TEAMS.map((t) => ({
    id: uid(), name: t.name, code: uniqueCode(), logo: logoFor(t), notifyEmail: "",
    players: Array.from({ length: 6 }, () => ({ id: uid(), name: names.pop() })),
  }));
}

// Players for sale: a few "stars" at a higher base price, then middle and
// entry level. Never repeats a name that is already in the league or pool.
function poolPlan(league, pool, minBid) {
  const taken = new Set([...league.teams.flatMap((t) => t.players.map((p) => p.name)), ...pool.map((p) => p.name)].map((n) => n.toLowerCase()));
  const names = namePool().filter((n) => !taken.has(n.toLowerCase()));
  const tier = (count, base) => ({ names: names.splice(0, count), base });
  return [tier(4, Math.max(minBid, 5)), tier(8, Math.max(minBid, 3)), tier(8, minBid)];
}

module.exports = { TEAMS, buildTeams, poolPlan };
