const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Support both config.txt (user-friendly) and .env (developer)
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
    fs.readFileSync(configPath, "utf8")
      .split("\n")
      .forEach(line => {
        line = line.trim();
        if (!line || line.startsWith("#")) return;
        const [key, ...val] = line.split("=");
        if (key && val.length) process.env[key.trim()] = val.join("=").trim();
      });
    return;
  }

  // Fall back to .env (developers)
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8")
      .split("\n")
      .forEach(line => {
        const [key, ...val] = line.split("=");
        if (key && val.length) process.env[key.trim()] = val.join("=").trim();
      });
  }
}

function getSources() {
  loadConfig();
  return {
    airbnb:     process.env.ICAL_AIRBNB     || null,
    booking:    process.env.ICAL_BOOKING    || null,
    lekkeslaap: process.env.ICAL_LEKKESLAAP || null,
  };
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

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/config") {
    const sources = getSources();
    const hasLiveData = Object.values(sources).some(Boolean);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hasLiveData }));
    return;
  }

  if (pathname === "/calendars") {
    console.log("\nFetching calendars...");
    const sources = getSources();
    try {
      const results = await Promise.all(
        Object.entries(sources).filter(([, u]) => u).map(async ([name, srcUrl]) => {
          try {
            const text = await fetchUrl(srcUrl);
            const hasCalendar = text.includes("BEGIN:VCALENDAR");
            const hasEvents   = text.includes("BEGIN:VEVENT");
            if (!hasCalendar) {
              console.log(`  [${name}] INVALID — no VCALENDAR. First 200 chars: ${text.slice(0, 200)}`);
              return { name, success: false, data: "", error: "Response was not a valid iCal feed (no BEGIN:VCALENDAR)" };
            }
            if (!hasEvents) {
              console.log(`  [${name}] EMPTY — valid iCal but no events`);
              return { name, success: true, data: text, error: null, empty: true };
            }
            console.log(`  [${name}] OK (${text.length} chars)`);
            return { name, success: true, data: text, error: null };
          } catch (e) {
            console.log(`  [${name}] FAILED: ${e.message}`);
            return { name, success: false, data: "", error: e.message };
          }
        })
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
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