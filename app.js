// Ontario Library Occupancy dashboard. Reads snapshots committed by the collector
// to the repo's `data` branch: latest.json + <uni>/<YYYY-MM>.csv.
"use strict";

const params = new URLSearchParams(location.search);
const DATA = params.get("data") || "https://raw.githubusercontent.com/eitanzur/library-tracker/data/";
const TZ = "America/Toronto";
const GAP = 45 * 60; // seconds; longer gaps break the line
const bust = () => "?v=" + Math.floor(Date.now() / 300000);

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "text" ? (n.textContent = v) : n.setAttribute(k, v);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const svgNS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}) => {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const fmtTime = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "short", day: "numeric" });
const fmtHour = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric" });
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: false });
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function level(p) {
  if (p == null) return { label: "Under 25%", color: "var(--good)" };
  if (p < 50) return { label: "Not busy", color: "var(--good)" };
  if (p < 75) return { label: "Busy", color: "var(--warn)" };
  if (p < 90) return { label: "Very busy", color: "var(--serious)" };
  return { label: "Full", color: "var(--crit)" };
}
const pctText = (r) => (r.flag === "<25" ? "< 25%" : r.pct == null ? "–" : Math.round(r.pct) + "%");
const ago = (t) => {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// ---- data -------------------------------------------------------------------

function parseCSV(txt) {
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && txt[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.length > 1) rows.push(row); row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => {
    const o = Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]));
    return {
      t: +o.t, library: o.library, space: o.space, flag: o.flag,
      pct: o.pct === "" ? null : +o.pct,
      people: o.people === "" ? null : +o.people,
      cap: o.cap === "" ? null : +o.cap,
    };
  });
}

const cache = {};
async function loadHistory(uni) {
  if (cache[uni]) return cache[uni];
  // Load every month from the first snapshot we know of (Nov 2026) up to now, newest 3 at most.
  const months = [];
  const d = new Date();
  for (let i = 0; i < 3; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }
  const parts = await Promise.all(months.map(async (m) => {
    try {
      const r = await fetch(`${DATA}${uni}/${m}.csv${bust()}`);
      return r.ok ? parseCSV(await r.text()) : [];
    } catch { return []; }
  }));
  const rows = parts.flat().sort((a, b) => a.t - b.t);
  return (cache[uni] = rows);
}

// Building-level series for a library. If the source only reports zones
// (uOttawa), use the mean of its zones at each timestamp.
function buildingSeries(rows, lib) {
  const own = rows.filter((r) => r.library === lib && r.space === "");
  if (own.length) return { pts: own, derived: false };
  const by = new Map();
  for (const r of rows) if (r.library === lib && r.pct != null) {
    if (!by.has(r.t)) by.set(r.t, []);
    by.get(r.t).push(r.pct);
  }
  const pts = [...by].map(([t, v]) => ({ t, pct: v.reduce((a, b) => a + b, 0) / v.length, flag: "" }));
  return { pts, derived: true };
}

// ---- state ------------------------------------------------------------------

let UNIS = [], LATEST = null, cur = null, lib = null, range = 7;

async function init() {
  const [unis, latest] = await Promise.all([
    fetch("universities.json").then((r) => r.json()),
    fetch(`${DATA}latest.json${bust()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  UNIS = unis; LATEST = latest;
  if (latest) $("#updated").textContent = `Last snapshot ${ago(latest.t)} (${fmtTime.format(latest.t * 1000)}).`;

  const live = UNIS.filter((u) => u.status === "live");
  const tabs = $("#tabs");
  for (const u of live) {
    const b = el("button", { role: "tab", "data-k": u.key, text: u.name.replace(/^University of /, "").replace(/ University$/, "") });
    b.onclick = () => selectUni(u.key);
    tabs.append(b);
  }
  renderCoverage();
  document.querySelectorAll("#range button").forEach((b) => (b.onclick = () => { range = +b.dataset.r; renderDetail(); }));
  const want = params.get("u") || location.hash.slice(1);
  selectUni(live.some((u) => u.key === want) ? want : live[0].key);
  // Redraw when the chart's width changes (also catches a first draw before layout settled).
  let lastW = 0;
  new ResizeObserver(debounce(() => {
    const w = $("#chart").clientWidth;
    if (w && Math.abs(w - lastW) > 4) { lastW = w; renderDetail(); }
  }, 100)).observe($("#chart"));
  addEventListener("hashchange", () => {
    const k = location.hash.slice(1);
    if (k !== cur && live.some((u) => u.key === k)) selectUni(k);
  });
}

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

async function selectUni(key) {
  cur = key; lib = null;
  history.replaceState(null, "", "#" + key);
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.k === key));
  const u = UNIS.find((x) => x.key === key);
  $("#uni-name").textContent = u.name;
  $("#uni-source").href = u.source;
  $("#uni-note").textContent = u.note;
  $("#cards").innerHTML = '<div class="empty">Loading…</div>';
  const rows = await loadHistory(key);
  if (cur !== key) return;
  renderCards(rows);
}

function latestRows(rows) {
  const snap = LATEST?.universities?.[cur];
  if (snap?.ok) return snap.rows.map((r) => ({ ...r, t: LATEST.t }));
  const t = rows.length ? rows[rows.length - 1].t : 0;
  return rows.filter((r) => r.t === t);
}

function renderCards(rows) {
  const now = latestRows(rows);
  const libs = [...new Set([...rows.map((r) => r.library), ...now.map((r) => r.library)])];
  const box = $("#cards");
  box.innerHTML = "";
  if (!libs.length) { box.innerHTML = '<div class="empty">No snapshots yet. The first one lands within 15 minutes.</div>'; $("#detail").hidden = true; return; }
  $("#detail").hidden = false;
  for (const name of libs) {
    let r = now.find((x) => x.library === name && x.space === "");
    let derived = false;
    if (!r) {
      const z = now.filter((x) => x.library === name && x.pct != null);
      if (z.length) { r = { pct: z.reduce((a, b) => a + b.pct, 0) / z.length, flag: "" }; derived = true; }
    }
    const lv = level(r?.flag === "<25" ? null : r?.pct);
    const closed = r?.flag === "closed";
    const card = el("button", { class: "card", "aria-pressed": "false", "data-lib": name }, [
      el("div", { class: "name", text: name }),
      el("div", { class: "val" }, [r ? pctText(r) : "–", el("small", { text: r?.people != null ? `${r.people.toLocaleString()} / ${r.cap.toLocaleString()}` : derived ? "avg of zones" : "" })]),
      el("div", { class: "meter" }, [el("i", { style: `width:${Math.min(100, r?.flag === "<25" ? 25 : r?.pct ?? 0)}%;${r?.flag === "<25" ? "opacity:.35" : ""}` })]),
      el("div", { class: "meta" }, [el("span", { class: "dot", style: `background:${closed ? "var(--muted)" : lv.color}` }), closed ? "Closed" : lv.label]),
    ]);
    card.onclick = () => { lib = name; markCards(); renderDetail(); };
    box.append(card);
  }
  lib = libs[0];
  markCards();
  renderDetail();
}
const markCards = () => document.querySelectorAll(".card").forEach((c) => c.setAttribute("aria-pressed", c.dataset.lib === lib));

// ---- detail -----------------------------------------------------------------

function renderDetail() {
  if (!cur || !lib || !cache[cur]) return;
  const rows = cache[cur];
  document.querySelectorAll("#range button").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.r === range));
  $("#lib-name").textContent = lib;
  const { pts, derived } = buildingSeries(rows, lib);
  const end = Date.now() / 1000;
  const start = range ? end - range * 86400 : (pts[0]?.t ?? end - 86400);
  const view = pts.filter((p) => p.t >= start);
  lineChart($("#chart"), view, start, end);
  const notes = [];
  if (derived) notes.push("This source reports floors and zones only, so the line is the average across them.");
  if (pts.some((p) => p.flag === "<25")) notes.push("Shaded band = under 25%: Queen's hides exact values below 25%.");
  if (pts.length && pts[0].t > end - (range || 1) * 86400) notes.push(`History starts ${fmtTime.format(pts[0].t * 1000)}.`);
  $("#chart-note").textContent = notes.join(" ");
  heatmap($("#heat"), pts);
  spacesTable(rows);
}

function lineChart(box, pts, t0, t1) {
  box.innerHTML = "";
  if (!pts.length) { box.append(el("div", { class: "empty", text: "No data in this range yet." })); return; }
  const W = Math.max(320, box.clientWidth), H = W < 500 ? 220 : 280;
  const m = { l: 36, r: 12, t: 10, b: 26 };
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (p) => m.t + (1 - p / 100) * (H - m.t - m.b);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${lib} occupancy over time` });

  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
    const tx = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }); tx.textContent = v + "%"; svg.append(tx);
  }
  // x ticks: days for long ranges, hours for 24h
  const span = t1 - t0, step = span <= 2 * 86400 ? 6 * 3600 : span <= 10 * 86400 ? 86400 : 7 * 86400;
  const off = tzOffset(t0);
  for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1; t += step) {
    const tx = s("text", { x: x(t), y: H - 8, "text-anchor": "middle" });
    tx.textContent = step < 86400 ? fmtHour.format(t * 1000) : fmtDay.format(t * 1000);
    svg.append(tx);
  }

  // segments split on gaps; "<25" points shade the 0–25 band instead of drawing a value
  let d = "", area = "", prev = null;
  for (const p of pts) {
    const brk = !prev || p.t - prev.t > GAP;
    if (p.flag === "<25") {
      area += `M${x(p.t) - 2},${y(0)}V${y(25)}H${x(p.t) + 2}V${y(0)}Z`;
      prev = { ...p, hidden: true };
      continue;
    }
    if (p.pct == null) { prev = null; continue; }
    d += (brk || prev?.hidden ? "M" : "L") + x(p.t).toFixed(1) + "," + y(p.pct).toFixed(1);
    prev = p;
  }
  if (area) svg.append(s("path", { d: area, fill: "var(--series-wash)" }));
  svg.append(s("path", { d, fill: "none", stroke: "var(--series)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // hover: crosshair + nearest point
  const cross = s("line", { y1: m.t, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
  const dot = s("circle", { r: 4.5, fill: "var(--series)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  svg.append(cross, dot, hit);
  const tip = $("#tip");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const cx = x(best.t), cy = best.flag === "<25" ? y(12.5) : y(best.pct ?? 0);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", best.flag === "<25" ? "hidden" : "visible");
    tip.innerHTML = `<b>${pctText(best)}</b>${best.people != null ? ` · ${best.people.toLocaleString()} people` : ""}<div class="t">${fmtTime.format(best.t * 1000)}</div>`;
    tip.hidden = false;
    const tx = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
    tip.style.left = tx + "px"; tip.style.top = ev.clientY - tip.offsetHeight - 12 + "px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
  box.append(svg);
}

function tzOffset(t) {
  // seconds to add to UTC to get Toronto wall-clock time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(t * 1000).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000;
  return Math.round((wall - t) / 60) * 60;
}

function heatmap(box, pts) {
  box.innerHTML = "";
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const p of pts) {
    const v = p.flag === "<25" ? 12.5 : p.pct;
    if (v == null || p.flag === "closed") continue;
    const parts = Object.fromEntries(partsFmt.formatToParts(p.t * 1000).map((x) => [x.type, x.value]));
    const d = DOW.indexOf(parts.weekday), h = +parts.hour % 24;
    sum[d][h] += v; cnt[d][h]++;
  }
  if (!cnt.flat().some(Boolean)) { box.append(el("div", { class: "empty", text: "Builds up as history accumulates." })); return; }
  const W = Math.max(560, box.clientWidth), cw = (W - 40) / 24, ch = 22, H = 7 * ch + 22;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Average occupancy by weekday and hour" });
  const steps = ["--h1", "--h2", "--h3", "--h4", "--h5", "--h6", "--h7"];
  const tip = $("#tip");
  for (let d = 0; d < 7; d++) {
    const lab = s("text", { x: 0, y: d * ch + 15 }); lab.textContent = DOW[d]; svg.append(lab);
    for (let h = 0; h < 24; h++) {
      const n = cnt[d][h], v = n ? sum[d][h] / n : null;
      const fill = v == null ? "var(--h0)" : `var(${steps[Math.min(6, Math.floor(v / 100 * 7))]})`;
      const c = s("rect", { x: 40 + h * cw + 1, y: d * ch + 1, width: cw - 2, height: ch - 2, rx: 3, fill });
      c.addEventListener("pointermove", (ev) => {
        const hr = `${(h % 12) || 12}${h < 12 ? "am" : "pm"}`;
        tip.innerHTML = `<b>${v == null ? "No data" : Math.round(v) + "% avg"}</b><div class="t">${DOW[d]} ${hr} · ${n} snapshot${n === 1 ? "" : "s"}</div>`;
        tip.hidden = false;
        tip.style.left = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
        tip.style.top = ev.clientY - tip.offsetHeight - 12 + "px";
      });
      c.addEventListener("pointerleave", () => (tip.hidden = true));
      svg.append(c);
    }
  }
  for (const h of [0, 6, 12, 18]) {
    const t = s("text", { x: 40 + h * cw + 2, y: H - 4 }); t.textContent = h === 0 ? "12am" : h === 12 ? "12pm" : h < 12 ? h + "am" : h - 12 + "pm"; svg.append(t);
  }
  box.append(svg);
}

function spacesTable(rows) {
  const tb = $("#spaces tbody");
  tb.innerHTML = "";
  const now = latestRows(rows).filter((r) => r.library === lib && r.space);
  $("#spaces-wrap").hidden = !now.length;
  const t1 = Date.now() / 1000, t0 = t1 - 86400;
  for (const r of now) {
    const hist = rows.filter((x) => x.library === lib && x.space === r.space && x.t >= t0 && x.pct != null);
    const tr = el("tr", {}, [
      el("td", { text: r.space }),
      el("td", { class: "num", text: r.flag === "closed" ? "Closed" : pctText(r) }),
      el("td", { class: "num", text: r.people != null ? `${r.people} / ${r.cap}` : "–" }),
      el("td", {}, [spark(hist, t0, t1)]),
    ]);
    tb.append(tr);
  }
}

function spark(pts, t0, t1) {
  const W = 120, H = 24;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" });
  svg.append(s("line", { x1: 0, x2: W, y1: H - 1, y2: H - 1, stroke: "var(--grid)", "stroke-width": 1 }));
  let d = "", prev = null;
  for (const p of pts) {
    const X = ((p.t - t0) / (t1 - t0)) * W, Y = H - 2 - (p.pct / 100) * (H - 4);
    d += (!prev || p.t - prev.t > GAP ? "M" : "L") + X.toFixed(1) + "," + Y.toFixed(1);
    prev = p;
  }
  if (d) svg.append(s("path", { d, fill: "none", stroke: "var(--series)", "stroke-width": 1.5, "stroke-linejoin": "round" }));
  return svg;
}

// ---- coverage ----------------------------------------------------------------

function renderCoverage() {
  const tb = $("#coverage tbody");
  const label = { live: ["Tracking live", "var(--good)"], blocked: ["Has data, blocked", "var(--warn)"], none: ["None found", "var(--muted)"] };
  for (const u of UNIS) {
    const [txt, col] = label[u.status];
    const ok = u.status === "live" && LATEST?.universities?.[u.key];
    const status = ok && !ok.ok ? ["Source failing", "var(--crit)"] : [txt, col];
    tb.append(el("tr", {}, [
      el("td", {}, [el("a", { href: u.source, target: "_blank", rel: "noopener", text: u.name })]),
      el("td", {}, [el("span", { class: "badge" }, [el("span", { class: "dot", style: `background:${status[1]}` }), status[0]])]),
      el("td", { text: ok && !ok.ok ? `${u.note} Last error: ${ok.error}` : u.note }),
    ]));
  }
}

init();
