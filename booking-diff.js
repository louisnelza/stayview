// ── Booking diff engine ──────────────────────────────────────
// Compares the bookings in a freshly fetched iCal feed against the
// UIDs we have already seen for that source, and reports which
// bookings are new. Persisted to known-uids.json so it survives
// restarts:
//
//   {
//     "1:airbnb":     ["uid1", "uid2"],
//     "1:lekkeslaap": ["uid3"]
//   }
//
// Rules:
//   - First time a source is seen → baseline only, nothing reported
//     (no notification storm on upgrade or when adding a property).
//   - New UID on a real booking → reported as added.
//   - New UID on a blocked-dates entry → remembered, not reported.
//   - UID gone from the feed → reported as removed (logged only;
//     cancellation alerts are a future enhancement).
//   - Feed suddenly has zero events while we know some UIDs → treated
//     as a platform glitch; known UIDs are kept so the next good fetch
//     doesn't report every booking as new.

const fs = require("fs");

function localYmd(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Some feeds omit UID — fall back to a stable key from dates + summary
function bookingKey(b) {
  if (b.uid) return b.uid;
  return `nouid:${localYmd(b.start)}:${localYmd(b.end)}:${b.summary}`;
}

// Pure diff — no I/O. `known` is an array of UIDs, or undefined if
// this source has never been seen before.
function diffSource(known, bookings) {
  const currentKeys = [...new Set(bookings.map(bookingKey))];

  if (known === undefined) {
    return { baseline: true, skipped: false, added: [], removed: [], next: currentKeys };
  }

  if (currentKeys.length === 0 && known.length > 0) {
    return { baseline: false, skipped: true, added: [], removed: [], next: known };
  }

  const knownSet = new Set(known);
  const currentSet = new Set(currentKeys);
  const seen = new Set();
  const added = [];
  for (const b of bookings) {
    const key = bookingKey(b);
    if (knownSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (!b.isBlocked) added.push(b);
  }
  const removed = known.filter(k => !currentSet.has(k));
  return { baseline: false, skipped: false, added, removed, next: currentKeys };
}

class KnownUidStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, uids] of Object.entries(raw)) {
          if (Array.isArray(uids)) this.data[key] = uids.map(String);
        }
      }
      const count = Object.keys(this.data).length;
      console.log(`[diff] Loaded known UIDs for ${count} source${count !== 1 ? "s" : ""}`);
    } catch (e) {
      // Corrupt file — start fresh. Every source re-baselines, so no
      // false notifications; at worst we miss bookings made meanwhile.
      console.warn("[diff] Could not load known UIDs, re-baselining:", e.message);
      this.data = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn("[diff] Could not save known UIDs:", e.message);
    }
  }

  // Diff a source's bookings against what we know, then remember them.
  update(sourceKey, bookings) {
    const result = diffSource(this.data[sourceKey], bookings);
    this.data[sourceKey] = result.next;
    this.save();
    return result;
  }
}

module.exports = { diffSource, bookingKey, KnownUidStore };
