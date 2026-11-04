"use strict";

// ---------- Provider catalogue ----------

const PROVIDERS = [
  { id: "metoffice", source: "metoffice", name: "Met Office", note: "UK weather service", group: "services" },
  { id: "accuweather", source: "accuweather", name: "AccuWeather", note: "5-day forecast", group: "services" },
  { id: "metno", source: "metno", name: "yr.no", note: "MET Norway", group: "services" },
  { id: "openweather", source: "openweather", name: "OpenWeather", note: "3-hourly forecast", group: "services" },
  { id: "om-ecmwf", source: "openmeteo", name: "ECMWF", note: "European model", group: "models" },
  { id: "om-ukmo", source: "openmeteo", name: "UKMO", note: "UK Met Office model", group: "models" },
  { id: "om-gfs", source: "openmeteo", name: "GFS", note: "US model (NOAA)", group: "models" },
  { id: "om-icon", source: "openmeteo", name: "ICON", note: "German model (DWD)", group: "models" },
  { id: "om-meteofrance", source: "openmeteo", name: "Météo-France", note: "French model", group: "models" },
];
const GROUPS = { services: "Forecast services", models: "Weather models" };
const SOURCE_NAMES = {
  openmeteo: "Open-Meteo models",
  metno: "yr.no (MET Norway)",
  metoffice: "Met Office",
  accuweather: "AccuWeather",
  openweather: "OpenWeather",
};

const WORDS = {
  clear: "Sunny", partly: "Partly cloudy", cloudy: "Cloudy", fog: "Foggy", drizzle: "Light rain",
  rain: "Rain", "heavy-rain": "Heavy rain", sleet: "Sleet", snow: "Snow", thunder: "Thunderstorms",
};
const WET = new Set(["drizzle", "rain", "heavy-rain", "sleet", "snow", "thunder"]);

const DEMO = /[?&]demo\b/.test(location.search) || window.WEATHER_DEMO === true;

// ---------- State ----------

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  settings: Object.assign({ temp: "C", wind: "mph", rain: "mm", dist: "mi", hidden: [] }, store.get("wc.settings", {})),
  place: store.get("wc.place", null),
  saved: store.get("wc.saved", []),
  sources: null,          // [{id, enabled}]
  results: {},            // provider id -> provider result
  loading: new Set(),     // source ids loading
  sourceErrors: {},       // source id -> message
  fetchedAt: null,
  day: 0,
  open: null,             // expanded provider id
  mode: store.get("wc.mode", "temp"), // what the list compares: temp, rain or wind
  page: "compare",        // compare, forecast or stations
  stations: null,         // live station readings near the place
  stationsLoading: false,
};

const $ = (s) => document.querySelector(s);

// ---------- API ----------

async function api(path) {
  if (DEMO) return demoApi(path);
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

async function loadSources() {
  if (state.sources) return state.sources;
  try {
    state.sources = await api("/api/sources");
  } catch {
    state.sources = [{ id: "openmeteo", enabled: true }, { id: "metno", enabled: true }];
  }
  return state.sources;
}

async function refresh() {
  const place = state.place;
  if (!place) return;
  const sources = (await loadSources()).filter((s) => s.enabled && sourceVisible(s.id));
  $("#refreshBtn").classList.add("spin");
  state.sourceErrors = {};
  const stationsDone = loadStations(place).then(render);
  await Promise.all(
    sources.map(async (s) => {
      state.loading.add(s.id);
      render();
      try {
        const q = new URLSearchParams({ source: s.id, lat: place.lat, lon: place.lon, tz: place.tz || "UTC" });
        const body = await api(`/api/forecast?${q}`);
        if (state.place !== place) return;
        for (const p of body.providers) state.results[p.id] = p;
      } catch (err) {
        if (state.place !== place) return;
        state.sourceErrors[s.id] = err.message;
      } finally {
        state.loading.delete(s.id);
        render();
      }
    })
  );
  await stationsDone;
  if (state.place !== place) return;
  recordSnapshot();
  state.fetchedAt = Date.now();
  store.set("wc.last", { key: placeKey(place), results: state.results, fetchedAt: state.fetchedAt });
  $("#refreshBtn").classList.remove("spin");
  render();
}

function placeKey(p) { return `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; }

function setPlace(place) {
  state.place = place;
  state.results = {};
  state.stations = null;
  if (window.StationMap) StationMap.reset();
  state.day = 0;
  state.open = null;
  store.set("wc.place", place);
  const last = store.get("wc.last", null);
  if (last && last.key === placeKey(place)) {
    state.results = last.results;
    state.fetchedAt = last.fetchedAt;
  }
  render();
  refresh();
}

// ---------- Units ----------

const fmt = {
  temp(c) {
    if (c == null) return "–";
    return Math.round(state.settings.temp === "F" ? c * 9 / 5 + 32 : c) + "°";
  },
  tempDiff(c) { return Math.round(state.settings.temp === "F" ? c * 9 / 5 : c); },
  windNum(kmh) {
    if (kmh == null) return "–";
    const u = state.settings.wind;
    return String(Math.round(u === "kmh" ? kmh : u === "ms" ? kmh / 3.6 : u === "kn" ? kmh / 1.852 : kmh / 1.609));
  },
  windUnit() {
    return { kmh: "km/h", ms: "m/s", kn: "kn", mph: "mph" }[state.settings.wind] || "mph";
  },
  dist(km) {
    if (km == null) return "";
    const v = state.settings.dist === "km" ? km : km / 1.609;
    return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${state.settings.dist === "km" ? "km" : "mi"}`;
  },
  rain(mm) {
    if (mm == null) return null;
    if (state.settings.rain === "in") return mm < 0.01 * 25.4 ? "0 in" : `${(mm / 25.4).toFixed(2)} in`;
    return mm < 0.1 ? "0 mm" : `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
  },
};

// ---------- Derived data ----------

function placeToday() {
  const tz = (state.place && state.place.tz) || undefined;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function placeHour() {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: state.place.tz, hour: "2-digit", hourCycle: "h23" }).format(new Date());
  } catch {
    return String(new Date().getHours()).padStart(2, "0");
  }
}

function visibleProviders() {
  return PROVIDERS.filter((p) => !state.settings.hidden.includes(p.id) && sourceEnabled(p.source));
}
function sourceEnabled(id) {
  const s = state.sources && state.sources.find((x) => x.id === id);
  return state.sources ? !!(s && s.enabled) : id === "openmeteo" || id === "metno";
}
function sourceVisible(id) {
  return PROVIDERS.some((p) => p.source === id && !state.settings.hidden.includes(p.id));
}

function dates() {
  const today = placeToday();
  const all = new Set();
  for (const p of visibleProviders()) {
    const r = state.results[p.id];
    if (r && r.ok) r.days.forEach((d) => d.date >= today && all.add(d.date));
  }
  const list = [...all].sort().slice(0, 7);
  if (!list.length) {
    // Placeholder week while loading.
    const base = new Date(today + "T12:00:00Z");
    for (let i = 0; i < 7; i++) list.push(new Date(base.getTime() + i * 864e5).toISOString().slice(0, 10));
  }
  return list;
}

function dayFor(providerId, date) {
  const r = state.results[providerId];
  return r && r.ok ? r.days.find((d) => d.date === date) || null : null;
}

function isWet(d) {
  return (d.pop != null && d.pop >= 50) || (d.mm != null && d.mm >= 1) || WET.has(d.code);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function med(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? median(v) : null;
}

function consensus(date) {
  const days = visibleProviders().map((p) => dayFor(p.id, date)).filter(Boolean);
  if (!days.length) return null;
  const his = days.map((d) => d.hi);
  const los = days.map((d) => d.lo);
  const wet = days.filter(isWet).length;
  const counts = {};
  for (const d of days) if (d.code) counts[d.code] = (counts[d.code] || 0) + 1;
  let code = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "cloudy";
  // If most sources expect rain but disagree on the type, show rain.
  if (wet > days.length / 2 && !WET.has(code)) code = "rain";
  if (wet <= days.length / 2 && WET.has(code)) code = "partly";
  return {
    n: days.length, wet, code,
    hi: median(his), lo: median(los),
    hiMin: Math.min(...his), hiMax: Math.max(...his),
    loMin: Math.min(...los), loMax: Math.max(...los),
    min: Math.min(...los), max: Math.max(...his),
    his,
    wind: med(days.map((d) => d.wind)),
    gust: med(days.map((d) => d.gust)),
    dir: circularMean(days.map((d) => d.dir).filter((x) => x != null)),
    mm: med(days.map((d) => d.mm)),
  };
}

// ---------- Icons (drawn in code so they match the app, not the phone's emoji set) ----------

const CLOUD = "M9.5 25h13.2a5 5 0 0 0 .9-9.92A7.2 7.2 0 0 0 10 14.3 5.4 5.4 0 0 0 9.5 25z";
function sunRays(cx, cy, r1, r2) {
  let d = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    d += `M${(cx + Math.cos(a) * r1).toFixed(1)} ${(cy + Math.sin(a) * r1).toFixed(1)}L${(cx + Math.cos(a) * r2).toFixed(1)} ${(cy + Math.sin(a) * r2).toFixed(1)}`;
  }
  return d;
}
function wxIcon(code, night = false, cls = "") {
  const cloud = (dy = 0, dx = 0) => `<path class="cl" d="${CLOUD}" transform="translate(${dx} ${dy})"/>`;
  const sun = (cx, cy, r) => `<circle class="su" cx="${cx}" cy="${cy}" r="${r}"/><path class="su" d="${sunRays(cx, cy, r + 2.6, r + 5)}"/>`;
  const moon = (cx, cy, s) => `<path class="mo" transform="translate(${cx} ${cy}) scale(${s})" d="M3 -8a8 8 0 1 0 6 13.4A6.6 6.6 0 0 1 3 -8z"/>`;
  const drops = (n, len = 4) =>
    [10.5, 15, 19.5, 24].slice(0, n).map((x, i) => `<path class="dr" d="M${x + (n < 3 ? 2 : 0)} ${23 + (i % 2)}l-1.4 ${len}"/>`).join("");
  let g;
  switch (code) {
    case "clear": g = night ? moon(16, 16, 1.25) : sun(16, 16, 6); break;
    case "partly": g = (night ? moon(12, 11, 0.85) : sun(11.5, 11.5, 4.2)) + cloud(3, 2.5); break;
    case "cloudy": g = `<path class="cl" d="${CLOUD}" transform="translate(4 -4) scale(0.8)" opacity="0.55"/>` + cloud(1); break;
    case "fog": g = cloud(-5) + `<path class="fg" d="M7 24h18M10 28h14"/>`; break;
    case "drizzle": g = cloud(-5) + drops(3, 2.5); break;
    case "rain": g = cloud(-5) + drops(3); break;
    case "heavy-rain": g = cloud(-5) + drops(4, 6); break;
    case "sleet": g = cloud(-5) + `<path class="dr" d="M11 23l-1.4 4M20 23l-1.4 4"/><circle class="sn" cx="15.5" cy="26" r="1.4"/><circle class="sn" cx="24" cy="26" r="1.4"/>`; break;
    case "snow": g = cloud(-5) + [[11, 24], [16, 27], [21, 24], [13.5, 29.5], [19, 30]].map(([x, y]) => `<circle class="sn" cx="${x}" cy="${y}" r="1.5"/>`).join(""); break;
    case "thunder": g = cloud(-5) + `<path class="bo" d="M17.5 19.5 12.5 26h3.5l-1.5 5.5 6-7.5h-3.6l2-4.5z"/>`; break;
    default: g = cloud(1);
  }
  return `<svg class="wx ${cls}" viewBox="0 0 32 32" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;
}
// Arrow points the way the wind is blowing TO (dir is where it comes FROM).
function windArrow(dir, cls = "arrow") {
  const rot = dir == null ? 0 : (dir + 180) % 360;
  return `<svg class="${cls}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M12 2.5 18.5 20 12 16.2 5.5 20z" fill="currentColor"/></svg>`;
}
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (d) => (d == null ? "" : COMPASS[Math.round(d / 22.5) % 16]);
function windWord(kmh) {
  if (kmh == null) return "";
  if (kmh < 6) return "Calm";
  if (kmh < 20) return "Light wind";
  if (kmh < 39) return "Breezy";
  if (kmh < 62) return "Windy";
  if (kmh < 89) return "Gale";
  return "Storm";
}
function circularMean(dirs) {
  if (!dirs.length) return null;
  let x = 0, y = 0;
  for (const d of dirs) { x += Math.cos((d * Math.PI) / 180); y += Math.sin((d * Math.PI) / 180); }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---------- Rendering ----------

function render() {
  renderHeader();
  const page = state.page;
  document.querySelectorAll(".tabs button").forEach((b) => (b.dataset.page === page ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("#pageCompare").hidden = page !== "compare";
  $("#pageForecast").hidden = page !== "forecast";
  $("#pageStations").hidden = page !== "stations";
  $("#days").hidden = page !== "compare";
  // On the Stations page the sky panel shrinks to a slim bar so the map gets the room.
  $("#sky").classList.toggle("compact", page === "stations");
  if (page === "forecast") {
    const pred = renderForecastPage();
    if (pred && pred.days.length) applyHero(heroForecast(pred));
    else renderHero(null, null);
  } else if (page === "stations") {
    renderStationsPage();
    if (state.stations && (state.stations.stations || []).length) applyHero(heroStations(state.stations));
    else applyHero({ code: "cloudy", wind: 12, dir: 250, html: `<div class="mini"><span class="ms"><b>Measured now</b>${state.place ? (state.stationsLoading ? "Reading stations…" : "No stations reporting nearby") : "Choose a place first"}</span></div>` });
  } else {
    const ds = dates();
    if (state.day >= ds.length) state.day = 0;
    const date = ds[state.day];
    const c = consensus(date);
    renderHero(date, c);
    renderDays(ds);
    renderModes();
    renderList(date, c);
  }
  renderFooter();
}

function applyHero(m) {
  $("#sky").dataset.code = m.code;
  sky_.set({ code: m.code, wind: m.wind, dir: m.dir });
  $("#hero").innerHTML = m.html;
}

function renderHeader() {
  $("#placeName").textContent = state.place ? state.place.name : "Choose a place";
  $("#refreshBtn").classList.toggle("spin", state.loading.size > 0);
}

function dayLabel(date, i) {
  if (date === placeToday()) return "Today";
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}
function longDate(date) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function renderHero(date, c) {
  const hero = $("#hero");
  const sky = $("#sky");
  if (!state.place || !c) {
    sky.dataset.code = "cloudy";
    sky_.set({ code: "cloudy", wind: 12, dir: 250 });
    hero.innerHTML = state.place
      ? `<div class="empty">Gathering forecasts…<small>Asking ${visibleProviders().length} sources about ${esc(state.place.name)}.</small></div>`
      : `<div class="empty">Where are you?<small>Tap the place name above to search, or use your location.</small></div>`;
    return;
  }
  sky.dataset.code = c.code;
  sky_.set({ code: c.code, wind: c.wind, dir: c.dir });

  const today = date === placeToday();
  const headline = c.wet > c.n / 2 && c.code !== "drizzle" ? `${WORDS[c.code]} likely` : WORDS[c.code];
  const spreadDeg = fmt.tempDiff(c.hiMax - c.hiMin);
  const rainSplit = c.n >= 3 && c.wet / c.n > 0.25 && c.wet / c.n < 0.75;
  const agree = c.n < 2 ? ["–", "one source"]
    : spreadDeg <= 2 && !rainSplit ? ["Strong", `highs within ${Math.max(spreadDeg, 1)}°`]
    : spreadDeg <= 4 ? ["Mixed", rainSplit ? "split on rain" : `highs vary ${spreadDeg}°`]
    : ["Low", `highs vary ${spreadDeg}°`];
  const rainVal = c.wet === 0 ? "Dry" : `${c.wet} of ${c.n}`;
  const rainSub = c.wet === 0 ? "every source" : "sources say rain";
  const windVal = c.wind != null ? `${windArrow(c.dir, "")}<span>${fmt.windNum(c.wind)} <small style="font-size:12px;font-weight:500">${fmt.windUnit()}</small></span>` : "–";
  const windSub = [compass(c.dir), c.gust != null ? `gusts ${fmt.windNum(c.gust)}` : null].filter(Boolean).join(" · ");

  const span = Math.max(c.hiMax - c.hiMin, 0.1);
  const pad = Math.max(span * 0.15, 0.5);
  const pos = (t) => (((t - (c.hiMin - pad)) / (span + 2 * pad)) * 100).toFixed(1);
  const dots = c.his.map((h) => `<span class="dot" style="left:${pos(h)}%"></span>`).join("");

  hero.innerHTML = `
    <div class="when">${today ? "Today" : dayLabel(date, state.day)} · ${longDate(date).replace(/^\w+ /, "")}</div>
    <div class="main">
      <div class="temp" aria-label="High ${fmt.temp(c.hi)}">${fmt.temp(c.hi)}</div>
      ${wxIcon(c.code, false, "big-ico")}
    </div>
    <div class="cond">
      <div class="cond-word">${headline}</div>
      <div class="cond-sub">Low ${fmt.temp(c.lo)} · typical of ${c.n} source${c.n === 1 ? "" : "s"} · ${windWord(c.wind).toLowerCase() || "wind unknown"}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Rain</div><div class="v">${rainVal}</div><div class="s">${rainSub}</div></div>
      <div class="stat"><div class="k">Wind</div><div class="v">${windVal}</div><div class="s">${windSub || "&nbsp;"}</div></div>
      <div class="stat"><div class="k">Agreement</div><div class="v">${agree[0]}</div><div class="s">${agree[1]}</div></div>
    </div>
    <div class="spread" aria-label="Highs forecast by each source, from ${fmt.temp(c.hiMin)} to ${fmt.temp(c.hiMax)}">
      <div class="lbl"><span>How high will it get? Each dot is one source</span></div>
      <div class="axis">${dots}<span class="med" style="left:${pos(c.hi)}%"></span></div>
      <div class="ends"><span>Coolest ${fmt.temp(c.hiMin)}</span><span>Warmest ${fmt.temp(c.hiMax)}</span></div>
    </div>`;
}

function renderDays(ds) {
  const nav = $("#days");
  nav.innerHTML = "";
  nav.setAttribute("role", "tablist");
  ds.forEach((date, i) => {
    const c = consensus(date);
    const b = el("button", { class: "day", role: "tab", "aria-selected": String(i === state.day), "aria-label": longDate(date) });
    b.innerHTML = `<span class="dn">${dayLabel(date, i)}</span>${c ? wxIcon(c.code, false, "di") : '<span class="di"></span>'}<span class="dt">${c ? `<b>${fmt.temp(c.hi)}</b> ${fmt.temp(c.lo)}` : "&nbsp;"}</span>`;
    b.onclick = () => selectDay(i);
    nav.append(b);
  });
  const sel = nav.children[state.day];
  if (sel && state.day > 2) sel.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderModes() {
  document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === state.mode)));
}

function renderList(date, c) {
  const list = $("#list");
  list.innerHTML = "";
  const providers = visibleProviders();
  const days = providers.map((p) => dayFor(p.id, date)).filter(Boolean);
  const scale = {
    min: c ? c.min : 0,
    max: c ? c.max : 1,
    wind: Math.max(1, ...days.map((d) => Math.max(d.gust || 0, d.wind || 0))),
    hi: c ? c.hi : null,
  };
  for (const [g, title] of Object.entries(GROUPS)) {
    const items = providers.filter((p) => p.group === g);
    if (!items.length) continue;
    list.append(el("h3", { class: "group" }, title));
    const card = el("div", { class: "card" });
    for (const p of items) card.append(renderRow(p, date, scale));
    list.append(card);
  }
}

function renderRow(p, date, scale) {
  const r = state.results[p.id];
  const d = dayFor(p.id, date);
  const row = el("div", { class: "row" });
  const btn = el("button", { class: "row-main", "aria-expanded": String(state.open === p.id) });

  if (d) {
    let badge = "";
    if (state.mode === "temp" && scale.hi != null) {
      const diff = fmt.tempDiff(d.hi - scale.hi);
      if (Math.abs(diff) >= 2) badge = `<span class="diff ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : "−"}${Math.abs(diff)}°</span>`;
    }
    btn.innerHTML = `<div class="who"><div class="n">${esc(p.name)}${badge}</div><div class="s">${esc(p.note)}</div></div>
      <div class="ico" title="${WORDS[d.code] || ""}">${wxIcon(d.code)}</div>${vizFor(d, scale)}`;
    btn.onclick = () => { state.open = state.open === p.id ? null : p.id; render(); };
  } else {
    row.classList.add("off");
    const loading = state.loading.has(p.source) && !r;
    const err = state.sourceErrors[p.source] || (r && !r.ok && r.error);
    btn.innerHTML = `<div class="who"><div class="n">${esc(p.name)}</div><div class="s">${esc(p.note)}</div></div>
      <div class="msg">${loading ? '<span class="skeleton"></span>' : err ? `${esc(err)}` : r ? (date === placeToday() ? "Nothing left for today" : "No forecast this far ahead") : ""}</div>`;
    btn.disabled = true;
  }
  row.append(btn);
  if (d && state.open === p.id) row.append(renderHours(r, date));
  return row;
}

function vizFor(d, s) {
  if (state.mode === "rain") {
    const pop = d.pop != null ? Math.round(d.pop) : null;
    const mm = fmt.rain(d.mm);
    return `<div class="viz rain"><div class="track"><i class="pop" style="width:${pop ?? 0}%"></i></div><div class="b">${pop != null ? pop + "%" : "–"}</div>
      <div class="mm">${pop == null ? "No chance given" : "Chance of rain"}${mm ? ` · ${mm}` : ""}</div></div>`;
  }
  if (state.mode === "wind") {
    const w = d.wind != null ? (d.wind / s.wind) * 100 : 0;
    const gst = d.gust != null ? (d.gust / s.wind) * 100 : 0;
    const sub = [d.dir != null ? `From ${compass(d.dir)}` : null, d.gust != null ? `gusts ${fmt.windNum(d.gust)}` : null].filter(Boolean).join(" · ");
    return `<div class="viz wind">${windArrow(d.dir)}<div class="track"><i class="gust" style="width:${gst.toFixed(1)}%"></i><i class="wind" style="width:${w.toFixed(1)}%"></i></div><div class="b">${d.wind != null ? fmt.windNum(d.wind) : "–"}<small>${fmt.windUnit()}</small></div>
      <div class="mm">${sub}</div></div>`;
  }
  const span = Math.max(s.max - s.min, 1);
  const left = ((d.lo - s.min) / span) * 100;
  const width = Math.max(((d.hi - d.lo) / span) * 100, 4);
  const tick = s.hi != null ? `<span class="tick" style="left:${(((s.hi - s.min) / span) * 100).toFixed(1)}%"></span>` : "";
  return `<div class="viz"><div class="a">${fmt.temp(d.lo)}</div><div class="track"><i class="temp" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i>${tick}</div><div class="b">${fmt.temp(d.hi)}</div></div>`;
}

function renderHours(r, date) {
  // For today, show the next 24 hours from now; for other days, that day's hours.
  const all = r.hours || [];
  let hrs;
  if (date === placeToday()) {
    const now = `${date}T${placeHour()}`;
    const start = all.findIndex((h) => h.time.slice(0, 13) >= now);
    // Keep the slot that covers "now" for 3-hourly sources.
    const from = start > 0 && all[start].time.slice(0, 13) > now ? start - 1 : Math.max(start, 0);
    hrs = start === -1 ? [] : all.slice(from).filter((h) => Date.parse(h.time + "Z") - Date.parse(now + ":00Z") < 24 * 3600e3);
  } else {
    hrs = all.filter((h) => h.time.slice(0, 10) === date);
  }
  if (!hrs.length) return el("div", { class: "hours-empty" }, `${r.name} has no hour-by-hour forecast for this day.`);
  const box = el("div", { class: "hours" });
  hrs.forEach((h, i) => {
    const hour = Number(h.time.slice(11, 13));
    const night = hour < 7 || hour >= 19;
    const label = i === 0 && date === placeToday() ? "Now" : h.time.slice(0, 10) !== date && hour === 0 ? dayLabel(h.time.slice(0, 10), 1) : h.time.slice(11, 13);
    const cell = el("div", { class: "hour" });
    cell.innerHTML = `<span class="t">${label}</span>${wxIcon(h.code, night, "i")}<span class="v">${fmt.temp(h.temp)}</span>
      <span class="p">${h.pop != null && h.pop >= 10 ? Math.round(h.pop) + "%" : ""}</span>
      <span class="w">${h.wind != null ? windArrow(h.dir, "") + fmt.windNum(h.wind) : ""}</span>`;
    box.append(cell);
  });
  return box;
}

function renderFooter() {
  const f = $("#footer");
  if (!state.fetchedAt) { f.textContent = DEMO ? "Demo data" : ""; return; }
  const t = new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tip = { compare: "Tap a source for hour by hour", forecast: "Blended from every source and live stations", stations: "Station readings refresh every 10 minutes" }[state.page];
  f.textContent = `${DEMO ? "Demo data · " : ""}Updated ${t} · ${tip}`;
}

function selectDay(i) {
  const n = dates().length;
  state.day = Math.max(0, Math.min(n - 1, i));
  render();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

// ---------- Sky animation ----------
// The panel's motion carries the forecast: rain or snow falls at the angle the wind
// blows, clouds drift at the wind's speed, and gusty days get wind streaks.

const sky_ = (() => {
  let canvas, ctx, w = 0, h = 0, dpr = 1, raf = 0, last = 0, visible = true;
  let cfg = { code: "cloudy", wind: 10, dir: 250 };
  let drops = [], flakes = [], clouds = [], streaks = [], flash = 0, nextFlash = 3;
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  function setup() {
    canvas = document.getElementById("skyCanvas");
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    new ResizeObserver(resize).observe(canvas);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }).observe(canvas);
    }
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && start());
    resize();
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (still.matches) frame(0); else start();
  }
  // Wind as screen velocity: east is +x. Clamp so a gale doesn't look silly.
  function windVec() {
    const to = (((cfg.dir ?? 250) + 180) % 360) * (Math.PI / 180);
    const k = Math.min(cfg.wind || 0, 70);
    return { x: Math.sin(to) * k, k };
  }
  function seed() {
    const c = cfg.code;
    const rainN = { drizzle: 60, rain: 130, "heavy-rain": 230, thunder: 190, sleet: 60 }[c] || 0;
    const snowN = { snow: 110, sleet: 45 }[c] || 0;
    const cloudN = { clear: 0, partly: 3, fog: 6 }[c] ?? 5;
    drops = Array.from({ length: rainN }, () => ({ x: Math.random() * w, y: Math.random() * h, l: 10 + Math.random() * 14, v: 520 + Math.random() * 320, a: 0.18 + Math.random() * 0.25 }));
    flakes = Array.from({ length: snowN }, () => ({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 2.2, v: 25 + Math.random() * 40, p: Math.random() * 6.28 }));
    clouds = Array.from({ length: cloudN }, (_, i) => ({ x: Math.random() * w, y: h * (0.08 + 0.55 * Math.random()), r: 70 + Math.random() * 90, a: (c === "fog" ? 0.16 : 0.1) + Math.random() * 0.08, s: 0.6 + (i % 3) * 0.25 }));
    const sN = windVec().k > 18 ? Math.round(windVec().k / 4) : 0;
    streaks = Array.from({ length: sN }, () => newStreak(true));
  }
  function newStreak(anywhere) {
    return { x: anywhere ? Math.random() * w : -120, y: Math.random() * h * 0.9, l: 50 + Math.random() * 90, t: anywhere ? Math.random() : 0, life: 1.6 + Math.random() * 1.6, bend: (Math.random() - 0.5) * 16 };
  }
  function start() {
    if (still.matches || raf || !visible || document.visibilityState !== "visible") return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function loop(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    frame(dt);
    if (visible && document.visibilityState === "visible") raf = requestAnimationFrame(loop);
  }
  function frame(dt) {
    if (!ctx) return;
    const t = performance.now() / 1000;
    const wv = windVec();
    ctx.clearRect(0, 0, w, h);

    if (cfg.code === "clear" || cfg.code === "partly") {
      // Soft sun glow with slowly turning rays.
      const sx = w * 0.82, sy = h * 0.14, pulse = 1 + Math.sin(t * 0.6) * 0.04;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 190 * pulse);
      g.addColorStop(0, "rgba(255,236,170,0.55)"); g.addColorStop(0.35, "rgba(255,226,150,0.18)"); g.addColorStop(1, "rgba(255,226,150,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(t * 0.04);
      for (let i = 0; i < 12; i++) {
        ctx.rotate(Math.PI / 6);
        const rg = ctx.createLinearGradient(0, 0, 260, 0);
        rg.addColorStop(0, "rgba(255,240,200,0.12)"); rg.addColorStop(1, "rgba(255,240,200,0)");
        ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(260, -14); ctx.lineTo(260, 14); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    for (const c of clouds) {
      c.x += (wv.x * 0.9 + (wv.x >= 0 ? 4 : -4)) * c.s * dt;
      if (c.x - c.r > w) c.x = -c.r; else if (c.x + c.r < 0) c.x = w + c.r;
      for (const [ox, oy, f] of [[0, 0, 1], [c.r * 0.55, c.r * 0.12, 0.75], [-c.r * 0.5, c.r * 0.15, 0.7]]) {
        const g = ctx.createRadialGradient(c.x + ox, c.y + oy, 0, c.x + ox, c.y + oy, c.r * f);
        g.addColorStop(0, `rgba(255,255,255,${c.a})`); g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.x + ox, c.y + oy, c.r * f, 0, 6.283); ctx.fill();
      }
    }

    if (drops.length) {
      const slant = (wv.x * 9) / 600; // horizontal px per vertical px
      ctx.lineCap = "round"; ctx.lineWidth = 1.1;
      for (const d of drops) {
        d.y += d.v * dt; d.x += d.v * slant * dt;
        if (d.y > h + 20) { d.y = -20 - Math.random() * 40; d.x = Math.random() * (w + 200) - 100; }
        if (d.x > w + 40) d.x -= w + 80; else if (d.x < -40) d.x += w + 80;
        ctx.strokeStyle = `rgba(225,236,248,${d.a})`;
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.l * slant, d.y - d.l); ctx.stroke();
      }
    }

    for (const f of flakes) {
      f.p += dt; f.y += f.v * dt; f.x += (wv.x * 1.6 + Math.sin(f.p * 1.3) * 14) * dt;
      if (f.y > h + 6) { f.y = -6; f.x = Math.random() * w; }
      if (f.x > w + 6) f.x = -6; else if (f.x < -6) f.x = w + 6;
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill();
    }

    if (streaks.length) {
      const dirX = wv.x >= 0 ? 1 : -1;
      ctx.lineWidth = 1.2; ctx.lineCap = "round";
      for (let i = 0; i < streaks.length; i++) {
        const s = streaks[i];
        s.t += dt / s.life;
        s.x += (wv.k * 7 + 60) * dt * dirX;
        if (s.t >= 1) { streaks[i] = newStreak(false); if (dirX < 0) streaks[i].x = w + 120; continue; }
        const a = Math.sin(s.t * Math.PI) * 0.28;
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath(); ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo(s.x - s.l * 0.5 * dirX, s.y + s.bend, s.x - s.l * dirX, s.y);
        ctx.stroke();
      }
    }

    if (cfg.code === "thunder" && dt > 0) {
      nextFlash -= dt;
      if (nextFlash <= 0) { flash = 1; nextFlash = 4 + Math.random() * 6; }
      if (flash > 0) {
        ctx.fillStyle = `rgba(235,240,255,${flash * 0.35})`; ctx.fillRect(0, 0, w, h);
        flash = Math.max(0, flash - dt * 3.2);
      }
    }
  }
  function set(next) {
    const changed = next.code !== cfg.code || Math.round((next.wind || 0) / 5) !== Math.round((cfg.wind || 0) / 5) || Math.round((next.dir || 0) / 20) !== Math.round((cfg.dir || 0) / 20);
    cfg = { ...next };
    if (!ctx) setup();
    if (changed && ctx) { seed(); if (still.matches) frame(0); }
  }
  return { set };
})();

// ---------- Pages ----------

const PAGES = ["compare", "forecast", "stations"];
function pageFromHash() {
  const h = location.hash.replace("#", "");
  return PAGES.includes(h) ? h : "compare";
}
function goPage(p) {
  try {
    if (location.hash.replace("#", "") !== p) history.replaceState(null, "", p === "compare" ? location.pathname + location.search : "#" + p);
  } catch {}
  state.page = p;
  state.open = null;
  render();
  window.scrollTo({ top: 0 });
}

// ---------- Stations data and the Forecaster ----------

async function loadStations(place) {
  state.stationsLoading = true;
  try {
    const body = await api(`/api/stations?lat=${place.lat}&lon=${place.lon}`);
    if (state.place !== place) return;
    state.stations = body;
  } catch (err) {
    if (state.place !== place) return;
    state.stations = { stations: [], networks: {}, error: err.message };
  } finally {
    state.stationsLoading = false;
  }
}

function nowKey() {
  return `${placeToday()}T${placeHour()}:00`;
}

// Keep this device's own record of past forecasts, so we can learn which sources do best here.
function recordSnapshot() {
  if (!state.place) return;
  const providers = PROVIDERS.map((p) => state.results[p.id]).filter(Boolean);
  if (!providers.length) return;
  const key = snapKey();
  const snaps = store.get(key, []);
  const snap = Blend.snapshot(providers, nowKey());
  if (snaps.length && snaps[snaps.length - 1].issued === snap.issued) return;
  snaps.push(snap);
  store.set(key, snaps.slice(-36));
}

// Forecast history is kept per ~10 km area, so it survives small moves of the phone.
function snapKey() {
  return `wc.snap.${state.place.lat.toFixed(1)},${state.place.lon.toFixed(1)}`;
}
function placeElev() {
  const r = PROVIDERS.map((p) => state.results[p.id]).find((x) => x && x.elevation != null);
  return r ? r.elevation : null;
}

function prediction() {
  if (!state.place) return null;
  const providers = visibleProviders().map((p) => state.results[p.id]).filter((r) => r && r.ok);
  if (!providers.length) return null;
  const st = state.stations || {};
  let skill = null;
  if (st.history && st.history.obs) {
    const hist = st.history.obs.map((o) => ({ key: Blend.toLocalKey(o.time, state.place.tz || "UTC"), temp: o.temp }));
    skill = Blend.scoreSkill(store.get(snapKey(), []), hist);
  }
  return Blend.predict({ providers, stations: st.stations || [], nowKey: nowKey(), skill, placeElev: placeElev(), hours: 168 });
}

function forecastNotes(pred) {
  const out = [];
  const o = pred.now.obs;
  const hours = pred.hours.slice(0, 24);
  if (o.temp != null) {
    let s = `It's ${fmt.temp(o.temp)} at weather stations near you right now`;
    if (pred.now.rain === "raining") s += ", and it's raining";
    else if (pred.now.rain === "dry") s += ", and dry";
    s += ".";
    const adj = fmt.tempDiff(pred.now.tempAdj);
    if (Math.abs(adj) >= 1) s += ` That's ${Math.abs(adj)}° ${adj < 0 ? "cooler" : "warmer"} than the sources expected, so the next few hours are adjusted to match.`;
    out.push(s);
  }
  // Rain windows in the next 24 hours.
  const runs = [];
  let cur = null;
  hours.forEach((h) => {
    const wet = (h.pop ?? 0) >= 50;
    if (wet && !cur) cur = { from: h, to: h, peak: h.pop };
    else if (wet) { cur.to = h; cur.peak = Math.max(cur.peak, h.pop); }
    else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  const hh = (h) => h.time.slice(11, 13) + ":00";
  const maxPop = Math.max(0, ...hours.map((h) => h.pop ?? 0));
  if (!runs.length) out.push(maxPop < 25 ? "It should stay dry for the next 24 hours." : `Mostly dry for the next 24 hours, with a small chance of a shower (up to ${Math.round(maxPop)}%).`);
  else {
    const txt = runs.slice(0, 2).map((r) => (r.from === hours[0] ? `now until about ${hh(r.to)}` : r.from === r.to ? `around ${hh(r.from)}` : `from ${hh(r.from)} to about ${hh(r.to)}`));
    out.push(`Rain likely ${txt.join(", and again ")}.`);
  }
  // Temperature.
  const temps = hours.map((h) => h.temp);
  const minT = Math.min(...temps), maxT = Math.max(...temps);
  const minAt = hours[temps.indexOf(minT)], maxAt = hours[temps.indexOf(maxT)];
  out.push(maxAt.time < minAt.time
    ? `Peaking at ${fmt.temp(maxT)} around ${hh(maxAt)}, then down to ${fmt.temp(minT)} by ${hh(minAt)}.`
    : `Down to ${fmt.temp(minT)} around ${hh(minAt)}, then up to ${fmt.temp(maxT)} by ${hh(maxAt)}.`);
  // Wind.
  const gusts = hours.map((h) => h.gust ?? h.wind ?? 0);
  const g = Math.max(...gusts);
  const gAt = hours[gusts.indexOf(g)];
  const from = gAt && gAt.dir != null ? ` from the ${COMPASS_WORDS[compass(gAt.dir)] || compass(gAt.dir)}` : "";
  if (g >= 55) out.push(`Windy, with gusts up to ${fmt.windNum(g)} ${fmt.windUnit()}${from}.`);
  else if (g >= 35) out.push(`Breezy at times, gusting ${fmt.windNum(g)} ${fmt.windUnit()}${from}.`);
  else out.push(`Light winds${from}.`);
  // The week ahead.
  const later = pred.days.slice(1);
  if (later.length >= 3) {
    const wettest = later.reduce((a, d) => ((d.pop ?? 0) + (d.mm ?? 0) * 5 > (a.pop ?? 0) + (a.mm ?? 0) * 5 ? d : a));
    const best = later.reduce((a, d) => ((d.pop ?? 100) - d.hi * 3 < (a.pop ?? 100) - a.hi * 3 ? d : a));
    const unsure = later.filter((d) => d.confidence === "low").map((d) => dayName(d.date));
    let s = `Looking ahead, ${dayName(best.date)} looks the best day`;
    if (wettest !== best && (wettest.pop ?? 0) >= 40) s += ` and ${dayName(wettest.date)} the wettest`;
    s += ".";
    if (unsure.length) s += ` Sources disagree about ${unsure.slice(0, 2).join(" and ")}, so check again nearer the time.`;
    out.push(s);
  }
  return out;
}
const COMPASS_WORDS = { N: "north", NE: "north-east", E: "east", SE: "south-east", S: "south", SW: "south-west", W: "west", NW: "north-west", NNE: "north-north-east", ENE: "east-north-east", ESE: "east-south-east", SSE: "south-south-east", SSW: "south-south-west", WSW: "west-south-west", WNW: "west-north-west", NNW: "north-north-west" };
function dayName(date) {
  if (date === placeToday()) return "today";
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

function heroForecast(pred) {
  const d = pred.days[0];
  const h0 = pred.hours[0];
  const conf = { high: ["High", "sources agree"], medium: ["Medium", "partly agree"], low: ["Low", "sources differ"] }[d.confidence];
  const headline = (d.pop ?? 0) >= 50 && d.code !== "drizzle" ? `${WORDS[d.code]} likely` : WORDS[d.code];
  return {
    code: d.code, wind: d.wind, dir: d.dir,
    html: `
    <div class="when">Forecaster · Today</div>
    <div class="main"><div class="temp">${fmt.temp(d.hi)}</div>${wxIcon(d.code, false, "big-ico")}</div>
    <div class="cond"><div class="cond-word">${headline}</div>
      <div class="cond-sub">Low ${fmt.temp(d.lo)}${h0 ? ` · now ${fmt.temp(h0.temp)}` : ""} · blended from ${pred.weights.length} sources</div></div>
    <div class="stats">
      <div class="stat"><div class="k">Rain</div><div class="v">${d.pop != null ? Math.round(d.pop) + "%" : "–"}</div><div class="s">${d.mm ? "about " + fmt.rain(d.mm) : "chance today"}</div></div>
      <div class="stat"><div class="k">Wind</div><div class="v">${windArrow(d.dir, "")}<span>${fmt.windNum(d.wind)} <small style="font-size:12px;font-weight:500">${fmt.windUnit()}</small></span></div><div class="s">${[compass(d.dir), d.gust != null ? "gusts " + fmt.windNum(d.gust) : null].filter(Boolean).join(" · ")}</div></div>
      <div class="stat"><div class="k">Confidence</div><div class="v">${conf[0]}</div><div class="s">${conf[1]}</div></div>
    </div>`,
  };
}

function renderForecastPage() {
  const box = $("#pageForecast");
  const pred = prediction();
  if (!pred || !pred.days.length) {
    box.innerHTML = `<div class="panel"><h2>Forecaster</h2><p class="lead">${state.loading.size || state.stationsLoading ? "Gathering forecasts and station readings…" : "No forecasts to work from yet."}</p></div>`;
    return null;
  }
  const notes = forecastNotes(pred).map((p) => `<p>${esc(p)}</p>`).join("");
  const basisText = {
    past: `Sources are weighted by how close their forecasts came to what <b>${esc(state.stations?.history?.name || "the nearest airport")}</b> actually measured over the last day.`,
    now: `Sources are weighted by how close they are to what <b>${pred.now.obs.tempN} nearby station${pred.now.obs.tempN === 1 ? "" : "s"}</b> read right now. As this phone saves more forecasts, the weights will switch to each source's track record over the past day.`,
    equal: "No station readings are available here yet, so every source counts equally.",
  }[pred.basis];
  const wrows = pred.weights.map((w) => {
    const lean = w.bias && Math.abs(fmt.tempDiff(w.bias)) >= 1 ? `, runs ${Math.abs(fmt.tempDiff(w.bias))}° ${w.bias > 0 ? "warm" : "cold"} here (corrected)` : "";
    const detail = w.basis === "past" && w.err != null ? `${fmt.tempDiff(w.err) || "<1"}° off on average${lean}` : w.basis === "now" && w.err != null ? `${Math.round(fmt.tempDiff(w.err) * 10) / 10}° from stations now` : "";
    return `<div class="wrow"><div class="nm"><b>${esc(w.name)}</b><small>${detail}</small></div><div class="track"><i style="width:${(w.w / pred.weights[0].w) * 100}%"></i></div><div class="pc">${Math.round(w.w * 100)}%</div></div>`;
  }).join("");
  const adj = fmt.tempDiff(pred.now.tempAdj);
  const nowText = pred.now.obs.temp != null
    ? `<p class="how">Right now: <b>${fmt.temp(pred.now.obs.temp)}</b> measured nearby${Math.abs(adj) >= 1 ? `, so the next few hours are moved <b>${adj > 0 ? "up" : "down"} ${Math.abs(adj)}°</b>, easing back to the blend by about 12 hours out` : ", close to what the sources expected"}.${pred.now.rain === "raining" ? " Rain gauges show it raining, so the next couple of hours lean wet." : pred.now.rain === "dry" ? " Rain gauges are dry, so the next couple of hours lean dry." : ""}</p>`
    : "";

  const scale = { min: Math.min(...pred.days.map((d) => d.lo)), max: Math.max(...pred.days.map((d) => d.hi)) };
  const span = Math.max(scale.max - scale.min, 1);
  const drows = pred.days.map((d, i) => {
    const left = ((d.lo - scale.min) / span) * 100, width = Math.max(((d.hi - d.lo) / span) * 100, 4);
    const open = state.fday === i;
    return `<button class="drow${open ? " open" : ""}" data-day="${i}" aria-expanded="${open}">
      <div class="dl">${dayLabel(d.date, i)}<small>${new Date(d.date + "T12:00:00Z").getUTCDate()}<span class="conf ${d.confidence}" title="${d.confidence} confidence"></span></small></div>
      ${wxIcon(d.code, false, "ico")}
      <div class="viz"><div class="a">${fmt.temp(d.lo)}</div><div class="track"><i class="temp" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></i></div><div class="b">${fmt.temp(d.hi)}</div></div>
      <div class="rp">${d.pop != null ? Math.round(d.pop) + "%" : ""}</div>
      <div class="wd">${windArrow(d.dir, "")}${fmt.windNum(d.wind)}</div>
    </button>${open ? dayDetail(pred, d, i) : ""}`;
  }).join("");

  box.innerHTML = `
    <section class="panel"><h2>Next 24 hours</h2><p class="lead">Line: our temperature. Shading: range across all sources.</p>${hourChart(pred.hours.slice(0, 24))}
      <div class="legend"><span><i style="background:var(--warm);opacity:.5"></i>Temperature</span><span><i style="background:var(--rain)"></i>Chance of rain</span><span><i style="background:var(--wind)"></i>Wind, ${fmt.windUnit()}</span></div></section>
    <section class="panel"><h2>Next 7 days</h2><p class="lead">Tap a day for details. Dots show confidence: <span class="conf high"></span> high <span class="conf medium"></span> medium <span class="conf low"></span> low</p>${drows}</section>
    <section class="panel notes"><h2>Forecaster's notes</h2>${notes}
      <div class="byline">Worked out on this phone from ${pred.weights.length} forecasts and ${(state.stations?.stations || []).length} live stations.</div></section>
    <section class="panel"><h2>How this forecast is made</h2><p class="how">Tailored to <b>${esc(state.place.gps ? "where you are" : state.place.name)}</b>${placeElev() != null ? ` (${Math.round(placeElev())} m above sea level)` : ""}, using stations within ${fmt.dist(40)}. Closer stations count more, and readings from higher or lower stations are corrected for height.</p><p class="how">${basisText}</p>${nowText}${wrows}</section>`;
  box.querySelectorAll(".drow").forEach((b) => {
    b.onclick = () => { const i = Number(b.dataset.day); state.fday = state.fday === i ? null : i; render(); };
  });
  return pred;
}

// The details that open under a day in "Next 7 days".
function dayDetail(pred, d, i) {
  const hrs = pred.hours.filter((h) => h.time.slice(0, 10) === d.date);
  const conf = { high: "Sources agree", medium: "Sources partly agree", low: "Sources differ" }[d.confidence];
  const rain = d.pop != null ? `${Math.round(d.pop)}%${d.mm ? `, about ${fmt.rain(d.mm)}` : ""}` : d.mm ? `about ${fmt.rain(d.mm)}` : "–";
  const wind = d.wind != null ? `${fmt.windNum(d.wind)} ${fmt.windUnit()}${d.dir != null ? ` from the ${COMPASS_WORDS[compass(d.dir)] || compass(d.dir)}` : ""}${d.gust != null ? `, gusts ${fmt.windNum(d.gust)}` : ""}` : "–";
  const highs = d.n > 1 ? `${fmt.temp(d.hiMin)} to ${fmt.temp(d.hiMax)} across ${d.n} sources` : "one source";
  return `<div class="dday">
    <div class="dgrid">
      <div><span>High and low</span><b>${fmt.temp(d.hi)} and ${fmt.temp(d.lo)}</b></div>
      <div><span>Rain</span><b>${rain}</b></div>
      <div><span>Wind</span><b>${wind}</b></div>
      <div><span>${conf}</span><b>Highs ${highs}</b></div>
    </div>
    ${hrs.length >= 4 ? hourChart(hrs, i === 0) : `<p class="how">Hour-by-hour detail isn't available this far ahead.</p>`}
  </div>`;
}

function hourChart(hours, fromNow = true) {
  if (hours.length < 2) return "";
  const W = 340, top = 22, th = 72, rTop = 112, rh = 30, labY = 160, windY = 178;
  const step = (W - 16) / (hours.length - 1);
  const x = (i) => 8 + i * step;
  const lo = Math.min(...hours.map((h) => h.lo)), hi = Math.max(...hours.map((h) => h.hi));
  const pad = Math.max((hi - lo) * 0.1, 0.5);
  const y = (t) => top + th - ((t - (lo - pad)) / (hi - lo + 2 * pad)) * th;
  const line = hours.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(h.temp).toFixed(1)}`).join("");
  const band = hours.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(h.hi).toFixed(1)}`).join("") +
    hours.slice().reverse().map((h, j) => `L${x(hours.length - 1 - j).toFixed(1)} ${y(h.lo).toFixed(1)}`).join("") + "Z";
  let g = `<line class="grid" x1="0" x2="${W}" y1="${rTop + rh}" y2="${rTop + rh}"/>`;
  g += `<path class="band" d="${band}"/><path class="line" d="${line}"/>`;
  hours.forEach((h, i) => {
    const bw = Math.max(step - 3, 3);
    const p = Math.max(0, Math.min(100, h.pop ?? 0));
    g += `<rect class="rt" x="${(x(i) - bw / 2).toFixed(1)}" y="${rTop}" width="${bw.toFixed(1)}" height="${rh}" rx="2"/>`;
    if (p > 0) g += `<rect class="rb" x="${(x(i) - bw / 2).toFixed(1)}" y="${(rTop + rh - (rh * p) / 100).toFixed(1)}" width="${bw.toFixed(1)}" height="${((rh * p) / 100).toFixed(1)}" rx="2"/>`;
    if (i % 3 === 0) {
      g += `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(h.temp).toFixed(1)}" r="3"/>`;
      g += `<text class="tl" x="${x(i).toFixed(1)}" y="${(y(h.temp) - 8).toFixed(1)}">${fmt.temp(h.temp)}</text>`;
      g += `<text class="hl" x="${x(i).toFixed(1)}" y="${labY}">${i === 0 && fromNow ? "Now" : h.time.slice(11, 13)}</text>`;
      if (h.wind != null) {
        const rot = h.dir == null ? 0 : (h.dir + 180) % 360;
        g += `<g transform="translate(${x(i).toFixed(1)} ${windY}) rotate(${rot})"><path class="wa" d="M0 -6 4.5 5.5 0 3 -4.5 5.5z"/></g>`;
        g += `<text class="ws" x="${x(i).toFixed(1)}" y="${windY + 17}">${fmt.windNum(h.wind)}</text>`;
      }
    }
  });
  g += `<text class="ax" x="0" y="${rTop - 4}">Rain %</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${windY + 22}" role="img" aria-label="Temperature, rain chance and wind by hour">${g}</svg>`;
}

// ---------- Stations page ----------

const NETWORKS = {
  airport: ["Airports", "Official reports from UK airports, every 30 minutes"],
  metoffice: ["Met Office stations", "Hourly readings from about 150 official sites"],
  raingauge: ["Rain gauges", "Environment Agency gauges, every 15 minutes (England)"],
};

function heroStations(st) {
  const o = Blend.observedNow(st.stations || [], Date.now(), placeElev());
  const air = (st.stations || []).find((s) => s.network === "airport" && s.cover);
  const code = o.rainN && o.rainingN / o.rainN >= 0.5 ? "rain"
    : air ? ({ SKC: "clear", CLR: "clear", CAVOK: "clear", NSC: "clear", FEW: "partly", SCT: "partly" }[air.cover] || "cloudy")
    : "cloudy";
  const rain = o.rainN ? (o.rainingN ? `Raining at ${o.rainingN} of ${o.rainN}` : "Dry everywhere") : "";
  const wind = o.wind != null ? `<span class="mw">${windArrow(o.dir, "")}${fmt.windNum(o.wind)} ${fmt.windUnit()}</span>` : "";
  return {
    code, wind: o.wind, dir: o.dir,
    html: `<div class="mini" aria-label="Measured now near you">
      ${wxIcon(code, Number(placeHour()) < 7 || Number(placeHour()) >= 18, "mi")}
      <span class="mt">${o.temp != null ? fmt.temp(o.temp) : "–"}</span>
      <span class="ms"><b>Measured now</b>${[rain, `${(st.stations || []).length} stations`].filter(Boolean).join(" · ")}</span>
      ${wind}
    </div>`,
  };
}

function ago(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function renderStationsPage() {
  const box = $("#stationsList");
  if (state.place && window.StationMap) {
    StationMap.show($("#map"), state.place, (state.stations && state.stations.stations) || [], { fmt, api, esc, ago, compass, timeline: rainTimeline });
  }
  const st = state.stations;
  if (!st) {
    box.innerHTML = `<div class="panel"><h2>Stations near you</h2><p class="lead">${state.stationsLoading ? "Reading stations…" : "Pick a place to see nearby stations."}</p></div>`;
    return;
  }
  const nets = Object.entries(NETWORKS).map(([id, [name]]) => {
    const n = (st.networks || {})[id] || {};
    const status = !n.enabled ? ["", "needs a free key"]
      : n.ok ? ["ok", `${n.count} nearby`] : ["bad", n.error || "not responding"];
    return `<div class="net"><span>${name}</span><span class="st ${status[0]}">${esc(status[1])}</span></div>`;
  }).join("");
  let groups = "";
  for (const [id, [name, lead]] of Object.entries(NETWORKS)) {
    const list = (st.stations || []).filter((s) => s.network === id);
    if (!list.length) continue;
    const rows = list.map((s) => {
      if (s.network === "raingauge") return gaugeRow(s);
      const rain = s.rain1h != null ? (s.rain1h > 0 ? `<span class="r">${fmt.rain(s.rain1h)}/h</span>` : `<span class="r dry">dry</span>`)
        : s.wx ? `<span class="r">${esc(s.wx)}</span>` : s.raining === false ? `<span class="r dry">dry</span>` : `<span class="r"></span>`;
      return `<div class="srow"><div class="nm"><b>${esc(s.name)}</b><small>${fmt.dist(s.dist)} · ${ago(s.time)}</small></div>
        <div class="rd">${rain}${s.wind != null ? `<span class="w">${windArrow(s.dir, "")}${fmt.windNum(s.wind)}</span>` : ""}${s.temp != null ? `<span class="t">${fmt.temp(s.temp)}</span>` : ""}</div></div>`;
    }).join("");
    groups += `<section class="panel"><h2>${name}</h2><p class="lead">${lead}</p>${rows}</section>`;
  }
  box.innerHTML = `<section class="panel"><h2>Station networks</h2><p class="lead">Live readings feed into the Forecaster.</p><div class="nets">${nets}</div></section>${groups ||
    `<section class="panel"><p class="lead">No stations reported near here in the last few hours.</p></section>`}`;
  box.querySelectorAll(".srow.gauge").forEach((b) => {
    b.onclick = () => { state.openGauge = state.openGauge === b.dataset.id ? null : b.dataset.id; renderStationsPage(); };
  });
}

// A rain gauge: how much has fallen, and a 24-hour timeline when tapped.
function gaugeRow(s) {
  const open = state.openGauge === s.id;
  const total = s.rain24h != null ? `<span class="r${s.rain24h > 0 ? "" : " dry"}">${s.rain24h > 0 ? fmt.rain(s.rain24h) : "dry"}<small>24 h</small></span>` : "";
  const hour = s.rain1h != null ? `<span class="r${s.rain1h > 0 ? "" : " dry"}">${s.rain1h > 0 ? fmt.rain(s.rain1h) : "dry"}<small>last hour</small></span>` : "";
  return `<button class="srow gauge${open ? " open" : ""}" data-id="${esc(s.id)}" aria-expanded="${open}">
      <div class="nm"><b>${esc(s.name)}</b><small>${fmt.dist(s.dist)} · ${ago(s.time)}</small></div>
      <div class="rd">${hour}${total}</div></button>${open ? `<div class="gdetail">${rainTimeline(s.hourly)}</div>` : ""}`;
}

function rainTimeline(hourly) {
  if (!hourly || !hourly.length) return `<p class="how">No timeline from this gauge.</p>`;
  const W = 340, H = 64, top = 14, n = hourly.length, step = W / n;
  const max = Math.max(1, ...hourly.map((h) => h.mm || 0));
  let g = `<line class="grid" x1="0" x2="${W}" y1="${top + H}" y2="${top + H}"/>`;
  hourly.forEach((h, i) => {
    const x = i * step + 1.5, bw = step - 3;
    if (h.mm == null) g += `<rect class="gap" x="${x.toFixed(1)}" y="${top + H - 2}" width="${bw.toFixed(1)}" height="2"/>`;
    else if (h.mm > 0) {
      const bh = Math.max((h.mm / max) * H, 2);
      g += `<rect class="rb" x="${x.toFixed(1)}" y="${(top + H - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"><title>${fmt.rain(h.mm)}</title></rect>`;
      if (h.mm === max && max > 0) g += `<text class="tl" x="${(x + bw / 2).toFixed(1)}" y="${(top + H - bh - 4).toFixed(1)}">${fmt.rain(h.mm)}</text>`;
    }
    if (i % 6 === 5 || i === n - 1) {
      const hh = new Date(h.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: (state.place && state.place.tz) || undefined });
      g += `<text class="hl" x="${(x + bw / 2).toFixed(1)}" y="${top + H + 14}">${i === n - 1 ? "Now" : hh}</text>`;
    }
  });
  return `<svg class="chart rainline" viewBox="0 0 ${W} ${top + H + 20}" role="img" aria-label="Rain each hour over the last 24 hours">${g}</svg>
    <p class="how">Rain each hour over the last 24 hours. Hours with no reading show as a thin grey line.</p>`;
}

// ---------- Place sheet ----------

function openPlaceSheet() {
  renderSaved();
  $("#results").innerHTML = "";
  $("#search").value = "";
  $("#placeSheet").showModal();
}

function renderSaved() {
  const ul = $("#saved");
  ul.innerHTML = "";
  const cur = state.place;
  const list = [...state.saved];
  if (cur && !list.some((p) => placeKey(p) === placeKey(cur))) list.unshift({ ...cur, unsaved: true });
  $("#savedTitle").hidden = !list.length;
  for (const p of list) {
    const saved = !p.unsaved;
    const li = el("li");
    const pick = el("button", { class: "pick" }, p.name, el("span", { class: "sub" }, p.region || (p.gps ? "Current location" : "")));
    pick.onclick = () => { $("#placeSheet").close(); setPlace(strip(p)); };
    const star = el("button", { class: "star", "aria-label": saved ? "Remove from saved" : "Save place" }, saved ? "★" : "☆");
    star.onclick = () => {
      if (saved) state.saved = state.saved.filter((x) => placeKey(x) !== placeKey(p));
      else state.saved.push(strip(p));
      store.set("wc.saved", state.saved);
      renderSaved();
    };
    li.append(pick, star);
    ul.append(li);
  }
}

function strip(p) {
  const { unsaved, ...rest } = p;
  return rest;
}

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  const q = $("#search").value.trim();
  const ul = $("#results");
  if (q.length < 2) { ul.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      if ($("#search").value.trim() !== q) return;
      ul.innerHTML = "";
      if (!results.length) ul.append(el("li", { class: "note" }, "No places found"));
      for (const r of results) {
        const li = el("li");
        const b = el("button", { class: "pick" }, r.name, el("span", { class: "sub" }, r.region));
        b.onclick = () => { $("#placeSheet").close(); setPlace(r); };
        li.append(b);
        ul.append(li);
      }
    } catch (err) {
      ul.innerHTML = "";
      ul.append(el("li", { class: "note" }, `Search failed: ${err.message}`));
    }
  }, 300);
}

function useGps() {
  const btn = $("#gpsBtn");
  if (!navigator.geolocation) { btn.textContent = "Location isn't available on this device"; return; }
  btn.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      btn.textContent = "📍 Use my location";
      const place = {
        name: "My location",
        lat: Math.round(pos.coords.latitude * 1000) / 1000,
        lon: Math.round(pos.coords.longitude * 1000) / 1000,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        gps: true,
      };
      if ($("#placeSheet").open) $("#placeSheet").close();
      setPlace(place);
      const name = await reverseName(place).catch(() => null);
      if (name && state.place === place) {
        place.name = name.name;
        place.region = name.region;
        store.set("wc.place", place);
        renderHeader();
      }
    },
    (err) => {
      btn.textContent = err.code === 1 ? "Location permission denied. Search instead." : "Couldn't get your location";
      if (!$("#placeSheet").open) openPlaceSheet();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  );
}

// On opening, quietly check where the phone is. If it has moved more than a mile or so,
// switch the forecast to the new spot.
function locateQuietly() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const cur = state.place;
    const lat = Math.round(pos.coords.latitude * 1000) / 1000, lon = Math.round(pos.coords.longitude * 1000) / 1000;
    if (cur && Blend && distanceKm(cur.lat, cur.lon, lat, lon) < 1.5) return;
    const place = { name: "My location", lat, lon, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, gps: true };
    setPlace(place);
    const name = await reverseName(place).catch(() => null);
    if (name && state.place === place) { place.name = name.name; place.region = name.region; store.set("wc.place", place); renderHeader(); }
  }, () => {}, { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
}
function distanceKm(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

async function reverseName({ lat, lon }) {
  if (DEMO) return { name: "London", region: "England, United Kingdom" };
  const r = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
  ).then((x) => x.json());
  const name = r.locality || r.city || r.principalSubdivision;
  return name ? { name, region: [r.principalSubdivision, r.countryName].filter((x) => x && x !== name).join(", ") } : null;
}

// ---------- Settings sheet ----------

function openSettings() {
  const fm = $("#followMe");
  fm.checked = state.settings.followMe !== false;
  fm.onchange = () => { state.settings.followMe = fm.checked; saveSettings(); };
  document.querySelectorAll(".seg").forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(state.settings[key] === b.dataset.v)));
  });
  const ul = $("#sourceToggles");
  ul.innerHTML = "";
  for (const p of PROVIDERS) {
    const enabled = sourceEnabled(p.source);
    const id = `t-${p.id}`;
    const box = el("input", { type: "checkbox", id });
    box.checked = enabled && !state.settings.hidden.includes(p.id);
    box.disabled = !enabled;
    box.onchange = () => {
      const h = new Set(state.settings.hidden);
      box.checked ? h.delete(p.id) : h.add(p.id);
      state.settings.hidden = [...h];
      saveSettings();
      if (box.checked && !state.results[p.id]) refresh();
    };
    const label = el("label", { for: id }, p.name, el("span", { class: "sub" }, enabled ? p.note : "Needs an API key on the server"));
    ul.append(el("li", {}, label, box));
  }
  $("#settingsSheet").showModal();
}

function saveSettings() {
  store.set("wc.settings", state.settings);
  render();
}

// ---------- Helpers ----------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// ---------- Demo data (used with ?demo, so the design can be tried without a server) ----------

function demoApi(path) {
  const url = new URL(path, location.href);
  return new Promise((resolve) => setTimeout(() => resolve(demoBody(url)), 250 + Math.random() * 500));
}

function demoBody(url) {
  if (url.pathname === "/api/sources") return Object.keys(SOURCE_NAMES).map((id) => ({ id, enabled: true }));
  if (url.pathname === "/api/geocode") {
    const q = url.searchParams.get("q");
    return [
      { name: q[0].toUpperCase() + q.slice(1), region: "England, United Kingdom", lat: 51.5, lon: -0.12, tz: "Europe/London" },
      { name: q[0].toUpperCase() + q.slice(1) + " Bridge", region: "Scotland, United Kingdom", lat: 55.9, lon: -3.2, tz: "Europe/London" },
    ];
  }
  if (url.pathname === "/api/stations") return demoStations(Number(url.searchParams.get("lat")), Number(url.searchParams.get("lon")));
  const source = url.searchParams.get("source");
  const providers = PROVIDERS.filter((p) => p.source === source).map((p) => demoProvider(p));
  return { providers, fetchedAt: new Date().toISOString() };
}

function demoGauge(i, wet) {
  const hourly = Array.from({ length: 24 }, (_, k) => {
    const shower = wet && k > 15 ? Math.max(0, Math.sin((k - 15 + i) / 2) * 1.6) : k > 3 && k < 8 && i % 2 ? 0.4 * ((k + i) % 3) : 0;
    return { time: new Date(Date.now() - (23 - k) * 3600e3).toISOString(), mm: k === 10 && i === 1 ? null : Math.round(shower * 10) / 10 };
  });
  return { hourly, rain24h: Math.round(hourly.reduce((a, h) => a + (h.mm || 0), 0) * 10) / 10 };
}

function demoStations(lat, lon) {
  const now = Date.now();
  const t = (min) => new Date(now - min * 60000).toISOString();
  const s = (o) => ({ temp: null, humidity: null, wind: null, gust: null, dir: null, rain1h: null, raining: null, pressure: null, wx: null, ...o });
  const kmLat = 1 / 111, kmLon = 1 / (111 * Math.cos((lat * Math.PI) / 180));
  // Spread made-up stations around the centre; real London airport names near London.
  const london = distanceKm(lat, lon, 51.507, -0.128) < 30;
  const base = Math.round(lat * 10) * 7 + Math.round(lon * 10) * 13;
  const rnd = (i) => { const x = Math.sin(base + i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const at = (dx, dy) => ({ lat: lat + dy * kmLat, lon: lon + dx * kmLon, dist: Math.round(Math.hypot(dx, dy) * 10) / 10 });
  const list = [
    s({ id: "EGLC", network: "airport", name: london ? "London City" : "Airport", ...at(12, 0.5), time: t(14), temp: 11.6, wind: 24, gust: 37, dir: 230, raining: true, wx: "light rain", pressure: 1006, cover: "OVC", elev: 6 }),
    s({ id: "EGLL", network: "airport", name: london ? "London/Heathrow" : "Regional airport", ...at(-22, -3), time: t(14), temp: 11.2, wind: 28, dir: 220, raining: true, wx: "rain", pressure: 1006, cover: "BKN", elev: 25 }),
    s({ id: "EGKB", network: "airport", name: london ? "Biggin Hill" : "Airfield", ...at(8, -22), time: t(44), temp: 10.4, wind: 22, dir: 230, raining: false, pressure: 1007, cover: "OVC", elev: 182 }),
    s({ id: "EGGW", network: "airport", name: london ? "Luton" : "Airport north", ...at(-15, 42), time: t(14), temp: 10.1, wind: 30, gust: 44, dir: 240, raining: true, wx: "light rain", pressure: 1005, cover: "OVC", elev: 160 }),
    s({ id: "MO-1", network: "metoffice", name: london ? "London St James's Park" : "Met Office station", ...at(-0.8, -0.9), time: t(31), temp: 11.9, humidity: 91, wind: 17, gust: 33, dir: 225, raining: true, pressure: 1006, elev: 5 }),
  ];
  for (let i = 0; i < 7; i++) {
    const dx = (rnd(i + 200) - 0.5) * 40, dy = (rnd(i + 300) - 0.5) * 34;
    const wet = dx < 6;
    list.push(s({ id: `EA-${i}`, network: "raingauge", name: `Rain gauge, ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 / 45) % 8]} of you`, ...at(dx, dy), time: t(19), rain1h: wet ? Math.round(rnd(i) * 15) / 10 + 0.2 : 0, raining: wet, ...demoGauge(i, wet) }));
  }
  list.sort((a, b) => a.dist - b.dist);
  const history = {
    id: "EGLC", name: list[0].network === "airport" ? list[0].name : "London City", dist: 12.8,
    obs: Array.from({ length: 24 }, (_, i) => ({ time: new Date(now - (24 - i) * 3600e3).toISOString(), temp: 9 + 3 * Math.sin(((i - 6) / 24) * 6.28), wind: 20 })),
  };
  const count = (n) => list.filter((x) => x.network === n).length;
  return {
    stations: list, history, fetchedAt: new Date().toISOString(),
    networks: Object.fromEntries(["airport", "metoffice", "raingauge"].map((n) => [n, { enabled: true, ok: true, count: count(n) }])),
  };
}

function demoProvider(p) {
  let seed = [...p.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const today = placeToday();
  const base = new Date(today + "T00:00:00Z").getTime();
  const nDays = p.id === "accuweather" ? 5 : p.id === "openweather" ? 6 : 7;
  const pattern = [
    { hi: 13, lo: 7, pop: 70, code: "rain", wind: 26, dir: 225 },
    { hi: 11, lo: 5, pop: 40, code: "drizzle", wind: 32, dir: 250 },
    { hi: 12, lo: 4, pop: 10, code: "partly", wind: 16, dir: 300 },
    { hi: 14, lo: 6, pop: 5, code: "clear", wind: 9, dir: 200 },
    { hi: 13, lo: 8, pop: 55, code: "rain", wind: 22, dir: 190 },
    { hi: 10, lo: 6, pop: 85, code: "heavy-rain", wind: 44, dir: 240 },
    { hi: 9, lo: 3, pop: 20, code: "cloudy", wind: 18, dir: 320 },
  ];
  const codes = ["clear", "partly", "cloudy", "drizzle"];
  const days = [];
  const hours = [];
  for (let i = 0; i < nDays; i++) {
    const t = pattern[i];
    const spread = 1 + i * 0.5;
    const hi = Math.round((t.hi + (rnd() - 0.5) * spread * 2) * 10) / 10;
    const lo = Math.round((t.lo + (rnd() - 0.5) * spread * 2) * 10) / 10;
    const pop = Math.max(0, Math.min(100, Math.round(t.pop + (rnd() - 0.5) * 40)));
    let code = t.code;
    if (rnd() < 0.25) code = pop > 50 ? "rain" : codes[Math.floor(rnd() * 4)];
    const mm = pop > 40 ? Math.round(rnd() * pop / 10) / 2 : 0;
    const wind = Math.max(3, t.wind + (rnd() - 0.5) * 12 * spread);
    const gust = wind * (1.4 + rnd() * 0.5);
    const dir = (t.dir + (rnd() - 0.5) * 40 + 360) % 360;
    const date = new Date(base + i * 864e5).toISOString().slice(0, 10);
    const noPop = p.group === "models" && p.id !== "om-gfs";
    days.push({ date, hi, lo, pop: noPop ? null : pop, mm, wind, gust, dir, code });
    if (i < 3 || p.group === "models") {
      for (let h = 0; h < 24; h++) {
        const temp = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(((h - 3) / 24) * 2 * Math.PI));
        const hp = Math.max(0, Math.min(100, Math.round(pop + (rnd() - 0.5) * 50)));
        const hw = wind * (0.6 + 0.4 * Math.sin(((h - 6) / 24) * Math.PI * 2) * 0.5 + 0.3 * rnd());
        hours.push({
          time: `${date}T${String(h).padStart(2, "0")}:00`,
          temp: Math.round(temp * 10) / 10,
          pop: noPop ? null : hp,
          mm: hp > 60 ? 0.5 : 0,
          wind: hw,
          gust: hw * 1.6,
          dir: (dir + (rnd() - 0.5) * 30 + 360) % 360,
          code: hp > 60 ? code : hp > 30 ? "cloudy" : "partly",
        });
      }
    }
  }
  return { id: p.id, name: p.name, note: p.note, ok: true, elevation: p.source === "openmeteo" ? 24 : undefined, days, hours };
}

// ---------- Start ----------

function init() {
  $("#placeBtn").onclick = openPlaceSheet;
  $("#settingsBtn").onclick = openSettings;
  $("#refreshBtn").onclick = () => refresh();
  $("#gpsBtn").onclick = useGps;
  $("#search").oninput = onSearch;
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => goPage(b.dataset.page)));
  window.addEventListener("hashchange", () => { state.page = pageFromHash(); render(); });
  state.page = pageFromHash();
  document.querySelectorAll("#modes button").forEach((b) => (b.onclick = () => {
    state.mode = b.dataset.mode;
    store.set("wc.mode", state.mode);
    render();
  }));
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) =>
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); })
  );
  document.querySelectorAll(".seg").forEach((seg) => {
    seg.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.settings[seg.dataset.setting] = b.dataset.v;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      saveSettings();
    };
  });

  // Swipe left/right on the list to move between days.
  let sx = 0, sy = 0;
  const main = $("#main");
  main.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  main.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (e.target.closest(".hours, .days")) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) selectDay(state.day + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Refresh when coming back to the app after 30 minutes.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.place && Date.now() - (state.fetchedAt || 0) > 30 * 60000) refresh();
  });

  loadSources().then(() => {
    if (state.place && state.place.gps && state.settings.followMe !== false && !DEMO) { setPlace(state.place); locateQuietly(); }
    else if (state.place) setPlace(state.place);
    else if (DEMO) setPlace({ name: "London", region: "England, United Kingdom", lat: 51.507, lon: -0.128, tz: "Europe/London" });
    else { render(); useGps(); }
  });
  render();

  if ("serviceWorker" in navigator && !DEMO && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
