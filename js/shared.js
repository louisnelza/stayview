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
  if (b.start <= now && b.end > now) return 'active';
  if (b.start > now) return 'upcoming';
  return 'past';
}

// ── iCal parsing ──────────────────────────────────────────────

function unescapeIcal(s) {
  return s
    .replace(/\\n/g, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function extractGuestName(summary, description, source) {
  // Lekkeslaap embeds "Customer: Name" in the summary/description
  const customerMatch = (summary + ' ' + description).match(/Customer:\s*([^\\\n,]+)/i);
  if (customerMatch) return customerMatch[1].trim();
  // Booking.com anonymises all guests
  if (source === 'booking') return 'Booking.com Guest';
  // Airbnb anonymises guests as "Reserved"
  if (source === 'airbnb' && /^reserved$/i.test(summary.trim())) return 'Airbnb Guest';
  // General: strip confirmation codes in parentheses
  return summary.split('(')[0].replace(/\\n.*/s, '').trim() || 'Guest';
}

function parseIcal(text, source) {
  const bookings = [];
  const events = text.split('BEGIN:VEVENT');
  events.shift();
  for (const ev of events) {
    const get = k => {
      const m = ev.match(new RegExp(k + '[^:]*:([^\r\n]+)'));
      return m ? m[1].trim() : '';
    };
    const dtstart = get('DTSTART');
    const dtend   = get('DTEND');
    const uid     = get('UID');
    const rawSummary  = unescapeIcal(get('SUMMARY') || 'Guest');
    const description = unescapeIcal(get('DESCRIPTION'));
    if (!dtstart || !dtend) continue;
    const start = parseDate(dtstart);
    const end   = parseDate(dtend);
    if (isNaN(start) || isNaN(end)) continue;
    const nights = nightsBetween(start, end);
    // Booking.com: never blocked (uses "CLOSED - Not available" for real bookings too)
    // Airbnb: "Airbnb (Not available)" = blocked, "Reserved" = real booking
    // Others: standard blocked keywords
    const isBlocked = source === 'booking'
      ? false
      : source === 'airbnb'
        ? /not available/i.test(rawSummary)
        : /block|not available|unavailable|closed/i.test(rawSummary);
    const summary = isBlocked
      ? rawSummary
      : extractGuestName(rawSummary, description, source);
    bookings.push({ uid, source, summary, start, end, nights, isBlocked });
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
