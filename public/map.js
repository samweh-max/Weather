// Interactive map for the Stations page: a globe you can spin and zoom, live station
// readings, your place, and rain radar from the last two hours. Uses MapLibre GL,
// CARTO or OpenStreetMap street maps, Esri satellite imagery and RainViewer radar tiles.
// MapLibre is loaded the first time the map is shown.

(function () {
  "use strict";

  const LIB = "https://unpkg.com/maplibre-gl@5.24.0/dist/";
  const LIB_JS = LIB + "maplibre-gl.js";
  const LIB_CSS = LIB + "maplibre-gl.css";
  const STYLE_KEY = "wc.mapStyle";

  let map, placeMarker, placeAt = null, radar = null, radarFrames = [], radarIdx = 0, radarTimer = 0;
  let loading = null;
  let lastFetch = null;
  const seen = new Map(); // station id -> station
  let opts = {};
  let cartoKey = null;
  let style = "map";

  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!window.MAP_CSS_INLINED) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = LIB_CSS;
        document.head.append(css);
      }
      const js = document.createElement("script");
      js.src = LIB_JS;
      js.onload = () => resolve();
      js.onerror = () => { loading = null; reject(new Error("Map library didn't load")); };
      document.head.append(js);
    });
    return loading;
  }

  const dark = () =>
    document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

  function readStyle() { try { return localStorage.getItem(STYLE_KEY) === "sat" ? "sat" : "map"; } catch { return "map"; } }
  function saveStyle(s) { try { localStorage.setItem(STYLE_KEY, s); } catch {} }

  // CARTO's street maps need a free key (CARTO_KEY). Without one, fall back to OpenStreetMap's own tiles.
  function streetTiles() {
    if (cartoKey) {
      const k = encodeURIComponent(cartoKey);
      const name = dark() ? "dark_all" : "rastertiles/voyager";
      return ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/${name}/{z}/{x}/{y}@2x.png?key=${k}`);
    }
    return ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"];
  }

  // OpenStreetMap's tiles are bright and busy; calm them to sit with the app, and dim them at night.
  function streetPaint() {
    if (cartoKey) return { "raster-fade-duration": 150 };
    return dark()
      ? { "raster-saturation": -0.6, "raster-brightness-max": 0.62, "raster-contrast": -0.1, "raster-fade-duration": 150 }
      : { "raster-saturation": -0.45, "raster-contrast": -0.05, "raster-fade-duration": 150 };
  }

  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  const CARTO = '&copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>';
  const ESRI = 'Imagery &copy; <a href="https://www.esri.com/" target="_blank">Esri</a>, Maxar, Earthstar Geographics';

  // Night sky around the globe, with a soft blue edge of atmosphere that fades as you zoom in.
  const SKY = {
    "sky-color": "#0b1530",
    "horizon-color": "#3a6ea5",
    "fog-color": "#89b4e0",
    "sky-horizon-blend": 0.6,
    "horizon-fog-blend": 0.6,
    "fog-ground-blend": 0.9,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
  };

  function baseStyle() {
    const sources = {}, layers = [{ id: "bg", type: "background", paint: { "background-color": dark() ? "#16202b" : "#dfe7ee" } }];
    if (window.DEMO_LAND) {
      // Preview only: an outline of the land instead of map tiles, which the preview can't load.
      sources.land = { type: "geojson", data: window.DEMO_LAND, attribution: "Coastlines: Natural Earth" };
      layers[0].paint["background-color"] = dark() ? "#1d3446" : "#bcd6e8";
      layers.push({ id: "land", type: "fill", source: "land", paint: { "fill-color": dark() ? "#233140" : "#f4f6f8", "fill-outline-color": dark() ? "#3b4b5b" : "#9fb2c2" } });
    } else {
      sources.street = { type: "raster", tiles: streetTiles(), tileSize: cartoKey ? 512 : 256, maxzoom: 19, attribution: cartoKey ? OSM + " " + CARTO : OSM };
      sources.sat = { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: ESRI };
      sources.satLabels = { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 };
      layers.push(
        { id: "street", type: "raster", source: "street", paint: streetPaint(), layout: { visibility: style === "map" ? "visible" : "none" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 150 }, layout: { visibility: style === "sat" ? "visible" : "none" } },
        { id: "satLabels", type: "raster", source: "satLabels", paint: { "raster-fade-duration": 150 }, layout: { visibility: style === "sat" ? "visible" : "none" } },
      );
    }
    return { version: 8, projection: { type: "globe" }, sky: SKY, sources, layers };
  }

  function setStyle(s) {
    style = s;
    saveStyle(s);
    document.querySelectorAll("#mapStyle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.style === s)));
    if (!map || window.DEMO_LAND) return;
    map.setLayoutProperty("street", "visibility", s === "map" ? "visible" : "none");
    map.setLayoutProperty("sat", "visibility", s === "sat" ? "visible" : "none");
    map.setLayoutProperty("satLabels", "visibility", s === "sat" ? "visible" : "none");
    map.getContainer().classList.toggle("sat", s === "sat");
  }

  function themeChanged() {
    if (!map || window.DEMO_LAND || !map.getSource("street")) return;
    map.getSource("street").setTiles(streetTiles());
    for (const [k, v] of Object.entries(streetPaint())) map.setPaintProperty("street", k, v);
    map.setPaintProperty("bg", "background-color", dark() ? "#16202b" : "#dfe7ee");
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

  function el(html, cls) {
    const d = document.createElement("div");
    d.className = cls;
    d.innerHTML = html;
    return d;
  }

  function markerEl(s) {
    const f = opts.fmt;
    if (s.temp == null) {
      // Rain gauge: a drop, filled when it's raining.
      return el(`<div class="mk-gauge ${s.raining ? "wet" : ""}" title="${s.rain1h != null ? f.rain(s.rain1h) + " in the last hour" : ""}"><svg viewBox="0 0 16 16"><path d="M8 1.5C8 1.5 3 7.2 3 10.2a5 5 0 0 0 10 0C13 7.2 8 1.5 8 1.5z"/></svg></div>`, "st-mk gauge");
    }
    const arrow = s.wind != null && s.dir != null
      ? `<svg class="mk-arrow" viewBox="0 0 24 24" style="transform:rotate(${(s.dir + 180) % 360}deg)"><path d="M12 2.5 18.5 20 12 16.2 5.5 20z"/></svg>` : "";
    const official = s.network === "airport" || s.network === "metoffice";
    return el(`<div class="mk-temp ${official ? "official" : ""} ${s.raining ? "wet" : ""}" style="--c:${tempColor(s.temp)}">${f.temp(s.temp)}${arrow}</div>`, "st-mk temp");
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
      if (prev && prev._m) prev._m.remove();
      const node = markerEl(s);
      node.title = s.name;
      node.style.zIndex = s.temp != null ? "2" : "1";
      const pop = new maplibregl.Popup({ closeButton: false, offset: 14, maxWidth: "280px", className: "st-pop" }).setHTML(popupFor(s));
      const m = new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([s.lon, s.lat]).setPopup(pop).addTo(map);
      s._m = m;
      seen.set(s.id, s);
    }
  }

  function km(a, b) {
    const r = Math.PI / 180;
    const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  }

  // Fetch stations around the middle of the map when it has moved far enough (and isn't zoomed out to the whole globe).
  async function fetchAround() {
    if (map.getZoom() < 6) return;
    const c = map.getCenter();
    if (lastFetch && km(c, lastFetch) < 15) return;
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
      radarIdx = radarFrames.length - 1;
      radarFrames.forEach((f, i) => {
        map.addSource(`radar${i}`, {
          type: "raster", tileSize: 256, maxzoom: 7,
          tiles: [`${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`],
          attribution: i ? undefined : '<a href="https://www.rainviewer.com/" target="_blank">RainViewer</a>',
        });
        map.addLayer({ id: `radar${i}`, type: "raster", source: `radar${i}`, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 0 }, "raster-fade-duration": 0 } });
      });
      radar = { n: radarFrames.length };
      showFrame(radarIdx);
      return true;
    } catch {
      radar = null;
      return false;
    }
  }

  function showFrame(i) {
    if (!radar) return;
    for (let k = 0; k < radar.n; k++) map.setPaintProperty(`radar${k}`, "raster-opacity", k === i ? 0.75 : 0);
    const t = new Date(radarFrames[i].time * 1000);
    const lbl = document.getElementById("radarTime");
    if (lbl) lbl.textContent = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // While the radar is on, station and gauge markers are hidden so the rain is easy to see.
  function setRadar(on) {
    const btn = document.getElementById("radarBtn");
    const play = document.getElementById("radarPlay");
    map.getContainer().classList.toggle("radar-on", on);
    btn.setAttribute("aria-pressed", String(on));
    document.querySelector(".map-key").classList.toggle("dim", on);
    if (on && !radar) {
      btn.textContent = "Loading radar…";
      loadRadar().then((ok) => {
        btn.textContent = "Rain radar";
        play.hidden = !ok;
        if (!ok) {
          btn.textContent = "Radar unavailable";
          btn.disabled = true;
          btn.setAttribute("aria-pressed", "false");
          map.getContainer().classList.remove("radar-on");
          document.querySelector(".map-key").classList.remove("dim");
        }
      });
      return;
    }
    if (!radar) return;
    for (let k = 0; k < radar.n; k++) map.setLayoutProperty(`radar${k}`, "visibility", on ? "visible" : "none");
    if (on) showFrame(radarIdx); else stopRadar();
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
      if (radarIdx === radarFrames.length - 1) stopRadar();
    }, 600);
  }

  // Show (or create) the map inside `el`, centred on the place, with these stations.
  async function show(container, place, stations, options) {
    opts = options;
    placeAt = place;
    try {
      await loadLib();
    } catch (err) {
      container.innerHTML = `<div class="map-msg">The map couldn't load. Check your connection and try again.</div>`;
      return;
    }
    if (!map || map.getContainer() !== container) {
      if (map) map.remove();
      seen.clear();
      radar = null;
      lastFetch = null;
      style = readStyle();
      if (!window.DEMO_LAND) {
        try { cartoKey = (await opts.api("/api/map")).cartoKey || null; } catch { cartoKey = null; }
      } else {
        container.classList.add("offline");
      }
      map = new maplibregl.Map({
        container,
        style: baseStyle(),
        center: [place.lon, place.lat],
        zoom: 9,
        maxZoom: 17,
        attributionControl: false,
        dragRotate: true,
        pitchWithRotate: false,
        renderWorldCopies: false,
      });
      map.touchPitch.disable();
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), "bottom-right");
      container.classList.toggle("sat", style === "sat");
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themeChanged);
      // Zoomed out to the globe, station labels would pile on top of each other: hide them.
      const far = () => container.classList.toggle("far", map.getZoom() < 5);
      map.on("zoom", far);
      map.on("moveend", () => { clearTimeout(map._t); map._t = setTimeout(fetchAround, 500); });
      lastFetch = { lat: place.lat, lng: place.lon };
      document.getElementById("radarBtn").onclick = (e) => setRadar(e.currentTarget.getAttribute("aria-pressed") !== "true");
      document.getElementById("radarPlay").onclick = toggleRadarPlay;
      document.getElementById("recentre").onclick = () => map.flyTo({ center: [placeAt.lon, placeAt.lat], zoom: 10, bearing: 0, duration: 1600, essential: true });
      document.getElementById("globeBtn").onclick = () => map.flyTo({ center: [placeAt.lon, placeAt.lat], zoom: 0.6, bearing: 0, duration: 1800, essential: true });
      document.querySelectorAll("#mapStyle button").forEach((b) => (b.onclick = () => setStyle(b.dataset.style)));
      document.getElementById("mapStyle").hidden = !!window.DEMO_LAND;
      setStyle(style);
      const btn = document.getElementById("radarBtn");
      btn.setAttribute("aria-pressed", "false");
      btn.disabled = false;
      btn.textContent = "Rain radar";
      document.getElementById("radarPlay").hidden = true;
    }
    if (placeMarker) placeMarker.remove();
    placeMarker = new maplibregl.Marker({ element: el("<i></i>", "mk-me"), anchor: "center" }).setLngLat([place.lon, place.lat]).addTo(map);
    placeMarker.getElement().style.zIndex = "5";
    placeMarker.getElement().style.pointerEvents = "none";
    if (map.loaded()) addStations(stations); else map.once("load", () => addStations(stations));
    setTimeout(() => map.resize(), 50);
  }

  function reset() {
    for (const s of seen.values()) if (s._m) s._m.remove();
    seen.clear();
    lastFetch = null;
  }

  window.StationMap = { show, reset, tempColor };
})();
