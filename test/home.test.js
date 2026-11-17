// Home station on CampbellON, run against sample responses (no network needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeStation, homeNear, homeHistory, kindOf, pickSensors, convert, bucket, guessUnit, sendEvery } from "../worker/home.js";
import { stationsNear } from "../worker/stations.js";
import worker from "../worker/index.js";

const SID = "59efd9fd-3b3a-42d1-a83c-d3fdaf3bfc54";
const ORG = "org-1";
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const MIN = 60e3, HOUR = 3600e3;

const streams = [
  { id: "t", metadata: { field: "AirTC_Avg", table: "Table15", interval: "PT15M" } },
  { id: "tmax", metadata: { field: "AirTC_Max", table: "Table15", interval: "PT15M" } },
  { id: "pt", metadata: { field: "PTemp_C", table: "Table15", interval: "PT15M" } },
  { id: "rh", metadata: { field: "RH", table: "Table15", interval: "PT15M" } },
  { id: "ws", metadata: { field: "WS_ms_S_WVT", table: "Table15", interval: "PT15M" } },
  { id: "wsmax", metadata: { field: "WS_ms_Max", table: "Table15", interval: "PT15M" } },
  { id: "wd", metadata: { field: "WindDir_D1_WVT", table: "Table15", interval: "PT15M" } },
  { id: "rain", metadata: { field: "Rain_mm_Tot", table: "Table15", interval: "PT15M" } },
  { id: "rainday", metadata: { field: "Rain_mm_Tot", table: "Table24", interval: "P1D" } },
  { id: "bp", metadata: { field: "BP_mbar_Avg", table: "Table15", interval: "PT15M" } },
  { id: "batt", metadata: { field: "BattV_Min", table: "Table15", interval: "PT15M" } },
];
const latest = {
  t: { value: 9.4, unit: "Deg C" }, tmax: { value: 11, unit: "Deg C" }, pt: { value: 15, unit: "Deg C" },
  rh: { value: 88, unit: "%" }, ws: { value: 5, unit: "meters/second" }, wsmax: { value: 10, unit: "meters/second" },
  wd: { value: 225, unit: "degrees" }, rain: { value: 0.2, unit: "mm" }, rainday: { value: 6.4, unit: "mm" },
  bp: { value: 1012.3, unit: "mbar" }, batt: { value: 12.6, unit: "Volts" },
};

const calls = [];
function fixture(url, opts) {
  const u = new URL(url);
  calls.push(u.pathname);
  assert.equal(u.origin, "https://campbellon.com");
  if (u.pathname === "/api/v1/tokens") {
    const body = JSON.parse(opts.body);
    assert.equal(body.grant_type, "client_credentials");
    assert.equal(body.client_id, "sa-1");
    return { access_token: "tok", expires_in: 3600 };
  }
  assert.equal(opts.headers.Authorization, "Bearer tok");
  if (u.pathname === "/api/v1/organizations") return [{ id: ORG }];
  if (u.pathname === `/api/v1/organizations/${ORG}/stations/${SID}`) {
    return { id: SID, metadata: { $profile: "station", name: "Garden", location: { latitude: 51.52, longitude: -0.14, elevation: 30 } } };
  }
  if (u.pathname === `/api/v1/organizations/${ORG}/datastreams`) {
    assert.equal(u.searchParams.get("stationId"), SID);
    return streams;
  }
  if (u.pathname === `/api/v1/data/organizations/${ORG}/datapoints/latest`) {
    const ids = u.searchParams.get("datastream_ids").split(",");
    return { data: Object.fromEntries(ids.map((id) => {
      const s = streams.find((x) => x.id === id);
      return [id, { ts: iso(5 * MIN), quality: "raw", field_name: s.metadata.field, table_name: s.metadata.table, ...latest[id] }];
    })) };
  }
  const m = u.pathname.match(/datastreams\/(\w+)\/datapoints$/);
  if (m) {
    // Every 15 minutes for 26 hours. Rain: 0.5 mm per 15 min during the last 2 hours only.
    const pts = Array.from({ length: 26 * 4 }, (_, i) => now - 5 * MIN - i * 15 * MIN);
    const v = { t: (t) => 8 + ((t / HOUR) % 3), ws: () => 4, rain: (t) => (now - t < 2 * HOUR ? 0.5 : 0) }[m[1]];
    return { data: pts.map((t) => ({ ts: t, value: v(t) })) };
  }
  throw new Error("Unexpected " + url);
}

globalThis.fetch = async (url, opts = {}) => new Response(JSON.stringify(fixture(String(url), opts)), { headers: { "Content-Type": "application/json" } });

const env = { CAMPBELL_STATION_ID: SID, CAMPBELL_CLIENT_ID: "sa-1", CAMPBELL_CLIENT_SECRET: "secret" };
const place = { lat: 51.507, lon: -0.128 };

test("recognises common logger field names and skips the rest", () => {
  assert.equal(kindOf("AirTC_Avg", "Deg C"), "temp");
  assert.equal(kindOf("AirTemp_C", "°C"), "temp");
  assert.equal(kindOf("AirTC_Max", "Deg C"), null);
  assert.equal(kindOf("PTemp_C", "Deg C"), null);
  assert.equal(kindOf("RH", "%"), "humidity");
  assert.equal(kindOf("WS_ms_Avg", "m/s"), "wind");
  assert.equal(kindOf("WS_ms_Max", "m/s"), "gust");
  assert.equal(kindOf("WindDir", "Deg"), "dir");
  assert.equal(kindOf("WindDir_SD1_WVT", "Deg"), null);
  assert.equal(kindOf("Rain_mm_Tot", "mm"), "rain");
  assert.equal(kindOf("BP_mbar_Avg", "mbar"), "pressure");
  assert.equal(kindOf("BattV_Min", "Volts"), null);
});

test("rain uses the shortest table, not the daily total", () => {
  const p = pickSensors([
    { id: "a", field: "Rain_mm_Tot", unit: "mm", ts: iso(0), value: 6, interval: "P1D" },
    { id: "b", field: "Rain_mm_Tot", unit: "mm", ts: iso(0), value: 0.2, interval: "PT5M" },
  ]);
  assert.equal(p.rain.id, "b");
});

test("unit conversion", () => {
  assert.equal(convert("wind", 10, "m/s"), 36);
  assert.equal(Math.round(convert("temp", 50, "Deg F")), 10);
  assert.equal(convert("rain", 1, "in"), 25.4);
});

test("reads the station: latest values, rain totals and an hourly track", async () => {
  const { station: s, history } = await homeStation(place, env);
  assert.equal(s.network, "home");
  assert.equal(s.name, "Garden");
  assert.equal(s.temp, 9.4);
  assert.equal(s.humidity, 88);
  assert.equal(s.wind, 18);
  assert.equal(s.gust, 36);
  assert.equal(s.dir, 225);
  assert.equal(s.pressure, 1012.3);
  assert.equal(s.elev, 30);
  assert.ok(s.dist > 0 && s.dist < 3);
  assert.equal(s.rain1h, 2);
  assert.equal(s.rain24h, 4);
  assert.equal(s.raining, true);
  assert.equal(s.hourly.length, 24);
  assert.equal(s.hourly[23].mm, 2);
  assert.equal(s.hourly[0].mm, 0);
  assert.ok(s.readings.some((r) => r.field === "BattV_Min"));
  assert.ok(history.obs.length >= 24);
  assert.ok(history.obs.every((o) => o.temp != null && o.wind === 14.4));
});

test("readings say which sensors the app understands", async () => {
  const { station: s } = await homeStation(place, env);
  const t = s.readings.find((r) => r.field === "AirTC_Avg");
  assert.equal(t.kind, "temp");
  assert.equal(t.main, true);
  assert.equal(t.table, "Table15");
  assert.equal(s.readings.find((r) => r.field === "BattV_Min").kind, null);
});

test("far from home it still answers, with the distance", async () => {
  const r = await homeNear({ lat: 55.95, lon: -3.19 }, env);
  assert.ok(r.dist > 300);
});

test("no longer slows the other stations: not part of /api/stations", async () => {
  const r = await stationsNear(place, env);
  assert.equal(r.networks.home, undefined);
  assert.ok(!r.stations.some((s) => s.network === "home"));
});

test("history: chosen sensors between two dates, in steps, in app units", async () => {
  const to = now, from = now - 24 * HOUR;
  const r = await homeHistory({ from, to, ids: ["t", "rain", "ws", "nope"] }, env);
  assert.deepEqual(Object.keys(r.series).sort(), ["rain", "t", "ws"]);
  assert.equal(r.series.t.kind, "temp");
  assert.equal(r.series.t.step, 15 * MIN);
  const rainTotal = r.series.rain.buckets.reduce((a, b) => a + b.sum, 0);
  assert.ok(Math.abs(rainTotal - 4) < 0.01);
  assert.ok(r.series.ws.buckets.every((b) => b.avg === 14.4));
});

test("history: refuses ranges over a year and unknown sensors", async () => {
  await assert.rejects(homeHistory({ from: 0, to: 500 * 24 * HOUR, ids: ["t"] }, env), /year/);
  await assert.rejects(homeHistory({ from: now - HOUR, to: now, ids: ["nope"] }, env), /aren't on this station/);
});

test("bucket: days start at local midnight", () => {
  const day = 24 * HOUR, mid = Date.UTC(2026, 6, 1);
  const pts = [{ t: mid - 30 * MIN, v: 1 }, { t: mid + 30 * MIN, v: 3 }];
  assert.equal(bucket(pts, day, 0).length, 2);
  assert.equal(bucket(pts, day, 60 * MIN).length, 1); // UTC+1: both fall on 1 July
});

test("/api/home endpoint: off without a login, on with one", async () => {
  const off = await (await worker.fetch(new Request("https://x/api/home?lat=51.5&lon=-0.1"), {}, {})).json();
  assert.equal(off.enabled, false);
  const on = await (await worker.fetch(new Request("https://x/api/home?lat=51.5&lon=-0.1"), env, {})).json();
  assert.equal(on.enabled, true);
  assert.equal(on.station.name, "Garden");
  const h = await (await worker.fetch(new Request(`https://x/api/home/history?from=${now - HOUR}&to=${now}&ids=t`), env, {})).json();
  assert.ok(h.series.t.buckets.length >= 3);
});

test("bucket: wind direction averages round the compass", () => {
  const b = bucket([{ t: 0, v: 350 }, { t: 1, v: 10 }], HOUR, 0, true);
  assert.ok(b[0].avg < 1 || b[0].avg > 359);
});

test("fills in units the logger left out, but not for probe internals", () => {
  assert.equal(guessUnit("AirTC_Avg"), "Deg C");
  assert.equal(guessUnit("T_Avg"), "Deg C");
  assert.equal(guessUnit("WS_ms_S_WVT"), "meters/second");
  assert.equal(guessUnit("VWC_Avg"), "m^3/m^3");
  assert.equal(guessUnit("P_Avg"), "");
  assert.equal(guessUnit("PA_Avg"), "");
  assert.equal(guessUnit("WSDiag"), "");
  assert.equal(kindOf("T_Avg", "Deg C"), null);
});

test("works out how often the logger sends, counting rows close together as one send", () => {
  const t0 = Date.UTC(2026, 10, 17, 9, 10);
  const times = [];
  for (let h = 0; h < 12; h++) times.push(t0 + h * HOUR, t0 + h * HOUR + 40e3);
  assert.equal(sendEvery(times), HOUR);
  assert.equal(sendEvery([t0]), null);
});
