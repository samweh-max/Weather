// Cloudflare Worker: serves the app (from /public) and a small JSON API that
// fetches each weather provider, hides the API keys, and returns every
// forecast in one common shape:
//
//   { id, name, note, ok, days: [{date, hi, lo, pop, mm, wind, gust, dir, code}],
//     hours: [{time, temp, pop, mm, wind, gust, dir, code}] }
//
// `dir` is the direction the wind blows FROM, in degrees (0 = north).
//
// Units are always °C, mm and km/h. Times are local to the place ("YYYY-MM-DDTHH:MM").
// `code` is one of: clear, partly, cloudy, fog, drizzle, rain, heavy-rain, sleet, snow, thunder.

import { stationsNear } from "./stations.js";

const SOURCES = {
  openmeteo: { key: null, ttl: 900, fetch: openMeteo },
  metno: { key: null, ttl: 900, fetch: metNo },
  metoffice: { key: "METOFFICE_KEY", ttl: 1800, fetch: metOffice },
  accuweather: { key: "ACCUWEATHER_KEY", ttl: 3600, fetch: accuWeather },
  openweather: { key: "OPENWEATHER_KEY", ttl: 1800, fetch: openWeather },
};

// Keys pasted into Cloudflare can pick up spaces, line breaks or quotes; API keys never contain those.
function cleanKeys(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (/_KEY$/.test(k) && typeof v === "string") out[k] = v.replace(/[\s"']/g, "");
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    env = cleanKeys(env);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/sources") {
        return json(
          Object.entries(SOURCES).map(([id, s]) => ({ id, enabled: !s.key || !!env[s.key] }))
        );
      }
      if (url.pathname === "/api/map") {
        // The CARTO key is sent to the phone (map tiles load from the browser), but stays out of the repo.
        return json({ cartoKey: env.CARTO_KEY || null });
      }
      if (url.pathname === "/api/geocode") return json(await geocode(url.searchParams.get("q") || ""));
      if (url.pathname === "/api/stations") return await stations(url, env, ctx);
      if (url.pathname === "/api/forecast") return await forecast(url, env, ctx);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

async function forecast(url, env, ctx) {
  const id = url.searchParams.get("source");
  const source = SOURCES[id];
  if (!source) return json({ error: "Unknown source" }, 400);
  if (source.key && !env[source.key]) return json({ error: "No API key set for this source" }, 400);

  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: "Bad coordinates" }, 400);
  }
  const tz = validTz(url.searchParams.get("tz"));
  const place = { lat: round(lat, 3), lon: round(lon, 3), tz };

  // Cache by rounded position so nearby requests share one upstream call (free tiers are small).
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://cache.weather/${id}/${place.lat.toFixed(2)}/${place.lon.toFixed(2)}/${tz}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let providers;
  try {
    providers = await source.fetch(place, env, ctx);
  } catch (err) {
    providers = [{ id, name: id, ok: false, error: String(err.message || err), days: [], hours: [] }];
  }
  const body = { providers, fetchedAt: new Date().toISOString() };
  const res = json(body);
  if (cache && providers.every((p) => p.ok)) {
    const toCache = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${source.ttl}` },
    });
    const put = cache.put(cacheKey, toCache);
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return res;
}

async function stations(url, env, ctx) {
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "Bad coordinates" }, 400);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://cache.weather/stations/${lat.toFixed(2)}/${lon.toFixed(2)}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const body = { ...(await stationsNear({ lat, lon }, env)), fetchedAt: new Date().toISOString() };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=600" },
    }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return json(body);
}

// ---------- Open-Meteo (free, no key): several global models side by side ----------

const OM_MODELS = [
  ["ecmwf_ifs025", "om-ecmwf", "ECMWF", "European model"],
  ["ukmo_seamless", "om-ukmo", "UKMO", "UK Met Office model"],
  ["gfs_seamless", "om-gfs", "GFS", "US model (NOAA)"],
  ["icon_seamless", "om-icon", "ICON", "German model (DWD)"],
  ["meteofrance_seamless", "om-meteofrance", "Météo-France", "French model"],
];

async function openMeteo({ lat, lon, tz }) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: tz,
    forecast_days: "7",
    models: OM_MODELS.map((m) => m[0]).join(","),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const d = data.daily || {};
  const h = data.hourly || {};

  return OM_MODELS.map(([model, id, name, note]) => {
    const v = (obj, key, i) => {
      const arr = obj[`${key}_${model}`] ?? obj[key];
      return arr ? num(arr[i]) : null;
    };
    const days = (d.time || [])
      .map((date, i) => ({
        date,
        hi: v(d, "temperature_2m_max", i),
        lo: v(d, "temperature_2m_min", i),
        pop: v(d, "precipitation_probability_max", i),
        mm: noNeg(v(d, "precipitation_sum", i)),
        wind: v(d, "wind_speed_10m_max", i),
        gust: v(d, "wind_gusts_10m_max", i),
        dir: v(d, "wind_direction_10m_dominant", i),
        code: wmoCode(v(d, "weather_code", i)),
      }))
      .filter((x) => x.hi != null && x.lo != null);
    const hours = (h.time || [])
      .map((time, i) => ({
        time,
        temp: v(h, "temperature_2m", i),
        pop: v(h, "precipitation_probability", i),
        mm: v(h, "precipitation", i),
        wind: v(h, "wind_speed_10m", i),
        gust: v(h, "wind_gusts_10m", i),
        dir: v(h, "wind_direction_10m", i),
        code: wmoCode(v(h, "weather_code", i)),
      }))
      .filter((x) => x.temp != null);
    const ok = days.length > 0;
    return { id, name, note, ok, error: ok ? undefined : "No data for this place", elevation: num(data.elevation), days, hours };
  });
}

// Some models report tiny negative rain totals; treat them as dry.
const noNeg = (x) => (x == null ? null : Math.max(0, x));

function wmoCode(c) {
  if (c == null) return null;
  if (c <= 1) return "clear";
  if (c === 2) return "partly";
  if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog";
  if (c === 56 || c === 57 || c === 66 || c === 67) return "sleet";
  if (c >= 51 && c <= 55) return "drizzle";
  if (c === 61 || c === 63 || c === 80 || c === 81) return "rain";
  if (c === 65 || c === 82) return "heavy-rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95) return "thunder";
  return "cloudy";
}

// ---------- MET Norway / yr.no (free, no key, needs a contact in User-Agent) ----------

async function metNo({ lat, lon, tz }, env) {
  const contact = env.CONTACT || "https://github.com/";
  const data = await getJson(
    `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
    { headers: { "User-Agent": `weather-compare/1.0 ${contact}` } }
  );
  const series = data?.properties?.timeseries || [];
  const slots = [];
  const hours = [];
  for (let i = 0; i < series.length; i++) {
    const e = series[i];
    const inst = e.data?.instant?.details || {};
    const n1 = e.data?.next_1_hours;
    const n6 = e.data?.next_6_hours;
    const time = localTime(e.time, tz);
    const wind = inst.wind_speed != null ? inst.wind_speed * 3.6 : null;
    const gust = inst.wind_speed_of_gust != null ? inst.wind_speed_of_gust * 3.6 : null;
    const dir = num(inst.wind_from_direction);
    const nextGap = series[i + 1] ? (Date.parse(series[i + 1].time) - Date.parse(e.time)) / 3600000 : 6;
    const useHourly = n1 && nextGap <= 1;
    const block = useHourly ? n1 : n6 || n1;
    const slot = {
      time,
      temp: num(inst.air_temperature),
      tMax: num(n6?.details?.air_temperature_max),
      tMin: num(n6?.details?.air_temperature_min),
      pop: num(block?.details?.probability_of_precipitation),
      mm: num(block?.details?.precipitation_amount),
      wind,
      gust,
      dir,
      code: metNoCode(block?.summary?.symbol_code),
    };
    // Only the start of each 6-hour block carries the 6-hour max/min we want to count.
    if (useHourly) slot.tMax = slot.tMin = null;
    slots.push(slot);
    if (n1) {
      hours.push({
        time,
        temp: slot.temp,
        pop: num(n1.details?.probability_of_precipitation),
        mm: num(n1.details?.precipitation_amount),
        wind,
        gust,
        dir,
        code: metNoCode(n1.summary?.symbol_code),
      });
    } else if (hours.length && i < series.length) {
      hours.push({ time, temp: slot.temp, pop: slot.pop, mm: slot.mm, wind, gust, dir, code: slot.code });
    }
  }
  const days = daysFromSlots(slots, tz).slice(0, 7);
  return [
    { id: "metno", name: "yr.no", note: "MET Norway", ok: days.length > 0, days, hours: hours.slice(0, 7 * 24) },
  ];
}

function metNoCode(s) {
  if (!s) return null;
  s = s.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return "thunder";
  if (s.includes("sleet")) return "sleet";
  if (s.includes("snow")) return "snow";
  if (s.startsWith("heavyrain")) return "heavy-rain";
  if (s.startsWith("lightrain")) return "drizzle";
  if (s.startsWith("rain")) return "rain";
  if (s === "fog") return "fog";
  if (s === "cloudy") return "cloudy";
  if (s === "fair" || s === "partlycloudy") return "partly";
  if (s === "clearsky") return "clear";
  return "cloudy";
}

// ---------- Met Office DataHub, Site-specific global spot (free key) ----------

async function metOffice({ lat, lon, tz }, env) {
  const base = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point";
  const q = `latitude=${lat}&longitude=${lon}&includeLocationName=true&excludeParameterMetadata=true`;
  const opts = { headers: { apikey: env.METOFFICE_KEY, accept: "application/json" } };
  const [daily, hourly] = await Promise.all([
    getJson(`${base}/daily?${q}`, opts),
    getJson(`${base}/hourly?${q}`, opts).catch(() => null),
  ]);

  const hours = (hourly?.features?.[0]?.properties?.timeSeries || []).map((t) => ({
    time: localTime(t.time, tz),
    temp: num(t.screenTemperature),
    pop: num(t.probOfPrecipitation),
    mm: num(t.totalPrecipAmount),
    wind: t.windSpeed10m != null ? t.windSpeed10m * 3.6 : null,
    gust: t.windGustSpeed10m != null ? t.windGustSpeed10m * 3.6 : null,
    dir: num(t.windDirectionFrom10m),
    code: metOfficeCode(t.significantWeatherCode),
  }));
  const mmByDay = {};
  for (const h of hours) {
    const date = h.time.slice(0, 10);
    if (h.mm != null) mmByDay[date] = (mmByDay[date] || 0) + h.mm;
  }

  const today = localTime(new Date().toISOString(), tz).slice(0, 10);
  const days = (daily?.features?.[0]?.properties?.timeSeries || [])
    .map((t) => {
      const date = t.time.slice(0, 10);
      const dayCode = t.daySignificantWeatherCode;
      return {
        date,
        hi: num(t.dayMaxScreenTemperature),
        lo: num(t.nightMinScreenTemperature),
        pop: maxOf(t.dayProbabilityOfPrecipitation, t.nightProbabilityOfPrecipitation),
        mm: mmByDay[date] != null ? round(mmByDay[date], 1) : null,
        wind: t.midday10MWindSpeed != null ? t.midday10MWindSpeed * 3.6 : null,
        gust: t.midday10MWindGust != null ? t.midday10MWindGust * 3.6 : null,
        dir: num(t.midday10MWindDirection),
        code: metOfficeCode(dayCode != null && dayCode >= 0 ? dayCode : t.nightSignificantWeatherCode),
      };
    })
    .filter((x) => x.date >= today && x.hi != null)
    .slice(0, 7);
  return [{ id: "metoffice", name: "Met Office", note: "UK weather service", ok: days.length > 0, days, hours }];
}

function metOfficeCode(c) {
  if (c == null || c < 0) return null;
  if (c <= 1) return "clear";
  if (c <= 4) return "partly";
  if (c <= 6) return "fog";
  if (c <= 8) return "cloudy";
  if (c <= 12) return "drizzle";
  if (c <= 15) return "heavy-rain";
  if (c <= 21) return "sleet";
  if (c <= 27) return "snow";
  return "thunder";
}

// ---------- AccuWeather (free key, about 50 calls a day) ----------

async function accuWeather({ lat, lon }, env) {
  const key = env.ACCUWEATHER_KEY;
  const base = "https://dataservice.accuweather.com";
  const opts = { headers: { Authorization: `Bearer ${key}` } };
  const k = encodeURIComponent(key);

  // The location key for a spot never changes, so keep it for 30 days.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const locReq = new Request(`https://cache.weather/accu-loc/${lat.toFixed(2)}/${lon.toFixed(2)}`);
  let loc = cache ? await cache.match(locReq).then((r) => r && r.json()) : null;
  if (!loc) {
    loc = await getJson(`${base}/locations/v1/cities/geoposition/search?apikey=${k}&q=${lat},${lon}`, opts);
    if (cache) {
      await cache.put(
        locReq,
        new Response(JSON.stringify({ Key: loc.Key }), { headers: { "Cache-Control": "public, max-age=2592000" } })
      );
    }
  }
  const [daily, hourly] = await Promise.all([
    getJson(`${base}/forecasts/v1/daily/5day/${loc.Key}?apikey=${k}&metric=true&details=true`, opts),
    getJson(`${base}/forecasts/v1/hourly/12hour/${loc.Key}?apikey=${k}&metric=true&details=true`, opts).catch(
      () => []
    ),
  ]);

  const days = (daily.DailyForecasts || []).map((f) => ({
    date: f.Date.slice(0, 10),
    hi: num(f.Temperature?.Maximum?.Value),
    lo: num(f.Temperature?.Minimum?.Value),
    pop: maxOf(f.Day?.PrecipitationProbability, f.Night?.PrecipitationProbability),
    mm: sumOf(f.Day?.TotalLiquid?.Value, f.Night?.TotalLiquid?.Value),
    wind: num(f.Day?.Wind?.Speed?.Value),
    gust: num(f.Day?.WindGust?.Speed?.Value),
    dir: num(f.Day?.Wind?.Direction?.Degrees),
    code: accuCode(f.Day?.Icon),
  }));
  const hours = (hourly || []).map((h) => ({
    time: h.DateTime.slice(0, 16),
    temp: num(h.Temperature?.Value),
    pop: num(h.PrecipitationProbability),
    mm: num(h.TotalLiquid?.Value),
    wind: num(h.Wind?.Speed?.Value),
    gust: num(h.WindGust?.Speed?.Value),
    dir: num(h.Wind?.Direction?.Degrees),
    code: accuCode(h.WeatherIcon),
  }));
  return [{ id: "accuweather", name: "AccuWeather", note: "5-day forecast", ok: days.length > 0, days, hours }];
}

function accuCode(i) {
  if (i == null) return null;
  if ([1, 2, 30, 31, 33, 34].includes(i)) return "clear";
  if ([3, 4, 5, 35, 36, 37].includes(i)) return "partly";
  if ([6, 7, 8, 32, 38].includes(i)) return "cloudy";
  if (i === 11) return "fog";
  if ([12, 13, 14, 39, 40].includes(i)) return "rain";
  if (i === 18) return "heavy-rain";
  if ([15, 16, 17, 41, 42].includes(i)) return "thunder";
  if ([24, 25, 26, 29].includes(i)) return "sleet";
  if ([19, 20, 21, 22, 23, 43, 44].includes(i)) return "snow";
  return "cloudy";
}

// ---------- OpenWeatherMap 5-day / 3-hour forecast (free key) ----------

async function openWeather({ lat, lon, tz }, env) {
  const data = await getJson(
    `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${encodeURIComponent(
      env.OPENWEATHER_KEY
    )}`
  );
  const slots = (data.list || []).map((e) => ({
    time: localTime(new Date(e.dt * 1000).toISOString(), tz),
    temp: num(e.main?.temp),
    tMax: num(e.main?.temp_max),
    tMin: num(e.main?.temp_min),
    pop: e.pop != null ? Math.round(e.pop * 100) : null,
    mm: sumOf(e.rain?.["3h"], e.snow?.["3h"]) ?? 0,
    wind: e.wind?.speed != null ? e.wind.speed * 3.6 : null,
    gust: e.wind?.gust != null ? e.wind.gust * 3.6 : null,
    dir: num(e.wind?.deg),
    code: owmCode(e.weather?.[0]?.id),
  }));
  const days = daysFromSlots(slots, tz).slice(0, 6);
  const hours = slots.map(({ time, temp, pop, mm, wind, gust, dir, code }) => ({ time, temp, pop, mm, wind, gust, dir, code }));
  return [{ id: "openweather", name: "OpenWeather", note: "3-hourly forecast", ok: days.length > 0, days, hours }];
}

function owmCode(id) {
  if (id == null) return null;
  if (id < 300) return "thunder";
  if (id < 400) return "drizzle";
  if (id === 511) return "sleet";
  if (id === 500 || id === 520) return "drizzle";
  if (id === 501 || id === 521 || id === 531) return "rain";
  if (id < 600) return "heavy-rain";
  if (id >= 611 && id <= 616) return "sleet";
  if (id < 700) return "snow";
  if (id < 800) return "fog";
  if (id === 800) return "clear";
  if (id <= 802) return "partly";
  return "cloudy";
}

// ---------- Place search (Open-Meteo geocoding, free) ----------

async function geocode(q) {
  q = q.trim();
  if (q.length < 2) return [];
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`
  );
  return (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(", "),
    lat: r.latitude,
    lon: r.longitude,
    tz: r.timezone,
  }));
}

// ---------- Helpers ----------

// Turn time slots (hourly, 3-hourly or 6-hourly) into one summary per local day.
export function daysFromSlots(slots, tz) {
  const byDate = new Map();
  for (const s of slots) {
    const date = s.time.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(s);
  }
  const today = localTime(new Date().toISOString(), tz).slice(0, 10);
  const days = [];
  for (const [date, list] of byDate) {
    if (date < today) continue;
    if (list.length < 2 && date !== today) continue;
    const temps = list.flatMap((s) => [s.temp, s.tMax, s.tMin]).filter((t) => t != null);
    if (!temps.length) continue;
    const pops = list.map((s) => s.pop).filter((p) => p != null);
    const winds = list.map((s) => s.wind).filter((w) => w != null);
    const gusts = list.map((s) => s.gust).filter((g) => g != null);
    const mms = list.map((s) => s.mm).filter((m) => m != null);
    // Daily icon: the slot closest to midday, matching how most apps choose one.
    const withCode = list.filter((s) => s.code);
    const mid = withCode.sort(
      (a, b) => Math.abs(Number(a.time.slice(11, 13)) - 12) - Math.abs(Number(b.time.slice(11, 13)) - 12)
    )[0];
    days.push({
      date,
      hi: round(Math.max(...temps), 1),
      lo: round(Math.min(...temps), 1),
      pop: pops.length ? Math.max(...pops) : null,
      mm: mms.length ? round(mms.reduce((a, b) => a + b, 0), 1) : null,
      wind: winds.length ? round(Math.max(...winds), 1) : null,
      gust: gusts.length ? round(Math.max(...gusts), 1) : null,
      dir: mid && mid.dir != null ? mid.dir : (list.find((s) => s.dir != null) || {}).dir ?? null,
      code: mid ? mid.code : null,
    });
  }
  return days;
}

export function localTime(iso, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function validTz(tz) {
  try {
    if (tz) {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return tz;
    }
  } catch {}
  return "UTC";
}

async function getJson(url, opts = {}) {
  // Some providers (the Met Office among them) refuse requests that don't say who is asking.
  const headers = { "User-Agent": "weather-compare/1.0 (+https://github.com/samweh-max/Weather)", ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " (check the API key)" : res.status === 429 || res.status === 503 ? " (daily limit reached?)" : "";
    // Pass on the provider's own short explanation, if it gave one.
    const why = (await res.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    throw new Error(`Provider returned ${res.status}${hint}${why ? `: ${why}` : ""}`);
  }
  return res.json();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function num(x) {
  return typeof x === "number" && isFinite(x) ? x : null;
}
function maxOf(...xs) {
  const v = xs.map(num).filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
}
function sumOf(...xs) {
  const v = xs.map(num).filter((x) => x != null);
  return v.length ? round(v.reduce((a, b) => a + b, 0), 1) : null;
}
function round(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
