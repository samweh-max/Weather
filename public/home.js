// Your own weather station (CampbellON): its card on the Stations page, plain-English sensor
// names, favourites pinned to the card, and the history explorer.
// Uses helpers from app.js (state, fmt, esc, api, store, render…), which loads after this file;
// nothing here runs until app.js calls it.

/* global state, fmt, esc, api, store, render, windArrow, compass, rainTimeline, ago, distanceKm, $ */

const HOME_RANGE = 80;  // km: further than this, your station isn't shown for a place
const HOME_CHECK = 15;  // km: closer than this, it becomes the record the forecasts are checked against

// ---------- Loading ----------

// Show the last copy straight away, then fetch a new one. The rest of the page never waits.
function homeInit() {
  const last = store.get("wc.home", null);
  state.home = last && last.station ? { ...last, cached: true } : last;
  state.homeLoading = false;
}

async function loadHome() {
  if (!state.place) return;
  state.homeLoading = true;
  syncStations();
  render();
  try {
    const body = await api(`/api/home?lat=${state.place.lat}&lon=${state.place.lon}`);
    state.home = body;
    if (body.enabled === false) store.set("wc.home", { enabled: false });
    else if (body.station) store.set("wc.home", { enabled: true, station: body.station, history: body.history });
  } catch (err) {
    // Keep showing the last copy; say what went wrong only if there is nothing to show.
    state.home = state.home && state.home.station ? { ...state.home, cached: true, error: err.message } : { enabled: true, error: err.message };
  } finally {
    state.homeLoading = false;
    syncStations();
    render();
  }
}

function homeHere() {
  const h = state.home;
  if (!h || !h.station || !state.place) return null;
  const s = h.station;
  const dist = s.lat != null && s.lon != null ? Math.round(distanceKm(state.place.lat, state.place.lon, s.lat, s.lon) * 10) / 10 : 0;
  return dist <= HOME_RANGE ? { ...s, dist } : null;
}

function homeNet() {
  const h = state.home;
  if (!h) return state.homeLoading ? { enabled: true, loading: true } : { enabled: false };
  if (h.enabled === false) return { enabled: false };
  if (state.homeLoading && !h.station) return { enabled: true, loading: true };
  if (!h.station) return { enabled: true, ok: false, error: h.error || "not responding" };
  const mine = homeHere();
  if (!mine) {
    const s = h.station;
    const far = state.place && s.lat != null ? distanceKm(state.place.lat, state.place.lon, s.lat, s.lon) : null;
    return { enabled: true, ok: true, count: 0, far };
  }
  return { enabled: true, ok: true, count: 1, updating: state.homeLoading };
}

// Put your station in with the others (it arrives separately), and let it be the record the
// forecasts are checked against when it is close.
function syncStations() {
  const raw = state.stationsRaw;
  const mine = homeHere();
  if (!raw && !mine) { state.stations = null; return; }
  const base = raw || { stations: [], networks: {}, partial: true };
  const stations = [...(base.stations || []).filter((s) => s.network !== "home"), ...(mine ? [mine] : [])].sort((a, b) => a.dist - b.dist);
  let history = base.history;
  const track = state.home && state.home.history;
  if (mine && mine.dist <= HOME_CHECK && track && (track.obs || []).some((o) => o.temp != null)) history = { ...track, dist: mine.dist };
  state.stations = { ...base, stations, history, networks: { ...(base.networks || {}), home: homeNet() } };
}

// ---------- Sensor names ----------

// Logger field names (AirTC_Avg, WS_ms_S_WVT, SlrW…) in plain English.
const SENSOR_WORDS = [
  [/^(air)?t(emp)?c?_?(avg|mean)?$|^airtc|^airtemp|^air_?temp|^t107|^t109|^hc2s3_?t|^ta(_|$)|^temp_?c|^temperature/i, "Air temperature"],
  [/^ptemp|panel.?t/i, "Logger temperature"],
  [/^batt|battery/i, "Logger battery"],
  [/^rh|humid/i, "Humidity"],
  [/dew.?p|^td(_|c|$)/i, "Dew point"],
  [/^ws.*max|wind.?sp.*max|gust/i, "Strongest gust"],
  [/^ws|wind.?sp|windspeed|^wspd/i, "Wind speed"],
  [/wind.?dir.*(sd|std)|^wd.*(sd|std)/i, "Wind direction spread"],
  [/wind.?dir|^wd/i, "Wind direction"],
  [/rain|precip|^ppt|^tb4|^tr525/i, "Rain"],
  [/^bp|baro|press|^mslp/i, "Air pressure"],
  [/^slr.?mj|solar.?en|^rad.?mj/i, "Solar energy"],
  [/^slr|solar|^sr0|^sw_?in|^rad/i, "Sunshine strength"],
  [/^par/i, "Light for plants (PAR)"],
  [/^uv/i, "UV"],
  [/^eto|^et_?o|evapo/i, "Evaporation (ETo)"],
  [/soil.?t|^tsoil/i, "Soil temperature"],
  [/vwc|soil.?m|moist/i, "Soil moisture"],
  [/leaf|^lw/i, "Leaf wetness"],
  [/snow/i, "Snow depth"],
  [/vis/i, "Visibility"],
  [/heat.?ind/i, "Heat index"],
  [/chill/i, "Wind chill"],
  [/water.?t|^tw/i, "Water temperature"],
  [/level|stage/i, "Water level"],
  [/signal|rssi/i, "Signal strength"],
];
const STAT_WORDS = [[/_?(avg|mean|wvt|_s_)/i, "average"], [/_?(max|tmx)/i, "highest"], [/_?(min|tmn)/i, "lowest"], [/_?(tot|sum)/i, "total"], [/_?(std|sd)/i, "spread"]];

function tableWords(t) {
  if (!t) return "";
  const m = /(\d+)\s*(m|min)?$/i.exec(t);
  if (/day|daily|24/i.test(t)) return "daily";
  if (/hour|60/i.test(t)) return "hourly";
  if (m && +m[1] > 0 && +m[1] < 60) return `every ${+m[1]} min`;
  return t.replace(/_/g, " ").toLowerCase();
}

function sensorName(r, all) {
  const f = r.field || "";
  const hit = SENSOR_WORDS.find(([re]) => re.test(f));
  let name = hit ? hit[1] : f.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  const stat = STAT_WORDS.find(([re]) => re.test(f.replace(/^[^_]+/, "")));
  // Leave out "average" on the common case; say it where it tells two sensors apart.
  const twins = (all || []).filter((x) => x !== r && SENSOR_WORDS.find(([re]) => re.test(x.field || "")) === hit && hit);
  const plain = (stat && stat[1] === "average" && (r.main || !twins.length)) || (stat && stat[1] === "total" && hit && hit[1] === "Rain" && r.main);
  if (stat && !plain && !(hit && /gust/i.test(hit[1]))) name += `, ${stat[1]}`;
  if (twins.some((x) => x.field === r.field && x.table !== r.table)) name += ` (${tableWords(r.table)})`;
  return name;
}

const UNIT_WORDS = { "deg c": "°C", degc: "°C", "°c": "°C", c: "°C", "deg f": "°F", "°f": "°F", "%": "%", volts: "V", v: "V", "w/m^2": "W/m²", "w/m2": "W/m²", "mj/m^2": "MJ/m²", "mj/m2": "MJ/m²", mbar: "hPa", hpa: "hPa", mm: "mm", degrees: "°", deg: "°", "m^3/m^3": "m³/m³", "umol/m^2/s": "µmol/m²/s", "meters/second": "m/s", "m/s": "m/s" };

// A reading in the user's units where the app knows the kind, otherwise as the logger reports it.
function sensorValue(r) {
  const v = r.value;
  if (v == null || !isFinite(v)) return "–";
  const u = (r.unit || "").trim();
  const std = homeStd(r, v);
  switch (r.kind) {
    case "temp": return fmt.temp(std);
    case "wind": case "gust": return `${fmt.windNum(std)} ${fmt.windUnit()}`;
    case "rain": return fmt.rain(std) || "0 mm";
    case "humidity": return Math.round(v) + "%";
    case "dir": return `${Math.round(v)}° ${compass(v)}`;
    case "pressure": return Math.round(std) + " hPa";
  }
  if (/^(deg\s*c|°c|degc|c)$/i.test(u)) return fmt.temp(v);
  const nice = UNIT_WORDS[u.toLowerCase()] ?? u;
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n.toLocaleString()}${nice ? (nice === "%" || nice === "°" || nice === "°C" ? "" : " ") + nice : ""}`;
}

// The same unit sums as the Worker: everything to °C, km/h, mm and hPa.
function homeStd(r, v) {
  const u = (r.unit || "").toLowerCase().replace(/\s+/g, "");
  if (r.kind === "temp") return /f$/.test(u) ? (v - 32) / 1.8 : v;
  if (r.kind === "wind" || r.kind === "gust") return /km\/h|kph/.test(u) ? v : /mph/.test(u) ? v * 1.609344 : /kn/.test(u) ? v * 1.852 : v * 3.6;
  if (r.kind === "rain") return /^in/.test(u) ? v * 25.4 : v;
  if (r.kind === "pressure") return /inhg/.test(u) ? v * 33.8639 : /kpa/.test(u) ? v * 10 : v;
  return v;
}

// ---------- Favourites ----------

const favKey = (r) => `${r.field}|${r.table || ""}`;
function homeFavs(readings) {
  const saved = store.get("wc.homeFav", null);
  if (saved) return saved;
  // Until you choose, pin the main wind, rain, humidity and pressure sensors.
  return ["wind", "rain", "humidity", "pressure"].map((k) => readings.find((r) => r.kind === k && r.main)).filter(Boolean).map(favKey);
}
function toggleFav(key, readings) {
  const favs = new Set(homeFavs(readings));
  favs.has(key) ? favs.delete(key) : favs.add(key);
  store.set("wc.homeFav", [...favs]);
}

// ---------- The card ----------

function homeTile(r, s, all) {
  const k = favKey(r);
  const open = `data-hist="${esc(r.id)}"`;
  if (r.kind === "wind" && r.main) {
    return `<button class="mc" ${open} data-fav="${esc(k)}"><small>Wind</small><b><span class="mw">${windArrow(s.dir, "")}${fmt.windNum(s.wind)}</span></b>
      <small>${fmt.windUnit()}${s.dir != null ? " from " + compass(s.dir) : ""}${s.gust != null ? ` · gusts ${fmt.windNum(s.gust)}` : ""}</small></button>`;
  }
  if (r.kind === "rain" && r.main) {
    const now = s.rain1h != null ? (s.rain1h > 0 ? fmt.rain(s.rain1h) : "Dry") : "–";
    return `<button class="mc" ${open} data-fav="${esc(k)}"><small>Rain, last hour</small><b>${now}</b>
      <small>${s.rain24h != null ? `${s.rain24h > 0 ? fmt.rain(s.rain24h) : "none"} in 24 h` : ""}</small></button>`;
  }
  return `<button class="mc" ${open} data-fav="${esc(k)}"><small>${esc(sensorName(r, all))}</small><b>${esc(sensorValue(r))}</b></button>`;
}

function homeCardHtml() {
  const net = homeNet();
  const s = homeHere();
  if (!s) {
    // Loading for the first time: a calm placeholder the same shape as the card.
    if (net.loading || (state.homeLoading && store.get("wc.home", {}).enabled)) {
      return `<section class="panel mine-card loading" aria-busy="true" aria-label="Loading your station">
        <div class="mine-head"><div><span class="tag">My station</span><span class="sk sk-name"></span><span class="sk sk-sub"></span></div><span class="sk sk-t"></span></div>
        <div class="mine-grid">${'<div class="mc"><span class="sk sk-l"></span><span class="sk sk-v"></span></div>'.repeat(4)}</div></section>`;
    }
    return "";
  }
  const all = s.readings || [];
  const favs = homeFavs(all);
  const tiles = favs.map((k) => all.find((r) => favKey(r) === k)).filter(Boolean).map((r) => homeTile(r, s, all)).join("");
  const sorted = [...all].sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || sensorName(a, all).localeCompare(sensorName(b, all)));
  const rows = sorted.map((r) => {
    const k = favKey(r), on = favs.includes(k);
    return `<li><button class="sname" data-hist="${esc(r.id)}">${esc(sensorName(r, all))}</button><span class="sval">${esc(sensorValue(r))}</span>
      <button class="star${on ? " on" : ""}" data-star="${esc(k)}" aria-pressed="${on}" aria-label="${on ? "Unpin from" : "Pin to"} the card">${STAR_ICON}</button></li>`;
  }).join("");
  const when = state.homeLoading || state.home.cached ? `<span class="upd">${state.homeLoading ? "Updating" : ago(s.time)}</span>` : ago(s.time);
  return `<section class="panel mine-card">
    <div class="mine-head"><div><span class="tag">My station</span><h2>${esc(s.name)}</h2><small>${s.dist >= 0.5 ? fmt.dist(s.dist) + " · " : ""}${when}</small></div>
      <button class="mine-t" data-hist="${esc((all.find((r) => r.kind === "temp" && r.main) || {}).id || "")}" aria-label="Temperature history">${s.temp != null ? fmt.temp(s.temp) : "–"}</button></div>
    ${tiles ? `<div class="mine-grid">${tiles}</div>` : `<p class="how">Star sensors below to pin them here.</p>`}
    ${s.hourly ? `<div class="gdetail">${rainTimeline(s.hourly)}</div>` : ""}
    <button class="hist-btn" data-hist="">${ICON_CAL}<span>History</span><small>any day or range</small>${CHEV}</button>
    <details class="mine-all"${state.homeAllOpen ? " open" : ""}><summary>All sensors <small>${all.length}</small></summary>
      <p class="how">Tap ☆ to pin a sensor to the card. Tap a name to see its history.</p><ul>${rows}</ul></details>
  </section>`;
}

const STAR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.2 2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z"/></svg>`;
const ICON_CAL = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const CHEV = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Wire up the card after it is drawn.
function homeCardWire(box) {
  const card = box.querySelector(".mine-card");
  if (!card) return;
  const all = (homeHere() || {}).readings || [];
  card.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => { toggleFav(b.dataset.star, all); render(); }));
  card.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = () => openHistory(b.dataset.hist)));
  const d = card.querySelector(".mine-all");
  if (d) d.ontoggle = () => (state.homeAllOpen = d.open);
}

// ---------- History explorer ----------

const DAY = 864e5;
const hx = { sensor: null, span: "day", anchor: null, from: null, to: null, data: null, loading: false, error: null, scrub: null, req: 0 };
const histCache = new Map();

function localMidnight(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

function histRange() {
  const a = localMidnight(hx.anchor);
  let from, to;
  if (hx.span === "day") { from = a; to = addDays(a, 1); }
  else if (hx.span === "week") { from = addDays(a, -6); to = addDays(a, 1); }
  else if (hx.span === "month") { const d = new Date(a); from = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); }
  else if (hx.span === "year") { from = addDays(a, -364); to = addDays(a, 1); }
  else { from = localMidnight(hx.from); to = addDays(localMidnight(hx.to), 1); }
  // Never ask for the future; round "now" to 5 minutes so repeat looks hit the cache.
  const now = Math.floor(Date.now() / 300e3) * 300e3;
  return { from, to: Math.min(to, now), end: to };
}

function histLabel() {
  const { from, end } = histRange();
  const d = (t, o) => new Date(t).toLocaleDateString("en-GB", o);
  const today = localMidnight(Date.now());
  if (hx.span === "day") {
    return from === today ? "Today" : from === addDays(today, -1) ? "Yesterday" : d(from, { weekday: "short", day: "numeric", month: "short", year: new Date(from).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
  }
  if (hx.span === "month") return d(from, { month: "long", year: "numeric" });
  const last = end - DAY;
  const sameYear = new Date(from).getFullYear() === new Date(last).getFullYear();
  return `${d(from, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" })} – ${d(last, { day: "numeric", month: "short", year: "numeric" })}`;
}

function openHistory(id) {
  const s = homeHere() || (state.home && state.home.station);
  if (!s) return;
  const all = s.readings || [];
  hx.sensor = all.find((r) => r.id === id) || all.find((r) => r.kind === "temp" && r.main) || all[0];
  if (!hx.sensor) return;
  if (hx.anchor == null) hx.anchor = Date.now();
  if (hx.from == null) { hx.to = Date.now(); hx.from = addDays(Date.now(), -6); }
  hx.scrub = null;
  const sheet = $("#histSheet");
  sheet.querySelector("h2").textContent = s.name;
  drawHistory();
  if (!sheet.open) sheet.showModal();
  fetchHistory();
}

async function fetchHistory() {
  const { from, to } = histRange();
  const id = hx.sensor.id;
  const key = `${id}/${from}/${to}`;
  const req = ++hx.req;
  hx.error = null;
  if (histCache.has(key)) { hx.data = histCache.get(key); hx.loading = false; drawHistory(); return; }
  hx.loading = true;
  drawHistory();
  try {
    const q = new URLSearchParams({ from, to, ids: id, offset: -new Date(from).getTimezoneOffset() });
    const body = await api(`/api/home/history?${q}`);
    const series = body.series && body.series[id];
    let data = series ? { ...series, from, to } : { buckets: [], from, to };
    if (hx.sensor.kind === "rain" && data.buckets.length) data = rainTotals(data);
    histCache.set(key, data);
    if (req !== hx.req) return;
    hx.data = data;
  } catch (err) {
    if (req !== hx.req) return;
    hx.error = err.message;
  }
  hx.loading = false;
  drawHistory();
}

// Numbers for the chart, in the user's units.
function histUnit(r) {
  switch (r.kind) {
    case "temp": return { f: (v) => (state.settings.temp === "F" ? v * 9 / 5 + 32 : v), u: "°", dp: 1 };
    case "wind": case "gust": return { f: (v) => ({ kmh: v, ms: v / 3.6, kn: v / 1.852, mph: v / 1.609 })[state.settings.wind] ?? v / 1.609, u: " " + fmt.windUnit(), dp: 0 };
    case "rain": return { f: (v) => (state.settings.rain === "in" ? v / 25.4 : v), u: state.settings.rain === "in" ? " in" : " mm", dp: state.settings.rain === "in" ? 2 : 1 };
    case "humidity": return { f: (v) => v, u: "%", dp: 0 };
    case "pressure": return { f: (v) => v, u: " hPa", dp: 0 };
    case "dir": return { f: (v) => v, u: "°", dp: 0 };
  }
  const u = (UNIT_WORDS[(r.unit || "").trim().toLowerCase()] ?? r.unit ?? "").trim();
  if (u === "°C") return histUnit({ kind: "temp" });
  return { f: (v) => v, u: u ? (u === "%" || u === "°" ? u : " " + u) : "", dp: 1 };
}

function drawHistory() {
  const sheet = $("#histSheet");
  const s = homeHere() || (state.home && state.home.station);
  if (!sheet || !s) return;
  const all = s.readings || [];
  const r = hx.sensor;
  const isRain = r.kind === "rain";
  const U = histUnit(r);
  const conv = U.f;
  const show = (v) => (v == null ? "–" : `${(Math.round(conv(v) * 10 ** U.dp) / 10 ** U.dp).toLocaleString()}${U.u}`);

  // Which sensor: the ones the app understands first, then everything else.
  const known = all.filter((x) => x.kind && x.main);
  const chips = known.map((x) => `<button class="hchip${x.id === r.id ? " on" : ""}" data-s="${esc(x.id)}">${esc(sensorName(x, all))}</button>`).join("");
  const others = all.filter((x) => !known.includes(x)).sort((a, b) => sensorName(a, all).localeCompare(sensorName(b, all)));
  const more = others.length ? `<select class="hmore${known.includes(r) ? "" : " on"}" aria-label="Other sensors"><option value="">${known.includes(r) ? "More…" : esc(sensorName(r, all))}</option>${others.map((x) => `<option value="${esc(x.id)}"${x.id === r.id ? " selected" : ""}>${esc(sensorName(x, all))}</option>`).join("")}</select>` : "";

  const spans = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["custom", "Custom"]];
  const seg = spans.map(([v, l]) => `<button data-span="${v}" aria-pressed="${hx.span === v}">${l}</button>`).join("");
  const { end } = histRange();
  const atEnd = end > Date.now();
  const nav = hx.span === "custom"
    ? `<div class="hcustom"><label>From<input type="date" id="hFrom" value="${isoDay(hx.from)}" max="${isoDay(Date.now())}"></label><label>To<input type="date" id="hTo" value="${isoDay(hx.to)}" max="${isoDay(Date.now())}"></label></div>`
    : `<div class="hnav"><button data-step="-1" aria-label="Earlier">${CHEV}</button>
        <label class="hlabel"><span>${esc(histLabel())}</span><input type="date" id="hPick" value="${isoDay(hx.anchor)}" max="${isoDay(Date.now())}" aria-label="Pick a date"></label>
        <button data-step="1" aria-label="Later"${atEnd ? " disabled" : ""}>${CHEV}</button></div>`;

  const b = (hx.data && !hx.loading && hx.data.buckets) || [];
  let chart, stats = "";
  if (hx.loading) chart = `<div class="hchart sk-chart" aria-busy="true"><span class="sk"></span></div>`;
  else if (hx.error) chart = `<div class="hchart hmsg">${esc(hx.error)}</div>`;
  else if (!b.length) chart = `<div class="hchart hmsg">No readings in this range.</div>`;
  else {
    chart = histChart(b, hx.data, isRain, conv, U, r);
    stats = histStats(b, isRain, show, hx.data.step);
  }
  hxShow = { show, isRain };
  const readout = `<div class="hread idle"><span>${b.length ? "Touch the chart to read a value" : "&nbsp;"}</span></div>`;

  sheet.querySelector(".hbody").innerHTML = `
    <div class="hchips">${chips}${more}</div>
    <div class="hseg" role="group" aria-label="Range">${seg}</div>
    ${nav}
    ${readout}
    ${chart}
    ${stats}`;

  // Wiring.
  const body = sheet.querySelector(".hbody");
  body.querySelectorAll("[data-s]").forEach((x) => (x.onclick = () => pickSensor(x.dataset.s)));
  const sel = body.querySelector(".hmore");
  if (sel) sel.onchange = () => sel.value && pickSensor(sel.value);
  body.querySelectorAll("[data-span]").forEach((x) => (x.onclick = () => { hx.span = x.dataset.span; if (hx.span !== "custom") hx.anchor = Math.min(hx.anchor, Date.now()); hx.scrub = null; fetchHistory(); }));
  body.querySelectorAll("[data-step]").forEach((x) => (x.onclick = () => stepRange(Number(x.dataset.step))));
  const pick = body.querySelector("#hPick");
  if (pick) {
    pick.onchange = () => { if (pick.value) { hx.anchor = parseDay(pick.value); hx.scrub = null; fetchHistory(); } };
    body.querySelector(".hlabel span").onclick = () => { try { pick.showPicker(); } catch { pick.focus(); } };
  }
  const f = body.querySelector("#hFrom"), t = body.querySelector("#hTo");
  if (f && t) {
    const go = () => {
      let a = parseDay(f.value), z = parseDay(t.value);
      if (!isFinite(a) || !isFinite(z)) return;
      if (a > z) [a, z] = [z, a];
      if (z - a > 365 * DAY) a = addDays(z, -365);
      hx.from = a; hx.to = z; hx.scrub = null; fetchHistory();
    };
    f.onchange = go; t.onchange = go;
  }
  const svg = body.querySelector("svg.hsvg");
  if (svg) { wireScrub(svg); drawScrub(svg); }
}

let hxGeo = null, hxShow = null;
// The touched value: a line on the chart and the reading above it, without redrawing the chart.
function drawScrub(svg) {
  const b = (hx.data && hx.data.buckets) || [];
  const sc = hx.scrub != null && b[hx.scrub];
  const g = svg.querySelector(".scrubg");
  const read = svg.closest(".hbody").querySelector(".hread");
  if (!sc || !hxGeo) { if (g) g.innerHTML = ""; return; }
  const { show, isRain } = hxShow;
  const { x, y, conv, step, bw } = hxGeo;
  const cx = isRain ? x(sc.t) + bw / 2 : x(sc.t + step / 2);
  g.innerHTML = `<line class="hscrub" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${hxGeo.top}" y2="${hxGeo.top + hxGeo.H}"/>` +
    (isRain ? "" : `<circle class="hsdot" cx="${cx.toFixed(1)}" cy="${y(conv(sc.avg)).toFixed(1)}" r="4"/>`);
  read.className = "hread";
  read.innerHTML = `<b>${show(isRain ? sc.sum : sc.avg)}</b><span>${esc(whenLabel(sc.t, hx.data.step))}${!isRain && sc.n > 1 && sc.max !== sc.min ? ` · ${show(sc.min)} to ${show(sc.max)}` : ""}</span>`;
}

// Rain reads best as totals people think in: per hour for a day, per day for a week or a
// month, per week for longer.
function rainTotals(data) {
  const span = data.to - data.from;
  const step = span <= 1.5 * DAY ? 3600e3 : span <= 62 * DAY ? DAY : 7 * DAY;
  if ((data.step || 0) >= step) return data;
  const key = (t) => step === 3600e3 ? Math.floor(t / 3600e3) * 3600e3
    : step === DAY ? localMidnight(t)
    : addDays(localMidnight(data.from), Math.floor((localMidnight(t) - localMidnight(data.from)) / (7 * DAY) + 0.01) * 7);
  const m = new Map();
  for (const b of data.buckets) {
    const k = key(b.t);
    const g = m.get(k) || { t: k, sum: 0, n: 0, min: Infinity, max: -Infinity };
    g.sum += b.sum; g.n += b.n; g.min = Math.min(g.min, b.min); g.max = Math.max(g.max, b.max);
    m.set(k, g);
  }
  const buckets = [...m.values()].sort((a, b) => a.t - b.t).map((g) => ({ ...g, avg: g.sum / g.n }));
  return { ...data, step, buckets };
}

function pickSensor(id) {
  const s = homeHere() || state.home.station;
  hx.sensor = (s.readings || []).find((x) => x.id === id) || hx.sensor;
  hx.scrub = null;
  fetchHistory();
}

function stepRange(dir) {
  const n = { day: 1, week: 7, year: 365 }[hx.span];
  if (hx.span === "month") { const d = new Date(hx.anchor); d.setDate(1); d.setMonth(d.getMonth() + dir); hx.anchor = d.getTime(); }
  else hx.anchor = addDays(hx.anchor, dir * n);
  hx.anchor = Math.min(hx.anchor, Date.now());
  hx.scrub = null;
  fetchHistory();
}

function isoDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parseDay(v) { const [y, m, d] = String(v).split("-").map(Number); return new Date(y, m - 1, d).getTime(); }

function whenLabel(t, step) {
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  if (step >= 7 * DAY) return `Week of ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  if (step >= DAY) return day;
  const hm = (x) => new Date(x).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return step >= 3600e3 ? `${day}, ${hm(t)}–${hm(t + step)}` : `${day}, ${hm(t)}`;
}

function histChart(b, data, isRain, conv, U, r) {
  const W = 340, H = 150, top = 8, left = 34, bottom = 22, iw = W - left - 4;
  const from = data.from, to = Math.max(data.to, from + 1);
  const span = to - from;
  const x = (t) => left + ((t - from) / span) * iw;
  const vals = isRain ? b.map((p) => conv(p.sum)) : b.flatMap((p) => [conv(p.min), conv(p.max)]);
  let lo = isRain ? 0 : Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= isRain ? 0 : 1; }
  const pad = (hi - lo) * 0.08;
  if (!isRain) lo -= pad;
  hi += pad;
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * H;
  // Three tidy gridlines.
  const ticks = niceTicks(lo, hi, 3);
  let g = ticks.map((v) => `<line class="grid" x1="${left}" x2="${W - 4}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="yl" x="${left - 6}" y="${(y(v) + 3.5).toFixed(1)}">${fmtTick(v)}</text>`).join("");
  // Time labels.
  const step = data.step || 3600e3;
  const xt = timeTicks(from, to);
  g += xt.map((t) => `<text class="xl" x="${x(t.t).toFixed(1)}" y="${top + H + 16}">${esc(t.label)}</text>`).join("");
  if (isRain) {
    const bw = Math.max(1, (step / span) * iw - 1.5);
    g += b.map((p) => {
      const v = conv(p.sum);
      if (v <= 0) return "";
      const h = Math.max(1.5, y(lo) - y(v));
      return `<rect class="rb" x="${x(p.t).toFixed(1)}" y="${(y(lo) - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2).toFixed(1)}"/>`;
    }).join("");
  } else {
    // Gaps in the data break the line rather than joining across them.
    const runs = [];
    let run = [];
    b.forEach((p, i) => { if (i && p.t - b[i - 1].t > step * 2.5) { runs.push(run); run = []; } run.push(p); });
    runs.push(run);
    const mid = (p) => p.t + step / 2;
    for (const rr of runs) {
      if (rr.some((p) => p.max !== p.min)) {
        const up = rr.map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.max)).toFixed(1)}`);
        const dn = rr.slice().reverse().map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.min)).toFixed(1)}`);
        g += `<polygon class="band k-${r.kind || "x"}" points="${up.concat(dn).join(" ")}"/>`;
      }
      g += rr.length > 1
        ? `<polyline class="ln k-${r.kind || "x"}" points="${rr.map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.avg)).toFixed(1)}`).join(" ")}"/>`
        : `<circle class="dot k-${r.kind || "x"}" cx="${x(mid(rr[0])).toFixed(1)}" cy="${y(conv(rr[0].avg)).toFixed(1)}" r="2.5"/>`;
    }
  }
  hxGeo = { x, y, conv, step, top, H, bw: Math.max(1, (step / span) * iw - 1.5) };
  g += `<g class="scrubg"></g>`;
  return `<svg class="hsvg chart" viewBox="0 0 ${W} ${top + H + bottom}" data-left="${left}" data-iw="${iw}" data-from="${from}" data-span="${span}" role="img" aria-label="${esc(sensorName(r))} chart">${g}</svg>`;
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
function fmtTick(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 10) / 10); }

function timeTicks(from, to) {
  const span = to - from;
  const out = [];
  if (span <= 1.5 * DAY) {
    const every = span <= 0.5 * DAY ? 3 : 6;
    for (let t = Math.ceil(from / 3600e3) * 3600e3; t < to; t += 3600e3) {
      const h = new Date(t).getHours();
      if (h % every === 0) out.push({ t, label: `${String(h).padStart(2, "0")}:00` });
    }
  } else if (span <= 10 * DAY) {
    for (let t = localMidnight(from); t < to; t = addDays(t, 1)) if (t >= from) out.push({ t, label: new Date(t).toLocaleDateString("en-GB", { weekday: "short" }) });
  } else if (span <= 45 * DAY) {
    for (let t = localMidnight(from); t < to; t = addDays(t, 1)) {
      const d = new Date(t);
      if (t >= from && (d.getDate() === 1 || d.getDate() % 7 === 1)) out.push({ t, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) });
    }
  } else {
    const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
    const every = span > 200 * DAY ? 2 : 1;
    for (let i = 0; d.getTime() < to; i++, d.setMonth(d.getMonth() + 1)) {
      if (d.getTime() >= from && i % every === 0) out.push({ t: d.getTime(), label: d.toLocaleDateString("en-GB", { month: "short" }) });
    }
  }
  return out;
}

function histStats(b, isRain, show, step) {
  const tile = (l, v, sub) => `<div class="mc"><small>${l}</small><b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  if (isRain) {
    const total = b.reduce((a, p) => a + p.sum, 0);
    const wet = b.filter((p) => p.sum >= 0.2);
    const top = b.reduce((m, p) => (p.sum > m.sum ? p : m), b[0]);
    const unit = step >= 7 * DAY ? "weeks" : step >= DAY ? "days" : step === 3600e3 ? "hours" : "periods";
    const one = { weeks: "week", days: "day", hours: "hour" }[unit] || "spell";
    return `<div class="mine-grid hstats">${tile("Total", show(total))}${tile(`Wettest ${one}`, top.sum > 0 ? show(top.sum) : "–", top.sum > 0 ? whenLabel(top.t, step) : "")}${tile(`Wet ${unit}`, `${wet.length}`, `of ${b.length}`)}</div>`;
  }
  const hi = b.reduce((m, p) => (p.max > m.max ? p : m), b[0]);
  const lo = b.reduce((m, p) => (p.min < m.min ? p : m), b[0]);
  const n = b.reduce((a, p) => a + p.n, 0);
  const avg = b.reduce((a, p) => a + p.avg * p.n, 0) / n;
  return `<div class="mine-grid hstats three">${tile("Highest", show(hi.max), whenLabel(hi.t, step))}${tile("Lowest", show(lo.min), whenLabel(lo.t, step))}${tile("Average", show(avg))}</div>`;
}

function wireScrub(svg) {
  const pick = (e) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const px = ((e.clientX - r.left) / r.width) * vb.width;
    const left = +svg.dataset.left, iw = +svg.dataset.iw, from = +svg.dataset.from, span = +svg.dataset.span;
    const t = from + ((px - left) / iw) * span;
    const b = hx.data.buckets;
    let best = 0, d = Infinity;
    b.forEach((p, i) => { const dd = Math.abs(p.t + (hx.data.step || 0) / 2 - t); if (dd < d) { d = dd; best = i; } });
    if (best !== hx.scrub) { hx.scrub = best; drawScrub(svg); }
  };
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); pick(e); });
  svg.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "mouse") pick(e); });
}
