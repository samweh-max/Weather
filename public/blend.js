// Builds one forecast out of every source and the live station readings.
//
// 1. Learn: every forecast this phone saves is later checked against what really happened
//    here: temperature and wind at the nearest airport, rain at the nearby rain gauges.
//    The results build up into a track record per source that slowly forgets (half-life
//    about 10 days), so it reflects recent weeks, not just yesterday.
// 2. Correct and weight: each source's steady warm or cold lean is removed (separately for
//    day and night), then sources are weighted by what's left of their error, separately for
//    temperature, rain and wind. Until there is a track record, sources are judged on how
//    close they are to what stations read right now.
// 3. Nowcast: the first hours lean towards what stations read now, and rain seen at gauges
//    or airports upwind is timed to arrive with the wind.
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
    const rainy = recent.filter((s) => s.raining != null && s.dist <= 15);
    const gaugeMm = recent.filter((s) => s.rain1h != null && s.dist <= 15);
    return {
      temp: wmean(temps.map((s) => [atPlace(s), w(s)])),
      tempN: temps.length,
      wind: wmean(winds.map((s) => [s.wind, w(s)])),
      windN: winds.length,
      dir: wdir(winds.map((s) => [s.dir, w(s)])),
      rainN: rainy.length,
      rainingN: rainy.filter((s) => s.raining).length,
      rain1h: wmean(gaugeMm.map((s) => [s.rain1h, w(s)])),
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
        for (const [hk, v] of Object.entries(series)) {
          const t = typeof v === "number" ? v : v && v.t;
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

  // What really happened here, hour by hour ("YYYY-MM-DDTHH" in local time): temperature and
  // wind from the nearest airport's history, rain from the gauges within 20 km (closer count
  // more). Each gauge reading covers the hour that ends at its time.
  function truthFrom(history, stations, toKey) {
    const out = new Map();
    const get = (k) => out.get(k) || (out.set(k, {}), out.get(k));
    for (const o of (history && history.obs) || []) {
      const k = toKey(o.time).slice(0, 13);
      const h = get(k);
      if (o.temp != null && h.temp == null) h.temp = o.temp;
      if (o.wind != null && h.wind == null) h.wind = o.wind;
    }
    const gauges = (stations || []).filter((s) => s.network === "raingauge" && s.hourly && s.dist <= 20);
    const acc = new Map();
    for (const g of gauges) {
      const w = 1 / (1 + g.dist / 6);
      for (const r of g.hourly) {
        if (r.mm == null) continue;
        const k = toKey(new Date(Date.parse(r.time) - HOUR).toISOString()).slice(0, 13);
        const a = acc.get(k) || { s: 0, w: 0 };
        a.s += r.mm * w; a.w += w;
        acc.set(k, a);
      }
    }
    for (const [k, a] of acc) {
      const h = get(k);
      h.mm = a.s / a.w;
      h.wet = h.mm >= 0.2 ? 1 : 0;
    }
    return out;
  }

  const DAY_FROM = 8, DAY_TO = 19; // local hours counted as "day" for the warm or cold lean
  const isDay = (hk) => { const h = Number(hk.slice(11, 13)); return h >= DAY_FROM && h < DAY_TO; };
  const HALF_LIFE = 10 * 24 * HOUR;

  // Check saved forecasts against what happened and add the results to the long-term track
  // record (the ledger). Checked hours are removed from the snapshots so they only count once.
  // Returns { ledger, snaps } for the caller to save.
  function learn(ledger, snaps, truth, nowKey) {
    const nowMs = ms(nowKey.slice(0, 13) + ":00");
    const L = ledger && ledger.src ? { at: ledger.at, src: JSON.parse(JSON.stringify(ledger.src)) } : { at: nowMs, src: {} };
    // Old results fade: a check from 10 days ago counts half as much as one from today.
    const fade = 0.5 ** (Math.max(0, nowMs - (L.at || nowMs)) / HALF_LIFE);
    if (fade < 1) for (const r of Object.values(L.src)) for (const k of Object.keys(r)) r[k] *= fade;
    L.at = nowMs;
    const add = (id, key, v) => { const r = (L.src[id] ||= {}); r[key] = (r[key] || 0) + v; };
    const kept = [];
    for (const snap of snaps || []) {
      const issued = ms(snap.issued);
      const f = {};
      for (const [id, series] of Object.entries(snap.f || {})) {
        const left = {};
        for (const [hk, raw] of Object.entries(series)) {
          const t = ms(hk);
          if (t > nowMs - 2 * HOUR) { left[hk] = raw; continue; } // not over yet, or gauges not in
          const o = truth.get(hk.slice(0, 13));
          if (!o) { if (t > nowMs - 26 * HOUR) left[hk] = raw; continue; }
          const v = typeof raw === "number" ? { t: raw } : raw || {};
          const lead = t - issued;
          if (lead < HOUR || lead > 24 * HOUR) continue;
          if (v.t != null && o.temp != null) {
            const e = v.t - o.temp, d = isDay(hk) ? "d" : "n";
            add(id, "tn", 1); add(id, "tabs", Math.abs(e)); add(id, "tsum", e);
            add(id, d + "n", 1); add(id, d + "sum", e);
          }
          if (v.w != null && o.wind != null) {
            const e = v.w - o.wind;
            add(id, "wn", 1); add(id, "wabs", Math.abs(e)); add(id, "wsum", e);
          }
          const p = v.p != null ? v.p / 100 : v.m != null ? (v.m >= 0.2 ? 0.9 : 0.1) : null;
          if (p != null && o.wet != null) { add(id, "rn", 1); add(id, "rsq", (p - o.wet) ** 2); }
        }
        if (Object.keys(left).length) f[id] = left;
      }
      if (Object.keys(f).length) kept.push({ issued: snap.issued, f });
    }
    return { ledger: L, snaps: kept };
  }

  // Turn the ledger into each source's track record: typical temperature miss (mae) and lean
  // (bias, overall and for day and night), wind miss and lean, and rain score (Brier: 0 is
  // perfect, 0.25 is no better than a coin toss).
  function skillFrom(ledger) {
    const out = {};
    for (const [id, r] of Object.entries((ledger && ledger.src) || {})) {
      const o = { n: r.tn || 0 };
      if (r.tn) { o.mae = r.tabs / r.tn; o.bias = r.tsum / r.tn; }
      if (r.dn >= 4) o.biasDay = r.dsum / r.dn;
      if (r.nn >= 4) o.biasNight = r.nsum / r.nn;
      if (r.wn) o.wind = { n: r.wn, mae: r.wabs / r.wn, bias: r.wsum / r.wn };
      if (r.rn) o.rain = { n: r.rn, brier: r.rsq / r.rn };
      out[id] = o;
    }
    return out;
  }

  // What people have said the weather was really like here, compared with what each source
  // forecast for that hour. reports: [{ code, temp?, wind?, src: { id: { temp, code, pop, wind } } }]
  // wind is "calm", "breezy" or "windy". Returns per source: temperature misses and how often its
  // sky, rain and wind matched what was reported (0 to 1).
  const SKY = { clear: 0, partly: 1, cloudy: 2, fog: 2 };
  const windClass = (kmh) => (kmh == null ? null : kmh < 12 ? "calm" : kmh < 30 ? "breezy" : "windy");
  function scoreReports(reports) {
    const out = {};
    for (const r of reports || []) {
      if (!r || !r.src) continue;
      const saidWet = WET.has(r.code);
      for (const [id, f] of Object.entries(r.src)) {
        const o = (out[id] ||= { n: 0, hits: 0, errs: [] });
        let score = 0, parts = 0;
        if (r.code) {
          const fWet = (f.pop != null && f.pop >= 50) || WET.has(f.code);
          if (fWet === saidWet) {
            score += 0.6;
            // Both dry: did it get the sky right too? Both wet: did it get the kind of wet right?
            if (!saidWet && f.code in SKY && r.code in SKY) score += Math.abs(SKY[f.code] - SKY[r.code]) === 0 ? 0.4 : Math.abs(SKY[f.code] - SKY[r.code]) === 1 ? 0.2 : 0;
            else if (saidWet) score += f.code === r.code ? 0.4 : 0.2;
          }
          parts += 1;
        }
        if (r.wind && f.wind != null) { score += windClass(f.wind) === r.wind ? 0.5 : 0; parts += 0.5; }
        if (parts) { o.n++; o.hits += score / parts; }
        if (r.temp != null && f.temp != null) o.errs.push(f.temp - r.temp);
      }
    }
    for (const o of Object.values(out)) {
      o.match = o.n ? o.hits / o.n : null;
      o.tempN = o.errs.length;
      o.mae = o.tempN ? o.errs.reduce((a, b) => a + Math.abs(b), 0) / o.tempN : null;
      o.bias = o.tempN ? o.errs.reduce((a, b) => a + b, 0) / o.tempN : null;
      delete o.errs;
    }
    return out;
  }

  // Add reported temperatures to the airport track record. One report counts as three airport
  // checks, because it is from the exact spot and a person took the trouble.
  function mergeSkill(skill, rated) {
    const out = { ...(skill || {}) };
    for (const [id, r] of Object.entries(rated || {})) {
      if (!r.tempN) continue;
      const a = out[id], k = r.tempN * 3;
      out[id] = a && a.n
        ? { ...a, n: a.n + k, mae: (a.mae * a.n + r.mae * k) / (a.n + k), bias: (a.bias * a.n + r.bias * k) / (a.n + k) }
        : { ...(a || {}), n: k, mae: r.mae, bias: r.bias };
    }
    return out;
  }

  // Turn raw scores into weights that add up to 1, never letting a source drop below 2%.
  function norm(out, from, to) {
    const total = Object.values(out).reduce((a, x) => a + (x[from] || 0), 0) || 1;
    for (const v of Object.values(out)) v[to] = Math.max((v[from] || 0) / total, 0.02);
    const total2 = Object.values(out).reduce((a, x) => a + x[to], 0);
    for (const v of Object.values(out)) v[to] /= total2;
  }

  function weightsFor(sources, obs, nowMs, skill, rated) {
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
        const lean = (b) => (b == null ? bias : Math.max(-4, Math.min(4, b)));
        out[s.id] = { raw: 1 / (left + 0.7) ** 2, basis: "past", err: sk && sk.n >= 6 ? mae : null, bias, n: sk ? sk.n : 0,
          biasDay: sk && sk.n >= 6 ? lean(sk.biasDay) : 0, biasNight: sk && sk.n >= 6 ? lean(sk.biasNight) : 0 };
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
    // Sources that matched what people reported here get more say; ones that kept missing get less.
    for (const s of sources) {
      const r = rated && rated[s.id];
      if (!r || !r.n || !out[s.id]) continue;
      const smoothed = (r.hits + 0.6) / (r.n + 1); // a single report can't swing things much
      out[s.id].raw *= (0.35 + smoothed) ** 2;
      out[s.id].rated = { n: r.n, match: r.match };
    }
    norm(out, "raw", "w");
    // Rain and wind get their own weights once there's a track record for them; until then
    // they follow the temperature weights.
    const rainKnown = sources.filter((s) => skill && skill[s.id] && skill[s.id].rain && skill[s.id].rain.n >= 8);
    const windKnown = sources.filter((s) => skill && skill[s.id] && skill[s.id].wind && skill[s.id].wind.n >= 6);
    const enough = (list) => list.length >= Math.max(2, sources.length / 2);
    for (const s of sources) {
      const o = out[s.id], sk = skill && skill[s.id];
      if (!o) continue;
      const rr = rated && rated[s.id] && rated[s.id].n ? (0.35 + (rated[s.id].hits + 0.6) / (rated[s.id].n + 1)) ** 2 : 1;
      if (enough(rainKnown)) {
        const brier = sk && sk.rain && sk.rain.n >= 8 ? sk.rain.brier : rainKnown.reduce((a, x) => a + skill[x.id].rain.brier, 0) / rainKnown.length;
        o.rawR = rr / (brier + 0.04) ** 2;
        o.rain = sk && sk.rain && sk.rain.n >= 8 ? sk.rain.brier : null;
      } else o.rawR = o.raw;
      if (enough(windKnown)) {
        const wk = sk && sk.wind && sk.wind.n >= 6 ? sk.wind : null;
        const wb = wk ? Math.max(-15, Math.min(15, wk.bias)) : 0;
        const wmae = wk ? Math.max(0, wk.mae - Math.abs(wb) * 0.7) : windKnown.reduce((a, x) => a + skill[x.id].wind.mae, 0) / windKnown.length;
        o.rawW = 1 / (wmae + 3) ** 2;
        o.windBias = wb;
      } else { o.rawW = o.raw; o.windBias = 0; }
    }
    norm(out, "rawR", "wr");
    norm(out, "rawW", "ww");
    return out;
  }

  // Rain seen upwind: wet stations 5 to 60 km away, in the direction the wind blows from
  // (within 40°). Returns when it would get here and how likely, or null.
  function upwindRain(stations, place, obs, nowMs) {
    if (!place || obs.dir == null || obs.wind == null || obs.wind < 8) return null;
    const r = Math.PI / 180;
    const bearing = (s) => {
      const y = Math.sin((s.lon - place.lon) * r) * Math.cos(s.lat * r);
      const x = Math.cos(place.lat * r) * Math.sin(s.lat * r) - Math.sin(place.lat * r) * Math.cos(s.lat * r) * Math.cos((s.lon - place.lon) * r);
      return (Math.atan2(y, x) / r + 360) % 360;
    };
    const near = (stations || []).filter((s) => s.raining != null && s.lat != null && s.dist >= 5 && s.dist <= 60 && (!s.time || nowMs - Date.parse(s.time) < 2 * HOUR));
    const ahead = near.filter((s) => { const d = Math.abs(((bearing(s) - obs.dir + 540) % 360) - 180); return d <= 40; });
    if (ahead.length < 1) return null;
    const wet = ahead.filter((s) => s.raining);
    if (!wet.length) return null;
    const share = wet.length / ahead.length;
    const dist = wet.reduce((a, s) => a + s.dist, 0) / wet.length;
    const hours = dist / obs.wind;
    if (hours > 6) return null;
    // Showers change on the way, so the further away the less sure.
    const chance = Math.round(Math.min(80, 40 + 45 * share) * Math.exp(-hours / 6));
    return { hours: Math.max(1, Math.round(hours)), chance, n: wet.length, dist: Math.round(dist) };
  }

  function predict({ providers, stations, nowKey, skill, reports, placeElev = null, place = null, hours: nHours = 36 }) {
    const sources = (providers || []).filter((p) => p && p.ok && p.hours && p.hours.length);
    const dailySources = (providers || []).filter((p) => p && p.ok && p.days && p.days.length);
    const nowMs = ms(nowKey.slice(0, 13) + ":00");
    const realNow = Date.now();
    const obs = observedNow(stations, realNow, placeElev);
    const rated = reports && reports.length ? scoreReports(reports) : null;
    if (rated) skill = mergeSkill(skill, rated);
    const weights = weightsFor(sources, obs, nowMs, skill, rated);
    const even = 1 / Math.max(sources.length, 1);
    const wOf = (id) => (weights[id] ? weights[id].w : even);
    const wrOf = (id) => (weights[id] ? weights[id].wr : even);
    const wwOf = (id) => (weights[id] ? weights[id].ww : even);
    const biasOf = (id) => (weights[id] && weights[id].bias) || 0;
    // The warm or cold lean for the time of day, falling back to the overall lean.
    const biasAt = (id, hk) => { const w = weights[id]; if (!w) return 0; const b = isDay(hk) ? w.biasDay : w.biasNight; return b == null ? w.bias || 0 : b; };
    const windFix = (id, v) => (v == null ? null : Math.max(0, v - ((weights[id] && weights[id].windBias) || 0)));

    const hours = [];
    for (let i = 0; i < nHours; i++) {
      const t = nowMs + i * HOUR;
      const hk = keyOf(t);
      const vals = sources.map((s) => ({ s, w: wOf(s.id), wr: wrOf(s.id), ww: wwOf(s.id), temp: sub(at(s.hours, t, "temp"), biasAt(s.id, hk)), wind: windFix(s.id, at(s.hours, t, "wind")), gust: windFix(s.id, at(s.hours, t, "gust")), dir: at(s.hours, t, "dir"), mm: at(s.hours, t, "mm"), pop: at(s.hours, t, "pop"), code: at(s.hours, t, "code") }));
      const live = vals.filter((v) => v.temp != null);
      if (!live.length) break;
      const temps = live.map((v) => v.temp);
      hours.push({
        time: keyOf(t),
        temp: wmean(live.map((v) => [v.temp, v.w])),
        lo: Math.min(...temps),
        hi: Math.max(...temps),
        pop: wmean(live.map((v) => [popOf(v), v.wr])),
        mm: wmean(live.map((v) => [v.mm, v.wr])),
        wind: wmean(live.map((v) => [v.wind, v.ww])),
        gust: wmean(live.map((v) => [v.gust, v.ww])),
        dir: wdir(live.map((v) => [v.dir, v.ww])),
        codes: live.map((v) => [v.code, v.wr]),
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
          if (obs.rain1h != null && hours[0].mm != null) hours[0].mm = Math.max(hours[0].mm, obs.rain1h);
        } else if (frac === 0 && obs.rainN >= 3) {
          now.rain = "dry";
          hours.forEach((h, i) => { if (h.pop != null) h.pop *= 1 - 0.6 * Math.exp(-i / 2); });
        }
      }
      // Rain on its way: gauges or airports that are wet now, upwind of here, with the time
      // the wind would take to bring it.
      const up = upwindRain(stations, place, obs, realNow);
      if (up && now.rain !== "raining") {
        now.upwind = up;
        hours.forEach((h, i) => {
          if (h.pop == null || i === 0) return;
          const lift = up.chance * Math.exp(-(((i - up.hours) / 1.2) ** 2));
          h.pop = Math.max(h.pop, lift);
        });
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
      const ds = dailySources.map((s) => ({ id: s.id, d: s.days.find((x) => x.date === date), w: wOf(s.id), wr: wrOf(s.id), ww: wwOf(s.id) })).filter((x) => x.d);
      // Highs happen in the day and lows at night, so each gets that time's lean.
      const ds2 = ds.map((x) => ({ ...x, b: biasAt(x.id, date + "T14"), bn: biasAt(x.id, date + "T04") }));
      const his = ds2.map((x) => x.d.hi - x.b);
      const hi = wmean(ds2.map((x) => [x.d.hi - x.b, x.w]));
      const lo = wmean(ds2.map((x) => [x.d.lo - x.bn, x.w]));
      const pops = ds.map((x) => [popOf(x.d), x.wr]);
      const pop = wmean(pops);
      const sd = Math.sqrt(wmean(ds2.map((x) => [(x.d.hi - x.b - hi) ** 2, x.w])) || 0);
      const wetShare = wmean(ds.map((x) => [WET.has(x.d.code) || (popOf(x.d) ?? 0) >= 50 ? 1 : 0, x.wr]));
      const rainSplit = wetShare > 0.3 && wetShare < 0.7;
      const confidence = ds.length < 2 ? "low" : sd <= 1 && !rainSplit ? "high" : sd <= 2 ? "medium" : "low";
      const codes = ds.map((x) => [x.d.code, x.wr]);
      const code = pop != null && pop >= 50 ? wmode(codes.filter(([c]) => WET.has(c))) || "rain" : pop != null && pop < 30 ? wmode(codes.filter(([c]) => c && !WET.has(c))) || "partly" : wmode(codes);
      return {
        date, hi, lo, pop,
        mm: wmean(ds.map((x) => [x.d.mm, x.wr])),
        wind: wmean(ds.map((x) => [windFix(x.id, x.d.wind), x.ww])),
        gust: wmean(ds.map((x) => [windFix(x.id, x.d.gust), x.ww])),
        dir: wdir(ds.map((x) => [x.d.dir, x.ww])),
        code: code || "cloudy",
        hiMin: Math.min(...his), hiMax: Math.max(...his),
        n: ds.length, confidence, split: rainSplit, idx,
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
    return { hours, days, weights: ws, now, basis: ws[0] ? ws[0].basis : "equal", reports: (reports || []).length };
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
        if (v == null) continue;
        const r1 = (x) => (x == null ? undefined : Math.round(x * 10) / 10);
        const pop = at(p.hours, t, "pop");
        series[keyOf(t).slice(0, 13)] = { t: r1(v), p: pop == null ? undefined : Math.round(pop), m: r1(at(p.hours, t, "mm")), w: r1(at(p.hours, t, "wind")) };
      }
      if (Object.keys(series).length) f[p.id] = series;
    }
    return { issued: keyOf(nowMs).slice(0, 13) + ":00", f };
  }

  // What each source forecast for the hour someone reports on, saved alongside the report.
  function reportFrom(providers, nowKey, said) {
    const t = ms(nowKey.slice(0, 16));
    const src = {};
    for (const p of providers || []) {
      if (!p || !p.ok || !p.hours) continue;
      const f = { temp: at(p.hours, t, "temp"), code: at(p.hours, t, "code"), pop: at(p.hours, t, "pop"), wind: at(p.hours, t, "wind") };
      if (f.temp == null && f.code == null) continue;
      if (f.temp != null) f.temp = Math.round(f.temp * 10) / 10;
      src[p.id] = f;
    }
    return { at: nowKey.slice(0, 16), code: said.code || null, temp: said.temp ?? null, wind: said.wind || null, src };
  }

  root.Blend = { predict, scoreSkill, scoreReports, mergeSkill, reportFrom, snapshot, observedNow, toLocalKey, at, median, truthFrom, learn, skillFrom, upwindRain };
})(typeof window !== "undefined" ? window : globalThis);
