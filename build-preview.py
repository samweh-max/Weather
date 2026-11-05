"""Builds a single-file demo page (made-up data) from public/, for sharing a preview.

Usage: python3 build-preview.py OUT.html [path/to/maplibre-gl.css]
The MapLibre stylesheet is inlined because the preview host only allows stylesheets from Google Fonts.
Install it with `npm i -D maplibre-gl@5.24.0` or pass its path.
"""
import sys, pathlib
here = pathlib.Path(__file__).parent
root = here / "public"
css_path = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else here / "node_modules/maplibre-gl/dist/maplibre-gl.css"
map_css = css_path.read_text()
html = (root / "index.html").read_text()
body = html.split("<!-- APP:START -->")[1].split("<!-- APP:END -->")[0]
fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..700&family=Geist:wght@400..700&display=swap">'
land = (here / "preview-land.geojson").read_text()
scripts = "".join(f"<script>\n{(root / name).read_text()}\n</script>\n" for name in ["blend.js", "map.js", "app.js"])
out = f"""<title>Weather Compare</title>
<meta name="claude:viewport-fit-sides" content="cover">
{fonts}
<style>
{map_css}
</style>
<style>
{(root / "styles.css").read_text()}
</style>
{body}
<script>window.WEATHER_DEMO = true; window.MAP_CSS_INLINED = true; window.DEMO_LAND = {land};</script>
{scripts}"""
pathlib.Path(sys.argv[1]).write_text(out)
