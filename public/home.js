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

async function loadHome(extra = "") {
  if (!state.place) return;
  state.homeLoading = true;
  syncStations();
  render();
  try {
    const body = await api(`/api/home?lat=${state.place.lat}&lon=${state.place.lon}${extra}`);
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
    watchSends();
  }
}

// When the station's next batch is due, fetch it (a couple of minutes after, then once more ten
// minutes later if it was late), and keep the "next in … min" note ticking in between.
let sendTimer = 0, sendTick = 0, sendTries = 0, sendSeen = null;
function watchSends() {
  clearTimeout(sendTimer);
  const s = state.home && state.home.station;
  if (!s || !s.every) return;
  if (s.sent !== sendSeen) { sendSeen = s.sent; sendTries = 0; }
  const due = Date.parse(s.sent) + s.every + 2 * 60e3 + sendTries * 10 * 60e3;
  if (sendTries < 2) {
    sendTimer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      sendTries++;
      loadHome("&fresh=1");
    }, Math.max(30e3, due - Date.now()));
  }
  if (!sendTick) sendTick = setInterval(() => {
    const el = document.querySelector(".mine-card .sent");
    const h = homeHere();
    if (el && h) el.textContent = sendNote(h);
  }, 30e3);
}
document.addEventListener("visibilitychange", () => {
  // Back in the app after the batch was due: fetch it now.
  const s = state.home && state.home.station;
  if (document.visibilityState === "visible" && s && s.every && Date.now() > Date.parse(s.sent) + s.every + 2 * 60e3 && !state.homeLoading && sendTries < 2) { sendTries++; loadHome("&fresh=1"); }
});

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
  const m = /(\d+)\s*_?(m|mins?|minutes?)?$/i.exec(t);
  if (/day|daily|24/i.test(t)) return "daily";
  if (/hour|60/i.test(t)) return "hourly";
  if (m && +m[1] > 0 && +m[1] < 60) return `every ${+m[1]} min`;
  return t.replace(/_/g, " ").toLowerCase();
}

// Campbell soil probes (CS650/CS655) log water content, saltiness and their own temperature
// under short names: T_Avg there is the soil, not the air.
const SOIL_WORDS = [
  [/^t(_|$)/i, "Soil temperature"],
  [/^ec(_|$)/i, "Soil saltiness (conductivity)"],
  [/^p(_|$)/i, "Soil permittivity"],
  [/^pa(_|$)/i, "Soil probe signal time"],
  [/^vr(_|$)/i, "Soil probe signal ratio"],
];
const EXTRA_WORDS = [
  [/diag/i, "Wind sensor health"],
  [/^record$/i, "Record number"],
];
const hasSoilProbe = (all) => (all || []).some((x) => /vwc/i.test(x.field || ""));
function sensorWords(f, all) {
  const soil = hasSoilProbe(all) && SOIL_WORDS.find(([re]) => re.test(f));
  return soil || EXTRA_WORDS.find(([re]) => re.test(f)) || SENSOR_WORDS.find(([re]) => re.test(f));
}

function sensorName(r, all) {
  const f = r.field || "";
  const name = sensorBase(r, all);
  // Two different sensors that still read the same: name the logger field so they can't be mixed up.
  const same = (all || []).some((x) => x !== r && x.field !== f && x.table === r.table && sensorBase(x, all) === name);
  return same ? `${name} · ${f}` : name;
}

function sensorBase(r, all) {
  const f = r.field || "";
  const hit = sensorWords(f, all);
  let name = hit ? hit[1] : f.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  const stat = STAT_WORDS.find(([re]) => re.test(f.replace(/^[^_]+/, "")));
  // Leave out "average" on the common case; say it where it tells two sensors apart.
  const twins = (all || []).filter((x) => x !== r && hit && sensorWords(x.field || "", all) === hit);
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
  if (/^m\^?3\/m\^?3$/i.test(u)) return `${Math.round(v * 1000) / 10}%`;
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

// Each tile carries a small picture of what it measures: a compass for wind, a filling drop
// for rain, a ring for humidity and soil moisture, a dial for pressure, a sun for UV and a
// warmth bar for temperatures.
function tileLook(r, all) {
  const name = sensorName(r, all);
  if (r.kind === "temp" || /temperature/i.test(name) && !/logger/i.test(name)) return "temp";
  if (r.kind === "wind" || r.kind === "gust" || r.kind === "dir") return "wind";
  if (r.kind === "rain") return "rain";
  if (r.kind === "humidity") return "humid";
  if (r.kind === "pressure") return "press";
  if (/soil moisture/i.test(name)) return "soil";
  if (/^uv/i.test(name)) return "uv";
  return "";
}
const clampTo = (v, a, b) => Math.max(a, Math.min(b, v));
function ringViz(f, cls) {
  const C = 2 * Math.PI * 15, on = clampTo(f, 0, 1) * C;
  return `<svg class="viz ${cls}" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="15"/>
    <circle class="val" cx="20" cy="20" r="15" stroke-dasharray="${on.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 20 20)"/>
    <path class="ico" d="M20 13.5c2.6 3.3 4 5.5 4 7.3a4 4 0 0 1-8 0c0-1.8 1.4-4 4-7.3z"/></svg>`;
}
function windViz(dir, kmh) {
  // The needle points the way the wind is blowing, and grows with its strength.
  const len = 6 + clampTo((kmh || 0) / 50, 0, 1) * 8, rot = dir == null ? 0 : (dir + 180) % 360;
  const ticks = [0, 90, 180, 270].map((a) => `<path class="tk" d="M20 4.5v3" transform="rotate(${a} 20 20)"/>`).join("");
  return `<svg class="viz v-wind" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="16"/>${ticks}
    <text x="20" y="13.2" class="n">N</text>
    ${dir == null ? "" : `<g transform="rotate(${rot} 20 20)"><path class="val-f" d="M20 ${20 - len} 24.6 ${22 + len * 0.2} 20 ${20 + len * 0.12} 15.4 ${22 + len * 0.2}z"/></g>`}
    <circle class="hub" cx="20" cy="20" r="1.6"/></svg>`;
}
function rainViz(id, mm) {
  // The drop fills with the day's rain: full at 20 mm.
  const f = clampTo((mm || 0) / 20, 0, 1), y = 36 - 30 * f;
  const drop = "M20 5c6 7.5 10 13 10 18.2a10 10 0 0 1-20 0C10 18 14 12.5 20 5z";
  const cid = "rv" + String(id).replace(/[^\w]/g, "");
  return `<svg class="viz v-rain" viewBox="0 0 40 40" aria-hidden="true"><defs><clipPath id="${cid}"><path d="${drop}"/></clipPath></defs>
    <path class="trk-f" d="${drop}"/>${f > 0 ? `<rect class="val-f" x="8" y="${y.toFixed(1)}" width="24" height="${(36 - y).toFixed(1)}" clip-path="url(#${cid})"/>` : ""}
    <path class="edge" d="${drop}"/></svg>`;
}
function pressViz(hpa) {
  // A barometer dial from 970 (stormy) to 1040 hPa (settled).
  const f = clampTo(((hpa || 1010) - 970) / 70, 0, 1), a = Math.PI * (1 - f);
  const x = 20 + 12 * Math.cos(a), y = 26 - 12 * Math.sin(a);
  return `<svg class="viz v-press" viewBox="0 0 40 40" aria-hidden="true"><path class="trk" d="M5 26a15 15 0 0 1 30 0"/>
    <path class="val" d="M5 26a15 15 0 0 1 ${(15 - 15 * Math.cos(a)).toFixed(1)} ${(-15 * Math.sin(a)).toFixed(1)}"/>
    <path class="needle" d="M20 26L${x.toFixed(1)} ${y.toFixed(1)}"/><circle class="hub" cx="20" cy="26" r="2"/>
    <text x="5" y="35" class="n">L</text><text x="35" y="35" class="n">H</text></svg>`;
}
function uvViz(uv) {
  const n = clampTo(Math.round((uv || 0) * 1.2) + 4, 4, 12);
  const rays = Array.from({ length: n }, (_, i) => `<path d="M20 5.5v4" transform="rotate(${(360 / n) * i} 20 20)"/>`).join("");
  return `<svg class="viz v-uv" viewBox="0 0 40 40" aria-hidden="true"><g class="rays">${rays}</g><circle class="val-f" cx="20" cy="20" r="${(6 + clampTo(uv || 0, 0, 10) * 0.25).toFixed(1)}"/></svg>`;
}
function tempBar(c) {
  // Where today sits from bitter (−10°) to hot (30°), on the same colours as the charts.
  const f = clampTo(((c ?? 10) + 10) / 40, 0, 1);
  const stops = WARMTH.map(([t, col]) => `${col} ${(((t + 10) / 40) * 100).toFixed(0)}%`).join(",");
  return `<span class="tbar" style="--g:linear-gradient(90deg,${stops});--x:${(f * 100).toFixed(1)}%;--c:${mix(c ?? 10)}"><i></i></span>`;
}

function homeTile(r, s, all) {
  const k = favKey(r);
  const open = `data-hist="${esc(r.id)}"`;
  const look = tileLook(r, all);
  const std = r.value != null ? homeStd(r, r.value) : null;
  const tile = (label, value, sub, viz) => `<button class="mc look-${look || "x"}" ${open} data-fav="${esc(k)}">${viz || ""}<small>${label}</small><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}${look === "temp" ? tempBar(std) : ""}</button>`;
  if (r.kind === "wind" && r.main) {
    return tile("Wind", `${fmt.windNum(s.wind)} <small class="u">${fmt.windUnit()}</small>`,
      `${s.dir != null ? "from " + compass(s.dir) : ""}${s.gust != null ? ` · gusts ${fmt.windNum(s.gust)}` : ""}`, windViz(s.dir, s.wind));
  }
  if (r.kind === "rain" && r.main) {
    const now = s.rain1h != null ? (s.rain1h > 0 ? fmt.rain(s.rain1h) : "Dry") : "–";
    return tile("Rain, last hour", now, s.rain24h != null ? `${s.rain24h > 0 ? fmt.rain(s.rain24h) : "none"} in 24 h` : "", rainViz(r.id, s.rain24h));
  }
  const viz = look === "wind" ? windViz(r.kind === "dir" ? r.value : s.dir, r.kind === "dir" ? s.wind : std)
    : look === "rain" ? rainViz(r.id, std)
    : look === "humid" ? ringViz((r.value || 0) / 100, "v-humid")
    : look === "soil" ? ringViz(/m\^?3/i.test(r.unit || "") ? (r.value || 0) / 0.5 : (r.value || 0) / 50, "v-soil")
    : look === "press" ? pressViz(std)
    : look === "uv" ? uvViz(r.value)
    : "";
  return tile(esc(sensorName(r, all)), esc(sensorValue(r)), "", viz);
}

// The station records every few minutes but sends its data in batches (often hourly), so say
// when the last batch came in and when the next is due, rather than just "44 min ago".
function sendNote(s, now = Date.now()) {
  const last = Date.parse(s.sent || s.time);
  if (!isFinite(last)) return ago(s.time);
  const hm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const lastWords = `Sent ${hm(last)}`;
  if (!s.every) return `${lastWords} · ${ago(new Date(last).toISOString())}`;
  let next = last + s.every;
  if (now > next + Math.max(15 * 60e3, s.every * 0.5)) return `${lastWords} · next batch is late`;
  if (now > next) return `${lastWords} · next batch due now`;
  const mins = Math.round((next - now) / 60e3);
  return `${lastWords} · next ${mins <= 1 ? "any minute" : mins < 60 ? `in ${mins} min` : `about ${hm(next)}`}`;
}

let homeCardEntered = false;
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
  const sensors = all.filter((r) => !isHealth(r));
  const sorted = [...sensors].sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || sensorName(a, all).localeCompare(sensorName(b, all)));
  const rows = sorted.map((r) => {
    const k = favKey(r), on = favs.includes(k);
    return `<li><button class="sname" data-hist="${esc(r.id)}">${esc(sensorName(r, all))}</button><span class="sval">${esc(sensorValue(r))}</span>
      <button class="star${on ? " on" : ""}" data-star="${esc(k)}" aria-pressed="${on}" aria-label="${on ? "Unpin from" : "Pin to"} the card">${STAR_ICON}</button></li>`;
  }).join("");
  const sent = `<span class="sent">${sendNote(s)}</span>`;
  const when = state.homeLoading || state.home.cached ? `<span class="upd">${state.homeLoading ? "Updating" : sent}</span>` : sent;
  const enter = homeCardEntered ? "" : " enter";
  homeCardEntered = true;
  return `<section class="panel mine-card${enter}">
    <div class="mine-head"><div><div class="mine-tagrow"><span class="tag">My station</span>${healthPill(s)}</div><h2>${esc(s.name)}</h2><small>${s.dist >= 0.5 ? fmt.dist(s.dist) + " · " : ""}${when}</small></div>
      <button class="mine-t" data-hist="${esc((all.find((r) => r.kind === "temp" && r.main) || {}).id || "")}" aria-label="Temperature history">${s.temp != null ? fmt.temp(s.temp) : "–"}</button></div>
    ${tiles ? `<div class="mine-grid">${tiles}</div>` : `<p class="how">Star sensors below to pin them here.</p>`}
    ${s.hourly ? `<div class="gdetail">${rainTimeline(s.hourly)}</div>` : ""}
    <button class="hist-btn" data-hist="">${ICON_CAL}<span>History</span><small>any day or range</small>${CHEV}</button>
    <details class="mine-all"${state.homeAllOpen ? " open" : ""}><summary><span>All sensors <small>${sensors.length}</small></span><span class="sw"><span class="sw-show">Show</span><span class="sw-hide">Hide</span>${CHEV}</span></summary>
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
  card.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => { toggleFav(b.dataset.star, all); redrawHomeCard(box, `[data-star="${CSS.escape(b.dataset.star)}"]`); }));
  card.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = () => openHistory(b.dataset.hist)));
  const hb = card.querySelector("[data-health]");
  if (hb) hb.onclick = () => openHealth();
  const d = card.querySelector(".mine-all");
  if (d) d.ontoggle = () => (state.homeAllOpen = d.open);
}

// Redraw just the card, keeping whatever was tapped in the same place on screen: pinning a
// sensor adds a tile above the list, and the page shouldn't jump because of it.
function redrawHomeCard(box, anchorSel) {
  const card = box.querySelector(".mine-card");
  if (!card) return;
  const before = box.querySelector(anchorSel);
  const y0 = before ? before.getBoundingClientRect().top : 0;
  const t = document.createElement("template");
  t.innerHTML = homeCardHtml().trim();
  const next = t.content.firstElementChild;
  if (!next) return;
  card.replaceWith(next);
  homeCardWire(box);
  const after = box.querySelector(anchorSel);
  if (before && after) {
    const dy = after.getBoundingClientRect().top - y0;
    if (Math.abs(dy) > 0.5) window.scrollBy({ top: dy, behavior: "instant" });
  }
}

// ---------- History explorer ----------
// Pick up to four sensors; each gets the chart that suits it: a compass for wind, bars for
// rain, a line coloured by warmth for temperature, a filled curve for sunshine, and a plain
// line for the rest. Line charts share one time axis and are read together with one touch.

const DAY = 864e5;
const MAX_PICK = 4;
const hx = { ids: [], span: "day", anchor: null, from: null, to: null, data: null, loading: false, error: null, scrub: null, picking: false, rose: {}, req: 0 };
const histCache = new Map();

function localMidnight(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function isoDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parseDay(v) { const [y, m, d] = String(v).split("-").map(Number); return new Date(y, m - 1, d).getTime(); }
function fmtTick(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(Math.round(v * 10) / 10); }

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

function stepRange(dir) {
  const n = { day: 1, week: 7, year: 365 }[hx.span];
  if (hx.span === "month") { const d = new Date(hx.anchor); d.setDate(1); d.setMonth(d.getMonth() + dir); hx.anchor = d.getTime(); }
  else hx.anchor = addDays(hx.anchor, dir * n);
  hx.anchor = Math.min(hx.anchor, Date.now());
  hx.scrub = null;
  fetchHistory();
}

function whenLabel(t, step) {
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  if (step >= 7 * DAY) return `Week of ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  if (step >= DAY) return day;
  const hm = (x) => new Date(x).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return step >= 3600e3 ? `${day}, ${hm(t)}–${hm(t + step)}` : `${day}, ${hm(t)}`;
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

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



function homeReadings() {
  const s = homeHere() || (state.home && state.home.station);
  return (s && s.readings) || [];
}

// Favourites first (in the order you pinned them), then the main sensors, then the rest.
function orderedSensors(all) {
  const favs = homeFavs(all);
  const fav = favs.map((k) => all.find((r) => favKey(r) === k)).filter(Boolean);
  const main = all.filter((r) => !fav.includes(r) && r.kind && r.main);
  const rest = all.filter((r) => !fav.includes(r) && !main.includes(r)).sort((a, b) => sensorName(a, all).localeCompare(sensorName(b, all)));
  return { fav, others: [...main, ...rest] };
}

const isWind = (r) => r && (r.kind === "wind" || r.kind === "gust" || r.kind === "dir");
const mainOf = (all, kind) => all.find((r) => r.kind === kind && r.main);

// Wind charts need the direction and the speed together, so fetch both even if only one is picked.
function idsToFetch(all) {
  const ids = new Set(hx.ids);
  if (hx.ids.some((id) => isWind(all.find((r) => r.id === id)))) {
    for (const k of ["dir", "wind", "gust"]) { const m = mainOf(all, k); if (m) ids.add(m.id); }
  }
  return [...ids];
}

function openHistory(id) {
  const s = homeHere() || (state.home && state.home.station);
  if (!s) return;
  const all = s.readings || [];
  if (!all.length) return;
  if (id && all.some((r) => r.id === id)) hx.ids = [id];
  else if (!hx.ids.length || !hx.ids.every((x) => all.some((r) => r.id === x))) {
    const first = orderedSensors(all).fav[0] || mainOf(all, "temp") || all[0];
    hx.ids = [first.id];
  }
  if (hx.anchor == null) hx.anchor = Date.now();
  if (hx.from == null) { hx.to = Date.now(); hx.from = addDays(Date.now(), -6); }
  hx.scrub = null;
  hx.picking = false;
  const sheet = $("#histSheet");
  sheet.querySelector("h2").textContent = s.name;
  drawHistory();
  if (!sheet.open) sheet.showModal();
  fetchHistory();
}

async function fetchHistory() {
  const { from, to } = histRange();
  const all = homeReadings();
  const ids = idsToFetch(all);
  const req = ++hx.req;
  hx.error = null;
  hx.scrub = null;
  // Reuse whatever is already fetched for this range; only ask for the rest.
  const have = {}, need = [];
  for (const id of ids) {
    const c = histCache.get(`${id}/${from}/${to}`);
    if (c) have[id] = c; else need.push(id);
  }
  if (!need.length) { hx.data = have; hx.loading = false; drawHistory(); return; }
  hx.loading = true;
  drawHistory();
  try {
    const q = new URLSearchParams({ from, to, ids: need.join(","), offset: -new Date(from).getTimezoneOffset() });
    const body = await api(`/api/home/history?${q}`);
    for (const id of need) {
      const r = all.find((x) => x.id === id);
      const sr = body.series && body.series[id];
      let d = sr ? { ...sr, from, to } : { buckets: [], from, to };
      if (r && r.kind === "rain" && d.buckets.length) d = rainTotals(d);
      histCache.set(`${id}/${from}/${to}`, d);
      have[id] = d;
    }
    if (req !== hx.req) return;
    hx.data = have;
    hx.fresh = true;
  } catch (err) {
    if (req !== hx.req) return;
    hx.error = err.message;
  }
  hx.loading = false;
  drawHistory();
}

function drawHistory() {
  const sheet = $("#histSheet");
  const all = homeReadings();
  if (!sheet || !all.length) return;
  const picked = hx.ids.map((id) => all.find((r) => r.id === id)).filter(Boolean);

  // What to show: the picked sensors as pills, and a tidy list to add or remove more.
  const pills = picked.map((r) => `<span class="hpill k-${r.kind || "x"}" data-id="${esc(r.id)}"><i></i>${esc(sensorName(r, all))}${picked.length > 1 ? `<button data-drop="${esc(r.id)}" aria-label="Remove ${esc(sensorName(r, all))}">${ICON_X}</button>` : ""}</span>`).join("");
  const add = `<button class="hpill add${hx.picking ? " on" : ""}" data-pick aria-expanded="${hx.picking}">${hx.picking ? "Done" : `${ICON_PLUS}Add`}</button>`;
  let picker = "";
  if (hx.picking) {
    const { fav, others } = orderedSensors(all);
    const full = picked.length >= MAX_PICK;
    const row = (r) => {
      const on = hx.ids.includes(r.id);
      return `<button class="prow${on ? " on" : ""}" data-toggle="${esc(r.id)}" ${!on && full ? "disabled" : ""} role="checkbox" aria-checked="${on}">
        <span class="tick">${ICON_TICK}</span><span class="pn">${esc(sensorName(r, all))}</span><span class="pv">${esc(sensorValue(r))}</span></button>`;
    };
    picker = `<div class="hpicker">
      <p class="how">Show up to ${MAX_PICK} at once.${full ? " Remove one to add another." : ""}</p>
      ${fav.length ? `<h4>${STAR_ICON}Favourites</h4>${fav.map(row).join("")}` : ""}
      <h4>${fav.length ? "Everything else" : "Sensors"}</h4>${others.map(row).join("")}
    </div>`;
  }

  const spans = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["custom", "Custom"]];
  const seg = spans.map(([v, l]) => `<button data-span="${v}" aria-pressed="${hx.span === v}">${l}</button>`).join("");
  const { end } = histRange();
  const atEnd = end > Date.now();
  const nav = hx.span === "custom"
    ? `<div class="hcustom"><label>From<input type="date" id="hFrom" value="${isoDay(hx.from)}" max="${isoDay(Date.now())}"></label><label>To<input type="date" id="hTo" value="${isoDay(hx.to)}" max="${isoDay(Date.now())}"></label></div>`
    : `<div class="hnav"><button data-step="-1" aria-label="Earlier">${CHEV}</button>
        <label class="hlabel"><span>${esc(histLabel())}</span><input type="date" id="hPick" value="${isoDay(hx.anchor)}" max="${isoDay(Date.now())}" aria-label="Pick a date"></label>
        <button data-step="1" aria-label="Later"${atEnd ? " disabled" : ""}>${CHEV}</button></div>`;

  let blocks;
  const body = sheet.querySelector(".hbody");
  const old = new Map([...body.querySelectorAll(".hblock[data-id]")].map((b) => [b.dataset.id, b]));
  const sheetTop = sheet.scrollTop, bodyTop = body.scrollTop;
  const pickTop = body.querySelector(".hpicker")?.scrollTop || 0;
  const skeleton = (r) => `<section class="hblock" data-id="${esc(r.id)}"><div class="hbhead"><b>${esc(sensorName(r, all))}</b></div><div class="hchart sk-chart" aria-busy="true"><span class="sk"></span></div></section>`;
  // While loading, charts already on screen stay (faded); only new sensors get a placeholder.
  if (hx.loading) blocks = picked.map((r) => (old.has(r.id) && !old.get(r.id).querySelector(".sk-chart") ? `<section data-keep="${esc(r.id)}"></section>` : skeleton(r))).join("");
  else if (hx.error) blocks = `<div class="hchart hmsg">${esc(hx.error)}</div>`;
  else blocks = picked.map((r) => histBlock(r, all)).join("");
  const anyLine = !hx.loading && !hx.error && picked.some((r) => !roseFor(r, all));
  const readout = `<div class="hread idle"><span>${anyLine ? "Touch a chart to read the values" : "&nbsp;"}</span></div>`;

  body.innerHTML = `
    <div class="hpills">${pills}${add}</div>
    ${picker}
    <div class="hseg" role="group" aria-label="Range">${seg}</div>
    ${nav}
    ${readout}
    <div class="hblocks">${blocks}</div>`;
  body.querySelectorAll("[data-keep]").forEach((p) => { const b = old.get(p.dataset.keep); b.classList.add("busy"); p.replaceWith(b); });
  if (hx.fresh && !hx.loading) { body.querySelectorAll(".hblock").forEach((b) => b.classList.add("enter")); hx.fresh = false; }
  if (hx.pickOpened) { body.querySelector(".hpicker")?.classList.add("enter"); hx.pickOpened = false; }
  if (hx.added) { body.querySelector(`.hpill[data-id="${CSS.escape(hx.added)}"]`)?.classList.add("enter"); hx.added = null; }
  sheet.scrollTop = sheetTop; body.scrollTop = bodyTop;
  const pk = body.querySelector(".hpicker");
  if (pk) pk.scrollTop = pickTop;

  // Wiring.
  body.querySelector("[data-pick]").onclick = () => { hx.picking = !hx.picking; hx.pickOpened = hx.picking; drawHistory(); };
  body.querySelectorAll("[data-drop]").forEach((b) => (b.onclick = () => { hx.ids = hx.ids.filter((x) => x !== b.dataset.drop); fetchHistory(); }));
  body.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = () => {
    const id = b.dataset.toggle;
    if (hx.ids.includes(id)) { if (hx.ids.length > 1) hx.ids = hx.ids.filter((x) => x !== id); }
    else if (hx.ids.length < MAX_PICK) { hx.ids = [...hx.ids, id]; hx.added = id; }
    fetchHistory();
  }));
  body.querySelectorAll("[data-span]").forEach((x) => (x.onclick = () => { hx.span = x.dataset.span; if (hx.span !== "custom") hx.anchor = Math.min(hx.anchor, Date.now()); fetchHistory(); }));
  body.querySelectorAll("[data-step]").forEach((x) => (x.onclick = () => stepRange(Number(x.dataset.step))));
  const pick = body.querySelector("#hPick");
  if (pick) {
    pick.onchange = () => { if (pick.value) { hx.anchor = parseDay(pick.value); fetchHistory(); } };
    body.querySelector(".hlabel span").onclick = () => { try { pick.showPicker(); } catch { pick.focus(); } };
  }
  const f = body.querySelector("#hFrom"), t = body.querySelector("#hTo");
  if (f && t) {
    const go = () => {
      let a = parseDay(f.value), z = parseDay(t.value);
      if (!isFinite(a) || !isFinite(z)) return;
      if (a > z) [a, z] = [z, a];
      if (z - a > 365 * DAY) a = addDays(z, -365);
      hx.from = a; hx.to = z; fetchHistory();
    };
    f.onchange = go; t.onchange = go;
  }
  body.querySelectorAll("svg.hsvg").forEach(wireScrub);
  body.querySelectorAll("[data-petal]").forEach((p) => (p.onclick = () => {
    const id = p.closest(".hblock").dataset.id;
    hx.rose[id] = hx.rose[id] === Number(p.dataset.petal) ? null : Number(p.dataset.petal);
    drawHistory();
  }));
}

// ---------- One sensor's chart ----------

const geos = new Map(); // sensor id -> how to place its values, for reading them together

function roseFor(r, all) {
  if (!isWind(r) || !hx.data) return null;
  const dir = mainOf(all, "dir");
  const speed = r.kind === "dir" ? mainOf(all, "wind") : r;
  const ds = dir && hx.data[dir.id], ss = speed && hx.data[speed.id];
  if (!ds || !ss || !ds.buckets.length || !ss.buckets.length) return null;
  return { dir: ds, speed: ss, speedSensor: speed };
}

function histBlock(r, all) {
  const name = esc(sensorName(r, all));
  const rose = roseFor(r, all);
  if (rose) return `<section class="hblock" data-id="${esc(r.id)}"><div class="hbhead"><b>${name}</b><span class="hval"></span></div>${windRose(r, rose, all)}</section>`;
  const d = hx.data && hx.data[r.id];
  const b = (d && d.buckets) || [];
  if (!b.length) return `<section class="hblock" data-id="${esc(r.id)}"><div class="hbhead"><b>${name}</b></div><div class="hchart hmsg">No readings in this range.</div></section>`;
  const U = histUnit(r);
  const show = (v) => (v == null ? "–" : `${(Math.round(U.f(v) * 10 ** U.dp) / 10 ** U.dp).toLocaleString()}${U.u}`);
  const isRain = r.kind === "rain";
  return `<section class="hblock" data-id="${esc(r.id)}"><div class="hbhead"><b>${name}</b><span class="hval"></span></div>
    ${lineChart(r, d, U)}${histStats(b, isRain, show, d.step)}</section>`;
}

// Warmth colours for temperature lines, in °C.
const WARMTH = [[-10, "#5b7fd6"], [0, "#5fb0d9"], [8, "#58b89a"], [14, "#e8c25a"], [20, "#ec9a45"], [28, "#d9534f"]];
function warmth(c) {
  if (c <= WARMTH[0][0]) return WARMTH[0][1];
  for (let i = 1; i < WARMTH.length; i++) if (c <= WARMTH[i][0]) return WARMTH[i - 1][1] + "|" + WARMTH[i][1] + "|" + (c - WARMTH[i - 1][0]) / (WARMTH[i][0] - WARMTH[i - 1][0]);
  return WARMTH[WARMTH.length - 1][1];
}
function mix(c) {
  const w = warmth(c);
  if (!w.includes("|")) return w;
  const [a, b, f] = w.split("|");
  const h = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  const A = h(a), B = h(b), t = Number(f);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`;
}

const isSun = (r) => /^slr|solar|^sr0|^sw_?in|^rad|^par/i.test(r.field || "") && !/mj/i.test(r.field || "");

function lineChart(r, data, U) {
  const W = 340, H = 120, top = 8, left = 34, bottom = 22, iw = W - left - 4;
  const b = data.buckets;
  const isRain = r.kind === "rain";
  const conv = U.f;
  const from = data.from, to = Math.max(data.to, from + 1);
  const span = to - from;
  const x = (t) => left + ((t - from) / span) * iw;
  const step = data.step || 3600e3;
  const vals = isRain ? b.map((p) => conv(p.sum)) : b.flatMap((p) => [conv(p.min), conv(p.max)]);
  let lo = isRain || isSun(r) ? 0 : Math.min(...vals), hi = Math.max(...vals);
  if (r.kind === "humidity") { lo = Math.max(0, Math.min(lo, 40)); hi = Math.min(100, Math.max(hi, 100)); }
  if (hi - lo < 1e-9) { hi += 1; lo -= isRain ? 0 : 1; }
  const pad = (hi - lo) * 0.08;
  if (!isRain && !isSun(r) && r.kind !== "humidity") lo -= pad;
  if (r.kind !== "humidity") hi += pad;
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * H;
  const ticks = niceTicks(lo, hi, 3);
  let defs = "";
  let g = ticks.map((v) => `<line class="grid" x1="${left}" x2="${W - 4}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="yl" x="${left - 6}" y="${(y(v) + 3.5).toFixed(1)}">${fmtTick(v)}</text>`).join("");
  g += timeTicks(from, to).map((t) => `<text class="xl" x="${x(t.t).toFixed(1)}" y="${top + H + 16}">${esc(t.label)}</text>`).join("");
  const bw = Math.max(1, (step / span) * iw - 1.5);
  const gid = `g${r.id.replace(/[^a-z0-9]/gi, "")}`;
  if (isRain) {
    g += b.map((p) => {
      const v = conv(p.sum);
      if (v <= 0) return "";
      const h = Math.max(1.5, y(lo) - y(v));
      return `<rect class="rb" x="${x(p.t).toFixed(1)}" y="${(y(lo) - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2, bw / 2).toFixed(1)}"/>`;
    }).join("");
  } else {
    // Temperature: the line takes the colour of the warmth at each height.
    const isTemp = r.kind === "temp" || histUnit(r).u === "°" && /c$/i.test(r.unit || "");
    if (isTemp) {
      const toC = (v) => (state.settings.temp === "F" ? (v - 32) * 5 / 9 : v);
      const stops = Array.from({ length: 9 }, (_, i) => { const v = hi - ((hi - lo) * i) / 8; return `<stop offset="${(i / 8).toFixed(3)}" stop-color="${mix(toC(v))}"/>`; }).join("");
      defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${top}" y2="${top + H}">${stops}</linearGradient>`;
    }
    if (isSun(r)) defs += `<linearGradient id="${gid}s" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f2b93b" stop-opacity="0.55"/><stop offset="1" stop-color="#f2b93b" stop-opacity="0.04"/></linearGradient>`;
    const runs = [];
    let run = [];
    b.forEach((p, i) => { if (i && p.t - b[i - 1].t > step * 2.5) { runs.push(run); run = []; } run.push(p); });
    runs.push(run);
    const mid = (p) => p.t + step / 2;
    const stroke = isTemp ? ` style="stroke:url(#${gid})"` : "";
    for (const rr of runs) {
      const line = rr.map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.avg)).toFixed(1)}`);
      if (isSun(r)) {
        g += `<polygon fill="url(#${gid}s)" points="${x(mid(rr[0])).toFixed(1)},${y(lo).toFixed(1)} ${line.join(" ")} ${x(mid(rr[rr.length - 1])).toFixed(1)},${y(lo).toFixed(1)}"/>`;
      } else if (rr.some((p) => p.max !== p.min)) {
        const up = rr.map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.max)).toFixed(1)}`);
        const dn = rr.slice().reverse().map((p) => `${x(mid(p)).toFixed(1)},${y(conv(p.min)).toFixed(1)}`);
        g += `<polygon class="band k-${r.kind || "x"}"${isTemp ? ` style="fill:url(#${gid})"` : ""} points="${up.concat(dn).join(" ")}"/>`;
      }
      g += rr.length > 1
        ? `<polyline class="ln k-${r.kind || "x"}${isSun(r) ? " sun" : ""}"${stroke} points="${line.join(" ")}"/>`
        : `<circle class="dot k-${r.kind || "x"}" cx="${x(mid(rr[0])).toFixed(1)}" cy="${y(conv(rr[0].avg)).toFixed(1)}" r="2.5"/>`;
    }
  }
  geos.set(r.id, { x, y, conv, step, top, H, bw, isRain, b, U });
  g += `<g class="scrubg"></g>`;
  return `<svg class="hsvg chart" viewBox="0 0 ${W} ${top + H + bottom}" data-id="${esc(r.id)}" data-left="${left}" data-iw="${iw}" data-from="${from}" data-span="${span}" role="img" aria-label="${esc(sensorName(r))} chart"><defs>${defs}</defs>${g}</svg>`;
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

// ---------- Wind: the compass is the chart ----------
// Each petal points to where the wind came from. Its length is how much of the time it blew
// from there; its rings of colour are how strong it was.

const SPEED_BANDS = [8, 16, 32, 48]; // km/h edges: light, moderate, fresh, strong, gale
const POINTS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function windRose(r, rose, all) {
  // Pair each time step's direction with its speed.
  const sp = new Map(rose.speed.buckets.map((p) => [p.t, p]));
  const pairs = [];
  for (const d of rose.dir.buckets) {
    const s = sp.get(d.t);
    if (s) pairs.push({ dir: d.avg, speed: s.avg, max: s.max, w: s.n || 1, t: d.t });
  }
  if (!pairs.length) return `<div class="hchart hmsg">No wind readings in this range.</div>`;
  const total = pairs.reduce((a, p) => a + p.w, 0);
  const calmW = pairs.filter((p) => p.speed < 2).reduce((a, p) => a + p.w, 0);
  const petals = Array.from({ length: 16 }, () => [0, 0, 0, 0, 0]);
  const sums = Array(16).fill(0), speedSum = Array(16).fill(0);
  for (const p of pairs) {
    if (p.speed < 2) continue;
    const i = Math.round((((p.dir % 360) + 360) % 360) / 22.5) % 16;
    const band = SPEED_BANDS.findIndex((e) => p.speed < e);
    petals[i][band < 0 ? 4 : band] += p.w;
    sums[i] += p.w; speedSum[i] += p.speed * p.w;
  }
  const maxShare = Math.max(...sums) / total || 1;
  const C = 150, R0 = 16, R = 118;
  const rad = (share) => R0 + (R - R0) * Math.sqrt(share / maxShare); // area-true petals
  const pt = (deg, r) => { const a = ((deg - 90) * Math.PI) / 180; return `${(C + r * Math.cos(a)).toFixed(1)},${(C + r * Math.sin(a)).toFixed(1)}`; };
  const wedge = (i, r1, r2) => {
    const a1 = i * 22.5 - 9, a2 = i * 22.5 + 9;
    return `M${pt(a1, r1)} L${pt(a1, r2)} A${r2},${r2} 0 0 1 ${pt(a2, r2)} L${pt(a2, r1)} A${r1},${r1} 0 0 0 ${pt(a1, r1)}Z`;
  };
  const sel = hx.rose[r.id];
  let g = "";
  // Rings: share of the time.
  const ringShares = niceTicks(0, maxShare * 100, 4).filter((v) => v > 0).map((v) => v / 100);
  g += ringShares.map((s) => `<circle class="rring" cx="${C}" cy="${C}" r="${rad(s).toFixed(1)}"/><text class="rl" x="${C + 3}" y="${(C - rad(s) - 2).toFixed(1)}">${Math.round(s * 100)}%</text>`).join("");
  g += ["N", "E", "S", "W"].map((l, i) => { const [px, py] = pt(i * 90, R + 16).split(","); return `<text class="rc" x="${px}" y="${(+py + 4).toFixed(1)}">${l}</text>`; }).join("");
  for (let i = 0; i < 16; i++) {
    if (!sums[i]) continue;
    let cum = 0, inner = R0;
    const dim = sel != null && sel !== i;
    for (let k = 0; k < 5; k++) {
      if (!petals[i][k]) continue;
      cum += petals[i][k];
      const outer = rad(cum / total);
      g += `<path class="rp b${k}${dim ? " dim" : ""}" d="${wedge(i, inner, outer)}"/>`;
      inner = outer;
    }
    g += `<path class="rhit" data-petal="${i}" d="${wedge(i, 0, Math.max(inner, 40))}"><title>From ${POINTS16[i]}</title></path>`;
  }
  g += `<circle class="rcalm" cx="${C}" cy="${C}" r="${R0 - 2}"/><text class="rcalmt" x="${C}" y="${C + 3.5}">${Math.round((calmW / total) * 100)}%</text>`;

  const U = histUnit(rose.speedSensor);
  const show = (v) => `${Math.round(U.f(v))}${U.u}`;
  const edge = (v) => Math.round(U.f(v));
  const legend = [`under ${edge(8)}`, `${edge(8)}–${edge(16)}`, `${edge(16)}–${edge(32)}`, `${edge(32)}–${edge(48)}`, `over ${edge(48)}`]
    .map((l, k) => `<span><i class="b${k}"></i>${l}</span>`).join("");
  const top = sums.indexOf(Math.max(...sums));
  const avg = pairs.reduce((a, p) => a + p.speed * p.w, 0) / total;
  const gustS = mainOf(all, "gust");
  const gustB = gustS && hx.data[gustS.id] ? hx.data[gustS.id].buckets : [];
  const strongest = gustB.length ? Math.max(...gustB.map((p) => p.max)) : Math.max(...pairs.map((p) => p.max));
  const focus = sel != null && sums[sel]
    ? `<p class="rfocus"><b>From ${POINTS16[sel]}</b> ${Math.round((sums[sel] / total) * 100)}% of the time, averaging ${show(speedSum[sel] / sums[sel])}</p>`
    : `<p class="rfocus idle">Tap a petal to see that direction. The middle is how often it was calm.</p>`;
  const tile = (l, v, sub) => `<div class="mc"><small>${l}</small><b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  return `<svg class="rose" viewBox="-12 -12 324 324" role="img" aria-label="Wind compass: how often and how strongly the wind came from each direction">${g}</svg>
    <div class="rlegend"><span class="rlt">${esc(fmt.windUnit())}</span>${legend}</div>
    ${focus}
    <div class="mine-grid hstats three">${tile("Mostly from", POINTS16[top], `${Math.round((sums[top] / total) * 100)}% of the time`)}${tile("Average", show(avg))}${tile(gustB.length ? "Strongest gust" : "Strongest", show(strongest))}</div>`;
}

// ---------- Reading the charts together ----------

function wireScrub(svg) {
  const pick = (e) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const px = ((e.clientX - r.left) / r.width) * vb.width;
    const left = +svg.dataset.left, iw = +svg.dataset.iw, from = +svg.dataset.from, span = +svg.dataset.span;
    const t = from + ((px - left) / iw) * span;
    if (t !== hx.scrub) { hx.scrub = t; drawScrubAll(); }
  };
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); pick(e); });
  svg.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "mouse") pick(e); });
}

function drawScrubAll() {
  const body = $("#histSheet .hbody");
  if (!body || hx.scrub == null) return;
  let when = null;
  body.querySelectorAll("svg.hsvg").forEach((svg) => {
    const geo = geos.get(svg.dataset.id);
    const g = svg.querySelector(".scrubg");
    const val = svg.closest(".hblock").querySelector(".hval");
    if (!geo || !geo.b.length) return;
    const t = hx.scrub;
    let best = 0, d = Infinity;
    geo.b.forEach((p, i) => { const dd = Math.abs(p.t + geo.step / 2 - t); if (dd < d) { d = dd; best = i; } });
    const sc = geo.b[best];
    const cx = geo.isRain ? geo.x(sc.t) + geo.bw / 2 : geo.x(sc.t + geo.step / 2);
    g.innerHTML = `<line class="hscrub" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${geo.top}" y2="${geo.top + geo.H}"/>` +
      (geo.isRain ? "" : `<circle class="hsdot" cx="${cx.toFixed(1)}" cy="${geo.y(geo.conv(sc.avg)).toFixed(1)}" r="4"/>`);
    const show = (v) => `${(Math.round(geo.U.f(v) * 10 ** geo.U.dp) / 10 ** geo.U.dp).toLocaleString()}${geo.U.u}`;
    val.innerHTML = `<b>${show(geo.isRain ? sc.sum : sc.avg)}</b>${!geo.isRain && sc.n > 1 && sc.max !== sc.min ? ` <small>${show(sc.min)} to ${show(sc.max)}</small>` : ""}`;
    if (!when) when = whenLabel(sc.t, geo.step);
  });
  const read = body.querySelector(".hread");
  if (read && when) { read.className = "hread"; read.innerHTML = `<span class="hwhen">${esc(when)}</span>`; }
}

const ICON_X = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4 4 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const ICON_TICK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------- Station health ----------
// Everything the logger says about itself: its batteries, its own temperature, errors and
// skipped measurements, free storage, how long each scan takes, its outputs and record counts.
// Each is named in plain words and, where there is a sensible range, marked good or worth a look.

const usec = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} s` : `${Math.round(v / 1000)} ms`);
function bytes(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
  return `${Math.round(v)} bytes`;
}
const portNo = (f) => (/\((\d+)\)/.exec(f) || [])[1] || "";
const zeroGood = (bad = "bad") => (v) => (v === 0 ? ["good", "None"] : [bad, v.toLocaleString()]);
const HEALTH = [
  { re: /^battery$|^battv/i, group: "Power", name: (r) => /min/i.test(r.field) ? `Battery, lowest ${tableWords(r.table) === "daily" ? "today" : tableWords(r.table)}` : /avg/i.test(r.field) ? `Battery, average ${tableWords(r.table)}` : "Battery",
    show: (v) => `${v.toFixed(2)} V`, judge: (v) => (v >= 12.4 ? ["good", "Good"] : v >= 11.9 ? ["warn", "Getting low"] : ["bad", "Low"]), hint: "A healthy 12 V battery sits above 12.4 V." },
  { re: /lithium/i, group: "Power", name: () => "Backup battery", show: (v) => `${v.toFixed(2)} V`, judge: (v) => (v >= 2.7 ? ["good", "Good"] : ["warn", "Replace soon"]), hint: "Keeps the clock and memory going if the main power drops." },
  { re: /^sw12volts/i, group: "Power", name: (r) => `Switched 12 V output${portNo(r.field) ? " " + portNo(r.field) : ""}`, show: (v) => (v > 0.5 ? `On, ${v.toFixed(1)} V` : "Off") },
  { re: /^paneltemp|^ptemp/i, group: "Logger", name: (r) => /avg/i.test(r.field) && r.table && !/status/i.test(r.table) ? `Inside the logger, ${tableWords(r.table)}` : "Inside the logger", show: (v) => fmt.temp(v),
    judge: (v) => (v > -25 && v < 50 ? ["good", ""] : ["warn", "Outside its rated range"]) },
  { re: /progerrors/i, group: "Logger", name: () => "Program errors", show: (v) => v.toLocaleString(), judge: zeroGood("bad") },
  { re: /varoutofbound/i, group: "Logger", name: () => "Values out of range", show: (v) => v.toLocaleString(), judge: zeroGood("warn") },
  { re: /skippedscan/i, group: "Logger", name: () => "Skipped measurements", show: (v) => v.toLocaleString(), judge: zeroGood("warn"), hint: "Times the logger was too busy to take a scheduled reading." },
  { re: /wsdiag|diag/i, group: "Logger", name: () => "Wind sensor check", show: (v) => (v === 0 ? "OK" : `Code ${v}`), judge: (v) => (v === 0 ? ["good", ""] : ["warn", "Sensor reported a fault"]) },
  { re: /datastoragefree/i, group: "Storage", name: () => "Data storage free", show: bytes },
  { re: /cpudrivefree/i, group: "Storage", name: () => "Program drive free", show: bytes },
  { re: /memoryfree/i, group: "Storage", name: () => "Working memory free", show: bytes },
  { re: /^measuretime/i, group: "Timing", name: () => "Taking measurements", show: usec, hint: "How long each scan spends reading the sensors." },
  { re: /^processtime/i, group: "Timing", name: () => "Processing them", show: usec },
  { re: /^maxproctime/i, group: "Timing", name: () => "Longest processing", show: usec },
  { re: /^portstatus/i, group: "Outputs", name: (r) => `Control port${portNo(r.field) ? " " + portNo(r.field) : ""}`, show: (v) => (v ? "On" : "Off") },
  { re: /^record$/i, group: "Records", name: (r) => `${tableWords(r.table).replace(/^./, (c) => c.toUpperCase())} table`, show: (v) => `${v.toLocaleString()} saved` },
];
const HEALTH_GROUPS = ["Power", "Logger", "Sending", "Storage", "Timing", "Outputs", "Records", "Other"];

function healthRule(r) { return HEALTH.find((h) => h.re.test(r.field || "")); }
function isHealth(r) {
  return /status/i.test(r.table || "") || /^(record|batt|battery|ptemp|paneltemp|wsdiag|lithium)/i.test(r.field || "");
}
function healthItems(s) {
  const out = [];
  const health = (s.readings || []).filter(isHealth);
  const hasStatus = (re) => health.some((x) => /status/i.test(x.table || "") && re.test(x.field));
  for (const r of health) {
    const rule = healthRule(r);
    // The logger's battery and own temperature are logged in several tables too; the Status
    // report already has them, so keep only the day's lowest battery from the others.
    if (!/status/i.test(r.table || "")) {
      if (/^batt/i.test(r.field) && hasStatus(/^battery$/i) && !(/min/i.test(r.field) && tableWords(r.table) === "daily")) continue;
      if (/^ptemp/i.test(r.field) && hasStatus(/^paneltemp/i)) continue;
    }
    const v = r.value;
    if (rule) {
      const [state, note] = rule.judge ? rule.judge(v) : ["", ""];
      const name = rule.name(r);
      out.push({ r, group: rule.group, name, value: rule.show(v), state, note, hint: name === "Battery" || !/^batt/i.test(r.field) ? rule.hint : null });
    } else {
      out.push({ r, group: "Other", name: r.field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"), value: sensorValue(r), state: "" });
    }
  }
  const last = Date.parse(s.sent || s.time);
  if (isFinite(last)) {
    const hm = (t) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    out.push({ group: "Sending", name: "Last sent", value: `${hm(last)} · ${ago(new Date(last).toISOString())}` });
    if (s.every) {
      const late = Date.now() > last + s.every + Math.max(15 * 60e3, s.every / 2);
      out.push({ group: "Sending", name: "Sends every", value: s.every >= 3600e3 ? `${Math.round(s.every / 360e3) / 10} h` : `${Math.round(s.every / 60e3)} min` });
      out.push({ group: "Sending", name: "Next batch", value: late ? "Late" : hm(last + s.every), state: late ? "warn" : "good", note: late ? "Hasn't arrived yet" : "" });
    }
  }
  return out;
}
function healthSummary(items) {
  const bad = items.filter((i) => i.state === "bad"), warn = items.filter((i) => i.state === "warn");
  if (bad.length) return { state: "bad", text: bad.length === 1 ? `${bad[0].name}: ${bad[0].note || "needs a look"}` : `${bad.length} things need a look` };
  if (warn.length) return { state: "warn", text: warn.length === 1 ? `${warn[0].name}: ${warn[0].note || "worth a look"}` : `${warn.length} things worth a look` };
  return { state: "good", text: "All good" };
}

// The pill at the top of the card: a small dot in the health colour and the word Health.
function healthPill(s) {
  const items = healthItems(s);
  if (!items.some((i) => i.r)) return "";
  const sum = healthSummary(items);
  return `<button class="health-pill h-${sum.state}" data-health aria-label="Station health: ${esc(sum.text)}"><i></i>Health${CHEV}</button>`;
}

const healthHist = { id: null, data: null, at: 0 };
async function openHealth() {
  const s = homeHere() || (state.home && state.home.station);
  if (!s) return;
  const sheet = $("#healthSheet");
  sheet.querySelector("h2").textContent = s.name;
  drawHealth(s);
  if (!sheet.open) sheet.showModal();
  // A week of the main battery, for the little chart.
  const batt = (s.readings || []).find((r) => /^battery$/i.test(r.field)) || (s.readings || []).find((r) => /^battv/i.test(r.field));
  if (!batt) return;
  if (healthHist.id === batt.id && Date.now() - healthHist.at < 10 * 60e3) return;
  try {
    const to = Math.floor(Date.now() / 300e3) * 300e3, from = to - 7 * DAY;
    const q = new URLSearchParams({ from, to, ids: batt.id, offset: -new Date().getTimezoneOffset() });
    const body = await api(`/api/home/history?${q}`);
    Object.assign(healthHist, { id: batt.id, data: body.series && body.series[batt.id], at: Date.now() });
    if (sheet.open) drawHealth(s);
  } catch {}
}

function battChart(d) {
  const b = (d && d.buckets || []).filter((x) => x.avg != null);
  if (b.length < 3) return "";
  const W = 320, H = 70, lo = Math.min(12.1, ...b.map((x) => (x.min ?? x.avg) - 0.15)), hi = Math.max(13.8, ...b.map((x) => (x.max ?? x.avg) + 0.15));
  const t0 = b[0].t, t1 = b[b.length - 1].t;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  const line = b.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.avg).toFixed(1)}`).join("");
  const band = b.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.max ?? p.avg).toFixed(1)}`).join("") +
    [...b].reverse().map((p) => `L${x(p.t).toFixed(1)} ${y(p.min ?? p.avg).toFixed(1)}`).join("") + "Z";
  const ok = y(12.4);
  return `<figure class="hbatt"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="${ok.toFixed(1)}" width="${W}" height="${(H - ok).toFixed(1)}" class="low"/>
      <path d="${band}" class="band"/><path d="${line}" class="ln"/></svg>
    <figcaption><span>7 days ago</span><span>Last week · shaded below 12.4 V</span><span>Now</span></figcaption></figure>`;
}

function drawHealth(s) {
  const sheet = $("#healthSheet");
  const items = healthItems(s);
  const sum = healthSummary(items);
  const batt = items.find((i) => i.r && /^battery$|^battv/i.test(i.r.field) && i.name === "Battery") || items.find((i) => i.group === "Power" && i.r);
  const gauge = batt ? (() => {
    const v = batt.r.value, f = Math.max(0, Math.min(1, (v - 11.5) / 3));
    return `<div class="hgauge h-${batt.state}"><div class="hg-top"><span>Battery</span><b>${esc(batt.value)}</b></div>
      <span class="hg-bar"><i style="width:${(f * 100).toFixed(1)}%"></i><em style="left:${(((12.4 - 11.5) / 3) * 100).toFixed(1)}%"></em></span>
      <div class="hg-ends"><span>11.5 V</span><span>${esc(batt.note || "")}</span><span>14.5 V</span></div>
      ${healthHist.data ? battChart(healthHist.data) : ""}</div>`;
  })() : "";
  const groups = HEALTH_GROUPS.map((g) => {
    const rows = items.filter((i) => i.group === g);
    if (!rows.length) return "";
    return `<section class="hgroup"><h3>${g}</h3><ul>${rows.map((i) => `<li class="${i.state ? "h-" + i.state : ""}">
        <span class="hn">${esc(i.name)}${i.note && i.state && i.state !== "good" ? `<small class="nt">${esc(i.note)}</small>` : ""}${i.hint ? `<small>${esc(i.hint)}</small>` : ""}</span>
        <span class="hv">${i.state ? "<i></i>" : ""}${esc(i.value)}</span></li>`).join("")}</ul></section>`;
  }).join("");
  sheet.querySelector(".hbody").innerHTML = `
    <div class="hsum h-${sum.state}"><span class="dot"></span><div><b>${esc(sum.text)}</b><small>From the logger's own report, ${esc(ago(s.sent || s.time))}</small></div></div>
    ${gauge}${groups}`;
}
