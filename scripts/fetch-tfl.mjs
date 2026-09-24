// Fetches stop lists, route lines and service status for every route in web/data/garage.json
// from the TfL Unified API, and writes them into web/data/ for the app.
// Run by the "Publish app" GitHub workflow. Needs Node 18+ (built-in fetch). No packages.
//
// Writes:
//   web/data/routes/<id>.json  stops (name, letter, position) and route line, each direction
//   web/data/routes.json       index of routes for the app's route picker
//   web/data/changes.json      log of stop changes TfL made since the previous run
//   web/data/status.json       current TfL status and disruptions per route
// A route that fails to download keeps its previous file. The script never deletes data.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "web", "data");
const API = process.env.TFL_API_BASE || "https://api.tfl.gov.uk";
const KEY = process.env.TFL_APP_KEY ? `app_key=${encodeURIComponent(process.env.TFL_APP_KEY)}` : "";
const STATUS_ONLY = process.argv.includes("--status-only");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const note = s => { console.log(s); log.push(s); };

async function get(p) {
  const url = API + p + (KEY ? (p.includes("?") ? "&" : "?") + KEY : "");
  let last;
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "walthamstow-route-trainer" } });
      if (r.status === 429) { await sleep(5000 * a); last = new Error("rate limited"); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await sleep(1500 * a); }
  }
  throw new Error(`${p}: ${last && last.message}`);
}
async function readJson(f, fallback) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return fallback; } }
async function writeJson(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v) + "\n"); }

const rad = d => d * Math.PI / 180;
function metres(a, b) { // a,b = [lon,lat]
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2)), y = rad(b[1] - a[1]);
  return Math.sqrt(x * x + y * y) * 6371000;
}
function cleanLetter(s) {
  s = String(s || "").trim();
  if (!s || s.startsWith("->")) return "";
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 3);
}

// Stops in running order: TfL's longest regular "ordered line route", else the longest branch
function parseStops(j) {
  const byId = new Map();
  for (const sq of j.stopPointSequences || []) for (const p of sq.stopPoint || []) if (p && p.id && !byId.has(p.id)) byId.set(p.id, p);
  for (const p of j.stations || []) if (p && p.id && !byId.has(p.id)) byId.set(p.id, p);
  let stops = [];
  const olr = (j.orderedLineRoutes || []).filter(r => Array.isArray(r.naptanIds) && r.naptanIds.length);
  const regular = olr.filter(r => !r.serviceType || /regular/i.test(r.serviceType));
  const pool = regular.length ? regular : olr;
  if (pool.length) {
    const ids = pool.reduce((a, b) => b.naptanIds.length > a.naptanIds.length ? b : a).naptanIds;
    stops = ids.map(id => byId.get(id)).filter(Boolean);
  }
  if (stops.length < 2) {
    stops = (j.stopPointSequences || []).map(s => s.stopPoint || []).sort((a, b) => b.length - a.length)[0] || [];
  }
  return stops.map(p => ({
    id: p.id, name: String(p.name || p.commonName || "").trim(), letter: cleanLetter(p.stopLetter),
    lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6)
  })).filter(s => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// Route line: TfL gives one or more JSON strings of [lon,lat] points; take the longest line
function parseTrace(j, stops) {
  let best = [], bestLen = 0;
  for (let s of j.lineStrings || []) {
    if (typeof s === "string") { try { s = JSON.parse(s); } catch { continue; } }
    const segs = [];
    (function walk(a) {
      if (!Array.isArray(a)) return;
      if (a.length && Array.isArray(a[0]) && typeof a[0][0] === "number") segs.push(a.filter(p => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number").map(p => [p[0], p[1]]));
      else a.forEach(walk);
    })(s);
    for (const seg of segs) {
      let len = 0; for (let i = 1; i < seg.length; i++) len += metres(seg[i - 1], seg[i]);
      if (len > bestLen) { bestLen = len; best = seg; }
    }
  }
  if (best.length < 2) return stops.map(s => [s.lon, s.lat]);
  // make sure the line runs the same way as the stops
  if (stops.length) {
    const first = [stops[0].lon, stops[0].lat];
    if (metres(best[best.length - 1], first) < metres(best[0], first)) best = best.slice().reverse();
  }
  return simplify(best, 4).map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]);
}
// Douglas-Peucker, tolerance in metres
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const lat0 = rad(pts[0][1]), P = p => [rad(p[0]) * Math.cos(lat0) * 6371000, rad(p[1]) * 6371000];
  const xy = pts.map(P), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let idx = -1, dmax = tol;
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / L; if (d > dmax) { dmax = d; idx = i; } }
    if (idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// What changed between two stop lists (matched by TfL stop id)
function diffStops(label, oldS, newS) {
  const A = oldS, B = newS, n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i].id === B[j].id ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, prev = null;
  const lt = s => s.letter ? ` (${s.letter})` : "";
  while (i < n || j < m) {
    if (i < n && j < m && A[i].id === B[j].id) {
      if (A[i].letter !== B[j].letter) out.push(`${label}: '${B[j].name}' letter is now ${B[j].letter || "none"} (was ${A[i].letter || "none"})`);
      else if (A[i].name !== B[j].name) out.push(`${label}: '${A[i].name}' is now called '${B[j].name}'`);
      prev = B[j]; i++; j++;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { out.push(`${label}: '${A[i].name}'${lt(A[i])} is no longer served`); i++; }
    else { out.push(`${label}: new stop '${B[j].name}'${lt(B[j])} ${prev ? `after '${prev.name}'` : "at the start"}`); prev = B[j]; j++; }
  }
  return out;
}

function statusFromLine(l) {
  const out = [];
  for (const s of (l && l.lineStatuses) || []) {
    const o = { severity: s.statusSeverityDescription || "", reason: /good service/i.test(s.statusSeverityDescription || "") ? "" : (s.reason || "") };
    if (o.reason) {
      const vp = (s.validityPeriods || [])[0] || {};
      if (vp.fromDate) o.from = vp.fromDate; if (vp.toDate) o.to = vp.toDate;
      if (s.disruption && s.disruption.category) o.category = s.disruption.category;
    }
    out.push(o);
  }
  return out.length ? out : [{ severity: "Good Service", reason: "" }];
}
function disruptionsFrom(list) {
  return (Array.isArray(list) ? list : []).map(d => {
    const vp = (d.validityPeriods || [])[0] || {};
    const o = { category: d.categoryDescription || d.category || "Disruption", description: d.description || "" };
    const f = vp.fromDate || d.fromDate, t = vp.toDate || d.toDate;
    if (f) o.from = f; if (t) o.to = t; return o;
  }).filter(d => d.description);
}

async function main() {
  const garage = await readJson(path.join(DATA, "garage.json"), null);
  if (!garage || !Array.isArray(garage.routes) || !garage.routes.length) throw new Error("web/data/garage.json has no routes list");
  const ids = [...new Set(garage.routes.map(r => String(r).trim().toLowerCase()).filter(Boolean))];
  const now = new Date().toISOString(), today = now.slice(0, 10);

  if (!STATUS_ONLY) {
    const changes = await readJson(path.join(DATA, "changes.json"), { routes: {} });
    const index = { generated: now, garage: { name: garage.name || "", code: garage.code || "", operator: garage.operator || "" }, routes: [] };
    for (const id of ids) {
      const file = path.join(DATA, "routes", `${id}.json`);
      const old = await readJson(file, null);
      let route = old;
      try {
        const dirs = {};
        for (const d of ["outbound", "inbound"]) {
          const j = await get(`/Line/${encodeURIComponent(id)}/Route/Sequence/${d}?excludeCrowding=true`);
          const stops = parseStops(j);
          if (stops.length < 2) throw new Error(`${d}: no stops in TfL's answer`);
          dirs[d === "outbound" ? "out" : "in"] = { stops, trace: parseTrace(j, stops) };
          if (!route || !route.name) route = { name: j.lineName || id.toUpperCase() };
          await sleep(250);
        }
        const fresh = { id, name: (route && route.name) || id.toUpperCase(), updated: now, out: dirs.out, in: dirs.in };
        if (old && old.out && old.in) {
          const c = [
            ...diffStops(`To ${fresh.out.stops.at(-1).name}`, old.out.stops, fresh.out.stops),
            ...diffStops(`To ${fresh.in.stops.at(-1).name}`, old.in.stops, fresh.in.stops)
          ];
          if (c.length) {
            changes.routes[id] = [...c.map(text => ({ date: today, text })), ...(changes.routes[id] || [])].slice(0, 40);
            note(`${fresh.name}: ${c.length} stop change(s) since last run`);
          }
          const same = JSON.stringify([old.out, old.in]) === JSON.stringify([fresh.out, fresh.in]);
          if (same) fresh.updated = old.updated; // keep the file unchanged when nothing moved
        }
        await writeJson(file, fresh);
        route = fresh;
        note(`${fresh.name}: ${fresh.out.stops.length} stops out, ${fresh.in.stops.length} back`);
      } catch (e) {
        note(`${id.toUpperCase()}: couldn't download (${e.message})${old ? ", keeping the previous data" : ""}`);
      }
      if (route && route.out && route.in) {
        index.routes.push({
          id, name: route.name, updated: route.updated,
          out: { from: route.out.stops[0].name, to: route.out.stops.at(-1).name, count: route.out.stops.length },
          in: { from: route.in.stops[0].name, to: route.in.stops.at(-1).name, count: route.in.stops.length }
        });
      }
    }
    // drop changes older than 90 days
    const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    for (const k of Object.keys(changes.routes)) changes.routes[k] = changes.routes[k].filter(c => c.date >= cutoff);
    const oldIndex = await readJson(path.join(DATA, "routes.json"), null);
    if (oldIndex && JSON.stringify({ ...oldIndex, generated: 0 }) === JSON.stringify({ ...index, generated: 0 })) index.generated = oldIndex.generated;
    await writeJson(path.join(DATA, "routes.json"), index);
    await writeJson(path.join(DATA, "changes.json"), changes);
  }

  // Service status for every route (not committed; published with the app)
  const status = { checkedAt: now, lines: {} };
  try {
    const lines = await get(`/Line/${ids.map(encodeURIComponent).join(",")}/Status?detail=true`);
    for (const l of Array.isArray(lines) ? lines : [lines]) if (l && l.id) status.lines[String(l.id).toLowerCase()] = { status: statusFromLine(l), disruptions: [] };
    for (const id of ids) {
      try { const d = await get(`/Line/${encodeURIComponent(id)}/Disruption`); if (status.lines[id]) status.lines[id].disruptions = disruptionsFrom(d); } catch (e) { note(`${id.toUpperCase()} disruptions: ${e.message}`); }
      await sleep(150);
    }
    await writeJson(path.join(DATA, "status.json"), status);
    note(`Status: ${Object.entries(status.lines).map(([k, v]) => `${k.toUpperCase()} ${v.status.map(s => s.severity).join("/")}`).join(", ")}`);
  } catch (e) {
    note(`Status: couldn't download (${e.message}). The app will show its last saved status.`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "### TfL data\n\n" + log.map(l => "- " + l).join("\n") + "\n");
}

main().catch(e => { console.error("::error::" + e.message); process.exit(1); });
