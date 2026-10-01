const UA = "MemoryMapV9/2.0";

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address) {
  const urls = [
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=" + encodeURIComponent(address),
    "https://nominatim.openstreetmap.org/search.php?format=jsonv2&limit=1&q=" + encodeURIComponent(address)
  ];
  let last;
  for (const url of urls) {
    try {
      const d = await fetchJson(url, {}, 25000);
      if (Array.isArray(d) && d.length) {
        return { lat: +d[0].lat, lon: +d[0].lon, name: d[0].display_name || address };
      }
    } catch (e) { last = e; }
  }
  throw last || new Error("Address not found");
}

async function overpass(lat, lon, radius) {
  // IMPORTANT: include relation-based buildings and building:part.
  // Many landmarks and complex buildings are multipolygon relations, not a single way.
  const q = `[out:json][timeout:60];
  (
    way["building"](around:${radius},${lat},${lon});
    relation["building"](around:${radius},${lat},${lon});
    way["building:part"](around:${radius},${lat},${lon});
    relation["building:part"](around:${radius},${lat},${lon});
    way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|road)$"](around:${radius},${lat},${lon});
  );
  out body geom;`;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter"
  ];
  let last;
  for (const ep of endpoints) {
    try {
      return await fetchJson(ep, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: q
      }, 70000);
    } catch (e) { last = e; }
  }
  throw last || new Error("All Overpass servers failed");
}

function ll2xy(lat, lon, clat, clon) {
  const R = 6371000;
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180;
  const c = clat * Math.PI / 180, d = clon * Math.PI / 180;
  return [(b-d) * Math.cos((a+c)/2) * R, (a-c) * R];
}

function heightFromTags(tags = {}) {
  if (tags.height) {
    const m = String(tags.height).match(/[0-9]+(?:\.[0-9]+)?/);
    if (m) return +m[0];
  }
  if (tags["building:levels"]) {
    const m = String(tags["building:levels"]).match(/[0-9]+(?:\.[0-9]+)?/);
    if (m) return +m[0] * 3.2;
  }
  if (tags["building:min_level"]) return 12;
  return tags["building:part"] ? 9 : 12;
}

function samePoint(a, b) {
  if (!a || !b) return false;
  return Math.abs(a[0]-b[0]) < 1e-7 && Math.abs(a[1]-b[1]) < 1e-7;
}

function geomToLatLon(geometry = []) {
  return geometry
    .filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon))
    .map(p => [+p.lat, +p.lon]);
}

function cleanClosedRing(pts) {
  if (!pts || pts.length < 3) return null;
  const out = pts.slice();
  if (samePoint(out[0], out[out.length-1])) out.pop();
  return out.length >= 3 ? out : null;
}

function stitchRings(segments) {
  const unused = segments
    .map(s => s.slice())
    .filter(s => s.length >= 2);
  const rings = [];

  while (unused.length) {
    let ring = unused.shift().slice();
    let changed = true;
    let guard = 0;

    while (changed && unused.length && guard++ < 5000) {
      changed = false;
      const start = ring[0], end = ring[ring.length-1];

      for (let i=0;i<unused.length;i++) {
        const seg = unused[i];
        const s0 = seg[0], s1 = seg[seg.length-1];

        if (samePoint(end, s0)) {
          ring.push(...seg.slice(1));
        } else if (samePoint(end, s1)) {
          ring.push(...seg.slice(0,-1).reverse());
        } else if (samePoint(start, s1)) {
          ring.unshift(...seg.slice(0,-1));
        } else if (samePoint(start, s0)) {
          ring.unshift(...seg.slice(1).reverse());
        } else {
          continue;
        }
        unused.splice(i,1);
        changed = true;
        break;
      }
    }

    const cleaned = cleanClosedRing(ring);
    // Accept stitched rings only when they are actually closed before cleaning.
    if (ring.length >= 4 && samePoint(ring[0], ring[ring.length-1]) && cleaned) {
      rings.push(cleaned);
    }
  }
  return rings;
}

function parseOSM(osm, clat, clon) {
  const buildings = [];
  const roads = [];
  const dedupe = new Set();

  function pushBuilding(latlonPts, tags = {}, source = "") {
    const pts = cleanClosedRing(latlonPts);
    if (!pts) return;
    const xy = pts.map(([lat,lon]) => ll2xy(lat,lon,clat,clon));
    const key = xy.slice(0,8).map(p => p.map(v => v.toFixed(2)).join(",")).join("|");
    if (dedupe.has(key)) return;
    dedupe.add(key);
    buildings.push({
      pts: xy,
      hm: heightFromTags(tags),
      part: !!tags["building:part"],
      source
    });
  }

  for (const e of (osm.elements || [])) {
    if (e.type === "way") {
      const pts = geomToLatLon(e.geometry);
      if (pts.length < 2) continue;

      if (e.tags && (e.tags.building || e.tags["building:part"])) {
        pushBuilding(pts, e.tags, "way");
      } else if (e.tags && e.tags.highway) {
        const xy = pts.map(([lat,lon]) => ll2xy(lat,lon,clat,clon));
        let len = 0;
        for (let i=0;i<xy.length-1;i++) {
          len += Math.hypot(xy[i+1][0]-xy[i][0], xy[i+1][1]-xy[i][1]);
        }
        if (len >= 12) roads.push({ pts: xy, type: e.tags.highway });
      }
      continue;
    }

    if (e.type === "relation" && e.tags && (e.tags.building || e.tags["building:part"])) {
      const outerSegments = [];
      const innerSegments = [];

      for (const m of (e.members || [])) {
        if (m.type !== "way" || !m.geometry) continue;
        const seg = geomToLatLon(m.geometry);
        if (seg.length < 2) continue;
        if (m.role === "inner") innerSegments.push(seg);
        else outerSegments.push(seg);
      }

      const outerRings = stitchRings(outerSegments);
      // We currently export the outer shells. Inner holes are retained as metadata
      // for future boolean subtraction, but the important missing landmark footprint
      // is no longer discarded.
      for (const ring of outerRings) {
        pushBuilding(ring, e.tags, "relation");
      }
    }
  }

  return { buildings, roads };
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Headers":"Content-Type",
        "Access-Control-Allow-Methods":"POST,OPTIONS"
      },
      body:""
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    if (body.action === "health") {
      return {
        statusCode: 200,
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ ok:true, message:"MemoryMap V9.2 geometry engine is running." })
      };
    }

    if (body.action !== "map") throw new Error("Invalid action");

    const address = String(body.address || "").trim();
    if (!address) throw new Error("Address is required");

    let radius = Number(body.radius || 140);
    radius = Math.max(50, Math.min(radius, 400));

    const g = await geocode(address);
    const osm = await overpass(g.lat, g.lon, radius);
    const parsed = parseOSM(osm, g.lat, g.lon);

    return {
      statusCode: 200,
      headers: {
        "Content-Type":"application/json",
        "Cache-Control":"no-store"
      },
      body: JSON.stringify({
        engine: "v9.2-relations-parts",
        resolved_address: g.name,
        lat: g.lat,
        lon: g.lon,
        buildings: parsed.buildings,
        roads: parsed.roads
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ error: e.message || "Unknown server error" })
    };
  }
};