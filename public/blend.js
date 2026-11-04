// Builds one forecast out of every source and the live station readings.
//
// 1. Weight each source by how close it has been to reality here: its average
//    error over the past day against the nearest airport if we have that history,
//    otherwise how close it is to what stations read right now.
// 2. Average the sources hour by hour with those weights.
// 3. Nudge the first hours towards what stations are reading now (a "nowcast"),
//    fading the nudge out over the next few hours.
//
// Works in the browser (window.Blend) and in tests (globalThis.Blend). Units: °C, km/h, mm.

(function (root) {
  "use strict";

  const WET = new Set(["drizzle", "rain", "heavy-rain", "sleet", "snow", "thunder"]);
  const HOUR = 3600e3;

  // Local clock times ("YYYY-MM-DDTHH:MM") are compared as if they were UTC; only differences matter.
  const ms = (key) => Date.parse(key.slice(0, 16) + ":00Z");
  const keyOf = (t) => new Date(t).toISOString().slice(0, 16);

  function toLocalKey(iso, tz) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(iso)).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  // Value of `field` at time t from a source's hourly list; temps and wind are interpolated
  // between 3- or 6-hourly points, other fields use the slot that covers t.
  function at(hours, t, field) {
    let prev = null, next = null;
    for (const h of hours) {
      const ht = ms(h.time);
      if (ht <= t) prev = h; else { next = h; break; }
    }
    if (!prev) return null;
    const pt = ms(prev.time);
    if (pt === t) return prev[field];
    if (!next || ms(next.time) - pt > 6 * HOUR) return t - pt <= HOUR ? prev[field] : null;
    if ((field === "temp" || field === "wind" || field === "gust") && prev[field] != null && next[field] != null) {
      const f = (t - pt) / (ms(next.time) - pt);
      return prev[field] + (next[field] - prev[field]) * f;
    }
    return prev[field];
  }

  const sub = (v, b) => (v == null ? null : v - b);

  function wmean(pairs) {
    let s = 0, w = 0;
    for (const [v, wt] of pairs) if (v != null) { s += v * wt; w += wt; }
    return w ? s / w : null;
  }
  function wdir(pairs) {
    let x = 0, y = 0, n = 0;
    for (const [d, wt] of pairs) if (d != null) { x += Math.cos((d * Math.PI) / 180) * wt; y += Math.sin((d * Math.PI) / 180) * wt; n++; }
    return n ? ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 : null;
  }
  function wmode(pairs) {
    const c = {};
    for (const [v, wt] of pairs) if (v) c[v] = (c[v] || 0) + wt;
    return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || null;
  }
  function popOf(x) {
    if (x.pop != null) return x.pop;
    if (x.mm != null) return x.mm >= 0.2 ? 100 : 0;
    return null;
  }
  function median(xs) {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // What the stations near the place are reading now. Closer stations count more;
  // home stations count less than official ones.
  // Air cools about 0.65° per 100 m of height, so readings from stations higher or lower
  // than the place are shifted to the place's height.
  function observedNow(stations, nowMs, placeElev) {
    const recent = (stations || []).filter((s) => s.dist <= 40 && (!s.time || nowMs - Date.parse(s.time) < 2 * HOUR));
    const trust = { airport: 1, metoffice: 1, netatmo: 0.35, raingauge: 1 };
    const w = (s) => (trust[s.network] || 0.5) / (1 + s.dist / 8);
    const temps = recent.filter((s) => s.temp != null);
    const atPlace = (s) => (placeElev != null && s.elev != null ? s.temp + (s.elev - placeElev) * 0.0065 : s.temp);
    const winds = recent.filter((s) => s.wind != null && s.network !== "netatmo");
    const rainy = recent.filter((s) => s.raining != null);
    return {
      temp: wmean(temps.map((s) => [atPlace(s), w(s)])),
      tempN: temps.length,
      wind: wmean(winds.map((s) => [s.wind, w(s)])),
      windN: winds.length,
      dir: wdir(winds.map((s) => [s.dir, w(s)])),
      rainN: rainy.length,
      rainingN: rainy.filter((s) => s.raining).length,
    };
  }

  // Past accuracy: compare saved forecasts with what the nearest airport actually measured.
  // snaps: [{ issued: key, f: { sourceId: { hourKey: temp } } }], history: [{ key, temp }]
  function scoreSkill(snaps, history) {
    const obs = new Map((history || []).map((o) => [o.key.slice(0, 13), o.temp]));
    const err = {};
    for (const snap of snaps || []) {
      const issued = ms(snap.issued);
      for (const [id, series] of Object.entries(snap.f || {})) {
        for (const [hk, t] of Object.entries(series)) {
          const o = obs.get(hk.slice(0, 13));
          if (o == null || t == null) continue;
          const lead = ms(hk) - issued;
          if (lead < 2 * HOUR || lead > 24 * HOUR) continue;
          (err[id] ||= []).push(t - o);
        }
      }
    }
    const out = {};
    // mae: typical size of the miss. bias: whether the source tends to run warm (+) or cold (−) here.
    for (const [id, e] of Object.entries(err)) {
      out[id] = { n: e.length, mae: e.reduce((a, b) => a + Math.abs(b), 0) / e.length, bias: e.reduce((a, b) => a + b, 0) / e.length };
    }
    return out;
  }

  function weightsFor(sources, obs, nowMs, skill) {
    const scored = sources.filter((s) => skill && skill[s.id] && skill[s.id].n >= 6);
    const out = {};
    if (scored.length >= Math.max(2, sources.length / 2)) {
      const meanMae = scored.reduce((a, s) => a + skill[s.id].mae, 0) / scored.length;
      for (const s of sources) {
        const sk = skill[s.id];
        const mae = sk && sk.n >= 6 ? sk.mae : meanMae;
        // Correct a steady warm or cold lean first, then weight by what's left of the error.
        const bias = sk && sk.n >= 6 ? Math.max(-4, Math.min(4, sk.bias || 0)) : 0;
        const left = sk && sk.n >= 6 ? Math.max(0, mae - Math.abs(bias) * 0.7) : mae;
        out[s.id] = { raw: 1 / (left + 0.7) ** 2, basis: "past", err: sk && sk.n >= 6 ? mae : null, bias, n: sk ? sk.n : 0 };
      }
    } else if (obs.temp != null) {
      for (const s of sources) {
        const t = at(s.hours, nowMs, "temp");
        const w = at(s.hours, nowMs, "wind");
        if (t == null) { out[s.id] = { raw: null, basis: "now", err: null }; continue; }
        const e = Math.abs(t - obs.temp) + (w != null && obs.wind != null ? Math.abs(w - obs.wind) / 10 : 0);
        out[s.id] = { raw: 1 / (e + 0.8) ** 2, basis: "now", err: Math.abs(t - obs.temp) };
      }
      const known = Object.values(out).filter((x) => x.raw != null).map((x) => x.raw);
      const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
      for (const v of Object.values(out)) if (v.raw == null) v.raw = avg * 0.6;
    } else {
      for (const s of sources) out[s.id] = { raw: 1, basis: "equal", err: null };
    }
    const total = Object.values(out).reduce((a, x) => a + x.raw, 0) || 1;
    for (const v of Object.values(out)) v.w = Math.max(v.raw / total, 0.02);
    const total2 = Object.values(out).reduce((a, x) => a + x.w, 0);
    for (const v of Object.values(out)) v.w /= total2;
    return out;
  }

  function predict({ providers, stations, nowKey, skill, placeElev = null, hours: nHours = 36 }) {
    const sources = (providers || []).filter((p) => p && p.ok && p.hours && p.hours.length);
    const dailySources = (providers || []).filter((p) => p && p.ok && p.days && p.days.length);
    const nowMs = ms(nowKey.slice(0, 13) + ":00");
    const realNow = Date.now();
    const obs = observedNow(stations, realNow, placeElev);
    const weights = weightsFor(sources, obs, nowMs, skill);
    const wOf = (id) => (weights[id] ? weights[id].w : 1 / Math.max(sources.length, 1));
    const biasOf = (id) => (weights[id] && weights[id].bias) || 0;

    const hours = [];
    for (let i = 0; i < nHours; i++) {
      const t = nowMs + i * HOUR;
      const vals = sources.map((s) => ({ s, w: wOf(s.id), temp: sub(at(s.hours, t, "temp"), biasOf(s.id)), wind: at(s.hours, t, "wind"), gust: at(s.hours, t, "gust"), dir: at(s.hours, t, "dir"), mm: at(s.hours, t, "mm"), pop: at(s.hours, t, "pop"), code: at(s.hours, t, "code") }));
      const live = vals.filter((v) => v.temp != null);
      if (!live.length) break;
      const temps = live.map((v) => v.temp);
      hours.push({
        time: keyOf(t),
        temp: wmean(live.map((v) => [v.temp, v.w])),
        lo: Math.min(...temps),
        hi: Math.max(...temps),
        pop: wmean(live.map((v) => [popOf(v), v.w])),
        mm: wmean(live.map((v) => [v.mm, v.w])),
        wind: wmean(live.map((v) => [v.wind, v.w])),
        gust: wmean(live.map((v) => [v.gust, v.w])),
        dir: wdir(live.map((v) => [v.dir, v.w])),
        codes: live.map((v) => [v.code, v.w]),
        n: live.length,
      });
    }

    // Nowcast: lean the first few hours towards what stations read now.
    const now = { obs, tempAdj: 0, windAdj: 0, rain: null };
    if (hours.length) {
      if (obs.temp != null && obs.tempN >= 1) {
        now.tempAdj = Math.max(-5, Math.min(5, obs.temp - hours[0].temp));
        hours.forEach((h, i) => { const k = now.tempAdj * Math.exp(-i / 6); h.temp += k; h.lo += k; h.hi += k; });
      }
      if (obs.wind != null && obs.windN >= 1 && hours[0].wind != null) {
        now.windAdj = Math.max(-25, Math.min(25, obs.wind - hours[0].wind));
        hours.forEach((h, i) => { if (h.wind != null) h.wind = Math.max(0, h.wind + now.windAdj * Math.exp(-i / 4)); });
      }
      if (obs.rainN >= 2) {
        const frac = obs.rainingN / obs.rainN;
        if (frac >= 0.5) {
          now.rain = "raining";
          hours.forEach((h, i) => { if (h.pop != null) h.pop = Math.max(h.pop, 85 * Math.exp(-i / 2)); });
        } else if (frac === 0 && obs.rainN >= 3) {
          now.rain = "dry";
          hours.forEach((h, i) => { if (h.pop != null) h.pop *= 1 - 0.6 * Math.exp(-i / 2); });
        }
      }
    }
    for (const h of hours) {
      const code = wmode(h.codes) || "cloudy";
      const dry = wmode(h.codes.filter(([c]) => c && !WET.has(c))) || "cloudy";
      const wet = wmode(h.codes.filter(([c]) => WET.has(c))) || "rain";
      h.code = h.pop != null && h.pop >= 50 ? wet : h.pop != null && h.pop < 30 ? dry : code;
      delete h.codes;
    }

    // Days: weighted blend of each source's daily figures.
    const dates = [...new Set(dailySources.flatMap((s) => s.days.map((d) => d.date)))].filter((d) => d >= nowKey.slice(0, 10)).sort().slice(0, 7);
    const days = dates.map((date, idx) => {
      const ds = dailySources.map((s) => ({ id: s.id, d: s.days.find((x) => x.date === date), w: wOf(s.id) })).filter((x) => x.d);
      const ds2 = ds.map((x) => ({ ...x, b: biasOf(x.id) }));
      const his = ds2.map((x) => x.d.hi - x.b);
      const hi = wmean(ds2.map((x) => [x.d.hi - x.b, x.w]));
      const lo = wmean(ds2.map((x) => [x.d.lo - x.b, x.w]));
      const pops = ds.map((x) => [popOf(x.d), x.w]);
      const pop = wmean(pops);
      const sd = Math.sqrt(wmean(ds2.map((x) => [(x.d.hi - x.b - hi) ** 2, x.w])) || 0);
      const wetShare = wmean(ds.map((x) => [WET.has(x.d.code) || (popOf(x.d) ?? 0) >= 50 ? 1 : 0, x.w]));
      const rainSplit = wetShare > 0.3 && wetShare < 0.7;
      const confidence = ds.length < 2 ? "low" : sd <= 1 && !rainSplit ? "high" : sd <= 2 ? "medium" : "low";
      const codes = ds.map((x) => [x.d.code, x.w]);
      const code = pop != null && pop >= 50 ? wmode(codes.filter(([c]) => WET.has(c))) || "rain" : pop != null && pop < 30 ? wmode(codes.filter(([c]) => c && !WET.has(c))) || "partly" : wmode(codes);
      return {
        date, hi, lo, pop,
        mm: wmean(ds.map((x) => [x.d.mm, x.w])),
        wind: wmean(ds.map((x) => [x.d.wind, x.w])),
        gust: wmean(ds.map((x) => [x.d.gust, x.w])),
        dir: wdir(ds.map((x) => [x.d.dir, x.w])),
        code: code || "cloudy",
        hiMin: Math.min(...his), hiMax: Math.max(...his),
        n: ds.length, confidence, idx,
      };
    });

    // If the adjusted hours run warmer than today's blended high, meet them halfway.
    if (days[0] && hours.length) {
      const today = hours.filter((h) => h.time.slice(0, 10) === days[0].date).map((h) => h.temp);
      const hourMax = today.length ? Math.max(...today) : null;
      if (hourMax != null && hourMax > days[0].hi) days[0].hi = (days[0].hi + hourMax) / 2;
    }

    const ws = sources
      .map((s) => ({ id: s.id, name: s.name, ...weights[s.id] }))
      .sort((a, b) => b.w - a.w);
    return { hours, days, weights: ws, now, basis: ws[0] ? ws[0].basis : "equal" };
  }

  // Keep a copy of each source's next 24 hours, at most one per hour, for later scoring.
  function snapshot(providers, nowKey) {
    const nowMs = ms(nowKey.slice(0, 13) + ":00");
    const f = {};
    for (const p of providers || []) {
      if (!p || !p.ok || !p.hours) continue;
      const series = {};
      for (let i = 2; i <= 24; i += 2) {
        const t = nowMs + i * HOUR;
        const v = at(p.hours, t, "temp");
        if (v != null) series[keyOf(t).slice(0, 13)] = Math.round(v * 10) / 10;
      }
      if (Object.keys(series).length) f[p.id] = series;
    }
    return { issued: keyOf(nowMs).slice(0, 13) + ":00", f };
  }

  root.Blend = { predict, scoreSkill, snapshot, observedNow, toLocalKey, at, median };
})(typeof window !== "undefined" ? window : globalThis);
