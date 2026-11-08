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
// Returns a map of dates that need a turnaround/service reminder.
// Three cases:
//   1. Same-day swap — one booking ends, another starts same day
//   2. Checkout day — any booking ending (unit always needs cleaning)
//   3. Checkin after gap — a booking starts within GAP_DAYS of a
//      previous booking ending (unit may need refreshing)
const TURNAROUND_GAP_DAYS = 3;

function findTurnarounds(bookings) {
  // Returns a Map of dateStr -> { type: 'swap'|'checkout'|'checkin', propertyId }
  const turnarounds = new Map();
  const real = bookings.filter(bk => !bk.isBlocked);

  for (const a of real) {
    const aEndStr = localYmd(a.end);

    // Case 1 & 2: Every checkout day needs a turnaround
    if (!turnarounds.has(aEndStr)) {
      turnarounds.set(aEndStr, { type: 'checkout', propertyId: a.propertyId });
    }

    // Check if another booking starts on the same day (upgrade to swap)
    for (const bk of real) {
      if (a.uid === bk.uid) continue;
      if (a.propertyId !== bk.propertyId) continue;
      const bkStartStr = localYmd(bk.start);

      if (a.end.getTime() === bk.start.getTime()) {
        // Same-day swap — mark both checkout and checkin date (same date)
        turnarounds.set(aEndStr, { type: 'swap', propertyId: a.propertyId });
      } else {
        // Case 3: Checkin within GAP_DAYS of a previous checkout
        // Round so a gap spanning a DST change still counts as whole days
        const gapDays = nightsBetween(a.end, bk.start);
        if (gapDays > 0 && gapDays <= TURNAROUND_GAP_DAYS) {
          if (!turnarounds.has(bkStartStr)) {
            turnarounds.set(bkStartStr, { type: 'checkin', propertyId: bk.propertyId });
          }
        }
      }
    }
  }
  return turnarounds;
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

// ── Turnaround detection ──────────────────────────────────────
// A turnaround occurs when one booking ends on the same day
// another begins. Returns a Set of date strings that are
// turnaround days, and a Map of checkout->checkin booking pairs.
// ── Node export ───────────────────────────────────────────────
// Lets server.js reuse the iCal parser. No-op in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseIcal, parseDate, localYmd, parseYmd, isValidYmd, nightsBetween, fmtFull, SOURCE_LABELS };
}
