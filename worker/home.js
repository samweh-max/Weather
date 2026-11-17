// Your own weather station on CampbellON (Campbell Scientific's cloud, campbellon.com).
//
// /api/home returns one station in the same shape as the other networks (see stations.js),
// with network "home", plus a 24-hour hourly track used to check the forecasts:
//
//   { station: {..., rain24h, hourly, readings}, history: { id, name, dist, obs: [{time, temp, wind}] }, dist }
//
// /api/home/history returns chosen sensors between two dates (see homeHistory).
// It is kept apart from /api/stations so the other stations never wait for it.
//
// Sign-in (set as Cloudflare secrets, never in the repo):
//   CAMPBELL_CLIENT_ID + CAMPBELL_CLIENT_SECRET   a service account (best: keeps working with SSO)
//   or CAMPBELL_USERNAME + CAMPBELL_PASSWORD      your own CampbellON login
// Plain settings (wrangler.toml [vars]):
//   CAMPBELL_STATION_ID   the station's id
//   CAMPBELL_ORG_ID       optional; found automatically when left out
//   CAMPBELL_BASE         optional; defaults to https://campbellon.com
//
// CampbellON allows about 200 calls an hour, so everything is cached: the sign-in token until
// it expires, the station and its list of sensors for hours, and the reading itself for 5
// minutes (an older copy is served at once while a new one is fetched behind it).

import { distKm } from "./stations.js";

const MIN = 60e3, HOUR = 3600e3;

export function homeConfigured(env) {
  return !!(env.CAMPBELL_STATION_ID && ((env.CAMPBELL_CLIENT_ID && env.CAMPBELL_CLIENT_SECRET) || (env.CAMPBELL_USERNAME && env.CAMPBELL_PASSWORD)));
}

// The station near a place: the shared reading (see homeData) with the distance added.
// Far from home it still answers, with `far` set, so the app can say how far away it is.
export async function homeNear({ lat, lon }, env, ctx, fetcher = fetch, fresh = false) {
  const data = await homeData(env, ctx, fetcher, fresh);
  const s = data.station;
  const dist = s.lat != null && s.lon != null ? round(distKm(lat, lon, s.lat, s.lon), 1) : 0;
  return { ...data, station: { ...s, dist }, history: data.history ? { ...data.history, dist } : null, dist };
}

// Kept for older callers and tests: the station and its track, with the distance from a place.
export async function homeStation(place, env, fetcher = fetch) {
  const r = await homeNear(place, env, null, fetcher);
  return { station: r.station, history: r.history };
}

const FRESH = 5 * MIN, KEEP = 3 * 24 * HOUR;

// The station's reading, served from the last copy straight away. A copy older than five
// minutes is still served, and a new one is fetched in the background for the next visit,
// so opening the app never waits on CampbellON unless there is no copy at all.
// `fresh` (the refresh button) waits for a new reading unless the copy is under a minute old.
export async function homeData(env, ctx, fetcher = fetch, fresh = false) {
  const api = client(env, fetcher);
  const key = new Request(`https://cache.weather/campbell/${encodeURIComponent(api.who || "")}/${env.CAMPBELL_STATION_ID}/result`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = cache ? await cache.match(key).then((r) => r && r.json()).catch(() => null) : null;
  const save = async () => {
    const data = await readHome(api, env);
    const body = { at: Date.now(), data };
    if (cache) await cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${KEEP / 1000}` } }));
    return data;
  };
  if (hit && hit.data) {
    const age = Date.now() - hit.at;
    if (age < (fresh ? 60e3 : FRESH)) return hit.data;
    if (fresh) return save().catch(() => ({ ...hit.data, stale: true }));
    const refresh = save().catch(() => null);
    if (ctx && ctx.waitUntil) { ctx.waitUntil(refresh); return { ...hit.data, stale: true }; }
    return (await refresh) || { ...hit.data, stale: true };
  }
  return save();
}

async function readHome(api, env) {
  const sid = env.CAMPBELL_STATION_ID;
  const org = await orgOf(api, env);
  const [meta, list] = await Promise.all([
    api.cached(`station/${sid}`, 12 * HOUR, () => api.get(`/api/v1/organizations/${org}/stations/${sid}`)),
    sensorList(api, org, sid),
  ]);
  if (!list.length) throw new Error("No sensors found on this station");

  const ids = list.map((d) => d.id).slice(0, 200);
  const latest = await api.get(`/api/v1/data/organizations/${org}/datapoints/latest?datastream_ids=${ids.join(",")}`);
  const readings = Object.entries(latest?.data || {})
    .map(([id, r]) => {
      const d = list.find((x) => x.id === id);
      return { id, field: r.field_name || d?.metadata?.field || "", table: r.table_name || d?.metadata?.table || "", unit: r.unit || d?.metadata?.unit || d?.metadata?.units || guessUnit(r.field_name || d?.metadata?.field || ""), ts: r.ts, value: r.value, interval: d?.metadata?.interval };
    })
    .filter((r) => r.field);

  const pick = pickSensors(readings);
  const m = meta?.metadata || {};
  const loc = m.location || {};
  const sLat = num(loc.latitude), sLon = num(loc.longitude);
  const val = (k) => (pick[k] ? convert(k, pick[k].value, pick[k].unit) : null);

  // The last 24 hours of temperature, wind and rain, bucketed into hours.
  const end = Date.now(), start = end - 26 * HOUR;
  const series = async (k) => {
    if (!pick[k]) return [];
    const out = await api.get(`/api/v1/organizations/${org}/datastreams/${pick[k].id}/datapoints?startEpoch=${start}&endEpoch=${end}&limit=15000`);
    return points(out, k, pick[k].unit);
  };
  const [temps, winds, rains] = await Promise.all([series("temp"), series("wind"), series("rain")]);

  const times = [pick.temp, pick.wind, pick.rain, ...readings].filter(Boolean).map((r) => Date.parse(r.ts)).filter(isFinite);
  const last = times.length ? Math.max(...times) : null;
  let rain1h = null, rain24h = null, hourly = null;
  if (rains.length) {
    const to = Math.max(...rains.map((p) => p.t));
    const sum = (from, upto) => round(rains.filter((p) => p.t > from && p.t <= upto).reduce((a, p) => a + p.v, 0), 1);
    rain1h = sum(to - HOUR, to);
    rain24h = sum(to - 24 * HOUR, to);
    hourly = Array.from({ length: 24 }, (_, i) => {
      const upto = to - (23 - i) * HOUR, from = upto - HOUR;
      const any = rains.some((p) => p.t > from && p.t <= upto);
      return { time: new Date(upto).toISOString(), mm: any ? sum(from, upto) : null };
    });
  } else if (pick.rain) {
    rain1h = val("rain");
  }

  const name = m.name || m.alias || "My station";
  const picked = new Set(Object.values(pick).map((r) => r.id));
  const station = {
    id: `CC-${sid}`,
    network: "home",
    mine: true,
    name,
    lat: sLat, lon: sLon,
    time: last ? new Date(last).toISOString() : null,
    temp: round1(val("temp")),
    humidity: round1(val("humidity")),
    wind: round1(val("wind")),
    gust: round1(val("gust")),
    dir: val("dir") != null ? Math.round(val("dir")) % 360 : null,
    rain1h,
    rain24h,
    hourly,
    raining: rain1h == null ? null : rain1h >= 0.2,
    pressure: round1(val("pressure")),
    wx: null,
    elev: num(loc.elevation),
    // Every sensor's latest reading, for the station card and the history explorer.
    // `kind` marks the ones the app understands; `main` the one used for each kind.
    readings: readings
      .filter((r) => typeof r.value === "number" && isFinite(r.value))
      .map((r) => {
        const kind = kindOf(r.field, r.unit);
        return { id: r.id, field: r.field, table: r.table, interval: r.interval || null, value: r.value, unit: r.unit, ts: r.ts, kind, main: picked.has(r.id) || undefined };
      }),
  };

  // Hour by hour, the reading closest to the top of each hour (like an airport report).
  const byHour = new Map();
  const put = (k, pts) => {
    for (const p of pts) {
      const h = Math.round(p.t / HOUR) * HOUR;
      if (Math.abs(p.t - h) > 20 * MIN) continue;
      const o = byHour.get(h) || {};
      if (o[k + "D"] == null || Math.abs(p.t - h) < o[k + "D"]) { o[k] = p.v; o[k + "D"] = Math.abs(p.t - h); }
      byHour.set(h, o);
    }
  };
  put("temp", temps);
  put("wind", winds);
  const obs = [...byHour.entries()].sort((a, b) => a[0] - b[0])
    .map(([h, o]) => ({ time: new Date(h).toISOString(), temp: o.temp != null ? round1(o.temp) : null, wind: o.wind != null ? round1(o.wind) : null }))
    .filter((o) => o.temp != null || o.wind != null);
  const history = obs.length ? { id: station.id, name, home: true, obs } : null;
  return { station, history };
}

async function orgOf(api, env) {
  return env.CAMPBELL_ORG_ID || api.cached("org", 24 * HOUR, () => findOrg(api, env.CAMPBELL_STATION_ID));
}
async function sensorList(api, org, sid) {
  const streams = await api.cached(`streams/${sid}`, 6 * HOUR, () =>
    api.get(`/api/v1/organizations/${org}/datastreams?stationId=${sid}&status=active&limit=1000`));
  return (Array.isArray(streams) ? streams : streams?.data || []).filter((d) => d && d.id);
}
function points(out, k, unit) {
  return (out?.data || []).filter((p) => typeof p.value === "number" && isFinite(p.value))
    .map((p) => ({ t: typeof p.ts === "number" ? p.ts : Date.parse(p.ts), v: k ? convert(k, p.value, unit) : p.value }))
    .filter((p) => isFinite(p.t) && p.v != null);
}

// ---------- History: any sensors, any dates ----------

const STEPS = [5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * 24 * HOUR];
const MAX_SPAN = 400 * 24 * HOUR;

// The readings of chosen sensors between two times, grouped into at most ~400 steps
// (5 minutes for a day, a day for a year). Each step has the average, lowest, highest and
// total, in the app's units for the sensors it understands.
// `offset` is the phone's offset from UTC in minutes, so days start at local midnight.
export async function homeHistory({ from, to, ids, offset = 0 }, env, ctx, fetcher = fetch) {
  if (!(isFinite(from) && isFinite(to) && to > from)) throw new Error("Pick a start and an end");
  if (to - from > MAX_SPAN) throw new Error("Pick a range of a year or less");
  const api = client(env, fetcher);
  const org = await orgOf(api, env);
  const [list, now] = await Promise.all([sensorList(api, org, env.CAMPBELL_STATION_ID), homeData(env, ctx, fetcher)]);
  const units = Object.fromEntries((now.station.readings || []).map((r) => [r.id, r.unit]));
  const wanted = list.filter((d) => ids.includes(d.id)).slice(0, 8);
  if (!wanted.length) throw new Error("Those sensors aren't on this station");

  const span = to - from;
  const series = {};
  await Promise.all(wanted.map(async (d) => {
    const every = isoMs(d.metadata?.interval);
    const each = isFinite(every) ? every : 15 * MIN;
    const step = STEPS.find((s) => s >= each && span / s <= 400) || STEPS[STEPS.length - 1];
    // CampbellON returns at most 15,000 points a call, so long ranges are read in pieces.
    const pieces = Math.min(8, Math.max(1, Math.ceil(span / each / 14000)));
    const part = Math.ceil(span / pieces);
    const unit = units[d.id] || "";
    const kind = kindOf(d.metadata?.field || "", unit);
    const chunks = await Promise.all(Array.from({ length: pieces }, (_, i) => {
      const a = from + i * part, b = Math.min(to, a + part);
      return api.get(`/api/v1/organizations/${org}/datastreams/${d.id}/datapoints?startEpoch=${a}&endEpoch=${b}&limit=15000`);
    }));
    const pts = chunks.flatMap((c) => points(c, kind, unit));
    series[d.id] = { field: d.metadata?.field || "", kind, step, buckets: bucket(pts, step, offset * MIN, kind === "dir") };
  }));
  return { from, to, series };
}

// `circular` is for wind direction: 350° and 10° average to north, not south.
export function bucket(pts, step, off = 0, circular = false) {
  const map = new Map();
  const R = Math.PI / 180;
  for (const p of pts) {
    const t = Math.floor((p.t + off) / step) * step - off;
    const b = map.get(t) || { t, s: 0, n: 0, min: Infinity, max: -Infinity, x: 0, y: 0 };
    b.s += p.v; b.n++; b.min = Math.min(b.min, p.v); b.max = Math.max(b.max, p.v);
    if (circular) { b.x += Math.cos(p.v * R); b.y += Math.sin(p.v * R); }
    map.set(t, b);
  }
  return [...map.values()].sort((a, b) => a.t - b.t).map((b) => ({
    t: b.t,
    avg: round(circular ? ((Math.atan2(b.y, b.x) / R) + 360) % 360 : b.s / b.n, 2),
    min: round(b.min, 2), max: round(b.max, 2), sum: round(b.s, 2), n: b.n,
  }));
}

// ---------- Which sensor is which ----------

// Logger programs name fields freely (AirTC_Avg, AirTemp_C, WS_ms_S_WVT, Rain_mm_Tot…), so
// recognise them by name and unit, and skip the logger's own panel temperature, battery, soil etc.
const KINDS = {
  temp: { re: /(air.?t|^t_?air|^temp|^t107|^t109|^hc2s3.*t|^airtc|^ta(_|$)|airtemp)/i, unit: /°?\s*(c|f)$|deg\s*[cf]|celsius|fahrenheit/i },
  humidity: { re: /(^rh|humid)/i, unit: /%/ },
  gust: { re: /(gust|^ws.*max|wind.?spe*d.*max|^wsmax)/i, unit: /(m\/s|met(er|re)s?\/s|mps|km\/h|kph|mph|kn|knot)/i },
  wind: { re: /(^ws(_|$|ms|m_s|_ms|_kph|_mph)|wind.?sp|windspeed|^wspd|^ws_)/i, unit: /(m\/s|met(er|re)s?\/s|mps|km\/h|kph|mph|kn|knot)/i },
  dir: { re: /(^wd|wind.?dir|^dir)/i, unit: /(deg|°|^$)/i },
  rain: { re: /(rain|precip|^ppt|^tb4|^tr525|^tb3)/i, unit: /(mm|in|inch)/i },
  pressure: { re: /(^bp|baro|press|^mslp|^p_?(hpa|mbar))/i, unit: /(hpa|mbar|mb|kpa|inhg|pa)$/i },
};
const SKIP = /(^ptemp|panel|batt|volt|soil|water|leaf|surf|snow|road|_std|stdev|_min$|_tmn|^min|dewp|dew_?pt|wetbulb|heat|chill|ytd|accum|cum|daily|_day|24h|_rate|intens|sigma|sd_|_sd)/i;

// Some loggers send values without units. Fill in the usual Campbell ones from the field name,
// so readings aren't shown as bare numbers.
const GUESS = [
  [/^(airtc|airtemp|air_?temp|ptemp|paneltemp|t107|t109|soil_?t|t_?soil)|^t(_avg|_c)?$|temp_?c/i, "Deg C"],
  [/^rh|humid/i, "%"],
  [/^ws|wind.?sp/i, "meters/second"],
  [/wind.?dir|^wd/i, "degrees"],
  [/rain|precip/i, "mm"],
  [/^bp|baro/i, "mbar"],
  [/^batt|battery|volt/i, "Volts"],
  [/vwc/i, "m^3/m^3"],
  [/^ec(_|$)/i, "dS/m"],
  [/^slr.*w|^sw_?in|solar.*w/i, "W/m^2"],
];
export function guessUnit(field) {
  if (/diag|record|^pa(_|$)|^vr(_|$)|^p(_avg)?$/i.test(field)) return "";
  const hit = GUESS.find(([re]) => re.test(field));
  return hit ? hit[1] : "";
}

export function kindOf(field, unit) {
  if (SKIP.test(field)) return null;
  const order = ["gust", "temp", "humidity", "dir", "wind", "rain", "pressure"];
  for (const k of order) {
    const spec = KINDS[k];
    if (spec.re.test(field) && (!unit || spec.unit.test(unit.trim()))) {
      if (k === "temp" && /max|tmx/i.test(field)) return null;
      if (k === "wind" && /max|gust/i.test(field)) return "gust";
      if (k === "dir" && /std|sd/i.test(field)) return null;
      return k;
    }
  }
  return null;
}

const isoMs = (d) => {
  const m = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(d || "");
  if (!m) return Infinity;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 || Infinity;
};

// For each kind, the freshest sensor; among equally fresh ones, an average beats a sample,
// and for rain the shortest interval (so hourly sums are right).
export function pickSensors(readings) {
  const out = {};
  for (const r of readings) {
    if (typeof r.value !== "number" || !isFinite(r.value)) continue;
    const k = kindOf(r.field, r.unit);
    if (!k) continue;
    const prev = out[k];
    if (!prev || better(k, r, prev)) out[k] = r;
  }
  return out;
}
function better(k, a, b) {
  const ta = Date.parse(a.ts) || 0, tb = Date.parse(b.ts) || 0;
  if (k === "rain" && isoMs(a.interval) !== isoMs(b.interval)) return isoMs(a.interval) < isoMs(b.interval);
  if (Math.abs(ta - tb) > 30 * MIN) return ta > tb;
  const avg = (r) => (/avg|wvt|_s_|mean/i.test(r.field) ? 1 : 0);
  return avg(a) > avg(b);
}

// Everything out in °C, %, km/h, degrees, mm and hPa.
export function convert(k, v, unit) {
  if (typeof v !== "number" || !isFinite(v)) return null;
  const u = (unit || "").toLowerCase().replace(/\s+/g, "");
  if (k === "temp") return /f$|fahrenheit/.test(u) ? (v - 32) / 1.8 : v;
  if (k === "wind" || k === "gust") {
    if (/km\/h|kph|kmh/.test(u)) return v;
    if (/mph/.test(u)) return v * 1.609344;
    if (/kn|knot/.test(u)) return v * 1.852;
    return v * 3.6; // m/s, the logger default
  }
  if (k === "rain") return /^in|inch/.test(u) ? v * 25.4 : v;
  if (k === "pressure") {
    if (/inhg/.test(u)) return v * 33.8639;
    if (/kpa/.test(u)) return v * 10;
    if (/^pa$/.test(u)) return v / 100;
    return v;
  }
  return v;
}

// ---------- CampbellON calls ----------

let memToken = null; // { key, token, until }

function client(env, fetcher) {
  const base = (env.CAMPBELL_BASE || "https://campbellon.com").replace(/\/+$/, "");
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const who = env.CAMPBELL_CLIENT_ID || env.CAMPBELL_USERNAME;

  async function token(force) {
    if (!force && memToken && memToken.key === who && memToken.until > Date.now()) return memToken.token;
    const body = env.CAMPBELL_CLIENT_ID && env.CAMPBELL_CLIENT_SECRET
      ? { grant_type: "client_credentials", client_id: env.CAMPBELL_CLIENT_ID, client_secret: env.CAMPBELL_CLIENT_SECRET }
      : { grant_type: "password", client_id: "cloud", username: env.CAMPBELL_USERNAME, password: env.CAMPBELL_PASSWORD };
    const res = await fetcher(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CampbellON sign-in returned ${res.status}${res.status === 400 || res.status === 401 ? " (check the login)" : ""}`);
    const t = await res.json();
    if (!t.access_token) throw new Error("CampbellON sign-in gave no token");
    memToken = { key: who, token: t.access_token, until: Date.now() + Math.max(60, (t.expires_in || 3600) - 120) * 1000 };
    return memToken.token;
  }

  async function get(path, retried) {
    const res = await fetcher(base + path, { headers: { Authorization: `Bearer ${await token(retried)}`, accept: "application/json" } });
    if (res.status === 401 && !retried) return get(path, true);
    if (res.status === 429) throw new Error("CampbellON hourly limit reached, try again later");
    if (!res.ok) throw new Error(`CampbellON returned ${res.status}${res.status === 403 ? " (this login can't see that station)" : res.status === 404 ? " (station not found)" : ""}`);
    return res.json();
  }

  async function cached(name, ttlMs, make) {
    const key = new Request(`https://cache.weather/campbell/${encodeURIComponent(who || "")}/${name}`);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) return hit.json();
    }
    const value = await make();
    if (cache) {
      await cache.put(key, new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${Math.round(ttlMs / 1000)}` },
      }));
    }
    return value;
  }

  return { get, cached, who };
}

// Without an organisation id, use the first organisation this login belongs to that has the station.
async function findOrg(api, sid) {
  const orgs = await api.get("/api/v1/organizations");
  const list = Array.isArray(orgs) ? orgs : orgs?.data || [];
  if (!list.length) throw new Error("This login isn't in any CampbellON organisation");
  if (list.length === 1) return list[0].id;
  for (const o of list) {
    try { await api.get(`/api/v1/organizations/${o.id}/stations/${sid}`); return o.id; } catch { /* try the next */ }
  }
  throw new Error("Station not found in this login's organisations");
}

function num(x) {
  return typeof x === "number" && isFinite(x) ? x : null;
}
function round(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
function round1(x) {
  return x == null ? null : round(x, 1);
}
