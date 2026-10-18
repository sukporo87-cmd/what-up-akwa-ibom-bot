# Step 2 of refreshing src/data/tv-ng-ip-places.json (see build-ng-places.py):
# saves every Nigerian network in DB-IP's "IP to City Lite" database.
# Needs: pip install maxminddb. Run: python3 extract-ng-networks.py <file.mmdb> ng-raw.json
import json, sys
import maxminddb
r = maxminddb.open_database(sys.argv[1])
v4, v6 = [], []
for net, rec in r:
    if (rec or {}).get('country', {}).get('iso_code') != 'NG':
        continue
    city = (rec.get('city') or {}).get('names', {}).get('en') or ''
    state = ((rec.get('subdivisions') or [{}])[0]).get('names', {}).get('en') or ''
    (v4 if net.version == 4 else v6).append((int(net.network_address), int(net.broadcast_address), city, state))
json.dump({'v4': v4, 'v6': v6}, open(sys.argv[2], 'w'))
print(len(v4), 'IPv4 and', len(v6), 'IPv6 networks')
