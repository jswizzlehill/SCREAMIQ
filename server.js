// ScreamIQ server: no dependencies, needs Node 18+.  Run: ADMIN_PASSWORD=yourpass node server.js
const zlib = require("zlib"), http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || "";
const FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUB = path.join(__dirname, "public");
// Live rounds run on the server clock, counted from when the event was created (the code is up): 3-minute lobby, 10 questions (10s to answer + 5s reveal), results. (TIME_SCALE is for testing only.)
const K = +process.env.TIME_SCALE || 1;
const LOBBY = 180000 * K, QMS = 10000 * K, REV = 5000 * K, NQ = 10, RES = 20000 * K, CYCLE = LOBBY + NQ * (QMS + REV) + RES;

let db = { codes: { SCREAM: { label: "the Haunted House" } }, events: {}, scores: {}, secret: "" };
try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
db.events = db.events || {}; db.scores = db.scores || {}; db.codes = db.codes || {};
for (const id of Object.keys(db.events)) if (!db.events[id].code) db.events[id].code = "";
if (!db.secret) db.secret = crypto.randomBytes(24).toString("hex");
function save() { fs.writeFileSync(FILE + ".tmp", JSON.stringify(db)); fs.renameSync(FILE + ".tmp", FILE); }
for (const id of Object.keys(db.events)) { if (!db.events[id].code) db.events[id].code = newCode(); if (db.events[id].start === undefined) db.events[id].start = null; if (db.events[id].base === undefined) db.events[id].base = 0; if (db.events[id].opensAt === undefined) db.events[id].opensAt = null; if (db.events[id].closesAt === undefined) db.events[id].closesAt = null; }
const curRound = (ev, now) => (ev.start ? Math.max(0, Math.floor((now - ev.start) / CYCLE)) : 0);
save();
// Schedule: start and stop events by themselves at the times set in /admin.
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const id of Object.keys(db.events)) {
    const ev = db.events[id];
    if (!ev.start && ev.opensAt && now >= ev.opensAt) { ev.start = now - (ev.base || 0) * CYCLE; ev.opensAt = null; changed = true; }
    if (ev.start && ev.closesAt && now >= ev.closesAt) { ev.base = curRound(ev, now) + 1; ev.start = null; ev.closesAt = null; changed = true; }
  }
  if (changed) save();
}, 5000);
if (!ADMIN) console.warn("WARNING: ADMIN_PASSWORD not set, so the /admin page is disabled.");

// ---- rotating codes: a new code every `minutes`; the previous one still works for one more period ----
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function codeFor(id, slot) {
  const h = crypto.createHmac("sha256", db.secret).update(id + ":" + slot).digest();
  let s = ""; for (let i = 0; i < 5; i++) s += ALPHA[h[i] % ALPHA.length]; return s;
}
// One code per event, always valid. Everyone shares the same clock-driven game.
function newCode() {
  for (;;) {
    const b = crypto.randomBytes(5); let c = ""; for (let i = 0; i < 5; i++) c += ALPHA[b[i] % ALPHA.length];
    if (!db.codes[c] && !Object.values(db.events).some((e) => e.code === c)) return c;
  }
}
function resolveJoin(c) {
  if (db.codes[c]) return { board: c, label: db.codes[c].label };
  for (const id of Object.keys(db.events)) {
    const ev = db.events[id];
    if (ev.code === c) return { board: id, label: ev.label, live: true, round: curRound(ev, Date.now()), epoch: ev.start };
  }
  return null;
}
const validBoard = (b) => !!(db.codes[b] || db.events[b]);

const hits = new Map(), adminHits = new Map();
setInterval(() => { hits.clear(); adminHits.clear(); }, 60000);
function ipOf(req) { return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
// Venue Wi-Fi puts many phones behind one address, so the general limit is high.
function limited(req, map, max) {
  const ip = ipOf(req), n = (map.get(ip) || 0) + 1; map.set(ip, n); return n > max;
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
const top = (board, n, round) => (db.scores[board] || []).filter((r) => round === undefined || r.round === round).slice().sort((a, b) => b.score - a.score || a.t - b.t).slice(0, n)
  .map((r) => ({ name: r.name, score: r.score, right: r.right }));
function adminList() {
  return {
    ok: true,
    codes: Object.keys(db.codes).map((k) => ({ code: k, label: db.codes[k].label, plays: (db.scores[k] || []).length, top: top(k, 5) })),
    events: Object.keys(db.events).map((id) => {
      const ev = db.events[id];
      return { id, name: ev.name, label: ev.label, running: !!ev.start, opensAt: ev.opensAt, closesAt: ev.closesAt, code: ev.code, plays: (db.scores[id] || []).length, top: top(id, 5) };
    }),
  };
}

const FILES = new Map();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  if (limited(req, hits, 20000)) return send(res, 429, { ok: false });
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/api/join" && req.method === "POST") {
      const r = resolveJoin(normCode((await body(req)).code));
      return r ? send(res, 200, { ok: true, label: r.label, board: r.board, live: !!r.live, round: r.round, epoch: r.epoch, now: Date.now() }) : send(res, 200, { ok: false });
    }
    if (u.pathname === "/api/board" && req.method === "GET") {
      const c = normCode(u.searchParams.get("code"));
      const rd = u.searchParams.get("round"), bev = db.events[c];
      return validBoard(c) ? send(res, 200, { now: Date.now(), epoch: bev ? bev.start : undefined, rows: top(c, 10, rd === null ? undefined : +rd) }) : send(res, 404, { rows: [] });
    }
    if (u.pathname === "/api/display" && req.method === "GET") {
      const id = normCode(u.searchParams.get("event")), ev = db.events[id];
      if (!ev) return send(res, 404, { rows: [] });
      const now = Date.now(), cur = curRound(ev, now);
      return send(res, 200, { label: ev.label, now, epoch: ev.start, code: ev.code, rows: top(id, 10), roundRows: top(id, 10, cur) });
    }
    if (u.pathname === "/api/score" && req.method === "POST") {
      const b = await body(req), c = normCode(b.code);
      if (!validBoard(c)) return send(res, 404, { ok: false });
      const score = Math.floor(+b.score), right = Math.floor(+b.right), name = clean(b.name, 14), id = clean(b.id, 40);
      if (!name || !id || !(right >= 0 && right <= 10) || !(score >= right * 100 && score <= right * 145)) return send(res, 400, { ok: false });
      const list = db.scores[c] || (db.scores[c] = []);
      if (!list.some((r) => r.id === id)) {
        list.push({ id, name, score, right, round: Number.isInteger(b.round) && b.round >= 0 ? b.round : null, t: Date.now() });
        if (list.length > 2000) { list.sort((a, b) => b.score - a.score); list.length = 1500; }
        save();
      }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === "/api/admin" && req.method === "POST") {
      if (limited(req, adminHits, 30)) return send(res, 429, { ok: false });
      const b = await body(req);
      if (!adminOk(b.password)) return send(res, 401, { ok: false });
      const c = normCode(b.code), id = normCode(b.id);
      if (b.action === "add" && c) db.codes[c] = { label: clean(b.label, 40) || "the Haunted House" };
      if (b.action === "remove" && c) { delete db.codes[c]; delete db.scores[c]; }
      if (b.action === "reset" && c) db.scores[c] = [];
      if (b.action === "addEvent") {
        const nid = crypto.randomBytes(4).toString("hex").toUpperCase();
        const want = normCode(b.code), taken = db.codes[want] || Object.values(db.events).some((e) => e.code === want);
        db.events[nid] = { start: null, base: 0, opensAt: null, closesAt: null, code: want.length >= 3 && !taken ? want : newCode(), name: clean(b.name, 30) || "Event", label: clean(b.label, 40) || "the Haunted House", minutes: 0 };
      }
      if (b.action === "removeEvent" && db.events[id]) { delete db.events[id]; delete db.scores[id]; }
      if (b.action === "resetEvent" && db.events[id]) db.scores[id] = [];
      if (b.action === "setSchedule" && db.events[id]) {
        const o = +b.opensAt, c = +b.closesAt;
        db.events[id].opensAt = o > 0 ? o : null; db.events[id].closesAt = c > 0 ? c : null;
      }
      if (b.action === "startEvent" && db.events[id] && !db.events[id].start) { const ev = db.events[id]; ev.start = Date.now() - (ev.base || 0) * CYCLE; }
      if (b.action === "stopEvent" && db.events[id] && db.events[id].start) { const ev = db.events[id]; ev.base = curRound(ev, Date.now()) + 1; ev.start = null; }
      if (b.action === "restartEvent" && db.events[id] && db.events[id].start) { const ev = db.events[id], now = Date.now(); ev.start = now - (curRound(ev, now) + 1) * CYCLE; }
      if (b.action !== "list") save();
      return send(res, 200, adminList());
    }
    // static files
    let p = u.pathname === "/" ? "/index.html" : u.pathname === "/admin" ? "/admin.html" : u.pathname === "/display" ? "/display.html" : u.pathname;
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end("Not found"); }
    const st = fs.statSync(f); let c = FILES.get(f);
    if (!c || c.m !== st.mtimeMs) { const raw = fs.readFileSync(f); c = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw), tag: '"' + st.mtimeMs + "-" + st.size + '"' }; FILES.set(f, c); }
    if (req.headers["if-none-match"] === c.tag) { res.writeHead(304); return res.end(); }
    const h = { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: c.tag, Vary: "Accept-Encoding" };
    if (String(req.headers["accept-encoding"] || "").includes("gzip")) { h["Content-Encoding"] = "gzip"; res.writeHead(200, h); return res.end(c.gz); }
    res.writeHead(200, h); res.end(c.raw);
  } catch (e) { send(res, 500, { ok: false }); }
}).listen(PORT, () => console.log("ScreamIQ running on port " + PORT));
