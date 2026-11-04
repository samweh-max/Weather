// Interactive map for the Stations page: live station readings, your place, and
// rain radar from the last two hours. Uses Leaflet, CARTO base maps (OpenStreetMap data)
// and RainViewer radar tiles. Leaflet is loaded the first time the map is shown.

(function () {
  "use strict";

  const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
  const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";

  let map, base, stationLayer, placeMarker, radar = null, radarFrames = [], radarIdx = 0, radarTimer = 0;
  let loading = null;
  let lastFetch = null;
  const seen = new Map(); // station id -> station
  let opts = {};
  let cartoKey = null;

  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!window.LEAFLET_CSS_INLINED) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = LEAFLET_CSS;
        document.head.append(css);
      }
      const js = document.createElement("script");
      js.src = LEAFLET_JS;
      js.onload = () => resolve();
      js.onerror = () => reject(new Error("Map library didn't load"));
      document.head.append(js);
    });
    return loading;
  }

  const dark = () =>
    document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

  // CARTO's base maps need a free key (CARTO_KEY). Without one, fall back to OpenStreetMap's own tiles.
  function baseUrl() {
    if (cartoKey) return `https://{s}.basemaps.cartocdn.com/${dark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cartoKey)}`;
    return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  }

  function baseAttribution() {
    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
    return cartoKey ? osm + ' &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>' : osm;
  }

  // Colour for a temperature, cold blue through to hot orange.
  function tempColor(c) {
    const stops = [[-5, [91, 120, 230]], [3, [75, 160, 216]], [9, [86, 184, 160]], [14, [233, 190, 78]], [20, [242, 150, 82]], [28, [222, 92, 58]]];
    if (c <= stops[0][0]) return `rgb(${stops[0][1]})`;
    for (let i = 1; i < stops.length; i++) {
      if (c <= stops[i][0]) {
        const [t0, a] = stops[i - 1], [t1, b] = stops[i];
        const f = (c - t0) / (t1 - t0);
        return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
      }
    }
    return `rgb(${stops[stops.length - 1][1]})`;
  }

  function markerFor(s) {
    const f = opts.fmt;
    if (s.temp == null) {
      // Rain gauge: a drop, filled when it's raining.
      const wet = s.raining;
      return L.divIcon({
        className: "",
        html: `<div class="mk-gauge ${wet ? "wet" : ""}" title="${s.rain1h != null ? f.rain(s.rain1h) + " in the last hour" : ""}"><svg viewBox="0 0 16 16"><path d="M8 1.5C8 1.5 3 7.2 3 10.2a5 5 0 0 0 10 0C13 7.2 8 1.5 8 1.5z"/></svg></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
    }
    const arrow = s.wind != null && s.dir != null
      ? `<svg class="mk-arrow" viewBox="0 0 24 24" style="transform:rotate(${(s.dir + 180) % 360}deg)"><path d="M12 2.5 18.5 20 12 16.2 5.5 20z"/></svg>` : "";
    const official = s.network === "airport" || s.network === "metoffice";
    return L.divIcon({
      className: "",
      html: `<div class="mk-temp ${official ? "official" : ""} ${s.raining ? "wet" : ""}" style="--c:${tempColor(s.temp)}">${f.temp(s.temp)}${arrow}</div>`,
      iconSize: null, iconAnchor: [22, 14],
    });
  }

  function popupFor(s) {
    const f = opts.fmt;
    const net = { airport: "Airport", metoffice: "Met Office station", raingauge: "Rain gauge" }[s.network];
    const rows = [];
    if (s.temp != null) rows.push(["Temperature", f.temp(s.temp)]);
    if (s.humidity != null) rows.push(["Humidity", Math.round(s.humidity) + "%"]);
    if (s.wind != null) rows.push(["Wind", `${f.windNum(s.wind)} ${f.windUnit()}${s.dir != null ? " from " + opts.compass(s.dir) : ""}${s.gust != null ? ", gusts " + f.windNum(s.gust) : ""}`]);
    if (s.rain1h != null) rows.push(["Rain, last hour", f.rain(s.rain1h)]);
    if (s.rain24h != null) rows.push(["Rain, last 24 hours", f.rain(s.rain24h)]);
    else if (s.wx) rows.push(["Weather", s.wx]);
    else if (s.raining != null) rows.push(["Rain", s.raining ? "yes" : "dry"]);
    if (s.pressure != null) rows.push(["Pressure", Math.round(s.pressure) + " hPa"]);
    return `<div class="pop"><b>${opts.esc(s.name)}</b><small>${net}${s.time ? " · " + opts.ago(s.time) : ""}</small>
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${opts.esc(v)}</td></tr>`).join("")}</table>${s.hourly && opts.timeline ? opts.timeline(s.hourly) : ""}</div>`;
  }

  function addStations(list) {
    for (const s of list || []) {
      if (s.lat == null || s.lon == null) continue;
      const prev = seen.get(s.id);
      if (prev && prev.time === s.time) continue;
      if (prev && prev._m) stationLayer.removeLayer(prev._m);
      const m = L.marker([s.lat, s.lon], { icon: markerFor(s), zIndexOffset: s.temp != null ? 100 : 0, keyboard: true, title: s.name });
      m.bindPopup(() => popupFor(s), { closeButton: false, offset: [0, -6], minWidth: s.hourly ? 240 : 50 });
      s._m = m;
      seen.set(s.id, s);
      stationLayer.addLayer(m);
    }
  }

  // Fetch stations around the middle of the map when it has moved far enough.
  async function fetchAround() {
    const c = map.getCenter();
    if (lastFetch && map.distance(c, lastFetch) < 15000) return;
    lastFetch = c;
    try {
      const body = await opts.api(`/api/stations?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`);
      addStations(body.stations);
    } catch {}
  }

  async function loadRadar() {
    try {
      const data = await fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json());
      radarFrames = (data.radar && data.radar.past) || [];
      if (!radarFrames.length) throw new Error();
      const host = data.host;
      radarIdx = radarFrames.length - 1;
      const layers = radarFrames.map((f) =>
        L.tileLayer(`${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 14, zIndex: 5, attribution: '<a href="https://www.rainviewer.com/" target="_blank">RainViewer</a>' })
      );
      radar = { layers };
      layers.forEach((l) => l.addTo(map));
      showFrame(radarIdx);
      return true;
    } catch {
      radar = null;
      return false;
    }
  }

  function showFrame(i) {
    if (!radar) return;
    radar.layers.forEach((l, k) => l.setOpacity(k === i ? 0.7 : 0));
    const t = new Date(radarFrames[i].time * 1000);
    const lbl = document.getElementById("radarTime");
    if (lbl) lbl.textContent = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function setRadar(on) {
    const btn = document.getElementById("radarBtn");
    const play = document.getElementById("radarPlay");
    if (on && !radar) {
      btn.textContent = "Loading radar…";
      loadRadar().then((ok) => {
        btn.textContent = "Rain radar";
        btn.setAttribute("aria-pressed", String(ok));
        play.hidden = !ok;
        if (!ok) { btn.textContent = "Radar unavailable"; btn.disabled = true; }
      });
      return;
    }
    if (!radar) return;
    radar.layers.forEach((l) => (on ? l.addTo(map) : map.removeLayer(l)));
    if (on) showFrame(radarIdx); else stopRadar();
    btn.setAttribute("aria-pressed", String(on));
    play.hidden = !on;
  }

  function stopRadar() {
    clearInterval(radarTimer);
    radarTimer = 0;
    const play = document.getElementById("radarPlay");
    if (play) play.firstElementChild.textContent = "Play";
  }

  function toggleRadarPlay() {
    if (radarTimer) { stopRadar(); return; }
    document.getElementById("radarPlay").firstElementChild.textContent = "Pause";
    radarIdx = 0;
    showFrame(0);
    radarTimer = setInterval(() => {
      radarIdx = (radarIdx + 1) % radarFrames.length;
      showFrame(radarIdx);
      if (radarIdx === radarFrames.length - 1) { stopRadar(); }
    }, 600);
  }

  // Show (or create) the map inside `el`, centred on the place, with these stations.
  async function show(el, place, stations, options) {
    opts = options;
    try {
      await loadLeaflet();
    } catch (err) {
      el.innerHTML = `<div class="map-msg">The map couldn't load. Check your connection and try again.</div>`;
      return;
    }
    if (!map || map.getContainer() !== el) {
      if (map) map.remove();
      seen.clear();
      radar = null;
      lastFetch = null;
      map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView([place.lat, place.lon], 10);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      if (window.DEMO_LAND) {
        // Preview only: an outline of the land instead of map tiles, which the preview can't load.
        el.classList.add("offline");
        L.geoJSON(window.DEMO_LAND, { interactive: false, style: { className: "land", weight: 1 } }).addTo(map);
        map.attributionControl.addAttribution("Coastlines: Natural Earth");
      } else {
        try { cartoKey = (await opts.api("/api/map")).cartoKey || null; } catch { cartoKey = null; }
        el.classList.toggle("osm", !cartoKey);
        base = L.tileLayer(baseUrl(), { subdomains: "abcd", maxZoom: cartoKey ? 18 : 19, attribution: baseAttribution() }).addTo(map);
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => base.setUrl(baseUrl()));
      }
      stationLayer = L.layerGroup().addTo(map);
      map.on("moveend", () => { clearTimeout(map._t); map._t = setTimeout(fetchAround, 500); });
      lastFetch = L.latLng(place.lat, place.lon);
      document.getElementById("radarBtn").onclick = (e) => setRadar(e.currentTarget.getAttribute("aria-pressed") !== "true");
      document.getElementById("radarPlay").onclick = toggleRadarPlay;
      document.getElementById("recentre").onclick = () => map.setView([place.lat, place.lon], 11);
    }
    if (placeMarker) placeMarker.remove();
    placeMarker = L.marker([place.lat, place.lon], {
      icon: L.divIcon({ className: "", html: '<div class="mk-me"><i></i></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1000, interactive: false,
    }).addTo(map);
    addStations(stations);
    setTimeout(() => map.invalidateSize(), 50);
  }

  function reset() {
    seen.clear();
    if (stationLayer) stationLayer.clearLayers();
    lastFetch = null;
  }

  window.StationMap = { show, reset, tempColor };
})();
