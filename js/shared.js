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
  slaapstad:  'Slaapstad',
  direct:     'Direct',
  blocked:    'Blocked',
};

// ── Date helpers ──────────────────────────────────────────────

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDate(s) {
  const c = s.replace(/T.*/, '');
  if (c.length === 8) return new Date(+c.slice(0,4), +c.slice(4,6)-1, +c.slice(6,8));
  return new Date(s);
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
  if (b.start > now) return 'upcoming';
  if (b.end <= now)  return 'past';
  // Guest is currently in-stay — determine which day
  const checkoutDay = new Date(b.end);
  checkoutDay.setHours(0, 0, 0, 0);
  if (now.getTime() === b.start.getTime())    return 'checking-in';
  if (now.getTime() === checkoutDay.getTime()) return 'checking-out';
  return 'active';
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
    if (source === 'lekkeslaap' && !isBlocked) {
      details = parseLekkeslaapSummary(rawSummary);
    }

    const summary = isBlocked
      ? (rawSummary || description || 'Blocked')
      : extractGuestName(rawSummary, description, source);

    bookings.push({ uid, source, summary, start, end, nights, isBlocked, details, propertyId });
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