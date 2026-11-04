// Station readers, run against sample responses (no network needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stationsNear, distKm, geohashCentre } from "../worker/stations.js";

const now = Math.floor(Date.now() / 1000);
const iso = (secAgo) => new Date((now - secAgo) * 1000).toISOString();

function fixture(url, opts) {
  const u = new URL(url);
  if (u.hostname === "aviationweather.gov") {
    if (u.searchParams.get("ids")) {
      return Array.from({ length: 24 }, (_, i) => ({ icaoId: "EGLL", obsTime: now - i * 3600, temp: 8 + (i % 3), wspd: 5 }));
    }
    return [
      { icaoId: "EGLL", obsTime: now - 1800, temp: 8, dewp: 7, wdir: 60, wspd: 3, altim: 1028, wxString: "-RA -DZ", lat: 51.477, lon: -0.461, name: "London/Heathrow Intl, EN, GB" },
      { icaoId: "EGLL", obsTime: now - 3600, temp: 9, wdir: 60, wspd: 4, lat: 51.477, lon: -0.461, name: "London/Heathrow Intl, EN, GB" },
      { icaoId: "EGLC", obsTime: now - 1200, temp: 9, dewp: 6, wdir: "VRB", wspd: 2, wgst: 15, altim: 1027, lat: 51.505, lon: 0.055, name: "London City, EN, GB" },
      { icaoId: "EGPH", obsTime: now - 1200, temp: 4, wspd: 10, lat: 55.95, lon: -3.37, name: "Edinburgh, SC, GB" },
    ];
  }
  if (u.hostname === "environment.data.gov.uk") {
    if (u.pathname.endsWith("/stations")) {
      return { items: [
        { notation: "287283TP", label: "Rainfall station", lat: 51.449, long: -0.225 },
        { notation: "OLD1", label: "Rainfall station", lat: 51.5, long: -0.1 },
      ] };
    }
    if (u.pathname.includes("OLD1")) return { items: [{ dateTime: iso(10 * 3600), value: 0.4 }] };
    return { items: [0, 900, 1800, 2700, 3600, 4500].map((ago, i) => ({ dateTime: iso(ago + 300), value: i < 4 ? 0.2 : 1 })) };
  }
  if (u.hostname === "data.hub.api.metoffice.gov.uk") {
    assert.equal(opts.headers.apikey, "obs-key");
    if (u.pathname.endsWith("/nearest")) return [{ geohash: "gcpvj0", area: "London St James's Park", region: "London", country: "England" }];
    return [
      { datetime: iso(7200), temperature: 9, wind_speed: 4, wind_direction: "NE" },
      { datetime: iso(3600), temperature: 8.4, humidity: 93, mslp: 1028, wind_speed: 5, wind_gust: 10, wind_direction: "ENE", weather_code: 12 },
    ];
  }
  throw new Error("Unexpected " + url);
}

globalThis.fetch = async (url, opts = {}) => new Response(JSON.stringify(fixture(String(url), opts)), { headers: { "Content-Type": "application/json" } });

const place = { lat: 51.507, lon: -0.128 };

test("free networks work without any keys", async () => {
  const r = await stationsNear(place, {});
  assert.equal(r.networks.airport.ok, true);
  assert.equal(r.networks.raingauge.ok, true);
  assert.equal(r.networks.metoffice.enabled, false);
  assert.equal(r.networks.netatmo, undefined);
});

test("airports: latest report per airport, nearby only, in km/h", async () => {
  const r = await stationsNear(place, {});
  const air = r.stations.filter((s) => s.network === "airport");
  assert.deepEqual(air.map((s) => s.id).sort(), ["EGLC", "EGLL"]);
  const lhr = air.find((s) => s.id === "EGLL");
  assert.equal(lhr.temp, 8);
  assert.equal(lhr.name, "London/Heathrow");
  assert.ok(Math.abs(lhr.wind - 5.6) < 0.1);
  assert.equal(lhr.raining, true);
  assert.equal(lhr.wx, "light rain");
  assert.equal(air.find((s) => s.id === "EGLC").dir, null, "variable wind has no direction");
  assert.equal(r.history.id, "EGLC", "history comes from the nearest airport");
  assert.equal(r.history.obs.length, 24);
});

test("rain gauges add up the last hour and drop stale gauges", async () => {
  const r = await stationsNear(place, {});
  const g = r.stations.filter((s) => s.network === "raingauge");
  assert.equal(g.length, 1);
  assert.equal(g[0].rain1h, 0.8);
  assert.equal(g[0].rain24h, 2.8, "every reading in the last day");
  assert.equal(g[0].hourly.length, 24);
  assert.equal(g[0].hourly[23].mm, 0.8, "latest hour last");
  assert.equal(g[0].hourly.reduce((a, h) => a + (h.mm || 0), 0).toFixed(1), "2.8");
  assert.equal(g[0].raining, true);
});

test("Met Office observations use their own key and convert knots", async () => {
  const r = await stationsNear(place, { METOFFICE_OBS_KEY: "obs-key" });
  const mo = r.stations.find((s) => s.network === "metoffice");
  assert.equal(mo.temp, 8.4);
  assert.ok(Math.abs(mo.wind - 9.26) < 0.1);
  assert.equal(mo.dir, 67.5);
  assert.equal(mo.raining, true);
  assert.ok(Math.abs(mo.lat - 51.50) < 0.02 && Math.abs(mo.lon + 0.13) < 0.02, "placed on the map from its geohash");
});

test("geohash centre", () => {
  const c = geohashCentre("gcpvj0");
  assert.ok(Math.abs(c.lat - 51.50) < 0.01 && Math.abs(c.lon + 0.13) < 0.01);
});

test("a failing network is reported, not fatal", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes("environment.data") ? new Response("x", { status: 503 }) : real(url, o));
  const r = await stationsNear(place, {});
  globalThis.fetch = real;
  assert.equal(r.networks.raingauge.ok, false);
  assert.ok(r.stations.some((s) => s.network === "airport"));
});

test("distance", () => {
  assert.ok(Math.abs(distKm(51.507, -0.128, 51.477, -0.461) - 23.3) < 0.5);
});
