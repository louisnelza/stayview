const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { parseIcal, localYmd, parseYmd, isValidYmd, nightsBetween, datesInRange, fmtFull, SOURCE_LABELS } = require("./js/shared.js");
const { KnownUidStore } = require("./booking-diff.js");

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

// Days between a checkout and the next check-in within which the dashboard
// reminds the host to check the unit before the arrival. 0 turns these
// reminders off. Blank or invalid values fall back to the default.
const DEFAULT_TURNAROUND_GAP_DAYS = 3;
const MAX_TURNAROUND_GAP_DAYS = 30;
const warnedGapKeys = new Set();
function turnaroundGapDays(key) {
  const raw = (process.env[key] || "").trim();
  if (raw === "") return DEFAULT_TURNAROUND_GAP_DAYS;
  if (/^\d+$/.test(raw) && +raw <= MAX_TURNAROUND_GAP_DAYS) return +raw;
  if (!warnedGapKeys.has(key)) {
    warnedGapKeys.add(key);
    console.warn(`[config] ${key}=${raw} is not a whole number from 0 to ${MAX_TURNAROUND_GAP_DAYS}; using ${DEFAULT_TURNAROUND_GAP_DAYS}`);
  }
  return DEFAULT_TURNAROUND_GAP_DAYS;
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
        turnaroundGapDays: turnaroundGapDays(`${prefix}TURNAROUND_GAP_DAYS`),
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
        turnaroundGapDays: turnaroundGapDays("TURNAROUND_GAP_DAYS"),
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

// ── New booking detection ────────────────────────────────────
// Every fresh (non-stale) fetch is diffed against known-uids.json.
const knownUids = new KnownUidStore(path.join(getBaseDir(), "known-uids.json"));

function detectBookingChanges(property, source, text) {
  const sourceKey = `${property.id}:${source}`;
  let bookings;
  try {
    bookings = parseIcal(text, source, property.id);
  } catch(e) {
    console.warn(`  [diff] ${sourceKey} could not parse feed: ${e.message}`);
    return;
  }
  const result = knownUids.update(sourceKey, bookings);
  if (result.baseline) {
    console.log(`  [diff] ${sourceKey} baseline set — ${result.next.length} UID${result.next.length !== 1 ? 's' : ''} known`);
    return;
  }
  if (result.skipped) {
    console.warn(`  [diff] ${sourceKey} feed returned no events — keeping known UIDs (possible platform glitch)`);
    return;
  }
  result.removed.forEach(uid => console.log(`  [diff] ${sourceKey} UID no longer in feed: ${uid}`));
  if (result.added.length > 0) handleNewBookings(property, source, result.added);
}

// Notification senders (Telegram, ntfy, email — #54–#57) hook in here.
function handleNewBookings(property, source, bookings) {
  const label = SOURCE_LABELS[source] || source;
  for (const b of bookings) {
    console.log(`  [diff] New ${label} booking — ${property.name}: ${b.summary}, ` +
      `${fmtFull(b.start)} → ${fmtFull(b.end)} (${b.nights} night${b.nights !== 1 ? 's' : ''})`);
  }
}

// Store a successful fetch in the cache and check it for new bookings
function cacheFreshSource(property, name, text) {
  const result = {
    name, propertyId: property.id, success: true,
    data: text, error: null,
    empty: !text.includes('BEGIN:VEVENT'), stale: false,
  };
  serverSourceCache[`${property.id}:${name}`] = { result, fetchedAt: new Date() };
  saveDiskCache();
  detectBookingChanges(property, name, text);
  return result;
}

// Requests for the same feed while a fetch is under way share that fetch.
const refreshesInFlight = new Map();

// Fetch one feed and, if it is a real calendar, cache it. Throws when the
// fetch fails or the response isn't iCal, leaving the cache untouched so
// the last good copy is kept.
function refreshSource(property, name, srcUrl) {
  const key = `${property.id}:${name}`;
  if (refreshesInFlight.has(key)) return refreshesInFlight.get(key);
  const pending = (async () => {
    const text = await fetchUrl(srcUrl);
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('No VCALENDAR');
    const result = cacheFreshSource(property, name, text);
    console.log(`  [P${property.id}:${name}] OK (${text.length} chars)`);
    return result;
  })().finally(() => refreshesInFlight.delete(key));
  refreshesInFlight.set(key, pending);
  return pending;
}

async function fetchPropertySources(property) {
  const entries = Object.entries(property.sources).filter(([, u]) => u);
  return Promise.all(entries.map(async ([name, srcUrl]) => {
    const cacheKey = `${property.id}:${name}`;
    try {
      return await refreshSource(property, name, srcUrl);
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
    await Promise.all(uncached.map(async ({ prop, name, url }) => {
      try {
        await refreshSource(prop, name, url);
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
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: HEADERS,
      timeout: 15000,
    };
    https.get(options, (res) => {
      console.log(`  [${parsed.hostname}] HTTP ${res.statusCode}`);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve relative redirects against the current URL (keeps host and port)
        const location = new URL(res.headers.location, targetUrl).href;
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

// bookings.json exists but can't be read as a list of bookings — for
// example a typo after editing it by hand. It must never be treated as
// empty: the next save would overwrite it and lose every direct booking.
class BookingsFileError extends Error {}

const BOOKINGS_UNREADABLE_FOR_HOST =
  "bookings.json could not be read, so direct bookings are paused. Fix or restore the file; StayView has not changed it.";
const BOOKINGS_UNREADABLE_FOR_GUEST =
  "We can't take bookings right now. Please try again later.";

// No file yet means no direct bookings. Throws BookingsFileError if the
// file exists but can't be read or isn't a list.
function loadBookings() {
  const p = getBookingsPath();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch(e) {
    if (e.code === "ENOENT") return [];
    console.error(`[bookings] ${p} could not be read (${e.message}). Direct bookings are paused until it is fixed; the file has not been changed.`);
    throw new BookingsFileError(e.message);
  }
  if (!Array.isArray(data)) {
    console.error(`[bookings] ${p} is not a list of bookings. Direct bookings are paused until it is fixed; the file has not been changed.`);
    throw new BookingsFileError("not a list of bookings");
  }
  return data;
}

// Write to a temporary file, then rename it over bookings.json, so a crash
// or power cut mid-save leaves either the old file or the new one, never
// a half-written one.
function saveBookings(bookings) {
  const p = getBookingsPath();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(bookings, null, 2));
  fs.renameSync(tmp, p);
}

// Details of the property the booking page sells. The page handles one
// property, so with the numbered format this is property 1. Each setting
// is read from PROPERTY_1_* first, then from the legacy single-property
// name, so both config formats (and a mix of the two) work.
function getPropertyConfig() {
  loadConfig();
  const setting = (numbered, legacy) =>
    process.env[`PROPERTY_1_${numbered}`] || process.env[legacy] || "";
  const number = (value, fallback) => {
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    name:         setting("NAME", "PROPERTY_NAME")               || "My Property",
    description:  setting("DESCRIPTION", "PROPERTY_DESCRIPTION") || "A beautiful place to stay.",
    location:     setting("LOCATION", "PROPERTY_LOCATION"),
    nightly_rate: number(setting("NIGHTLY_RATE", "NIGHTLY_RATE"), 0),
    currency:     setting("CURRENCY", "CURRENCY")                || "ZAR",
    min_nights:   Math.max(1, Math.floor(number(setting("MIN_NIGHTS", "MIN_NIGHTS"), 1))),
    max_guests:   Math.max(1, Math.floor(number(setting("MAX_GUESTS", "MAX_GUESTS"), 10))),
    photo_url:    setting("PHOTO_URL", "PROPERTY_PHOTO_URL"),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Read a file that ships with the app (pages, scripts, styles).
// A copy next to the script or executable wins, so files can be updated
// without rebuilding; otherwise the copy bundled inside the pkg executable
// is used. Returns null if neither exists.
function readAppFile(relPath) {
  for (const dir of [getBaseDir(), __dirname]) {
    try { return fs.readFileSync(path.join(dir, relPath)); } catch(e) {}
  }
  return null;
}

function sendAppFile(res, relPath, contentType, notFoundMessage) {
  const body = readAppFile(relPath);
  if (body === null) { res.writeHead(404); res.end(notFoundMessage || "File not found"); return; }
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

// ── Availability for the booking page ────────────────────────
// The page loads availability from the feed cache when it is recent, so
// opening /book doesn't hit every platform each time.
const AVAILABILITY_CACHE_MS = 10 * 60 * 1000;
// A booking re-reads every feed. If a platform can't be reached, its cached
// copy is trusted only if it is this recent; otherwise the booking is
// refused rather than treating that platform's nights as free.
const BOOKING_FALLBACK_MAX_AGE_MS = 60 * 60 * 1000;

// Nights taken on the platform feeds of the booking page's property, as a
// Set of YYYY-MM-DD strings. Every event blocks its nights, including ones
// a platform marks as blocked rather than booked.
//   reuseIfNewerThanMs — use a cached feed this recent without refetching
//   fallbackMaxAgeMs   — if a fetch fails, accept a cached copy this recent
// `unreadable` lists the feeds that could not be read or trusted, so the
// caller can tell the result is incomplete.
async function getPlatformTakenNights({ reuseIfNewerThanMs, fallbackMaxAgeMs }) {
  const nights = new Set();
  const unreadable = [];
  const property = getProperties()[0];
  if (!property) return { nights, unreadable };

  await Promise.all(Object.entries(property.sources).filter(([, url]) => url).map(async ([name, url]) => {
    const cached = serverSourceCache[`${property.id}:${name}`];
    const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
    let text = null;
    if (cached && ageMs <= reuseIfNewerThanMs) {
      text = cached.result.data;
    } else {
      try {
        text = (await refreshSource(property, name, url)).data;
      } catch(e) {
        console.log(`  [P${property.id}:${name}] availability check FAILED: ${e.message}`);
        if (cached && ageMs <= fallbackMaxAgeMs) {
          console.log(`  [P${property.id}:${name}] using cached copy from ${Math.round(ageMs / 60000)} min ago`);
          text = cached.result.data;
        }
      }
    }
    if (text === null) { unreadable.push(name); return; }
    for (const b of parseIcal(text, name, property.id)) {
      datesInRange(b.start, b.end).forEach(d => nights.add(d));
    }
  }));
  return { nights, unreadable };
}

// Synchronous on purpose — /api/book calls it immediately before saving,
// with no await in between, so two requests can't both pass the check.
function addDirectBookingNights(takenNights) {
  loadBookings().forEach(b => datesInRange(b.checkin, b.checkout).forEach(d => takenNights.add(d)));
  return takenNights;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// ─────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
    const properties = getProperties().map(p => ({
      id: p.id, name: p.name, location: p.location, turnaroundGapDays: p.turnaroundGapDays,
      platforms: Object.keys(p.sources).filter(k => p.sources[k]),
    }));
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
    sendAppFile(res, "index.html", "text/html; charset=utf-8", "index.html not found");
    return;
  }

  // ── Booking engine: public page ──────────────────────────────
  if (pathname === "/book" || pathname === "/book.html") {
    sendAppFile(res, "book.html", "text/html; charset=utf-8", "Booking page not found");
    return;
  }

  // ── API: property info + availability ────────────────────────
  if (pathname === "/api/property") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPropertyConfig()));
    return;
  }

  if (pathname === "/api/availability") {
    const { nights, unreadable } = await getPlatformTakenNights({
      reuseIfNewerThanMs: AVAILABILITY_CACHE_MS,
      fallbackMaxAgeMs: Infinity,   // an old copy still shows nights that were taken
    });
    // complete: false means a platform has never been read, so some taken
    // nights may be missing. /api/book re-checks before accepting anything.
    // If bookings.json can't be read, show what the platforms say and mark
    // the result incomplete; /api/book refuses bookings until it is fixed.
    let directReadable = true;
    try {
      addDirectBookingNights(nights);
    } catch(e) {
      if (!(e instanceof BookingsFileError)) throw e;
      directReadable = false;
    }
    sendJson(res, 200, { blocked: [...nights], complete: unreadable.length === 0 && directReadable });
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
      if (!isValidYmd(checkin) || !isValidYmd(checkout)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid dates" }));
        return;
      }
      const start = parseYmd(checkin), end = parseYmd(checkout);
      if (end <= start) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid dates" }));
        return;
      }
      const nights = nightsBetween(start, end);
      const cfg = getPropertyConfig();
      if (checkin < localYmd(new Date())) {
        sendJson(res, 400, { error: "Check-in date is in the past" });
        return;
      }
      if (nights < cfg.min_nights) {
        sendJson(res, 400, { error: `Minimum stay is ${cfg.min_nights} night${cfg.min_nights > 1 ? "s" : ""}` });
        return;
      }
      // Refuse nights that are already taken. The page only offers free
      // dates, but its view can be stale (two guests booking at once) and
      // the endpoint can be called directly. Platform feeds are fetched
      // fresh first; direct bookings are re-read right before saving.
      const { nights: platformNights, unreadable } = await getPlatformTakenNights({
        reuseIfNewerThanMs: 0,
        fallbackMaxAgeMs: BOOKING_FALLBACK_MAX_AGE_MS,
      });
      if (unreadable.length > 0) {
        console.warn(`  [direct booking] Refused ${checkin} to ${checkout} — could not check ${unreadable.join(", ")}`);
        sendJson(res, 503, { error: "We can't confirm availability right now. Please try again in a few minutes." });
        return;
      }
      const taken = addDirectBookingNights(platformNights);
      if (datesInRange(checkin, checkout).some(d => taken.has(d))) {
        sendJson(res, 409, { error: "Sorry, those dates have just been taken. Please choose different dates." });
        return;
      }
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
      if (e instanceof BookingsFileError) {
        console.warn(`  [direct booking] Refused — bookings.json could not be read`);
        sendJson(res, 503, { error: BOOKINGS_UNREADABLE_FOR_GUEST });
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: list direct bookings (for dashboard) ─────────────────
  if (pathname === "/api/bookings") {
    try {
      sendJson(res, 200, loadBookings());
    } catch(e) {
      if (!(e instanceof BookingsFileError)) throw e;
      sendJson(res, 500, { error: BOOKINGS_UNREADABLE_FOR_HOST });
    }
    return;
  }

  // ── API: delete a direct booking ──────────────────────────────
  if (pathname.startsWith("/api/bookings/") && req.method === "DELETE") {
    const uid = decodeURIComponent(pathname.replace("/api/bookings/", ""));
    let bookings;
    try {
      bookings = loadBookings();
    } catch(e) {
      if (!(e instanceof BookingsFileError)) throw e;
      sendJson(res, 500, { error: BOOKINGS_UNREADABLE_FOR_HOST });
      return;
    }
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
  // Only plain file names directly inside js/ or css/ — nothing that
  // could step outside those folders.
  const staticMatch = pathname.match(/^\/(js|css)\/([\w-]+(?:\.[\w-]+)*)\.(js|css)$/);
  if (staticMatch && staticMatch[1] === staticMatch[3]) {
    const mimeType = staticMatch[3] === "js" ? "application/javascript" : "text/css";
    sendAppFile(res, pathname.slice(1), mimeType, "Static file not found: " + pathname);
    return;
  }

  res.writeHead(404); res.end("Not found");
}

// A bug in one request must not take the whole server down. Without this,
// an error thrown inside handleRequest becomes an unhandled promise
// rejection, which stops the Node process.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[error] ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Something went wrong. Please try again." });
    } else {
      res.destroy();
    }
  });
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