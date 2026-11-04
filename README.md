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

The map uses [Leaflet](https://leafletjs.com/), CARTO base maps with OpenStreetMap data, and [RainViewer](https://www.rainviewer.com/api.html) radar (free for personal use, past two hours only).

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
| Netatmo home stations | Thousands of shared home stations | Free Netatmo developer app (see below) |

Not included: Met Office WOW and Weather Underground have no public read API, and Scotland's (SEPA) and Wales's (NRW) rain gauges need their own registrations. These could be added later.

**Netatmo setup:** create an app at [dev.netatmo.com](https://dev.netatmo.com/), generate a token with the `read_station` scope, then set `NETATMO_CLIENT_ID`, `NETATMO_CLIENT_SECRET` and `NETATMO_REFRESH_TOKEN` as secrets. Netatmo sometimes issues a new refresh token. To keep it automatically, create a KV namespace (`npx wrangler kv namespace create TOKENS`) and add it to `wrangler.toml` as the `TOKENS` binding.

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
npx wrangler secret put NETATMO_CLIENT_ID
npx wrangler secret put NETATMO_CLIENT_SECRET
npx wrangler secret put NETATMO_REFRESH_TOKEN
npm run deploy
```

Wrangler prints the app's address (`https://weather-compare.<you>.workers.dev`). Open it on your phone.

For local testing, copy `.dev.vars.example` to `.dev.vars`, add your keys, and run `npm run dev`.

## Tests

`npm test` checks the provider and station readers and the blending maths against sample data (no network needed). The real services couldn't be reached while this was built, so the first live run is the real test. The Met Office observations format in particular was written from its documentation and should be checked first.
