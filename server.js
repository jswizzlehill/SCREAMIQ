// ScreamIQ server: no dependencies, needs Node 18+.  Run: ADMIN_PASSWORD=yourpass node server.js
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || "";
const FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUB = path.join(__dirname, "public");

let db = { codes: { SCREAM: { label: "the Haunted House" } }, scores: {} };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
function save() { fs.writeFileSync(FILE + ".tmp", JSON.stringify(db)); fs.renameSync(FILE + ".tmp", FILE); }
if (!ADMIN) console.warn("WARNING: ADMIN_PASSWORD not set, so the /admin page is disabled.");

const hits = new Map();
setInterval(() => hits.clear(), 60000);
function limited(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 240;
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 10000) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch (e) { ok({}); } });
    req.on("error", () => ok({}));
  });
}
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const normCode = (c) => clean(c, 12).toUpperCase();
function adminOk(pw) {
  if (!ADMIN || typeof pw !== "string") return false;
  const a = crypto.createHash("sha256").update(pw).digest(), b = crypto.createHash("sha256").update(ADMIN).digest();
  return crypto.timingSafeEqual(a, b);
}
const top = (code, n) => (db.scores[code] || []).slice().sort((a, b) => b.score - a.score || a.t - b.t).slice(0, n)
  .map((r) => ({ name: r.name, score: r.score, right: r.right }));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  if (limited(req)) return send(res, 429, { ok: false });
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/join" && req.method === "POST") {
      const c = normCode((await body(req)).code), e = db.codes[c];
      return e ? send(res, 200, { ok: true, label: e.label }) : send(res, 200, { ok: false });
    }
    if (u.pathname === "/api/board" && req.method === "GET") {
      const c = normCode(u.searchParams.get("code"));
      return db.codes[c] ? send(res, 200, { rows: top(c, 10) }) : send(res, 404, { rows: [] });
    }
    if (u.pathname === "/api/score" && req.method === "POST") {
      const b = await body(req), c = normCode(b.code);
      if (!db.codes[c]) return send(res, 404, { ok: false });
      const score = Math.floor(+b.score), right = Math.floor(+b.right), name = clean(b.name, 14), id = clean(b.id, 40);
      if (!name || !id || !(right >= 0 && right <= 10) || !(score >= right * 100 && score <= right * 145)) return send(res, 400, { ok: false });
      const list = db.scores[c] || (db.scores[c] = []);
      if (!list.some((r) => r.id === id)) {
        list.push({ id, name, score, right, t: Date.now() });
        if (list.length > 2000) { list.sort((a, b) => b.score - a.score); list.length = 1500; }
        save();
      }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/admin" && req.method === "POST") {
      const b = await body(req);
      if (!adminOk(b.password)) return send(res, 401, { ok: false });
      const c = normCode(b.code);
      if (b.action === "add" && c) db.codes[c] = { label: clean(b.label, 40) || "the Haunted House" };
      if (b.action === "remove" && c) { delete db.codes[c]; delete db.scores[c]; }
      if (b.action === "reset" && c) db.scores[c] = [];
      if (b.action !== "list") save();
      const out = Object.keys(db.codes).map((k) => ({ code: k, label: db.codes[k].label, plays: (db.scores[k] || []).length, top: top(k, 5) }));
      return send(res, 200, { ok: true, codes: out });
    }
    // static files
    let p = u.pathname === "/" ? "/index.html" : u.pathname === "/admin" ? "/admin.html" : u.pathname;
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { ok: false }); }
}).listen(PORT, () => console.log("ScreamIQ running on port " + PORT));
