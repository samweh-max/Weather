// Live readings from UK weather stations near a place, in one shape:
//
//   { id, network, name, lat, lon, dist, time, temp, humidity, wind, gust, dir,
//     rain1h, raining, pressure, wx, cover, elev }
// (cover: airport cloud cover code such as OVC; elev: station height in metres, when known)
//
// Units: °C, km/h, mm, hPa. `dist` is km from the place. `time` is ISO (UTC).
// Networks:
//   airport    – airport METAR reports via aviationweather.gov (free, no key)
//   raingauge  – Environment Agency rain gauges, England (free, no key)
//   metoffice  – Met Office land observations (free DataHub key, separate subscription)
//   netatmo    – Netatmo home weather stations shared publicly (free developer app)

const KT = 1.852;

export async function stationsNear({ lat, lon }, env) {
  const jobs = {
    airport: () => airports(lat, lon),
    raingauge: () => rainGauges(lat, lon),
    metoffice: env.METOFFICE_OBS_KEY || env.METOFFICE_KEY ? () => metOfficeObs(lat, lon, env) : null,
    netatmo: env.NETATMO_CLIENT_ID && env.NETATMO_CLIENT_SECRET && env.NETATMO_REFRESH_TOKEN ? () => netatmo(lat, lon, env) : null,
  };
  const networks = {};
  const stations = [];
  let history = null;
  await Promise.all(
    Object.entries(jobs).map(async ([id, job]) => {
      if (!job) { networks[id] = { enabled: false }; return; }
      try {
        const out = await job();
        networks[id] = { enabled: true, ok: true, count: out.stations.length };
        stations.push(...out.stations);
        if (out.history) history = out.history;
      } catch (err) {
        networks[id] = { enabled: true, ok: false, error: String(err.message || err) };
      }
    })
  );
  stations.sort((a, b) => a.dist - b.dist);
  return { stations, networks, history };
}

// ---------- Airports (METAR) ----------

async function airports(lat, lon) {
  const bbox = [lat - 1.2, lon - 2, lat + 1.2, lon + 2].map((x) => x.toFixed(2)).join(",");
  const list = await getJson(`https://aviationweather.gov/api/data/metar?bbox=${bbox}&format=json&hours=2`, {
    headers: { "User-Agent": "weather-compare/1.0" },
  });
  const latest = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    const prev = latest.get(m.icaoId);
    if (!prev || m.obsTime > prev.obsTime) latest.set(m.icaoId, m);
  }
  const stations = [...latest.values()]
    .map((m) => metarStation(m, lat, lon))
    .filter((s) => s.dist <= 90)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);

  // The last 24 hours at the nearest airport, used to check how well each source has been doing.
  let history = null;
  if (stations[0]) {
    const past = await getJson(`https://aviationweather.gov/api/data/metar?ids=${stations[0].id}&format=json&hours=26`, {
      headers: { "User-Agent": "weather-compare/1.0" },
    }).catch(() => []);
    history = {
      id: stations[0].id,
      name: stations[0].name,
      dist: stations[0].dist,
      obs: (Array.isArray(past) ? past : [])
        .map((m) => ({ time: new Date(m.obsTime * 1000).toISOString(), temp: num(m.temp), wind: m.wspd != null ? m.wspd * KT : null }))
        .filter((o) => o.temp != null)
        .sort((a, b) => a.time.localeCompare(b.time)),
    };
  }
  return { stations, history };
}

function metarStation(m, lat, lon) {
  const wx = m.wxString || "";
  return {
    id: m.icaoId,
    network: "airport",
    name: cleanName(m.name) || m.icaoId,
    lat: m.lat,
    lon: m.lon,
    dist: round(distKm(lat, lon, m.lat, m.lon), 1),
    time: new Date(m.obsTime * 1000).toISOString(),
    temp: num(m.temp),
    humidity: m.temp != null && m.dewp != null ? round(rh(m.temp, m.dewp), 0) : null,
    wind: m.wspd != null ? round(m.wspd * KT, 1) : null,
    gust: m.wgst != null ? round(m.wgst * KT, 1) : null,
    dir: typeof m.wdir === "number" ? m.wdir : null,
    rain1h: null,
    raining: /RA|DZ|SH|TS|SN|PL|GR|GS/.test(wx),
    pressure: num(m.altim),
    wx: metarWords(wx),
    cover: m.cover || null,
    elev: num(m.elev),
  };
}

function cleanName(n) {
  return n ? n.replace(/,\s*[A-Z]{2},\s*GB$/, "").replace(/\bIntl\b/, "").replace(/\s+/g, " ").trim() : n;
}

function metarWords(wx) {
  if (!wx) return null;
  const parts = [];
  if (/TS/.test(wx)) parts.push("thunder");
  if (/SN/.test(wx)) parts.push("snow");
  if (/RA/.test(wx)) parts.push(/\+RA/.test(wx) ? "heavy rain" : /-RA/.test(wx) ? "light rain" : "rain");
  else if (/DZ/.test(wx)) parts.push("drizzle");
  if (/SH/.test(wx) && !/RA|SN/.test(wx)) parts.push("showers");
  if (/FG/.test(wx)) parts.push("fog");
  else if (/BR/.test(wx)) parts.push("mist");
  return parts.join(", ") || null;
}

// ---------- Environment Agency rain gauges ----------

async function rainGauges(lat, lon) {
  const base = "https://environment.data.gov.uk/flood-monitoring";
  const list = await getJson(`${base}/id/stations?parameter=rainfall&lat=${lat.toFixed(4)}&long=${lon.toFixed(4)}&dist=25`);
  const near = (list.items || [])
    .filter((s) => typeof s.lat === "number" && typeof s.long === "number")
    .map((s) => ({ s, dist: distKm(lat, lon, s.lat, s.long) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);
  const stations = await Promise.all(
    near.map(async ({ s, dist }) => {
      const r = await getJson(`${base}/id/stations/${encodeURIComponent(s.notation)}/readings?_sorted&_limit=8&parameter=rainfall`).catch(() => ({ items: [] }));
      const items = (r.items || []).filter((x) => typeof x.value === "number").sort((a, b) => b.dateTime.localeCompare(a.dateTime));
      const latest = items[0];
      let rain1h = null;
      if (latest) {
        const cutoff = Date.parse(latest.dateTime) - 3600e3;
        rain1h = round(items.filter((x) => Date.parse(x.dateTime) > cutoff).reduce((a, x) => a + x.value, 0), 1);
      }
      return {
        id: `EA-${s.notation}`,
        network: "raingauge",
        name: s.label && s.label !== "Rainfall station" ? s.label : `Rain gauge, ${bearing(lat, lon, s.lat, s.long)} of you`,
        lat: s.lat,
        lon: s.long,
        dist: round(dist, 1),
        time: latest ? latest.dateTime : null,
        temp: null, humidity: null, wind: null, gust: null, dir: null,
        rain1h,
        raining: rain1h == null ? null : rain1h >= 0.2,
        pressure: null,
        wx: null,
      };
    })
  );
  // Leave out gauges that haven't reported for 6 hours.
  const fresh = stations.filter((s) => s.time && Date.now() - Date.parse(s.time) < 6 * 3600e3);
  return { stations: fresh };
}

// ---------- Met Office land observations ----------

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

async function metOfficeObs(lat, lon, env) {
  const base = "https://data.hub.api.metoffice.gov.uk/observation-land/1";
  const opts = { headers: { apikey: env.METOFFICE_OBS_KEY || env.METOFFICE_KEY, accept: "application/json" } };
  const near = await getJson(`${base}/nearest?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, opts);
  const site = Array.isArray(near) ? near[0] : near?.features?.[0]?.properties || near;
  if (!site || !site.geohash) return { stations: [] };
  const obs = await getJson(`${base}/${site.geohash}`, opts);
  const rows = (Array.isArray(obs) ? obs : obs?.observations || []).filter((o) => o && o.datetime);
  rows.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  const o = rows[0];
  if (!o) return { stations: [] };
  const dir = typeof o.wind_direction === "number" ? o.wind_direction : COMPASS.indexOf(o.wind_direction) >= 0 ? COMPASS.indexOf(o.wind_direction) * 22.5 : null;
  const sLat = num(site.latitude ?? site.lat);
  const sLon = num(site.longitude ?? site.lon);
  return {
    stations: [{
      id: `MO-${site.geohash}`,
      network: "metoffice",
      name: site.area || site.name || "Met Office station",
      lat: sLat, lon: sLon,
      dist: sLat != null && sLon != null ? round(distKm(lat, lon, sLat, sLon), 1) : 0,
      time: new Date(o.datetime).toISOString(),
      temp: num(o.temperature),
      humidity: num(o.humidity),
      // DataHub reports wind in knots.
      wind: o.wind_speed != null ? round(o.wind_speed * KT, 1) : null,
      gust: o.wind_gust != null ? round(o.wind_gust * KT, 1) : null,
      dir,
      rain1h: null,
      raining: o.weather_code != null ? o.weather_code >= 9 && o.weather_code <= 30 : null,
      pressure: num(o.mslp),
      wx: null,
    }],
  };
}

// ---------- Netatmo public home stations ----------

async function netatmoToken(env) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://cache.weather/netatmo-token");
  const hit = cache && (await cache.match(key));
  if (hit) return (await hit.json()).access_token;
  const refresh = (env.TOKENS && (await env.TOKENS.get("netatmo_refresh"))) || env.NETATMO_REFRESH_TOKEN;
  const res = await fetch("https://api.netatmo.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: env.NETATMO_CLIENT_ID,
      client_secret: env.NETATMO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Netatmo sign-in failed (${res.status})`);
  const tok = await res.json();
  // Netatmo can hand back a new refresh token; keep it if we have somewhere to put it.
  if (tok.refresh_token && tok.refresh_token !== refresh && env.TOKENS) await env.TOKENS.put("netatmo_refresh", tok.refresh_token);
  if (cache) {
    await cache.put(key, new Response(JSON.stringify({ access_token: tok.access_token }), {
      headers: { "Cache-Control": `public, max-age=${Math.max(60, (tok.expires_in || 10800) - 300)}` },
    }));
  }
  return tok.access_token;
}

async function netatmo(lat, lon, env) {
  const token = await netatmoToken(env);
  const d = 0.12;
  const q = new URLSearchParams({ lat_ne: lat + d, lon_ne: lon + d * 1.6, lat_sw: lat - d, lon_sw: lon - d * 1.6, filter: "true" });
  const data = await getJson(`https://api.netatmo.com/api/getpublicdata?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const out = [];
  for (const st of data.body || []) {
    const [sLon, sLat] = st.place?.location || [];
    if (typeof sLat !== "number") continue;
    const s = {
      id: `NA-${st._id}`, network: "netatmo", name: st.place?.street || st.place?.city || "Home station",
      lat: sLat, lon: sLon, dist: round(distKm(lat, lon, sLat, sLon), 1), time: null, elev: num(st.place?.altitude),
      temp: null, humidity: null, wind: null, gust: null, dir: null, rain1h: null, raining: null, pressure: null, wx: null,
    };
    for (const m of Object.values(st.measures || {})) {
      if (m.res && m.type) {
        const [ts, vals] = Object.entries(m.res)[0] || [];
        if (!vals) continue;
        m.type.forEach((t, i) => {
          if (t === "temperature") s.temp = num(vals[i]);
          if (t === "humidity") s.humidity = num(vals[i]);
          if (t === "pressure") s.pressure = num(vals[i]);
        });
        if (ts) s.time = new Date(Number(ts) * 1000).toISOString();
      }
      if (m.rain_60min != null) { s.rain1h = num(m.rain_60min); s.raining = s.rain1h >= 0.2; }
      if (m.wind_strength != null) { s.wind = num(m.wind_strength); s.gust = num(m.gust_strength); s.dir = num(m.wind_angle); }
    }
    if (s.temp != null || s.rain1h != null || s.wind != null) out.push(s);
  }
  // Home stations can sit in the sun or by a wall. Drop readings far from the local median.
  const temps = out.map((s) => s.temp).filter((t) => t != null).sort((a, b) => a - b);
  const med = temps.length ? temps[temps.length >> 1] : null;
  const kept = out.filter((s) => s.temp == null || med == null || Math.abs(s.temp - med) <= 3);
  return { stations: kept.sort((a, b) => a.dist - b.dist).slice(0, 15) };
}

// ---------- Helpers ----------

export function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  const deg = ((Math.atan2(y, x) / r) + 360) % 360;
  return POINTS[Math.round(deg / 45) % 8];
}
function rh(t, td) {
  const f = (x) => Math.exp((17.625 * x) / (243.04 + x));
  return Math.min(100, (100 * f(td)) / f(t));
}
async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Returned ${res.status}${res.status === 401 || res.status === 403 ? " (check the key)" : ""}`);
  return res.json();
}
function num(x) {
  return typeof x === "number" && isFinite(x) ? x : null;
}
function round(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
