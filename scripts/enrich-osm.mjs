// Adds road names, named turns and hazard notes to each route, using OpenStreetMap.
// For every route file in web/data/routes/, it downloads the roads and features along the
// route line from the Overpass API, matches the line to the roads, and writes
// web/data/osm/<id>.json. A route is only re-processed when its TfL data changes.
// Run by the "Publish app" GitHub workflow after fetch-tfl.mjs. Node 18+, no packages.
// Map data © OpenStreetMap contributors, available under the Open Database Licence.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "web", "data");
const ENDPOINTS = (process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter").split(",");
const FORCE = process.argv.includes("--force");
const ONLY = (process.argv.find(a => a.startsWith("--route=")) || "").slice(8).toLowerCase();
const VERSION = 3; // bump to re-process every route after changing this script
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
const note = s => { console.log(s); log.push(s); };
async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } }
async function writeJson(f, v) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v) + "\n"); }

async function overpass(query) {
  let last;
  for (let round = 0; round < 2; round++) for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "walthamstow-route-trainer (github.com)" }, body: "data=" + encodeURIComponent(query) });
      if (r.status === 429 || r.status === 504) { last = new Error(`HTTP ${r.status} from ${new URL(url).host}`); await sleep(15000); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      return await r.json();
    } catch (e) { last = e; await sleep(3000); }
  }
  throw last;
}

// ---------- geometry (local flat projection in metres) ----------
const R = 6371000, rad = d => d * Math.PI / 180;
function projector(lat0) { const k = Math.cos(rad(lat0)); return (lon, lat) => [rad(lon) * k * R, rad(lat) * R]; }
const brg = (ax, ay, bx, by) => (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function angDiff180(a, b) { let d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); }
function simplify(pts, tol, P) { // Douglas-Peucker on [lon,lat]
  if (pts.length < 3) return pts;
  const xy = pts.map(p => P(p[0], p[1])), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let idx = -1, dm = tol;
    for (let i = a + 1; i < b; i++) { const d = segDist(xy[i][0], xy[i][1], xy[a][0], xy[a][1], xy[b][0], xy[b][1]); if (d > dm) { dm = d; idx = i; } }
    if (idx > 0) { keep[idx] = 1; st.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function densify(trace, P, step = 8) {
  const out = []; let cum = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    const [ax, ay] = P(...trace[i]), [bx, by] = P(...trace[i + 1]);
    const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / step)), b = brg(ax, ay, bx, by);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: ax + t * (bx - ax), y: ay + t * (by - ay), lon: trace[i][0] + t * (trace[i + 1][0] - trace[i][0]), lat: trace[i][1] + t * (trace[i + 1][1] - trace[i][1]), cum: cum + t * L, brg: b });
    }
    cum += L;
  }
  const l = trace[trace.length - 1], [lx, ly] = P(...l);
  out.push({ x: lx, y: ly, lon: l[0], lat: l[1], cum, brg: out.length ? out[out.length - 1].brg : 0 });
  return out;
}
const r6 = v => +v.toFixed(6);

// ---------- tags ----------
const roadName = t => {
  const n = (t.name || "").trim(), ref = (t.ref || "").trim().split(";")[0];
  return n ? (ref && /^[AB]\d/.test(ref) ? `${n} (${ref})` : n) : (ref && /^[AB]\d/.test(ref) ? ref : "");
};
const isRbt = t => t.junction === "roundabout" || t.junction === "circular";
const yes = v => /^(yes|designated|permissive)$/.test(v || "");
const no = v => /^(no|private|destination|delivery)$/.test(v || "");
const isBusGate = t => (yes(t.bus) || yes(t.psv)) && (no(t.access) || no(t.motor_vehicle) || no(t.motorcar) || no(t.vehicle));
const is20 = t => /^20( ?mph)?$/i.test((t.maxspeed || "").trim());
const calmingWord = v => ({ hump: "speed humps", bump: "speed bumps", cushion: "speed cushions", table: "raised tables", chicane: "chicanes", choker: "road narrowings", island: "traffic islands", rumble_strip: "rumble strips", yes: "traffic calming" })[v] || "traffic calming";
const fmtLimit = v => { v = String(v).trim(); return /^\d+(\.\d+)?$/.test(v) ? `${v} m` : v; };

function buildQuery(polyA, polyB) {
  const poly = [...polyA, ...polyB].map(p => `${p[1].toFixed(5)},${p[0].toFixed(5)}`);
  // Overpass "around" takes one polyline; the two directions are passed as one list, with a
  // straight join between them that is harmless (it only adds a few extra candidate ways).
  const A = poly.join(",");
  return `[out:json][timeout:180];
(
  way[highway][highway!~"^(footway|cycleway|path|steps|pedestrian|track|bridleway|corridor|elevator|construction|proposed|platform|bus_stop|raceway)$"](around:30,${A});
) ->.roads;
.roads out tags geom;
(
  node[railway=level_crossing](around:20,${A});
  node[highway~"^(mini_roundabout|crossing|traffic_signals)$"](around:15,${A});
  node[traffic_calming](around:15,${A});
  node[maxheight](around:20,${A});
) ->.pts;
.pts out body;
(
  nwr[amenity~"^(school|college|hospital|marketplace)$"][name](around:90,${A});
  nwr[railway=station][name](around:110,${A});
  nwr[public_transport=station][bus=yes][name](around:90,${A});
) ->.poi;
.poi out tags center;`;
}

function processDirection(dir, osm, P, label) {
  const trace = dir.trace, stops = dir.stops;
  const S = densify(trace, P);
  const total = S[S.length - 1].cum;

  // ways and a grid index of their segments
  const ways = osm.elements.filter(e => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length > 1);
  const segs = [], grid = new Map(), C = 40;
  ways.forEach((w, wi) => {
    const g = w.geometry.map(p => P(p.lon, p.lat));
    for (let i = 0; i < g.length - 1; i++) {
      const s = { wi, ax: g[i][0], ay: g[i][1], bx: g[i + 1][0], by: g[i + 1][1] }; s.b = brg(s.ax, s.ay, s.bx, s.by);
      const si = segs.push(s) - 1;
      for (let cx = Math.floor(Math.min(s.ax, s.bx) / C); cx <= Math.floor(Math.max(s.ax, s.bx) / C); cx++)
        for (let cy = Math.floor(Math.min(s.ay, s.by) / C); cy <= Math.floor(Math.max(s.ay, s.by) / C); cy++) {
          const k = cx + "," + cy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(si);
        }
    }
  });

  // match every sample to the nearest road running the same way
  let matched = 0, prevWay = null;
  const wayAt = S.map(p => {
    const cx = Math.floor(p.x / C), cy = Math.floor(p.y / C), seen = new Set();
    let best = null, bc = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const si of grid.get((cx + dx) + "," + (cy + dy)) || []) {
      if (seen.has(si)) continue; seen.add(si);
      const s = segs[si], d = segDist(p.x, p.y, s.ax, s.ay, s.bx, s.by);
      if (d > 25) continue;
      // prefer roads running the same way, and staying on the road we're already on
      const cost = d + (angDiff180(p.brg, s.b) <= 35 ? 0 : 30) - (s.wi === prevWay ? 8 : 0);
      if (cost < bc) { bc = cost; best = s.wi; }
    }
    if (best !== null) { matched++; prevWay = best; }
    return best;
  });
  const matchRate = matched / S.length;
  // bridge short gaps (up to 60 m) in the match; longer unmatched stretches stay unnamed
  for (let i = 0; i < wayAt.length; i++) {
    if (wayAt[i] !== null) continue;
    let j = i; while (j < wayAt.length && wayAt[j] === null) j++;
    const gap = S[Math.min(j, S.length - 1)].cum - S[i].cum, fill = i > 0 ? wayAt[i - 1] : j < wayAt.length ? wayAt[j] : null;
    if (gap <= 60 && fill !== null) for (let k = i; k < j; k++) wayAt[k] = fill;
    i = j;
  }

  // runs of the same road, with junction noise smoothed out
  // group by road name only, so a road whose A-number is tagged on some parts but not others
  // doesn't look like a change of road; show the fullest version of the name
  const display = new Map();
  const keyOf = wi => {
    if (wi === null) return "?";
    const t = ways[wi].tags || {}; if (isRbt(t)) return "@rbt";
    const full = roadName(t), key = (t.name || "").trim() || full;
    if (key && (!display.has(key) || full.length > display.get(key).length)) display.set(key, full);
    return key;
  };
  let runs = [];
  wayAt.forEach((wi, i) => { const k = keyOf(wi); const r = runs[runs.length - 1]; if (r && r.key === k) { r.i1 = i; r.ways.add(wi); } else runs.push({ key: k, i0: i, i1: i, ways: new Set([wi]) }); });
  const len = r => S[r.i1].cum - S[r.i0].cum + 8;
  const mergeInto = (a, b) => { a.i0 = Math.min(a.i0, b.i0); a.i1 = Math.max(a.i1, b.i1); b.ways.forEach(w => a.ways.add(w)); };
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k], prev = runs[k - 1], next = runs[k + 1];
      const minLen = r.key === "@rbt" ? 6 : r.key === "" ? 60 : r.key === "?" ? 1e9 : 30;
      if (r.key === "?") continue; // unmatched stretches are kept as they are
      if (len(r) >= minLen || runs.length < 2) continue;
      if (prev && next && prev.key === next.key) { mergeInto(prev, r); mergeInto(prev, next); runs.splice(k, 2); }
      else if (prev) { mergeInto(prev, r); runs.splice(k, 1); }
      else if (next) { mergeInto(next, r); runs.splice(k, 1); }
      changed = true; k--;
    }
    // join neighbours that now share a name
    for (let k = runs.length - 1; k > 0; k--) if (runs[k].key === runs[k - 1].key) { mergeInto(runs[k - 1], runs[k]); runs.splice(k, 1); changed = true; }
    if (!changed) break;
  }
  runs = runs.map(r => ({ ...r, name: r.key === "?" || r.key === "@rbt" ? "" : (display.get(r.key) || r.key), rbt: r.key === "@rbt", unknown: r.key === "?" }));
  const runAt = i => runs.find(r => i >= r.i0 && i <= r.i1) || runs[runs.length - 1];
  const nameAt = i => { const r = runAt(i); if (!r.rbt) return r.name; const k = runs.indexOf(r); return (runs[k + 1] && runs[k + 1].name) || (runs[k - 1] && runs[k - 1].name) || ""; };

  // stops: nearest point along the line, in running order
  let from = 0;
  const stopIdx = stops.map(st => {
    const [x, y] = P(st.lon, st.lat); let best = from, bd = Infinity;
    for (let i = from; i < S.length; i++) { const d = Math.hypot(S[i].x - x, S[i].y - y); if (d < bd) { bd = d; best = i; } if (bd < 60 && d > bd + 200) break; }
    from = best; return { i: best, d: bd };
  });
  const stopRoads = stopIdx.map(({ i, d }) => {
    const r = runAt(i), name = nameAt(i);
    const nearEdge = (S[i].cum - S[r.i0].cum < 25 && r.i0 > 0) || (S[r.i1].cum - S[i].cum < 25 && r.i1 < S.length - 1);
    return { name: r.unknown ? "" : name, v: !name || r.unknown || nearEdge || d > 40 || matchRate < 0.6 ? 1 : 0 };
  });
  const stopCum = stopIdx.map(s => Math.round(S[s.i].cum));
  const stopBefore = cum => { let s = 0; for (let k = 0; k < stopCum.length; k++) if (stopCum[k] <= cum + 1) s = k; return s; };

  // turn-by-turn: a step wherever the road changes; roundabouts become roundabout steps
  const pts = osm.elements.filter(e => e.type === "node" && typeof e.lat === "number");
  const near = (e, maxD) => { const [x, y] = P(e.lon, e.lat); let bi = -1, bd = Infinity; for (let i = 0; i < S.length; i++) { const d = Math.hypot(S[i].x - x, S[i].y - y); if (d < bd) { bd = d; bi = i; } } return bd <= maxD ? bi : -1; };
  const steps = [];
  for (let k = 1; k < runs.length; k++) {
    const r = runs[k]; if (r.rbt || r.unknown) continue;
    const prev = runs[k - 1]; if (prev.unknown) { steps.push({ act: "turn", at: [r6(S[r.i0].lon), r6(S[r.i0].lat)], road: r.name, cum: S[r.i0].cum, extra: "Check this stretch on your route-learning drive: the map match is uncertain before here." }); continue; }
    if (prev.rbt) steps.push({ act: "rbt", at: [r6(S[prev.i0].lon), r6(S[prev.i0].lat)], road: r.name, cum: S[prev.i0].cum });
    else steps.push({ act: "turn", at: [r6(S[r.i0].lon), r6(S[r.i0].lat)], road: r.name, cum: S[r.i0].cum });
  }
  for (const n of pts.filter(e => (e.tags || {}).highway === "mini_roundabout")) {
    const i = near(n, 15); if (i < 0 || S[i].cum < 30 || total - S[i].cum < 30) continue;
    const close = steps.find(s => Math.abs(s.cum - S[i].cum) < 45);
    if (close) { close.act = "rbt"; close.extra = "Mini roundabout."; }
    else steps.push({ act: "rbt", at: [r6(S[i].lon), r6(S[i].lat)], road: nameAt(Math.min(S.length - 1, i + 4)), cum: S[i].cum, extra: "Mini roundabout." });
  }
  steps.sort((a, b) => a.cum - b.cum);

  // hazards and features, each tied to the stop just before it
  const feats = [], add = (cum, kind, text) => feats.push({ s: stopBefore(cum), cum: Math.round(cum), kind, text });
  const seenWay = new Set(), busRoads = new Set();
  runs.forEach(r => r.ways.forEach(wi => {
    if (wi === null || seenWay.has(wi)) return; seenWay.add(wi);
    const t = ways[wi].tags || {}; const i0 = wayAt.indexOf(wi); if (i0 < 0) return;
    const road = nameAt(i0) || "an unnamed road";
    if (t.maxheight && t.maxheight !== "none" && t.maxheight !== "default") add(S[i0].cum, "height", `Height limit ${fmtLimit(t.maxheight)} on ${road}`);
    if (t.maxwidth) add(S[i0].cum, "width", `Width limit ${fmtLimit(t.maxwidth)} on ${road}. Check whether buses are exempt`);
    // bus gates on named roads only (unnamed bus-only links are usually bus station approaches), once per road
    if (isBusGate(t) && nameAt(i0) && !busRoads.has(road)) { busRoads.add(road); add(S[i0].cum, "busgate", `Bus-only section on ${road} (bus gate): other traffic may stop or turn here unexpectedly`); }
    if (is20(t)) add(S[i0].cum, "speed20", road);
    if (t.bridge === "yes" && t.name) { /* the route itself crosses a bridge: not a hazard */ }
  }));
  runs.forEach((r, k) => { if (r.rbt) { const a = runs[k - 1] && runs[k - 1].name, b = runs[k + 1] && runs[k + 1].name; add(S[r.i0].cum, "rbt", a && b && a !== b ? `Roundabout where ${a} meets ${b}` : `Roundabout on ${a || b || "the route"}`); } });
  const calm = new Map();
  for (const n of pts) {
    const t = n.tags || {};
    if (t.railway === "level_crossing") { const i = near(n, 20); if (i >= 0) add(S[i].cum, "level", `Level crossing on ${nameAt(i) || "the route"}`); }
    else if (t.highway === "mini_roundabout") { const i = near(n, 15); if (i >= 0) add(S[i].cum, "mini", `Mini roundabout on ${nameAt(i) || "the route"}`); }
    else if (t.highway === "traffic_signals") { const i = near(n, 12); if (i >= 0) add(S[i].cum, "signals", ""); }
    else if (t.highway === "crossing" && (t.crossing === "zebra" || t.crossing_ref === "zebra")) { const i = near(n, 12); if (i >= 0) add(S[i].cum, "zebra", ""); }
    if (t.traffic_calming && t.traffic_calming !== "no") {
      const i = near(n, 15); if (i < 0) continue;
      const key = nameAt(i) + "|" + calmingWord(t.traffic_calming);
      if (!calm.has(key)) calm.set(key, { cum: S[i].cum, n: 0, road: nameAt(i), what: calmingWord(t.traffic_calming) });
      calm.get(key).n++;
    }
    if (t.maxheight && !t.highway && !t.railway) { const i = near(n, 20); if (i >= 0) add(S[i].cum, "height", `Height limit ${fmtLimit(t.maxheight)} on ${nameAt(i) || "the route"}`); }
  }
  calm.forEach(c => add(c.cum, "calming", `${c.what[0].toUpperCase() + c.what.slice(1)} on ${c.road || "the route"}${c.n > 1 ? ` (${c.n})` : ""}`));
  const pois = osm.elements.filter(e => (e.tags || {}).name && (e.center || typeof e.lat === "number") && ((e.tags.amenity && /^(school|college|hospital|marketplace)$/.test(e.tags.amenity)) || e.tags.railway === "station" || e.tags.public_transport === "station"));
  const poiSeen = new Set();
  for (const e of pois) {
    const c = e.center || e, t = e.tags, name = t.name.trim();
    const kind = t.amenity || (t.railway === "station" ? "station" : "busstation");
    const maxD = { school: 70, college: 70, hospital: 130, marketplace: 90, station: 120, busstation: 90 }[kind];
    const i = near({ lon: c.lon, lat: c.lat }, maxD); if (i < 0 || poiSeen.has(kind + name)) continue; poiSeen.add(kind + name);
    const road = nameAt(i), on = road ? ` near ${road}` : "";
    const text = {
      school: `${name}${on}: expect children and parents at school start and finish times`,
      college: `${name}${on}: students crossing, busy at start and end of the day`,
      hospital: `${name}${on}: give way to ambulances and keep entrances clear`,
      marketplace: `${name}${on}: stalls, deliveries and crowds on market days`,
      station: `${name}${on}: busy with people crossing and running for buses`,
      busstation: `${name}: low speed, heavy pedestrian flow, buses pulling out`
    }[kind];
    add(S[i].cum, kind, text);
  }
  feats.sort((a, b) => a.cum - b.cum);

  return {
    matchRate: Math.round(matchRate * 100) / 100,
    stopRoads, stopCum,
    roads: runs.filter(r => !r.unknown).map(r => ({ name: r.name, rbt: r.rbt ? 1 : 0, from: Math.round(S[r.i0].cum), to: Math.round(S[r.i1].cum) })),
    steps: steps.map(({ cum, ...s }) => s),
    features: feats.map(({ cum, ...f }) => f)
  };
}

async function main() {
  const dir = path.join(DATA, "routes");
  let files = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith(".json")); } catch { note("No route data yet; run fetch-tfl.mjs first."); return; }
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (ONLY && id !== ONLY) continue;
    const route = await readJson(path.join(dir, f), null);
    if (!route || !route.out || !route.in) continue;
    const outFile = path.join(DATA, "osm", `${id}.json`);
    const prev = await readJson(outFile, null);
    if (!FORCE && prev && prev.basedOn === route.updated && prev.version === VERSION) { note(`${route.name}: roads up to date`); continue; }
    try {
      const lat0 = route.out.stops[0].lat, P = projector(lat0);
      const q = buildQuery(simplify(route.out.trace, 15, P), simplify(route.in.trace, 15, P));
      const osm = await overpass(q);
      if (!osm || !Array.isArray(osm.elements)) throw new Error("no data in the answer");
      const res = { id, version: VERSION, basedOn: route.updated, generated: new Date().toISOString(), attribution: "© OpenStreetMap contributors",
        out: processDirection(route.out, osm, P, "out"), in: processDirection(route.in, osm, P, "in") };
      await writeJson(outFile, res);
      const named = d => d.stopRoads.filter(s => s.name).length;
      const low = Math.min(res.out.matchRate, res.in.matchRate) < 0.5;
      note(`${low ? "⚠ " : ""}${route.name}: roads matched ${Math.round(res.out.matchRate * 100)}% / ${Math.round(res.in.matchRate * 100)}% of the line, ${named(res.out)}+${named(res.in)} stops named, ${res.out.steps.length}+${res.in.steps.length} turns, ${res.out.features.length + res.in.features.length} features${low ? ". Too little of the line matched the map, so the app won't use these roads" : ""}`);
    } catch (e) {
      note(`${route.name}: couldn't get map data (${e.message})${prev ? ", keeping the previous roads" : ""}`);
    }
    await sleep(4000); // be gentle with the public Overpass servers
  }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, "### Roads and hazards (OpenStreetMap)\n\n" + log.map(l => "- " + l).join("\n") + "\n");
}
main().catch(e => { console.error("::warning::" + e.message); process.exit(0); });
