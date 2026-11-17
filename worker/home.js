// Your own weather station on CampbellON (Campbell Scientific's cloud, campbellon.com).
//
// Returns one station in the same shape as the other networks (see stations.js), with
// network "home", plus a 24-hour hourly track used to check the forecasts:
//
//   { station: {..., rain24h, hourly, readings}, history: { id, name, dist, obs: [{time, temp, wind}] } }
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
// it expires, the station and its list of sensors for hours, the latest readings for 5 minutes
// and the 24-hour track for 15 minutes.

import { distKm } from "./stations.js";

const MIN = 60e3, HOUR = 3600e3;

export function homeConfigured(env) {
  return !!(env.CAMPBELL_STATION_ID && ((env.CAMPBELL_CLIENT_ID && env.CAMPBELL_CLIENT_SECRET) || (env.CAMPBELL_USERNAME && env.CAMPBELL_PASSWORD)));
}

export async function homeStation({ lat, lon }, env, fetcher = fetch) {
  const api = client(env, fetcher);
  const sid = env.CAMPBELL_STATION_ID;
  const org = env.CAMPBELL_ORG_ID || (await api.cached("org", 24 * HOUR, () => findOrg(api, sid)));
  const meta = await api.cached(`station/${sid}`, 12 * HOUR, () => api.get(`/api/v1/organizations/${org}/stations/${sid}`));
  const streams = await api.cached(`streams/${sid}`, 6 * HOUR, () =>
    api.get(`/api/v1/organizations/${org}/datastreams?stationId=${sid}&status=active&limit=1000`));
  const list = (Array.isArray(streams) ? streams : streams?.data || []).filter((d) => d && d.id);
  if (!list.length) throw new Error("No sensors found on this station");

  const ids = list.map((d) => d.id).slice(0, 200);
  const latest = await api.cached(`latest/${sid}`, 5 * MIN, () =>
    api.get(`/api/v1/data/organizations/${org}/datapoints/latest?datastream_ids=${ids.join(",")}`));
  const readings = Object.entries(latest?.data || {})
    .map(([id, r]) => {
      const d = list.find((x) => x.id === id);
      return { id, field: r.field_name || d?.metadata?.field || "", table: r.table_name || d?.metadata?.table || "", unit: r.unit || "", ts: r.ts, value: r.value, interval: d?.metadata?.interval };
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
    const out = await api.cached(`series/${pick[k].id}`, 15 * MIN, () =>
      api.get(`/api/v1/organizations/${org}/datastreams/${pick[k].id}/datapoints?startEpoch=${start}&endEpoch=${end}&limit=15000`));
    return (out?.data || []).filter((p) => typeof p.value === "number" && isFinite(p.value))
      .map((p) => ({ t: typeof p.ts === "number" ? p.ts : Date.parse(p.ts), v: convert(k, p.value, pick[k].unit) }))
      .filter((p) => isFinite(p.t) && p.v != null);
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
  const station = {
    id: `CC-${sid}`,
    network: "home",
    mine: true,
    name,
    lat: sLat, lon: sLon,
    dist: sLat != null && sLon != null ? round(distKm(lat, lon, sLat, sLon), 1) : 0,
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
    // Every sensor's latest reading, for the station card.
    readings: readings
      .filter((r) => typeof r.value === "number" && isFinite(r.value))
      .map((r) => ({ field: r.field, value: r.value, unit: r.unit, ts: r.ts })),
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
  const history = obs.length ? { id: station.id, name, dist: station.dist, home: true, obs } : null;
  return { station, history };
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

  return { get, cached };
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
