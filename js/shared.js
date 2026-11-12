// ── shared.js ─────────────────────────────────────────────────
// Utilities shared between dashboard (index.html) and booking
// engine (book.html). No DOM dependencies — pure logic only.

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const SOURCE_LABELS = {
  airbnb:     'Airbnb',
  booking:    'Booking.com',
  lekkeslaap: 'Lekkeslaap',
  direct:     'Direct',
  blocked:    'Blocked',
};

// ── Date helpers ──────────────────────────────────────────────

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Format a Date as a local calendar date (YYYY-MM-DD). Never use
// toISOString() for this — it converts to UTC and shifts the date
// back a day in UTC+ timezones.
function localYmd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parse a YYYY-MM-DD string as local midnight. new Date('YYYY-MM-DD')
// parses as UTC midnight, which is the wrong day in UTC- timezones
// and not local midnight in UTC+ ones.
function parseYmd(s) {
  return new Date(s + 'T00:00:00');
}

// True only for a real calendar date in strict YYYY-MM-DD form.
// Rejects impossible dates like 2026-02-30, which Date would
// otherwise roll forward to 2 March.
function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return !isNaN(d) && localYmd(d) === s;
}

// Parse an iCal DTSTART/DTEND value to local midnight of its day.
//   20261110 / 2026-11-10    date-only: that calendar day
//   20261110T140000          floating or TZID local time: that day
//   20261110T230000Z         UTC instant: the local day it falls on
// Anything else returns an Invalid Date so the event is skipped.
function parseDate(s) {
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})(Z)?)?/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, sec, utc] = m;
  if (utc) {
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
  return new Date(+y, +mo - 1, +d);
}

function fmtShort(d) {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

function fmtFull(d) {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function nightsBetween(start, end) {
  return Math.round((end - start) / 86400000);
}

// Every night of a stay, as YYYY-MM-DD strings: the check-in date up to
// but not including the check-out date. Takes Dates or YYYY-MM-DD strings.
// Steps by calendar day, so stays across a DST change are counted right.
function datesInRange(start, end) {
  const toDate = x => (x instanceof Date ? new Date(x) : parseYmd(x));
  const dates = [];
  const last = toDate(end);
  for (const d = toDate(start); d < last; d.setDate(d.getDate() + 1)) dates.push(localYmd(d));
  return dates;
}

function getStatus(b) {
  const now = today();
  if (b.start > now)  return 'upcoming';
  if (b.end < now)    return 'past';
  // Guest is currently in-stay — determine which day
  const checkoutDay = new Date(b.end);
  checkoutDay.setHours(0, 0, 0, 0);
  if (now.getTime() === b.start.getTime())     return 'checking-in';
  if (now.getTime() === checkoutDay.getTime()) return 'checking-out';
  return 'active';
}

// ── Turnaround detection ─────────────────────────────────────
// Finds the dates on which a unit needs a turnaround/service reminder.
// Three cases, in order of precedence:
//   1. Same-day swap — one booking ends, another starts same day
//   2. Checkout day — any booking ending (unit always needs cleaning)
//   3. Checkin after gap — a booking starts within the property's gap
//      threshold of a previous booking ending (unit may need refreshing).
//      The threshold defaults to TURNAROUND_GAP_DAYS; 0 turns this case off.
// Turnarounds are tracked per property, so two properties with activity
// on the same date never overwrite each other.
const TURNAROUND_GAP_DAYS = 3;

// gapDaysFor(propertyId) returns that property's gap threshold in days.
function findTurnarounds(bookings, gapDaysFor = () => TURNAROUND_GAP_DAYS) {
  // Returns Map of propertyId -> Map of dateStr -> { type: 'swap'|'checkout'|'checkin', propertyId }
  const byProperty = new Map();
  for (const bk of bookings) {
    if (bk.isBlocked) continue;
    if (!byProperty.has(bk.propertyId)) byProperty.set(bk.propertyId, []);
    byProperty.get(bk.propertyId).push(bk);
  }

  const turnarounds = new Map();
  for (const [propertyId, real] of byProperty) {
    const gapDays = gapDaysFor(propertyId);
    const days = new Map();
    turnarounds.set(propertyId, days);

    // Index checkouts by date so each check-in is a lookup, not a scan
    const endingOn = new Map(); // dateStr -> bookings checking out that day
    for (const bk of real) {
      const endStr = localYmd(bk.end);
      if (!endingOn.has(endStr)) endingOn.set(endStr, []);
      endingOn.get(endStr).push(bk);
      // Case 2: every checkout day needs a turnaround
      days.set(endStr, { type: 'checkout', propertyId });
    }

    for (const bk of real) {
      const startStr = localYmd(bk.start);
      const endsBefore = dateStr => (endingOn.get(dateStr) || []).some(a => a !== bk);

      // Case 1: another booking checks out the day this one checks in
      if (endsBefore(startStr)) {
        days.set(startStr, { type: 'swap', propertyId });
        continue;
      }
      // Case 3: checkin within GAP_DAYS of a previous checkout.
      // Stepping by calendar day keeps this correct across DST changes.
      if (days.has(startStr)) continue;
      for (let gap = 1; gap <= gapDays; gap++) {
        const d = new Date(bk.start);
        d.setDate(d.getDate() - gap);
        if (endsBefore(localYmd(d))) {
          days.set(startStr, { type: 'checkin', propertyId });
          break;
        }
      }
    }
  }
  return turnarounds;
}

// The turnaround entry for one property on one date, or undefined.
function turnaroundOn(turnarounds, propertyId, dateStr) {
  const days = turnarounds instanceof Map ? turnarounds.get(propertyId) : null;
  return days ? days.get(dateStr) : undefined;
}

// Whether a date has a turnaround — for one property, or for any when 'all'.
function hasTurnaroundOn(turnarounds, dateStr, propertyId = 'all') {
  if (!(turnarounds instanceof Map)) return false;
  if (propertyId !== 'all') return !!turnaroundOn(turnarounds, propertyId, dateStr);
  for (const days of turnarounds.values()) if (days.has(dateStr)) return true;
  return false;
}

// Number of turnarounds in a calendar month (monthIndex 0–11), for one
// property or summed over all of them. Two properties turning over on the
// same day count as two.
function countTurnaroundsInMonth(turnarounds, year, monthIndex, propertyId = 'all') {
  if (!(turnarounds instanceof Map)) return 0;
  const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}-`;
  let count = 0;
  for (const [pid, days] of turnarounds) {
    if (propertyId !== 'all' && pid !== propertyId) continue;
    for (const dateStr of days.keys()) if (dateStr.startsWith(prefix)) count++;
  }
  return count;
}

// ── Direct bookings blocked on the platforms? ───────────────
// A direct booking only exists in StayView, so its nights have to be
// blocked on each platform by hand (#77). The platforms import each other's
// calendars, so a block made on one normally reaches the others.

// Platforms StayView can't check. Booking.com's export leaves out dates it
// closed through a calendar import, and labels everything it does export
// "CLOSED - Not available", so a closure made by hand looks like a booking.
const PLATFORMS_NOT_CHECKED = ['booking'];

// For each direct booking with nights from `from` onwards, compare those
// nights with each platform's feed for the same property:
//   missing   — nights the platform doesn't show as taken yet
//   conflicts — nights where the platform has its own booking (a likely
//               double booking, not a block)
// platformsFor(propertyId) lists the platforms configured for a property.
// Returns [{ booking, checked: [platform], missing: { platform: [dateStr] },
//            conflicts: { platform: [dateStr] } }]
function checkDirectBookingsBlocked(bookings, platformsFor, from = today()) {
  const blockedOn = new Map();  // "propertyId:platform" -> Set of nights blocked there
  const bookedOn  = new Map();  // "propertyId:platform" -> Set of nights booked there
  for (const b of bookings) {
    if (b.source === 'direct') continue;
    const key = `${b.propertyId}:${b.source}`;
    const target = b.isBlocked ? blockedOn : bookedOn;
    if (!target.has(key)) target.set(key, new Set());
    datesInRange(b.start, b.end).forEach(d => target.get(key).add(d));
  }
  const fromStr = localYmd(from);
  const results = [];
  for (const b of bookings) {
    if (b.source !== 'direct') continue;
    const nights = datesInRange(b.start, b.end).filter(d => d >= fromStr);
    if (nights.length === 0) continue;
    const checked = platformsFor(b.propertyId)
      .filter(p => p !== 'direct' && !PLATFORMS_NOT_CHECKED.includes(p));
    const missing = {}, conflicts = {};
    for (const p of checked) {
      const blocked = blockedOn.get(`${b.propertyId}:${p}`) || new Set();
      const booked  = bookedOn.get(`${b.propertyId}:${p}`)  || new Set();
      const clash = nights.filter(d => booked.has(d));
      const gaps  = nights.filter(d => !booked.has(d) && !blocked.has(d));
      if (clash.length) conflicts[p] = clash;
      if (gaps.length)  missing[p]   = gaps;
    }
    results.push({ booking: b, checked, missing, conflicts });
  }
  return results;
}

// ── iCal parsing ──────────────────────────────────────────────

// Unfold iCal line continuations (CRLF or LF followed by space/tab)
function unfoldIcal(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// Unescape iCal \n \, \; \\ sequences
function unescapeIcal(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

// Parse all structured fields from a Lekkeslaap SUMMARY value
// Format: "Reference: LS-XXXXX \nCustomer: Name \nEmail: x \nCell: y \nView at: url"
function parseLekkeslaapSummary(rawSummary) {
  const text = unescapeIcal(rawSummary);
  const get = key => {
    const m = text.match(new RegExp(key + ':\\s*(.+?)(?:\\n|$)', 'i'));
    return m ? m[1].trim() : null;
  };
  return {
    reference: get('Reference'),
    name:      get('Customer'),
    email:     get('Email'),
    cell:      get('Cell'),
    viewUrl:   get('View at'),
  };
}

function extractGuestName(summary, description, source) {
  if (source === 'lekkeslaap') {
    const parsed = parseLekkeslaapSummary(summary);
    if (parsed.name) return parsed.name;
  }
  if (source === 'booking') return 'Booking.com Guest';
  if (source === 'airbnb' && /^reserved$/i.test(summary.trim())) return 'Airbnb Guest';
  return summary.split('(')[0].replace(/\n.*/s, '').trim() || 'Guest';
}

function parseIcal(text, source, propertyId = 1) {
  const bookings = [];
  // Unfold wrapped lines before splitting into events
  const unfolded = unfoldIcal(text);
  const events = unfolded.split('BEGIN:VEVENT');
  events.shift();

  for (const ev of events) {
    const get = k => {
      const m = ev.match(new RegExp(k + '[^:]*:([^\r\n]+)'));
      return m ? m[1].trim() : '';
    };
    const dtstart     = get('DTSTART');
    const dtend       = get('DTEND');
    const uid         = get('UID');
    const rawSummary  = get('SUMMARY') || '';
    const description = unescapeIcal(get('DESCRIPTION'));

    if (!dtstart || !dtend) continue;
    const start = parseDate(dtstart);
    const end   = parseDate(dtend);
    if (isNaN(start) || isNaN(end)) continue;
    const nights = nightsBetween(start, end);

    const isBlocked = source === 'booking'
      ? false
      : source === 'airbnb'
        ? /not available/i.test(rawSummary)
        : /block|not available|unavailable|closed|blocked dates/i.test(description + rawSummary);

    // Parse all available fields for Lekkeslaap
    let details = null;
    let provisional = false;
    if (source === 'lekkeslaap' && !isBlocked) {
      details = parseLekkeslaapSummary(rawSummary);
      // Provisional booking — Lekkeslaap sends reference + view URL but no guest name yet
      provisional = !!(details && details.reference && !details.name);
    }

    const summary = isBlocked
      ? (rawSummary || description || 'Blocked')
      : provisional
        ? 'Provisional Booking'
        : extractGuestName(rawSummary, description, source);

    bookings.push({ uid, source, summary, start, end, nights, isBlocked, details, propertyId, provisional });
  }
  return bookings;
}

// ── DOM helpers ───────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Node export ───────────────────────────────────────────────
// Lets server.js reuse the iCal parser. No-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseIcal, parseDate, localYmd, parseYmd, isValidYmd, nightsBetween, datesInRange, fmtFull, SOURCE_LABELS, PLATFORMS_NOT_CHECKED, checkDirectBookingsBlocked, TURNAROUND_GAP_DAYS, findTurnarounds, turnaroundOn, hasTurnaroundOn, countTurnaroundsInMonth };
}
