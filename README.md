# Weather Compare

A simple phone web app that shows forecasts from many weather providers side by side for one place, so you can see at a glance whether they agree.

- **Forecast services:** Met Office, AccuWeather, yr.no (MET Norway), OpenWeather
- **Weather models (via Open-Meteo):** ECMWF, UKMO, GFS, ICON, Météo-France
- Summary at the top: typical high/low, how many sources expect rain, and how much they disagree
- Swipe between 7 days, tap any provider for its hour-by-hour forecast
- GPS or place search, saved places, °C/°F, mph/km/h/m/s, mm/in
- Installable: open it on your phone and use "Add to Home Screen"

BBC Weather and Apple Weather are not included. BBC has no public API, and Apple WeatherKit needs a paid Apple Developer account.

## Three pages

- **Compare:** every source side by side for the chosen day, switchable between temperature, rain and wind.
- **Forecaster:** one forecast blended from every source and checked against live stations, with written notes, a 24-hour chart, 7 days with confidence, and a breakdown of how much each source counts.
- **Stations:** an interactive map of live station readings (temperature, wind arrows, rain gauges) with the last two hours of rain radar, plus a list of the nearest stations. Pan the map and stations for the new area load in.

The map is a 3D globe drawn with [MapLibre GL](https://maplibre.org/). Street maps and all names are vector tiles from [OpenFreeMap](https://openfreemap.org/) (free, no key; falls back to OpenStreetMap picture tiles), satellite imagery from Esri World Imagery, and rain radar from [RainViewer](https://www.rainviewer.com/api.html) (free for personal use, past two hours only).

### How the Forecaster works

1. Each source gets a weight. Once the phone has saved a day of past forecasts, the weight comes from how close each source's earlier forecasts were to what the nearest airport actually measured. Until then, it comes from how close each source is to what nearby stations read right now.
2. The sources are averaged hour by hour with those weights.
3. The first few hours are nudged towards what stations read now, and the nudge fades out over about 12 hours. If most nearby rain gauges show rain, the next couple of hours lean wet. If they're all dry, they lean dry.

It's tailored to where the app is opened. By default the app checks your location each time it opens and switches if you've moved (Settings → "Use where I am each time I open the app"). Stations within 40 km count, with closer ones counting more, and readings from stations higher or lower than you are corrected by 0.65° per 100 m. Once there is history, any source that runs steadily warm or cold at your spot is corrected, as well as weighted.

The blending code is in `public/blend.js` and runs on the phone. Past forecasts are saved on the phone itself, so each device learns separately.

### Station networks

| Network | Coverage | Key |
| --- | --- | --- |
| Airport reports (METAR, aviationweather.gov) | About 60 UK airports, every 30 minutes | None |
| Environment Agency rain gauges | About 1,000 gauges in England, every 15 minutes | None |
| Met Office land observations | About 150 official stations, hourly | Free DataHub "Land Observations" subscription (`METOFFICE_OBS_KEY`; falls back to `METOFFICE_KEY`) |
| My station (CampbellON) | Your own Campbell Scientific station, shown when within 80 km | A CampbellON login (see below) |

**My station.** Your own station is read from [CampbellON](https://campbellon.com/docs/) and shown as its own card at the top of Stations and as a highlighted marker on the map. It counts twice as much as an official station in the "measured now" nudge, its rain gauge joins the rain checks, and when it is within 15 km it replaces the nearest airport as the record each source's past forecasts are checked against. Set `CAMPBELL_STATION_ID` in `wrangler.toml` (already set), then add a login as secrets: a service account is best (`CAMPBELL_CLIENT_ID` and `CAMPBELL_CLIENT_SECRET`, made under Settings → Service accounts on CampbellON, with read access to the station), or your own `CAMPBELL_USERNAME` and `CAMPBELL_PASSWORD` (doesn't work if your organisation uses single sign-on). The organisation is found automatically; set `CAMPBELL_ORG_ID` to skip that. It loads on its own (`/api/home`), so the rest of the page never waits for it: the last reading is shown at once and a fresh one replaces it when it arrives. CampbellON allows about 200 calls an hour, so the Worker keeps the reading for 5 minutes and serves an older copy while it fetches a new one in the background.

**History.** Tap History on the station card, a tile, or a sensor name to explore any sensor by Day, Week, Month, Year or a custom range (up to a year), step back and forward with the arrows, or tap the date to jump to one. Tap Add to show up to four sensors at once (favourites listed first); touch any chart to read them all at that moment. Each sensor gets the chart that suits it: wind is a compass (petal length is how often it blew from that direction, the shades are how strong), temperature is a line coloured by warmth, sunshine a filled curve, and rain shows as hourly, daily or weekly totals.

**Tiles.** Each pinned tile on the station card has a small picture of what it measures: a compass whose needle points the way the wind is blowing (longer when stronger), a drop that fills with the day's rain (full at 20 mm), rings for humidity and soil moisture, a barometer dial from low (970 hPa) to high (1040 hPa), a sun for UV, and a warmth bar for temperatures.

**Sensor names.** Sensors get plain names from their logger field. On a station with a Campbell soil probe (CS650/CS655), its short fields are named for the soil: `T_Avg` is soil temperature, not air, and `EC`, `P`, `PA` and `VR` are the probe's saltiness, permittivity and signal readings. If two different sensors would still read the same, the logger field is added to tell them apart. Units the logger leaves out are filled in from the field name.

**Sky.** The sky on the Compare page follows the real sun and moon for the place: the sun sits where it really is (low and warm at sunrise and sunset), the sky darkens through twilight, and at night there are stars and the moon in its real position and phase. The weather decides how much shows through. Other days show that day in daylight.

**Refresh.** The refresh button asks for fresh data (`?fresh=1`) instead of the Worker's recent copy (copies under two minutes old are still reused, to stay inside the free limits), and shows a tick when it's done. Worker copies are sent to the phone as "don't keep", so the phone's own cache can't hide new data. Data comes from `/api/home/history`, grouped into at most about 400 steps.

**Sensors and favourites.** Logger field names are shown in plain English ("WS_ms_S_WVT" is "Wind speed"). Star any sensor under All sensors to pin it to the card. Sensors are recognised by their logger field names (AirTC_Avg, RH, WS_ms_S_WVT, WindDir, Rain_mm_Tot, BP_mbar and similar); every sensor is listed under "All sensors" either way.

Not included: Met Office WOW and Weather Underground have no public read API, and Scotland's (SEPA) and Wales's (NRW) rain gauges need their own registrations. These could be added later.

## How it's built

- `public/` is the app itself: plain HTML, CSS and JavaScript, no build step.
- `worker/index.js` is a small Cloudflare Worker. It calls each provider, keeps the API keys secret, caches results so the free daily limits last, and turns every provider's data into the same shape.
- Open `index.html?demo` to try the design with made-up data and no server.

## Free API keys

Open-Meteo and yr.no need no key. The other three each need a free account:

| Provider | Sign up | Free limit |
| --- | --- | --- |
| Met Office | [datahub.metoffice.gov.uk](https://datahub.metoffice.gov.uk/) → subscribe to "Site Specific" global spot, free plan | 360 calls/day |
| AccuWeather (optional) | [developer.accuweather.com](https://developer.accuweather.com/) → create an app. Now only a 14-day trial, so it's fine to skip | trial only |
| OpenWeather | [openweathermap.org/api](https://openweathermap.org/api) → free plan | 1,000 calls/day |

Any source without a key is simply hidden in the app.

**Map tiles (optional):** the Stations map uses CARTO's clean light and dark maps when you add a free key from [carto.com/basemaps/apikey](https://www.carto.com/basemaps/apikey/) (non-commercial, 5 million tiles a month) as the secret `CARTO_KEY`. Without it the map falls back to OpenStreetMap's own tiles, toned down to match the app.

## Run it on Cloudflare (free)

```sh
npm install
npx wrangler login
npx wrangler secret put METOFFICE_KEY
npx wrangler secret put ACCUWEATHER_KEY
npx wrangler secret put OPENWEATHER_KEY
# optional, for more stations:
npx wrangler secret put METOFFICE_OBS_KEY
# optional, your own CampbellON station (a service account, or CAMPBELL_USERNAME + CAMPBELL_PASSWORD):
npx wrangler secret put CAMPBELL_CLIENT_ID
npx wrangler secret put CAMPBELL_CLIENT_SECRET
npm run deploy
```

Wrangler prints the app's address (`https://weather-compare.<you>.workers.dev`). Open it on your phone.

For local testing, copy `.dev.vars.example` to `.dev.vars`, add your keys, and run `npm run dev`.

## Tests

`npm test` checks the provider and station readers and the blending maths against sample data (no network needed). The real services couldn't be reached while this was built, so the first live run is the real test. The Met Office observations format in particular was written from its documentation and should be checked first.
