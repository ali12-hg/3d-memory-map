const UA = "MemoryMapV11/1.0";

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
        return {
          lat: +d[0].lat,
          lon: +d[0].lon,
          name: d[0].display_name || address,
          type: d[0].type || "",
          category: d[0].category || "",
          address: d[0].address || {}
        };
      }
    } catch (e) { last = e; }
  }
  throw last || new Error("Address not found");
}

async function overpass(lat, lon, radius) {
  const q = `[out:json][timeout:90];
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
      }, 95000);
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

function samePoint(a, b) {
  return !!a && !!b && Math.abs(a[0]-b[0]) < 1e-7 && Math.abs(a[1]-b[1]) < 1e-7;
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
  const unused = segments.map(s => s.slice()).filter(s => s.length >= 2);
  const rings = [];
  while (unused.length) {
    let ring = unused.shift().slice();
    let changed = true, guard = 0;
    while (changed && unused.length && guard++ < 8000) {
      changed = false;
      const start = ring[0], end = ring[ring.length-1];
      for (let i=0;i<unused.length;i++) {
        const seg = unused[i], s0 = seg[0], s1 = seg[seg.length-1];
        if (samePoint(end, s0)) ring.push(...seg.slice(1));
        else if (samePoint(end, s1)) ring.push(...seg.slice(0,-1).reverse());
        else if (samePoint(start, s1)) ring.unshift(...seg.slice(0,-1));
        else if (samePoint(start, s0)) ring.unshift(...seg.slice(1).reverse());
        else continue;
        unused.splice(i,1); changed = true; break;
      }
    }
    if (ring.length >= 4 && samePoint(ring[0], ring[ring.length-1])) {
      const cleaned = cleanClosedRing(ring);
      if (cleaned) rings.push(cleaned);
    }
  }
  return rings;
}

function polygonAreaMeters(xy) {
  let a = 0;
  for (let i=0;i<xy.length;i++) {
    const p=xy[i], q=xy[(i+1)%xy.length];
    a += p[0]*q[1]-q[0]*p[1];
  }
  return Math.abs(a)/2;
}

function parseHeight(tags = {}, footprintArea = 0) {
  const direct = tags.height && String(tags.height).match(/[0-9]+(?:\.[0-9]+)?/);
  if (direct) return { height: Math.max(2, +direct[0]), source: "height" };

  const levels = tags["building:levels"] && String(tags["building:levels"]).match(/[0-9]+(?:\.[0-9]+)?/);
  if (levels) return { height: Math.max(3, +levels[0] * 3.15), source: "levels" };

  const type = String(tags.building || tags["building:part"] || "").toLowerCase();
  // Conservative fallback: villages should look like villages, not skylines.
  let h = 8.0;
  if (["garage","garages","shed","carport","roof"].includes(type)) h = 3.2;
  else if (["bungalow"].includes(type)) h = 4.5;
  else if (["house","detached","semidetached_house","terrace","residential"].includes(type)) h = 7.5;
  else if (["apartments","dormitory"].includes(type)) h = 12.5;
  else if (["office","commercial","retail","hotel","hospital","university"].includes(type)) h = 14.5;
  else if (["church","cathedral","mosque","synagogue","civic","public"].includes(type)) h = 13.0;
  else if (["industrial","warehouse"].includes(type)) h = 7.0;

  // Footprint only nudges the estimate; it never creates skyscrapers.
  if (footprintArea > 1500) h += 2.0;
  else if (footprintArea > 700) h += 1.0;
  else if (footprintArea < 70) h -= 0.8;

  if (tags["building:part"]) h *= 0.92;
  return { height: Math.max(2.8, Math.min(18, h)), source: "inferred" };
}

function parseOSM(osm, clat, clon) {
  const buildings = [], roads = [];
  const dedupe = new Set();

  function pushBuilding(latlonPts, tags = {}, source = "") {
    const ring = cleanClosedRing(latlonPts);
    if (!ring) return;
    const xy = ring.map(([lat,lon]) => ll2xy(lat,lon,clat,clon));
    const footprintArea = polygonAreaMeters(xy);
    if (footprintArea < 8) return;

    const key = xy.slice(0,10).map(p => p.map(v => v.toFixed(2)).join(",")).join("|");
    if (dedupe.has(key)) return;
    dedupe.add(key);

    const h = parseHeight(tags, footprintArea);
    buildings.push({
      pts: xy,
      hm: h.height,
      height_source: h.source,
      building_type: String(tags.building || tags["building:part"] || ""),
      part: !!tags["building:part"],
      footprint_m2: footprintArea,
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
        if (len >= 25) roads.push({ pts: xy, type: e.tags.highway });
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
      const outers = stitchRings(outerSegments);
      const inners = stitchRings(innerSegments);
      for (const ring of outers) {
        pushBuilding(ring, e.tags, "relation");
      }
      // Inner rings are returned separately for preview/boolean support.
      // They are not treated as buildings.
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
        body: JSON.stringify({ ok:true, message:"MemoryMap V11 realistic engine is running." })
      };
    }
    if (body.action !== "map") throw new Error("Invalid action");

    const address = String(body.address || "").trim();
    if (!address) throw new Error("Address is required");

    let radius = Number(body.radius || 1000);
    radius = Math.max(100, Math.min(radius, 1500));

    const g = await geocode(address);
    const osm = await overpass(g.lat, g.lon, radius);
    const parsed = parseOSM(osm, g.lat, g.lon);

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Cache-Control":"no-store" },
      body: JSON.stringify({
        engine: "v11-realistic-framed",
        resolved_address: g.name,
        lat: g.lat,
        lon: g.lon,
        place_type: g.type,
        place_category: g.category,
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