// The blending maths, with small made-up sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../public/blend.js";
const { predict, scoreSkill, snapshot } = globalThis.Blend;

const nowKey = "2026-11-04T12:00";
function src(id, temp, extra = {}) {
  const hours = [];
  for (let i = -2; i < 30; i++) {
    const t = new Date(Date.parse("2026-11-04T12:00:00Z") + i * 3600e3).toISOString().slice(0, 16);
    hours.push({ time: t, temp, wind: 20, gust: 30, dir: 270, pop: extra.pop ?? 10, mm: 0, code: extra.code ?? "partly" });
  }
  const days = [{ date: "2026-11-04", hi: temp + 2, lo: temp - 4, pop: extra.pop ?? 10, mm: 0, wind: 20, gust: 30, dir: 270, code: extra.code ?? "partly" },
                { date: "2026-11-05", hi: temp + 1, lo: temp - 5, pop: 60, mm: 3, wind: 30, gust: 50, dir: 200, code: "rain" }];
  return { id, name: id, ok: true, hours, days };
}
const station = (temp, extra = {}) => ({ network: "airport", dist: 5, time: new Date().toISOString(), temp, wind: 20, dir: 270, raining: false, ...extra });

test("with no stations, sources count equally", () => {
  const r = predict({ providers: [src("a", 10), src("b", 14)], stations: [], nowKey });
  assert.equal(r.basis, "equal");
  assert.equal(Math.round(r.hours[0].temp), 12);
  assert.equal(r.hours[0].lo, 10);
  assert.equal(r.hours[0].hi, 14);
});

test("the source closest to what stations read now gets more weight, and hour 0 matches the stations", () => {
  const r = predict({ providers: [src("a", 10), src("b", 14)], stations: [station(10)], nowKey });
  assert.equal(r.basis, "now");
  assert.equal(r.weights[0].id, "a");
  assert.ok(r.weights[0].w > 0.8);
  assert.ok(Math.abs(r.hours[0].temp - 10) < 0.01, "hour 0 is pulled to the observed temperature");
  assert.ok(r.hours[20].temp > r.hours[0].temp, "the nudge fades later");
});

test("stations reporting rain raise the chance of rain in the next hours", () => {
  const st = [station(10, { raining: true }), station(10, { raining: true, dist: 9 }), station(10, { raining: false, dist: 12 })];
  const r = predict({ providers: [src("a", 10), src("b", 10)], stations: st, nowKey });
  assert.equal(r.now.rain, "raining");
  assert.ok(r.hours[0].pop >= 80);
  assert.ok(r.hours[10].pop < 20);
});

test("past accuracy beats a single reading when there is enough history", () => {
  const providers = [src("a", 10), src("b", 14)];
  const snaps = [];
  const history = [];
  for (let i = 0; i < 12; i++) {
    const issued = new Date(Date.parse("2026-11-03T12:00:00Z") + i * 3600e3).toISOString().slice(0, 16);
    const target = new Date(Date.parse(issued + ":00Z") + 4 * 3600e3).toISOString().slice(0, 13);
    snaps.push({ issued, f: { a: { [target]: 10 }, b: { [target]: 14 } } });
    history.push({ key: target + ":00", temp: 14 });
  }
  const skill = scoreSkill(snaps, history);
  assert.equal(skill.b.mae, 0);
  assert.equal(skill.a.mae, 4);
  const r = predict({ providers, stations: [], nowKey, skill });
  assert.equal(r.basis, "past");
  assert.equal(r.weights[0].id, "b");
});

test("daily blend and confidence", () => {
  const r = predict({ providers: [src("a", 10), src("b", 10.5)], stations: [], nowKey });
  assert.equal(r.days.length, 2);
  assert.equal(r.days[1].code, "rain");
  assert.equal(r.days[0].confidence, "high");
  const r2 = predict({ providers: [src("a", 6), src("b", 14)], stations: [], nowKey });
  assert.equal(r2.days[0].confidence, "low");
});

test("snapshot keeps the next 24 hours, every 2 hours", () => {
  const s = snapshot([src("a", 10)], nowKey);
  assert.equal(s.issued, "2026-11-04T12:00");
  assert.equal(Object.keys(s.f.a).length, 12);
});

test("a source that always runs warm here is corrected, not just down-weighted", () => {
  const snaps = [], history = [];
  for (let i = 0; i < 12; i++) {
    const issued = new Date(Date.parse("2026-11-03T12:00:00Z") + i * 3600e3).toISOString().slice(0, 16);
    const target = new Date(Date.parse(issued + ":00Z") + 4 * 3600e3).toISOString().slice(0, 13);
    snaps.push({ issued, f: { a: { [target]: 13 }, b: { [target]: 13 } } });
    history.push({ key: target + ":00", temp: 10 });
  }
  const skill = scoreSkill(snaps, history);
  assert.equal(skill.a.bias, 3);
  const r = predict({ providers: [src("a", 13), src("b", 13)], stations: [], nowKey, skill });
  assert.ok(Math.abs(r.hours[5].temp - 10) < 0.01, "both sources are 3° warm here, so the blend says 10°");
  assert.ok(Math.abs(r.days[0].hi - 12) < 0.01);
});

test("stations on a hill are shifted to the place's height", () => {
  const hill = { network: "airport", dist: 5, time: new Date().toISOString(), temp: 8, elev: 310 };
  const r = predict({ providers: [src("a", 10)], stations: [hill], nowKey, placeElev: 10 });
  assert.ok(Math.abs(r.now.obs.temp - 9.95) < 0.01);
});

test("reports of what the weather was really like shift weight to the sources that matched", () => {
  const { reportFrom, scoreReports } = globalThis.Blend;
  const dry = src("dry", 10, { pop: 5, code: "partly" });
  const wet = src("wet", 10, { pop: 80, code: "rain" });
  const reports = [0, 1, 2].map(() => reportFrom([dry, wet], nowKey, { code: "rain", wind: "breezy" }));
  assert.equal(reports[0].src.wet.code, "rain");
  const s = scoreReports(reports);
  assert.ok(s.wet.match > 0.9 && s.dry.match < 0.4, JSON.stringify(s));
  const r = predict({ providers: [dry, wet], stations: [], nowKey, reports });
  const w = Object.fromEntries(r.weights.map((x) => [x.id, x.w]));
  assert.ok(w.wet > w.dry * 2, JSON.stringify(w));
  assert.equal(r.reports, 3);
});

test("reported temperatures count towards each source's warm or cold lean", () => {
  const { reportFrom } = globalThis.Blend;
  const warm = src("warm", 14), right = src("right", 10);
  const reports = [0, 1].map(() => reportFrom([warm, right], nowKey, { code: "cloudy", temp: 10 }));
  const r = predict({ providers: [warm, right], stations: [], nowKey, reports });
  assert.equal(r.basis, "past");
  const wr = r.weights.find((x) => x.id === "warm");
  assert.equal(Math.round(wr.bias), 4);
  assert.ok(Math.abs(r.hours[0].temp - 10) < 0.5, String(r.hours[0].temp));
});

test("saved forecasts are checked against airports and rain gauges, and build a lasting track record", () => {
  const { truthFrom, learn, skillFrom } = globalThis.Blend;
  const toKey = (iso) => iso.slice(0, 16);
  const obs = [], hourly = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(Date.parse("2026-11-03T12:00:00Z") + i * 3600e3).toISOString();
    obs.push({ time: t, temp: 10, wind: 20 });
    hourly.push({ time: new Date(Date.parse(t) + 3600e3).toISOString(), mm: i % 2 ? 1 : 0 });
  }
  const truth = truthFrom({ obs }, [{ network: "raingauge", dist: 3, hourly }], toKey);
  const snaps = [];
  for (let i = 0; i < 20; i++) {
    const hk = new Date(Date.parse("2026-11-03T12:00:00Z") + i * 3600e3).toISOString().slice(0, 13);
    const wet = i % 2 === 1;
    snaps.push({ issued: new Date(Date.parse(hk + ":00Z") - 3 * 3600e3).toISOString().slice(0, 16), f: {
      good: { [hk]: { t: 10, p: wet ? 90 : 10, w: 20 } },
      warm: { [hk]: { t: 13, p: wet ? 10 : 90, w: 35 } },
    } });
  }
  const { ledger, snaps: left } = learn(null, snaps, truth, "2026-11-04T12:00");
  assert.equal(left.length, 0, "checked hours are used up");
  const sk = skillFrom(ledger);
  assert.equal(Math.round(sk.warm.bias), 3);
  assert.ok(sk.good.rain.brier < 0.05 && sk.warm.rain.brier > 0.5);
  assert.equal(Math.round(sk.warm.wind.bias), 15);
  // Ten days later the same record counts half as much.
  const later = learn(ledger, [], new Map(), "2026-11-14T12:00").ledger;
  assert.ok(Math.abs(skillFrom(later).warm.n - sk.warm.n / 2) < 0.01);
  // Rain weights follow the rain record, not the temperature one.
  const r = predict({ providers: [src("good", 10, { pop: 80 }), src("warm", 13, { pop: 0 })], stations: [], nowKey, skill: sk });
  const w = Object.fromEntries(r.weights.map((x) => [x.id, x]));
  assert.ok(w.good.wr > 0.9);
  assert.ok(r.hours[3].pop > 70);
  assert.ok(Math.abs(r.hours[3].temp - 10) < 0.01, "the warm source's lean is corrected");
});

test("rain seen upwind is timed to arrive with the wind", () => {
  const place = { lat: 51.5, lon: 0 };
  // Wind from the west at 20 km/h; a wet gauge 40 km west, a dry one 40 km east.
  const st = [
    { network: "airport", dist: 3, lat: 51.5, lon: 0.04, time: new Date().toISOString(), temp: 10, wind: 20, dir: 270, raining: false },
    { network: "raingauge", dist: 40, lat: 51.5, lon: -0.576, time: new Date().toISOString(), raining: true },
    { network: "raingauge", dist: 40, lat: 51.5, lon: 0.576, time: new Date().toISOString(), raining: false },
  ];
  const r = predict({ providers: [src("a", 10, { pop: 5 })], stations: st, nowKey, place });
  assert.equal(r.now.upwind.hours, 2);
  assert.ok(r.hours[2].pop > 30 && r.hours[8].pop < 10);
});
