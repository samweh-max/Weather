// Home station on CampbellON, run against sample responses (no network needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeStation, kindOf, pickSensors, convert } from "../worker/home.js";
import { stationsNear } from "../worker/stations.js";

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

test("shows up as a nearby station and becomes the forecast check", async () => {
  const r = await stationsNear(place, env);
  assert.equal(r.networks.home.ok, true);
  assert.equal(r.networks.home.count, 1);
  const home = r.stations.find((s) => s.network === "home");
  assert.equal(home.mine, true);
  assert.equal(r.history.home, true);
  assert.equal(r.history.name, "Garden");
});

test("left out when the place is far from home", async () => {
  const r = await stationsNear({ lat: 55.95, lon: -3.19 }, env);
  assert.equal(r.networks.home.count, 0);
  assert.ok(r.networks.home.far > 300);
  assert.ok(!r.stations.some((s) => s.network === "home"));
});

test("off without a login", async () => {
  const r = await stationsNear(place, { CAMPBELL_STATION_ID: SID });
  assert.equal(r.networks.home.enabled, false);
});
