// Runs the worker against sample provider responses (no network needed): `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { localTime, daysFromSlots } from "../worker/index.js";

const TZ = "Europe/London";
const now = new Date();
const today = localTime(now.toISOString(), TZ).slice(0, 10);
const dayIso = (i) => new Date(Date.parse(today + "T00:00:00Z") + i * 864e5).toISOString().slice(0, 10);

const env = { METOFFICE_KEY: "k1", ACCUWEATHER_KEY: "k2", OPENWEATHER_KEY: "k3", CONTACT: "test" };

function fixture(url) {
  const u = new URL(url);
  if (u.hostname === "api.open-meteo.com") {
    const models = u.searchParams.get("models").split(",");
    const daily = { time: [0, 1, 2, 3, 4, 5, 6].map(dayIso) };
    const hourly = { time: [] };
    for (let i = 0; i < 48; i++) hourly.time.push(`${dayIso(Math.floor(i / 24))}T${String(i % 24).padStart(2, "0")}:00`);
    models.forEach((m, k) => {
      const missing = m === "ukmo_seamless";
      daily[`temperature_2m_max_${m}`] = daily.time.map((_, i) => (missing && i > 4 ? null : 12 + k));
      daily[`temperature_2m_min_${m}`] = daily.time.map((_, i) => (missing && i > 4 ? null : 5 + k));
      daily[`weather_code_${m}`] = daily.time.map(() => 61);
      daily[`precipitation_sum_${m}`] = daily.time.map(() => 2.4);
      daily[`precipitation_probability_max_${m}`] = daily.time.map(() => (m === "gfs_seamless" ? 70 : null));
      daily[`wind_speed_10m_max_${m}`] = daily.time.map(() => 20);
      daily[`wind_gusts_10m_max_${m}`] = daily.time.map(() => 41);
      daily[`wind_direction_10m_dominant_${m}`] = daily.time.map(() => 225);
      hourly[`temperature_2m_${m}`] = hourly.time.map(() => 9);
      hourly[`weather_code_${m}`] = hourly.time.map(() => 3);
      hourly[`precipitation_${m}`] = hourly.time.map(() => 0);
      hourly[`precipitation_probability_${m}`] = hourly.time.map(() => null);
      hourly[`wind_speed_10m_${m}`] = hourly.time.map(() => 15);
    });
    return { daily, hourly };
  }
  if (u.hostname === "api.met.no") {
    const timeseries = [];
    const start = Date.parse(today + "T00:00:00Z");
    for (let h = 0; h < 60; h++) timeseries.push(metEntry(start + h * 3600e3, true));
    for (let h = 60; h < 216; h += 6) timeseries.push(metEntry(start + h * 3600e3, false));
    return { properties: { timeseries } };
  }
  if (u.hostname === "data.hub.api.metoffice.gov.uk") {
    if (u.pathname.endsWith("/daily")) {
      return {
        features: [{ properties: { timeSeries: [-1, 0, 1, 2, 3, 4, 5, 6].map((i) => ({
          time: dayIso(i) + "T00:00Z",
          dayMaxScreenTemperature: 14, nightMinScreenTemperature: 6,
          dayProbabilityOfPrecipitation: 40, nightProbabilityOfPrecipitation: 60,
          daySignificantWeatherCode: i === 0 ? -1 : 12, nightSignificantWeatherCode: 2,
          midday10MWindSpeed: 5, midday10MWindGust: 12, midday10MWindDirection: 200,
        })) } }],
      };
    }
    return {
      features: [{ properties: { timeSeries: Array.from({ length: 48 }, (_, i) => ({
        time: new Date(Date.parse(today + "T00:00:00Z") + i * 3600e3).toISOString().slice(0, 16) + "Z",
        screenTemperature: 10, probOfPrecipitation: 30, totalPrecipAmount: 0.5, windSpeed10m: 4, significantWeatherCode: 7,
      })) } }],
    };
  }
  if (u.hostname === "dataservice.accuweather.com") {
    if (u.pathname.includes("geoposition")) return { Key: "328328" };
    if (u.pathname.includes("/daily/")) {
      return { DailyForecasts: [0, 1, 2, 3, 4].map((i) => ({
        Date: dayIso(i) + "T07:00:00+00:00",
        Temperature: { Maximum: { Value: 13.3 }, Minimum: { Value: 4.4 } },
        Day: { Icon: 18, PrecipitationProbability: 80, TotalLiquid: { Value: 3 }, Wind: { Speed: { Value: 22 }, Direction: { Degrees: 180 } }, WindGust: { Speed: { Value: 50 } } },
        Night: { Icon: 33, PrecipitationProbability: 20, TotalLiquid: { Value: 1 } },
      })) };
    }
    return Array.from({ length: 12 }, (_, i) => ({
      DateTime: `${today}T${String(i + 8).padStart(2, "0")}:00:00+00:00`,
      WeatherIcon: 6, Temperature: { Value: 11 }, PrecipitationProbability: 20, TotalLiquid: { Value: 0 }, Wind: { Speed: { Value: 15 } },
    }));
  }
  if (u.hostname === "api.openweathermap.org") {
    const start = Math.floor(Date.parse(today + "T00:00:00Z") / 1000);
    return { list: Array.from({ length: 40 }, (_, i) => ({
      dt: start + i * 10800,
      main: { temp: 8 + (i % 8), temp_min: 7 + (i % 8), temp_max: 9 + (i % 8) },
      weather: [{ id: i % 8 === 4 ? 501 : 803 }], pop: 0.35, rain: i % 8 === 4 ? { "3h": 1.2 } : undefined, wind: { speed: 5, gust: 11, deg: 90 },
    })) };
  }
  if (u.hostname === "geocoding-api.open-meteo.com") {
    return { results: [{ name: "London", admin1: "England", country: "United Kingdom", latitude: 51.5, longitude: -0.12, timezone: TZ }] };
  }
  throw new Error("Unexpected URL " + url);
}

function metEntry(t, hourly) {
  const d = {
    instant: { details: { air_temperature: 8, wind_speed: 4, wind_speed_of_gust: 9, wind_from_direction: 270 } },
    next_6_hours: { summary: { symbol_code: "lightrainshowers_day" }, details: { air_temperature_max: 11, air_temperature_min: 4, precipitation_amount: 1.2, probability_of_precipitation: 55 } },
  };
  if (hourly) d.next_1_hours = { summary: { symbol_code: "partlycloudy_day" }, details: { precipitation_amount: 0.1, probability_of_precipitation: 20 } };
  return { time: new Date(t).toISOString().replace(".000", ""), data: d };
}

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  return new Response(JSON.stringify(fixture(String(url))), { headers: { "Content-Type": "application/json" } });
};

async function call(path, e = env) {
  const res = await worker.fetch(new Request("https://app.test" + path), e, {});
  return { status: res.status, body: await res.json() };
}
const q = (source) => `/api/forecast?source=${source}&lat=51.507&lon=-0.128&tz=${TZ}`;

function checkShape(p) {
  assert.ok(p.ok, `${p.id} should be ok: ${p.error}`);
  assert.ok(p.days.length >= 5, `${p.id} has ${p.days.length} days`);
  assert.equal(p.days[0].date, today, `${p.id} starts today`);
  for (const d of p.days) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof d.hi, "number");
    assert.equal(typeof d.lo, "number");
    assert.ok(d.hi >= d.lo, `${p.id} hi >= lo`);
    assert.ok(d.code, `${p.id} has a weather code on ${d.date}`);
  }
  for (const h of p.hours) assert.match(h.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
}

test("sources lists which providers have keys", async () => {
  const { body } = await call("/api/sources", { CONTACT: "x" });
  assert.deepEqual(body.find((s) => s.id === "metoffice"), { id: "metoffice", enabled: false });
  assert.deepEqual(body.find((s) => s.id === "openmeteo"), { id: "openmeteo", enabled: true });
});

test("map key is passed on only when set", async () => {
  assert.equal((await call("/api/map", {})).body.cartoKey, null);
  assert.equal((await call("/api/map", { CARTO_KEY: "k" })).body.cartoKey, "k");
});

test("keyed source without a key is refused", async () => {
  const { status } = await call(q("accuweather"), {});
  assert.equal(status, 400);
});

test("Open-Meteo returns one forecast per model", async () => {
  const { body } = await call(q("openmeteo"));
  assert.equal(body.providers.length, 5);
  body.providers.forEach(checkShape);
  const ukmo = body.providers.find((p) => p.id === "om-ukmo");
  assert.equal(ukmo.days.length, 5, "drops days the model doesn't cover");
  assert.equal(body.providers.find((p) => p.id === "om-gfs").days[0].pop, 70);
  assert.equal(body.providers[0].days[0].code, "rain");
  assert.equal(body.providers[0].days[0].gust, 41);
  assert.equal(body.providers[0].days[0].dir, 225);
});

test("MET Norway is summarised per day", async () => {
  const { body } = await call(q("metno"));
  const p = body.providers[0];
  checkShape(p);
  // Hourly part uses hourly temperatures; the 6-hourly part uses each block's max/min.
  assert.equal(p.days[0].hi, 8);
  assert.equal(p.days[3].hi, 11);
  assert.equal(p.days[3].lo, 4);
  assert.equal(p.days[0].dir, 270);
  assert.ok(Math.abs(p.days[0].gust - 32.4) < 0.01);
  assert.ok(p.hours.length >= 48);
  const ua = calls.find((c) => c.url.includes("met.no")).opts.headers["User-Agent"];
  assert.match(ua, /weather-compare/);
});

test("Met Office skips yesterday and adds rain totals from hourly", async () => {
  const { body } = await call(q("metoffice"));
  const p = body.providers[0];
  checkShape(p);
  assert.equal(p.days.length, 7);
  assert.equal(p.days[0].code, "partly", "falls back to night code when day code is -1");
  assert.equal(p.days[1].code, "drizzle");
  assert.equal(p.days[0].pop, 60);
  assert.equal(p.days[0].dir, 200);
  assert.ok(Math.abs(p.days[0].gust - 43.2) < 0.01);
  assert.ok(p.days[0].mm > 0);
  assert.equal(calls.find((c) => c.url.includes("metoffice")).opts.headers.apikey, "k1");
});

test("AccuWeather looks up the location then the forecast", async () => {
  const { body } = await call(q("accuweather"));
  const p = body.providers[0];
  checkShape(p);
  assert.equal(p.days[0].mm, 4);
  assert.equal(p.days[0].pop, 80);
  assert.equal(p.days[0].code, "heavy-rain");
  assert.equal(p.days[0].gust, 50);
  assert.equal(p.days[0].dir, 180);
  assert.equal(p.hours.length, 12);
});

test("OpenWeather 3-hourly data becomes daily", async () => {
  const { body } = await call(q("openweather"));
  const p = body.providers[0];
  checkShape(p);
  assert.equal(p.days[0].hi, 16);
  assert.equal(p.days[0].lo, 7);
  assert.equal(p.days[0].pop, 35);
  assert.equal(p.days[0].dir, 90);
  assert.ok(Math.abs(p.days[0].gust - 39.6) < 0.01);
});

test("geocode returns places with time zones", async () => {
  const { body } = await call("/api/geocode?q=london");
  assert.equal(body[0].tz, TZ);
  assert.equal(body[0].region, "England, United Kingdom");
});

test("bad input is rejected", async () => {
  assert.equal((await call("/api/forecast?source=nope&lat=1&lon=1")).status, 400);
  assert.equal((await call("/api/forecast?source=metno&lat=200&lon=1")).status, 400);
});

test("upstream failure becomes a readable error, not a crash", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("no", { status: 401 });
  const { body } = await call(q("openweather"));
  globalThis.fetch = real;
  assert.equal(body.providers[0].ok, false);
  assert.match(body.providers[0].error, /check the API key/);
});

test("daysFromSlots handles a single day", () => {
  const days = daysFromSlots([{ time: today + "T12:00", temp: 5, code: "clear" }, { time: today + "T15:00", temp: 9, code: "rain" }], TZ);
  assert.equal(days[0].hi, 9);
  assert.equal(days[0].code, "clear");
});
