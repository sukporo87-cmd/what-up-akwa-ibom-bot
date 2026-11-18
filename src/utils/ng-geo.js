// ============================================================
// FILE: src/utils/ng-geo.js
// Which Nigerian state a point is in, from the state boundaries in
// src/data/ng-states.json (GRID3 2022, through geoBoundaries, CC BY 4.0).
//
//   stateAt(9.0765, 7.3986)   -> 'FCT'      (central Abuja)
//   stateAt(6.5244, 3.3792)   -> 'Lagos'
//   stateAt(51.5, -0.12)      -> null       (not in Nigeria)
//
// Used for a Live Round: a player's phone shares where it is, and the
// server keeps only the state (WUT TV, Nov 18, 2026). The names are the
// ones in utils/ng-places (NIGERIAN_STATES), so 'FCT' for Abuja.
//
// A point exactly on a border can land in either state; boundaries are
// rounded to about 100 metres. Nothing here ever throws.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'ng-states.json');
// Nigeria's bounding box, with a little room: anything outside is not in Nigeria.
const NG = { minLon: 2.5, minLat: 4.0, maxLon: 14.8, maxLat: 14.0 };

let table = null;
function load() {
    if (table) return table;
    try {
        table = JSON.parse(fs.readFileSync(FILE, 'utf8')).states || [];
    } catch (e) {
        table = [];
    }
    return table;
}

/** Ray casting: is (x, y) inside this ring of [lon, lat] points? */
function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Inside a polygon: inside its outer ring and none of its holes. */
function inPolygon(x, y, rings) {
    if (!rings.length || !inRing(x, y, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
    return true;
}

/** A finite latitude and longitude, or false. */
function valid(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** The Nigerian state at this point, or null if it is not in Nigeria (or not a point). */
function stateAt(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!valid(lat, lon)) return null;
    if (lon < NG.minLon || lon > NG.maxLon || lat < NG.minLat || lat > NG.maxLat) return null;
    for (const s of load()) {
        const b = s.bbox;
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
        for (const poly of s.polygons) if (inPolygon(lon, lat, poly)) return s.state;
    }
    return null;
}

module.exports = { stateAt, valid };
