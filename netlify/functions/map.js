const UA = "MemoryMapV9/1.0";

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
  const q = `[out:json][timeout:55];
  (
    way["building"](around:${radius},${lat},${lon});
    way["highway"](around:${radius},${lat},${lon});
  );
  out body;
  >;
  out skel qt;`;

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
      }, 65000);
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

function parseOSM(osm, clat, clon) {
  const nodes = new Map(), ways = [];
  for (const e of (osm.elements || [])) {
    if (e.type === "node") nodes.set(e.id, [+e.lat, +e.lon]);
    else if (e.type === "way") ways.push(e);
  }

  const buildings = [], roads = [];
  const keepHighways = new Set(["primary","secondary","tertiary","residential","unclassified","living_street","road"]);
  for (const w of ways) {
    let pts = (w.nodes || []).map(id => nodes.get(id)).filter(Boolean);
    if (pts.length < 2) continue;

    if (w.tags && w.tags.building && pts.length >= 3) {
      const first = pts[0], last = pts[pts.length-1];
      if (pts.length > 3 && first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0,-1);
      if (pts.length < 3) continue;

      let hm = 12;
      if (w.tags.height) {
        const m = String(w.tags.height).match(/[0-9]+(?:\.[0-9]+)?/);
        if (m) hm = +m[0];
      } else if (w.tags["building:levels"]) {
        const m = String(w.tags["building:levels"]).match(/[0-9]+(?:\.[0-9]+)?/);
        if (m) hm = +m[0] * 3.2;
      }

      buildings.push({
        pts: pts.map(([lat,lon]) => ll2xy(lat,lon,clat,clon)),
        hm
      });
    } else if (w.tags && w.tags.highway && keepHighways.has(w.tags.highway)) {
      const xy = pts.map(([lat,lon]) => ll2xy(lat,lon,clat,clon));
      let len = 0;
      for (let i=0;i<xy.length-1;i++) len += Math.hypot(xy[i+1][0]-xy[i][0], xy[i+1][1]-xy[i][1]);
      if (len < 12) continue;
      roads.push({ pts: xy, type: w.tags.highway });
    }
  }
  return { buildings, roads };
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type", "Access-Control-Allow-Methods":"POST,OPTIONS" }, body:"" };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    if (body.action === "health") {
      return {
        statusCode: 200,
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ ok:true, message:"Serverless function is running." })
      };
    }

    if (body.action !== "map") throw new Error("Invalid action");

    const address = String(body.address || "").trim();
    if (!address) throw new Error("Address is required");

    let radius = Number(body.radius || 180);
    radius = Math.max(50, Math.min(radius, 400));

    const g = await geocode(address);
    const osm = await overpass(g.lat, g.lon, radius);
    const parsed = parseOSM(osm, g.lat, g.lon);

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", "Cache-Control":"public, max-age=300" },
      body: JSON.stringify({
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