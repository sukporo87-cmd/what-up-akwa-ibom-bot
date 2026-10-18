# Builds src/data/tv-ng-ip-places.json from DB-IP's free "IP to City Lite"
# database (CC BY 4.0, https://db-ip.com). Keeps only Nigerian networks,
# merged, so the file is small enough to ship with the backend.
#
# To refresh it (DB-IP publishes a new release each month; once or twice a
# year is plenty for approximate places):
#   1. npm pack dbip-city-lite            (the database, as an npm package)
#      tar xzf dbip-city-lite-*.tgz && gunzip package/dbip-city-lite.mmdb.gz
#   2. pip install maxminddb
#      python3 extract-ng-networks.py package/dbip-city-lite.mmdb ng-raw.json
#   3. python3 build-ng-places.py ng-raw.json <YYYY-MM> ../src/data/tv-ng-ip-places.json
import json, sys
raw = json.load(open(sys.argv[1]))
places, index = [], {}
def place(city, state):
    city = (city or '').strip(); state = (state or '').strip()
    if state == 'Federal Capital Territory': state = 'FCT'
    label = city if (not state or city == state or city.startswith(state + ' (')) else (f'{city}, {state}' if city else state)
    label = label or 'Nigeria'
    if label not in index: index[label] = len(places); places.append(label)
    return index[label]
out = {}
for key in ('v4', 'v6'):
    rows = sorted((s, e, place(c, st)) for s, e, c, st in raw[key])
    merged = []
    for s, e, p in rows:
        if merged and merged[-1][2] == p and merged[-1][1] + 1 == s: merged[-1][1] = e
        else: merged.append([s, e, p])
    out[key] = merged if key == 'v4' else [[format(s, 'x'), format(e, 'x'), p] for s, e, p in merged]
doc = {'source': 'IP Geolocation by DB-IP (https://db-ip.com), IP to City Lite, CC BY 4.0', 'release': sys.argv[2],
       'note': 'Nigerian networks only. Approximate: a network is placed where its provider registers it.',
       'places': places, 'v4': out['v4'], 'v6': out['v6']}
json.dump(doc, open(sys.argv[3], 'w'), separators=(',', ':'))
print(len(places), 'places,', len(out['v4']), 'v4,', len(out['v6']), 'v6')
