import json
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT_HTML = ROOT / 'service-areas-map.html'
CACHE = ROOT / 'service_areas_geocode.json'

SERVICE_AREAS = [
    'Anthem, AZ',
    'Apache Junction, AZ',
    'Avondale, AZ',
    'Buckeye, AZ',
    'Carefree, AZ',
    'Cave Creek, AZ',
    'Chandler, AZ',
    'El Mirage, AZ',
    'Fountain Hills, AZ',
    'Gilbert, AZ',
    'Glendale, AZ',
    'Goodyear, AZ',
    'Guadalupe, AZ',
    'Laveen Village, AZ',
    'Litchfield Park, AZ',
    'Maricopa, AZ',
    'Mesa, AZ',
    'Peoria, AZ',
    'Paradise Valley, AZ',
    'Phoenix, AZ',
    'Queen Creek, AZ',
    'San Tan Valley, AZ',
    'Scottsdale, AZ',
    'Sun City, AZ',
    'Sun City West, AZ',
    'Surprise, AZ',
    'Tempe, AZ',
    'Tolleson, AZ',
    'Youngtown, AZ',
]


def load_cache():
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding='utf-8'))
    return {}


def save_cache(data):
    CACHE.write_text(json.dumps(data, indent=2), encoding='utf-8')


def geocode_city(city):
    params = {
        'format': 'json',
        'limit': 1,
        'q': city,
    }
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'AlwaysGreenTurf/1.0 (service-areas map)'}
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode('utf-8'))
    if not payload:
        return None
    item = payload[0]
    return {
        'name': city.replace(', AZ', ''),
        'lat': float(item['lat']),
        'lon': float(item['lon']),
    }


def build_html(points):
    lats = [p['lat'] for p in points]
    lons = [p['lon'] for p in points]
    center_lat = sum(lats) / len(lats)
    center_lon = sum(lons) / len(lons)

    points_js = json.dumps(points)

    return f"""<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"UTF-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
  <title>Service Areas Map</title>
  <link rel=\"stylesheet\" href=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.css\" integrity=\"sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=\" crossorigin=\"\"/>
  <style>
    html, body, #map {{ height:100%; margin:0; }}
    #map {{ background:#0b200b; }}
    .pin-3d {{
      width:20px; height:20px;
      background:radial-gradient(circle at 30% 30%, #c8ffb5 0%, #63e963 35%, #25b425 70%, #128712 100%);
      border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      box-shadow:0 8px 18px rgba(0,0,0,.35);
      position:relative;
    }}
    .pin-3d::before {{
      content:''; position:absolute; left:50%; top:50%;
      width:10px; height:10px; border-radius:50%;
      transform:translate(-50%, -50%) rotate(45deg);
      background:radial-gradient(circle at 30% 30%, #f3ffe9 0%, #9bff9b 60%, #5ddf5d 100%);
      box-shadow:inset 0 -1px 2px rgba(0,0,0,.2);
    }}
    .pin-3d::after {{
      content:''; position:absolute; left:50%; bottom:-10px;
      width:22px; height:6px; border-radius:50%;
      transform:translateX(-50%) rotate(45deg);
      background:radial-gradient(ellipse at center, rgba(0,0,0,.35) 0%, rgba(0,0,0,0) 70%);
      opacity:.6;
    }}
    .leaflet-popup-content {{ font-family: 'Poppins', sans-serif; font-weight:600; }}
  </style>
</head>
<body>
  <div id=\"map\"></div>
  <script src=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js\" integrity=\"sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=\" crossorigin=\"\"></script>
  <script>
    const points = {points_js};
    const map = L.map('map', {{ zoomControl: true }}).setView([{center_lat}, {center_lon}], 9);

    L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }}).addTo(map);

    const pinIcon = L.divIcon({{
      className: '',
      html: '<div class="pin-3d"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 20],
      popupAnchor: [0, -20]
    }});

    points.forEach(p => {{
      const m = L.marker([p.lat, p.lon], {{ icon: pinIcon }}).addTo(map);
      m.bindPopup(p.name);
    }});

    const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
    map.fitBounds(bounds.pad(0.25));
  </script>
</body>
</html>"""


def main():
    cache = load_cache()
    results = []
    for city in SERVICE_AREAS:
        if city in cache:
            results.append(cache[city])
            continue
        data = geocode_city(city)
        if data is None:
            raise SystemExit(f'Failed to geocode: {city}')
        cache[city] = data
        results.append(data)
        time.sleep(1.1)  # be polite to Nominatim
    save_cache(cache)
    OUT_HTML.write_text(build_html(results), encoding='utf-8')
    print(f'Wrote {OUT_HTML.name} with {len(results)} points')


if __name__ == '__main__':
    main()
