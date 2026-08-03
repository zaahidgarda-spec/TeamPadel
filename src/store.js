const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, name + ".json");
}

function readJson(name, fallback) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Failed to read " + name + ":", e.message);
    return fallback;
  }
}

function writeJson(name, data) {
  const p = filePath(name);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function getIndex() {
  return readJson("leagues-index", []);
}
function saveIndex(index) {
  writeJson("leagues-index", index);
}
function getLeague(id) {
  return readJson("league-" + id, null);
}
function saveLeague(id, league) {
  writeJson("league-" + id, league);
}
function deleteLeague(id) {
  const p = filePath("league-" + id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = {
  getIndex,
  saveIndex,
  getLeague,
  saveLeague,
  deleteLeague,
};
