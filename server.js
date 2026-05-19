const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ── Config loading ───────────────────────────────────────────
// Two config formats are supported intentionally:
//
//   .env         → developers, Raspberry Pi, Render/Railway
//                  standard Node.js convention, supported natively
//                  by all cloud platforms as environment variables
//
//   config.txt   → non-technical users running the packaged executable
//                  (.exe / mac / linux binary built with pkg)
//                  visible in File Explorer/Finder, editable in Notepad
//                  NEVER committed to git (listed in .gitignore)
//
// Both use the same KEY=VALUE format. config.txt takes priority for
// iCal URLs only if at least one URL is set — otherwise falls through
// to .env so a blank config.txt doesn't override real credentials.
function loadConfig() {
  const fs = require("fs");
  const path = require("path");

  // Determine base directory — works both for Node and pkg executables
  const baseDir = process.pkg
    ? path.dirname(process.execPath)
    : __dirname;

  // Try config.txt first (non-technical users)
  const configPath = path.join(baseDir, "config.txt");
  if (fs.existsSync(configPath)) {
    const configVars = {};
    fs.readFileSync(configPath, "utf8")
      .replace(/\r/g, "")
      .split("\n")
      .forEach(line => {
        line = line.trim();
        if (!line || line.startsWith("#")) return;
        const [key, ...val] = line.split("=");
        if (key && val.length) configVars[key.trim()] = val.join("=").trim();
      });
    // Only use config.txt for iCal if at least one URL is actually set
    // Otherwise fall through to .env so a blank config.txt doesn't override real credentials
    // Only use config.txt as the iCal source if at least one iCal URL has a value
    // This prevents an empty config.txt template from blocking .env credentials
    const hasIcalInConfig = Object.entries(configVars).some(([k, v]) =>
      v && (k.startsWith("ICAL_") || k.match(/^PROPERTY_\d+_(AIRBNB|BOOKING|LEKKESLAAP)$/))
    );
    if (hasIcalInConfig) {
      Object.assign(process.env, configVars);
      return;
    }
    // No iCal URLs in config.txt — apply non-iCal settings only, let .env handle credentials
    Object.entries(configVars).forEach(([k, v]) => {
      if (!k.startsWith("ICAL_") && !k.match(/^PROPERTY_\d+_(AIRBNB|BOOKING|LEKKESLAAP)$/)) {
        process.env[k] = v;
      }
    });
  }

  // Load .env for iCal credentials (developers / Pi with real data)
  // .replace(/\r/g, '') strips Windows CRLF line endings
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8")
      .replace(/\r/g, "")
      .split("\n")
      .forEach(line => {
        line = line.trim();
        if (!line || line.startsWith("#")) return;
        const [key, ...val] = line.split("=");
        if (key && val.length) process.env[key.trim()] = val.join("=").trim();
      });
  }
}

// Returns array of property objects from config.
// Supports both legacy single-property format (ICAL_AIRBNB etc.)
// and new multi-property format (PROPERTY_1_NAME, PROPERTY_1_AIRBNB etc.)
function getProperties() {
  loadConfig();
  const properties = [];

  // Detect numbered properties: PROPERTY_1_NAME, PROPERTY_2_NAME ...
  let i = 1;
  while (true) {
    const prefix = `PROPERTY_${i}_`;
    const name        = process.env[`${prefix}NAME`];
    const airbnb      = process.env[`${prefix}AIRBNB`]      || null;
    const booking     = process.env[`${prefix}BOOKING`]     || null;
    const lekkeslaap  = process.env[`${prefix}LEKKESLAAP`]  || null;
    // Stop scanning if no name AND no URLs found for this number
    if (!name && !airbnb && !booking && !lekkeslaap) break;
    // Only add the property if it has at least one iCal URL configured
    // This prevents a config.txt with PROPERTY_1_NAME but no URLs from
    // blocking the legacy .env fallback
    if (airbnb || booking || lekkeslaap) {
      properties.push({
        id:          i,
        name:        name        || `Property ${i}`,
        description: process.env[`${prefix}DESCRIPTION`]   || "",
        location:    process.env[`${prefix}LOCATION`]      || "",
        nightlyRate: parseFloat(process.env[`${prefix}NIGHTLY_RATE`] || "0"),
        currency:    process.env[`${prefix}CURRENCY`]      || "ZAR",
        minNights:   parseInt(process.env[`${prefix}MIN_NIGHTS`]     || "1"),
        maxGuests:   parseInt(process.env[`${prefix}MAX_GUESTS`]     || "10"),
        photoUrl:    process.env[`${prefix}PHOTO_URL`]     || "",
        sources: { airbnb, booking, lekkeslaap },
      });
    }
    i++;
  }

  // Fall back to legacy single-property config
  // Reads ALL ICAL_* keys dynamically so unknown platforms (e.g. ICAL_SLAAPSTAD) work too
  if (properties.length === 0) {
    const sources = {};
    Object.entries(process.env).forEach(([k, v]) => {
      if (k.startsWith('ICAL_') && v) {
        const platform = k.replace('ICAL_', '').toLowerCase();
        sources[platform] = v;
      }
    });
    if (Object.keys(sources).length > 0) {
      properties.push({
        id:          1,
        name:        process.env.PROPERTY_NAME        || "My Property",
        description: process.env.PROPERTY_DESCRIPTION || "",
        location:    process.env.PROPERTY_LOCATION    || "",
        nightlyRate: parseFloat(process.env.NIGHTLY_RATE || "0"),
        currency:    process.env.CURRENCY             || "ZAR",
        minNights:   parseInt(process.env.MIN_NIGHTS  || "1"),
        maxGuests:   parseInt(process.env.MAX_GUESTS  || "10"),
        photoUrl:    process.env.PROPERTY_PHOTO_URL   || "",
        sources,
      });
    }
  }
  return properties;
}

// Legacy helper — returns sources for first property (backwards compat)
function getSources() {
  const props = getProperties();
  return props.length > 0 ? props[0].sources : { airbnb: null, booking: null, lekkeslaap: null };
}

// ── Server-side polling state ────────────────────────────────
// The server polls iCal feeds independently of the browser tab.
// Per-source cache: only updates when a source succeeds.
// Failed sources serve last known good data instead of an error.
// Cache is persisted to disk so it survives server restarts.
let serverSourceCache   = {};     // { "1:airbnb": { result, fetchedAt } }
let serverLastFetchedAt = null;   // timestamp of last poll attempt
let serverPollTimer     = null;   // setInterval handle

function getCachePath() {
  const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
  return path.join(baseDir, "ical-cache.json");
}

function loadDiskCache() {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // Restore cache entries — convert fetchedAt strings back to Date objects
    Object.entries(raw).forEach(([key, entry]) => {
      serverSourceCache[key] = {
        result: entry.result,
        fetchedAt: new Date(entry.fetchedAt),
      };
    });
    const count = Object.keys(serverSourceCache).length;
    console.log(`[cache] Loaded ${count} cached source${count !== 1 ? 's' : ''} from disk`);
  } catch(e) {
    console.warn('[cache] Could not load disk cache:', e.message);
  }
}

function saveDiskCache() {
  try {
    const serializable = {};
    Object.entries(serverSourceCache).forEach(([key, entry]) => {
      serializable[key] = {
        result: entry.result,
        fetchedAt: entry.fetchedAt.toISOString(),
      };
    });
    fs.writeFileSync(getCachePath(), JSON.stringify(serializable, null, 2));
  } catch(e) {
    console.warn('[cache] Could not save disk cache:', e.message);
  }
}

// Build results array from cache
function buildCachedResults() {
  return Object.values(serverSourceCache).map(entry => entry.result);
}

// Load cache from disk on startup
loadDiskCache();

async function fetchPropertySources(property) {
  const entries = Object.entries(property.sources).filter(([, u]) => u);
  return Promise.all(entries.map(async ([name, srcUrl]) => {
    const cacheKey = `${property.id}:${name}`;
    try {
      const text = await fetchUrl(srcUrl);
      const hasCalendar = text.includes('BEGIN:VCALENDAR');
      const hasEvents   = text.includes('BEGIN:VEVENT');
      if (!hasCalendar) {
        console.log(`  [P${property.id}:${name}] INVALID — no VCALENDAR`);
        // Don't update cache — keep last known good data
        const cached = serverSourceCache[cacheKey];
        if (cached) {
          console.log(`  [P${property.id}:${name}] Serving cached data from ${cached.fetchedAt.toLocaleTimeString()}`);
          return { ...cached.result, stale: true };
        }
        return { name, propertyId: property.id, success: false, data: '', error: 'No VCALENDAR' };
      }
      const result = { name, propertyId: property.id, success: true, data: text, error: null, empty: !hasEvents, stale: false };
      serverSourceCache[cacheKey] = { result, fetchedAt: new Date() };
      saveDiskCache();
      console.log(`  [P${property.id}:${name}] OK (${text.length} chars)`);
      return result;
    } catch(e) {
      console.log(`  [P${property.id}:${name}] FAILED: ${e.message}`);
      // Serve last known good data if available
      const cached = serverSourceCache[cacheKey];
      if (cached) {
        const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000);
        console.log(`  [P${property.id}:${name}] Serving cached data from ${ageMin} min ago`);
        return { ...cached.result, stale: true, staleReason: e.message };
      }
      return { name, propertyId: property.id, success: false, data: '', error: e.message };
    }
  }));
}

async function serverFetchAll() {
  const properties = getProperties();
  if (properties.length === 0) return;
  console.log(`\n[server poll] Fetching ${properties.length} propert${properties.length > 1 ? 'ies' : 'y'}...`);
  try {
    await Promise.all(properties.map(fetchPropertySources));
    serverLastFetchedAt = new Date();
    console.log(`[server poll] Done at ${serverLastFetchedAt.toLocaleTimeString()}`);
  } catch(e) {
    console.error('[server poll] Unexpected error:', e.message);
  }
}

function startServerPolling(intervalMs) {
  if (serverPollTimer) clearInterval(serverPollTimer);
  if (intervalMs <= 0) return;
  serverFetchAll();
  serverPollTimer = setInterval(serverFetchAll, intervalMs);
  console.log(`[server poll] Auto-refresh every ${Math.round(intervalMs / 60000)} minutes`);
}

// Retry fetching any sources that have never been successfully cached.
// Runs every 5 minutes until all sources have at least one cached entry.
let retryTimer = null;

function startCachePrimer() {
  if (retryTimer) return; // already running
  retryTimer = setInterval(async () => {
    const properties = getProperties();
    const uncached = [];
    for (const prop of properties) {
      for (const [name, url] of Object.entries(prop.sources)) {
        if (!url) continue;
        const key = `${prop.id}:${name}`;
        if (!serverSourceCache[key]) {
          uncached.push({ prop, name, url, key });
        }
      }
    }
    if (uncached.length === 0) {
      console.log('[cache] All sources cached — stopping retry timer');
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    console.log(`[cache] Retrying ${uncached.length} uncached source${uncached.length > 1 ? 's' : ''}...`);
    await Promise.all(uncached.map(async ({ prop, name, url, key }) => {
      try {
        const text = await fetchUrl(url);
        const hasCalendar = text.includes('BEGIN:VCALENDAR');
        if (!hasCalendar) { console.log(`  [${name}] retry: invalid iCal`); return; }
        const result = {
          name, propertyId: prop.id, success: true,
          data: text, error: null,
          empty: !text.includes('BEGIN:VEVENT'), stale: false,
        };
        serverSourceCache[key] = { result, fetchedAt: new Date() };
        saveDiskCache();
        console.log(`  [${name}] retry: cached successfully`);
      } catch(e) {
        console.log(`  [${name}] retry: still failing — ${e.message}`);
      }
    }));
  }, 5 * 60 * 1000); // retry every 5 minutes
  console.log('[cache] Cache primer started — will retry uncached sources every 5 minutes');
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/calendar, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

function fetchUrl(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error("Too many redirects"));
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: HEADERS,
      timeout: 15000,
    };
    https.get(options, (res) => {
      console.log(`  [${parsed.hostname}] HTTP ${res.statusCode}`);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location.startsWith("http")
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        res.resume();
        return fetchUrl(location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject).on("timeout", () => reject(new Error("Request timed out")));
  });
}

// ── Bookings storage ─────────────────────────────────────────
function getBaseDir() {
  return process.pkg ? path.dirname(process.execPath) : __dirname;
}

function getBookingsPath() {
  return path.join(getBaseDir(), "bookings.json");
}

function loadBookings() {
  try {
    const p = getBookingsPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch(e) {}
  return [];
}

function saveBookings(bookings) {
  fs.writeFileSync(getBookingsPath(), JSON.stringify(bookings, null, 2));
}

function getPropertyConfig() {
  loadConfig();
  return {
    name:        process.env.PROPERTY_NAME        || "My Property",
    description: process.env.PROPERTY_DESCRIPTION || "A beautiful place to stay.",
    location:    process.env.PROPERTY_LOCATION    || "",
    nightly_rate: parseFloat(process.env.NIGHTLY_RATE || "0"),
    currency:    process.env.CURRENCY             || "ZAR",
    min_nights:  parseInt(process.env.MIN_NIGHTS  || "1"),
    max_guests:  parseInt(process.env.MAX_GUESTS  || "10"),
    photo_url:   process.env.PROPERTY_PHOTO_URL   || "",
  };
}

function parseIcalDates(text) {
  const blocked = [];
  const events = text.split("BEGIN:VEVENT");
  events.shift();
  for (const ev of events) {
    const get = k => { const m = ev.match(new RegExp(k + "[^:]*:([^\r\n]+)")); return m ? m[1].trim() : ""; };
    const dtstart = get("DTSTART"), dtend = get("DTEND");
    if (!dtstart || !dtend) continue;
    const parseD = s => { const c = s.replace(/T.*/,""); return new Date(+c.slice(0,4), +c.slice(4,6)-1, +c.slice(6,8)); };
    const start = parseD(dtstart), end = parseD(dtend);
    if (isNaN(start) || isNaN(end)) continue;
    for (let d = new Date(start); d < end; d.setDate(d.getDate()+1)) {
      blocked.push(d.toISOString().slice(0,10));
    }
  }
  return blocked;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveFile(res, filePath, fallbackPath, contentType) {
  const externalPath = path.join(getBaseDir(), filePath);
  let html = null;
  if (fs.existsSync(externalPath)) {
    html = fs.readFileSync(externalPath, "utf8");
  } else {
    try { html = fs.readFileSync(path.join(__dirname, fallbackPath || filePath), "utf8"); } catch(e) {}
  }
  if (!html) { res.writeHead(404); res.end("File not found"); return; }
  res.writeHead(200, { "Content-Type": contentType || "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

// ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/config") {
    loadConfig();
    const sources = getSources();
    const hasLiveData = getProperties().length > 0;
    // Parse poll interval from config — default 2 hours, 0 = disabled
    const rawInterval = process.env.POLL_INTERVAL_MINUTES;
    const pollMinutes = rawInterval !== undefined ? parseInt(rawInterval) : 120;
    const pollIntervalMs = pollMinutes > 0 ? pollMinutes * 60 * 1000 : 0;
    const properties = getProperties().map(p => ({ id: p.id, name: p.name, location: p.location }));
    // Collect all active platform names across all properties
    const activePlatforms = [...new Set(
      getProperties().flatMap(p => Object.entries(p.sources)
        .filter(([, v]) => v)
        .map(([k]) => k)
      )
    )];
    // Start server-side polling if not already running
    if (pollIntervalMs > 0 && hasLiveData && !serverPollTimer) {
      startServerPolling(pollIntervalMs);
    }
    // Start cache primer — retries any uncached sources every 5 minutes
    if (hasLiveData) startCachePrimer();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasLiveData, pollIntervalMs, properties, activePlatforms }));
    return;
  }

  if (pathname === "/calendars") {
    const url = new URL(req.url, "http://localhost");
    const forceRefresh = url.searchParams.get("force") === "1";
    const hasCachedData = Object.keys(serverSourceCache).length > 0;

    if (forceRefresh) {
      // Force — fetch fresh then return updated cache
      console.log("\nFetching calendars (force refresh)...");
      try {
        const properties = getProperties();
        await Promise.all(properties.map(fetchPropertySources));
        serverLastFetchedAt = new Date();
      } catch(e) {
        console.error('[calendars] Force refresh error:', e.message);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildCachedResults()));
      return;
    }

    if (hasCachedData) {
      // Always serve cache immediately — never block waiting for a live fetch
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildCachedResults()));
      return;
    }

    // Truly empty cache — first ever cold start with no disk cache
    // Best-effort fetch; cache primer will fill gaps in background
    console.log("\nFetching calendars (cold start)...");
    try {
      const properties = getProperties();
      await Promise.all(properties.map(fetchPropertySources));
      serverLastFetchedAt = new Date();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildCachedResults()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Debug endpoint ───────────────────────────────────────────
  if (pathname === "/debug") {
    loadConfig();
    const icalKeys = Object.entries(process.env)
      .filter(([k]) => k.startsWith("ICAL_"))
      .map(([k, v]) => ({ key: k, value: v, length: v.length, lastChar: v.charCodeAt(v.length - 1) }));
    const propKeys = Object.keys(process.env).filter(k => k.startsWith("PROPERTY_"));
    const props = getProperties();
    const cacheStatus = Object.entries(serverSourceCache).map(([key, entry]) => ({
      key,
      fetchedAt: entry.fetchedAt,
      ageMinutes: Math.round((Date.now() - entry.fetchedAt) / 60000),
      dataLength: entry.result.data ? entry.result.data.length : 0,
      success: entry.result.success,
    }));
    // Find which sources have never been cached
    const uncachedSources = [];
    for (const prop of props) {
      for (const [name, url] of Object.entries(prop.sources)) {
        if (!url) continue;
        const key = `${prop.id}:${name}`;
        if (!serverSourceCache[key]) uncachedSources.push(key);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      icalKeys, propKeys,
      propertiesFound: props.length,
      properties: props,
      cacheStatus,
      uncachedSources,
      cacheComplete: uncachedSources.length === 0,
      retryActive: !!retryTimer,
    }, null, 2));
    return;
  }

  // ── Last updated timestamp ────────────────────────────────────
  if (pathname === "/last-updated") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ lastFetchedAt: serverLastFetchedAt }));
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    // When running as a pkg executable, index.html is bundled inside.
    // When running as plain Node, check next to the script first, then fall back to bundled.
    let html = null;
    const externalPath = path.join(
      process.pkg ? path.dirname(process.execPath) : __dirname,
      "index.html"
    );
    if (fs.existsSync(externalPath)) {
      // External file takes priority — allows updates without rebuilding the executable
      html = fs.readFileSync(externalPath, "utf8");
    } else {
      try {
        // Fall back to bundled version inside the executable
        html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      } catch(e) {
        res.writeHead(404); res.end("index.html not found"); return;
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }

  // ── Booking engine: public page ──────────────────────────────
  // Booking engine — enabled when feature/booking-engine is released
  if (pathname === "/book" || pathname === "/book.html") {
    const bookFile = ["book", "html"].join("."); // dynamic so pkg doesn't scan it
    const bookExternal = path.join(
      process.pkg ? path.dirname(process.execPath) : __dirname,
      bookFile
    );
    let bookHtml = null;
    if (fs.existsSync(bookExternal)) {
      bookHtml = fs.readFileSync(bookExternal, "utf8");
    }
    if (!bookHtml) { res.writeHead(404); res.end("Booking engine not yet available."); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(bookHtml);
    return;
  }

  // ── API: property info + availability ────────────────────────
  if (pathname === "/api/property") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPropertyConfig()));
    return;
  }

  if (pathname === "/api/availability") {
    const sources = getSources();
    const blockedDates = new Set();
    // Add platform iCal blocked dates
    await Promise.all(Object.values(sources).filter(Boolean).map(async srcUrl => {
      try {
        const text = await fetchUrl(srcUrl);
        parseIcalDates(text).forEach(d => blockedDates.add(d));
      } catch(e) {}
    }));
    // Add direct bookings
    loadBookings().forEach(b => {
      let d = new Date(b.checkin);
      const end = new Date(b.checkout);
      while (d < end) { blockedDates.add(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1); }
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ blocked: [...blockedDates] }));
    return;
  }

  // ── API: submit booking ───────────────────────────────────────
  if (pathname === "/api/book" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { name, email, phone, guests, checkin, checkout, message } = body;
      if (!name || !email || !checkin || !checkout) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required fields" }));
        return;
      }
      const start = new Date(checkin), end = new Date(checkout);
      if (isNaN(start) || isNaN(end) || end <= start) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid dates" }));
        return;
      }
      const nights = Math.round((end - start) / 86400000);
      const cfg = getPropertyConfig();
      const booking = {
        uid: "direct-" + Date.now(),
        source: "direct",
        name, email, phone: phone || "", guests: guests || 1,
        checkin, checkout, nights,
        total: cfg.nightly_rate > 0 ? cfg.nightly_rate * nights : null,
        currency: cfg.currency,
        message: message || "",
        status: "pending",
        created: new Date().toISOString(),
      };
      const bookings = loadBookings();
      bookings.push(booking);
      saveBookings(bookings);
      console.log(`  [direct booking] ${name} — ${checkin} to ${checkout} (${nights} nights)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, booking }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: list direct bookings (for dashboard) ─────────────────
  if (pathname === "/api/bookings") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadBookings()));
    return;
  }

  // ── API: delete a direct booking ──────────────────────────────
  if (pathname.startsWith("/api/bookings/") && req.method === "DELETE") {
    const uid = decodeURIComponent(pathname.replace("/api/bookings/", ""));
    const bookings = loadBookings();
    const idx = bookings.findIndex(b => b.uid === uid);
    if (idx === -1) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Booking not found" }));
      return;
    }
    const deleted = bookings.splice(idx, 1)[0];
    saveBookings(bookings);
    console.log(`  [direct booking] Deleted: ${deleted.name} — ${deleted.checkin} to ${deleted.checkout}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, deleted }));
    return;
  }

  // ── Static files: /js/ and /css/ ─────────────────────────────
  if (pathname.startsWith('/js/') || pathname.startsWith('/css/')) {
    const ext      = pathname.split('.').pop();
    const mimeMap  = { js: 'application/javascript', css: 'text/css' };
    const mimeType = mimeMap[ext] || 'text/plain';
    const filePath = path.join(
      process.pkg ? path.dirname(process.execPath) : __dirname,
      pathname
    );
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404); res.end('Static file not found: ' + pathname);
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const PORT = 3456;
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
    }
  }
  console.log(`\nStayView running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIp}:${PORT}\n`);
});