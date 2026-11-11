// ── booking.js ────────────────────────────────────────────────
// Booking engine logic for book.html.
// Depends on: js/shared.js (loaded first via <script> tag)

let blockedDates = new Set(); // nights that are already taken (YYYY-MM-DD)
let property     = {};

// Calendar state
const sel = { in: '', out: '' };   // selected check-in / check-out (YYYY-MM-DD)
let previewOut = '';               // check-out being hovered while choosing
let viewYear   = new Date().getFullYear();
let viewMonth  = new Date().getMonth();
const MAX_MONTHS_AHEAD = 18;

const $ = id => document.getElementById(id);
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = d => `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const minNights = () => property.min_nights || 1;

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const [propRes, availRes] = await Promise.all([
      fetch('/api/property').then(r => r.json()),
      fetch('/api/availability').then(r => r.json()),
    ]);
    property     = propRes;
    blockedDates = new Set(availRes.blocked || []);

    // Property info
    $('prop-name').textContent  = property.name;
    $('hero-title').textContent = property.name;
    $('prop-desc').textContent  = property.description;
    document.title = 'Book — ' + property.name;
    if (property.location) $('hero-location').textContent = property.location;

    if (property.photo_url) {
      const img = document.createElement('img');
      img.src = property.photo_url;
      img.alt = property.name;
      // Keep the illustrated hero if the photo fails to load
      img.onload = () => { $('hero-placeholder').style.display = 'none'; };
      img.onerror = () => img.remove();
      $('hero').insertBefore(img, $('hero').firstChild.nextSibling);
    }

    const facts = [];
    if (property.max_guests)   facts.push(`Sleeps <b>${property.max_guests}</b>`);
    if (minNights() > 1)       facts.push(`<b>${minNights()}-night</b> minimum`);
    if (property.nightly_rate > 0) {
      facts.push(`From <b>${fmtCurrency(property.nightly_rate)}</b> a night`);
      $('rate-display').style.display = 'block';
      $('rate-display').innerHTML = `${fmtCurrency(property.nightly_rate)} <span>/ night</span>`;
    }
    $('facts').innerHTML = facts.map(f => `<li>${f}</li>`).join('');

    setGuests(Math.min(2, property.max_guests || 10));
  } catch(e) {
    console.error('Init failed:', e);
    $('prop-name').textContent = 'Book direct';
    $('prop-desc').textContent = 'We couldn’t load this property right now. Please refresh the page to try again.';
  }
  renderMonths();
  updateState();
}

// ── Currency formatting ───────────────────────────────────────

function fmtCurrency(amount) {
  if (!amount) return '';
  const sym = property.currency === 'ZAR' ? 'R' : (property.currency || '') + ' ';
  return sym + amount.toLocaleString('en-ZA', { minimumFractionDigits: 0 });
}

// ── Guests ────────────────────────────────────────────────────

function setGuests(n) {
  const max = property.max_guests || 10;
  n = Math.max(1, Math.min(max, n));
  $('guests').value = n;
  $('guests-out').textContent = plural(n, 'guest');
  $('guests-minus').disabled = n <= 1;
  $('guests-plus').disabled  = n >= max;
}
$('guests-minus').onclick = () => setGuests(+$('guests').value - 1);
$('guests-plus').onclick  = () => setGuests(+$('guests').value + 1);

// ── Availability ──────────────────────────────────────────────

function isDateBlocked(dateStr) {
  return blockedDates.has(dateStr);
}

function datesInRange(checkin, checkout) {
  const dates = [];
  let d = parseYmd(checkin);
  const end = parseYmd(checkout);
  while (d < end) {
    dates.push(localYmd(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Latest possible check-out for a given check-in: the first taken night
// after it. Guests may leave on the morning the next guest arrives.
function latestCheckout(checkin) {
  const d = parseYmd(checkin);
  for (let i = 0; i < 366; i++) {
    d.setDate(d.getDate() + 1);
    if (isDateBlocked(localYmd(d))) break;
  }
  return localYmd(d);
}

// What clicking a day would do right now
//   past | blocked | short (under the minimum stay) | in (sets check-in) | out (sets check-out)
function dayRole(ds) {
  if (ds < localYmd(new Date())) return 'past';
  const choosingOut = sel.in && !sel.out;
  if (choosingOut && ds > sel.in && ds <= latestCheckout(sel.in)) {
    const nights = nightsBetween(parseYmd(sel.in), parseYmd(ds));
    return nights >= minNights() ? 'out' : 'short';
  }
  return isDateBlocked(ds) ? 'blocked' : 'in';
}

// ── Calendar rendering ────────────────────────────────────────

function monthHtml(year, month) {
  const first = new Date(year, month, 1);
  const days  = new Date(year, month + 1, 0).getDate();
  const lead  = (first.getDay() + 6) % 7; // Monday first
  const todayStr = localYmd(new Date());

  let cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<div class="dow">${d}</div>`).join('');
  cells += '<div></div>'.repeat(lead);
  for (let d = 1; d <= days; d++) {
    const ds = localYmd(new Date(year, month, d));
    cells += `<button type="button" class="day${ds === todayStr ? ' is-today' : ''}" data-date="${ds}">${d}</button>`;
  }
  return `<div class="month">
    <div class="month-title">${MONTHS[month]} ${year}</div>
    <div class="month-grid">${cells}</div>
  </div>`;
}

function renderMonths() {
  const next = new Date(viewYear, viewMonth + 1, 1);
  $('months').innerHTML = monthHtml(viewYear, viewMonth) + monthHtml(next.getFullYear(), next.getMonth());

  const now = new Date();
  const ahead = (viewYear - now.getFullYear()) * 12 + viewMonth - now.getMonth();
  $('cal-prev').disabled = ahead <= 0;
  $('cal-next').disabled = ahead >= MAX_MONTHS_AHEAD;
  paintDays();
}

// Apply availability and selection state to the rendered day buttons
function paintDays() {
  const out = sel.out || previewOut;
  document.querySelectorAll('#months .day').forEach(btn => {
    const ds   = btn.dataset.date;
    const role = dayRole(ds);
    const date = parseYmd(ds);
    btn.disabled = role === 'past' || role === 'blocked' || role === 'short';
    btn.classList.toggle('is-blocked', role === 'blocked');
    btn.classList.toggle('is-short',   role === 'short');
    btn.classList.toggle('is-in',      ds === sel.in);
    btn.classList.toggle('has-out',    ds === sel.in && !!out);
    btn.classList.toggle('is-out',     !!out && ds === out);
    btn.classList.toggle('in-range',   !!sel.in && !!out && ds > sel.in && ds < out);
    btn.title = role === 'short' ? `${minNights()}-night minimum` : '';
    btn.setAttribute('aria-label', `${fmtDay(date)} ${date.getFullYear()}` + (
      ds === sel.in ? ', check-in' : ds === sel.out ? ', check-out'
      : role === 'blocked' ? ', unavailable'
      : role === 'short'   ? `, below the ${minNights()}-night minimum`
      : role === 'out'     ? ', choose as check-out' : ''));
  });
}

function shiftMonth(dir) {
  const d = new Date(viewYear, viewMonth + dir, 1);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderMonths();
}
$('cal-prev').onclick = () => shiftMonth(-1);
$('cal-next').onclick = () => shiftMonth(1);

$('months').addEventListener('click', e => {
  const btn = e.target.closest('.day');
  if (!btn || btn.disabled) return;
  const ds = btn.dataset.date;
  if (dayRole(ds) === 'out') {
    sel.out = ds;
  } else {
    sel.in = ds; sel.out = '';
  }
  previewOut = '';
  onDatesChange();
  // Re-rendering state must not drop keyboard focus
  const again = document.querySelector(`#months .day[data-date="${ds}"]`);
  if (again) again.focus({ preventScroll: true });
});

// Arrow keys move between selectable days, turning the page when needed
$('months').addEventListener('keydown', e => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  const btn  = e.target.closest('.day');
  if (!step || !btn) return;
  e.preventDefault();
  const d = parseYmd(btn.dataset.date);
  for (let i = 0; i < 62; i++) {
    d.setDate(d.getDate() + step);
    const find = () => document.querySelector(`#months .day[data-date="${localYmd(d)}"]`);
    let target = find();
    // Not rendered, or in the second month that is hidden on small screens
    if (!target || target.offsetParent === null) {
      const nav = $(step > 0 ? 'cal-next' : 'cal-prev');
      if (nav.disabled) return;
      shiftMonth(step > 0 ? 1 : -1);
      target = find();
      if (!target) return;
    }
    if (!target.disabled) { target.focus(); return; }
  }
});

// Preview the range while choosing a check-out
function setPreview(ds) {
  const next = ds && dayRole(ds) === 'out' ? ds : '';
  if (next !== previewOut) { previewOut = next; paintDays(); }
}
$('months').addEventListener('mouseover', e => {
  const btn = e.target.closest('.day');
  setPreview(btn ? btn.dataset.date : '');
});
$('months').addEventListener('mouseleave', () => setPreview(''));
$('months').addEventListener('focusin', e => {
  const btn = e.target.closest('.day');
  setPreview(btn ? btn.dataset.date : '');
});

$('clear-dates').onclick = () => {
  sel.in = sel.out = previewOut = '';
  onDatesChange();
};

// ── State → UI ────────────────────────────────────────────────

function onDatesChange() {
  $('checkin').value  = sel.in;
  $('checkout').value = sel.out;
  paintDays();
  updateState();
}

// True when the selected stay is complete and bookable
function checkAvailability() {
  const { in: checkin, out: checkout } = sel;
  if (!checkin || !checkout || checkout <= checkin) return false;
  const nights = nightsBetween(parseYmd(checkin), parseYmd(checkout));
  if (nights < minNights()) return false;
  return !datesInRange(checkin, checkout).some(isDateBlocked);
}

function updateState() {
  const msg  = $('avail-msg');
  const form = $('guest-form');
  const ok   = checkAvailability();

  $('sum-in').textContent  = sel.in  ? fmtDay(parseYmd(sel.in))  : 'Add date';
  $('sum-out').textContent = sel.out ? fmtDay(parseYmd(sel.out)) : 'Add date';
  $('sum-in').classList.toggle('empty', !sel.in);
  $('sum-out').classList.toggle('empty', !sel.out);
  $('clear-dates').hidden = !sel.in;

  if (ok) {
    const nights = nightsBetween(parseYmd(sel.in), parseYmd(sel.out));
    msg.className   = 'avail-msg available';
    msg.textContent = `✓ Available — ${fmtDay(parseYmd(sel.in))} to ${fmtDay(parseYmd(sel.out))}, ${plural(nights, 'night')}`;
  } else if (sel.in && sel.out) {
    msg.className   = 'avail-msg unavailable';
    msg.textContent = 'Sorry, these dates are not available. Please choose different dates.';
  } else if (sel.in) {
    msg.className   = 'avail-msg';
    msg.textContent = 'Now select your check-out date'
      + (minNights() > 1 ? ` — ${minNights()}-night minimum.` : '.');
  } else {
    msg.className   = 'avail-msg';
    msg.textContent = 'Select your check-in date.';
  }

  form.classList.toggle('locked', !ok);
  form.inert = !ok;
  updateSummary();
}

// ── Pricing summary ───────────────────────────────────────────

function stayTotal() {
  if (!sel.in || !sel.out) return null;
  const nights = nightsBetween(parseYmd(sel.in), parseYmd(sel.out));
  return { nights, total: property.nightly_rate > 0 ? property.nightly_rate * nights : null };
}

function updateSummary() {
  const lines = $('summary-lines');
  const empty = $('summary-empty');
  const stay  = stayTotal();

  if (!stay || stay.nights <= 0) {
    lines.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  if (stay.total !== null) {
    $('sl-nights').textContent = `${fmtCurrency(property.nightly_rate)} × ${plural(stay.nights, 'night')}`;
    $('sl-rate').textContent   = fmtCurrency(stay.total);
    $('sl-total').textContent  = fmtCurrency(stay.total);
  } else {
    $('sl-nights').textContent = plural(stay.nights, 'night');
    $('sl-rate').textContent   = '';
    $('sl-total').textContent  = 'Contact for pricing';
  }
  lines.style.display = 'flex';
}

// ── Form submission ───────────────────────────────────────────

function showFormError(text, field) {
  const errEl = $('form-error');
  errEl.textContent = text;
  errEl.className   = 'error-msg show';
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

['g-name', 'g-email'].forEach(id =>
  $(id).addEventListener('input', e => e.target.removeAttribute('aria-invalid')));

async function submitBooking() {
  const btn = $('submit-btn');
  $('form-error').className = 'error-msg';

  const name     = $('g-name').value.trim();
  const email    = $('g-email').value.trim();
  const phone    = $('g-phone').value.trim();
  const message  = $('g-message').value.trim();
  const checkin  = $('checkin').value;
  const checkout = $('checkout').value;
  const guests   = $('guests').value;

  if (!name)  return showFormError('Please enter your name.', $('g-name'));
  if (!email) return showFormError('Please enter your email address.', $('g-email'));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showFormError('Please enter a valid email address.', $('g-email'));
  }

  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    const res  = await fetch('/api/book', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, phone, guests, checkin, checkout, message }),
    });
    const data = await res.json();
    if (res.status === 409) {
      // Someone else took these nights while this page was open
      await datesJustTaken(data.error);
      btn.disabled    = false;
      btn.textContent = 'Request booking';
      return;
    }
    if (!res.ok || !data.success) throw new Error(data.error || 'Booking failed');

    // Show success screen
    const stay = stayTotal();
    $('page').style.display           = 'none';
    $('success-screen').style.display = 'block';
    $('conf-email').textContent       = email;
    $('conf-ref').textContent         = 'Reference: ' + data.booking.uid;
    $('conf-stay').innerHTML = `
      <div><dt>Check-in</dt><dd>${fmtDay(parseYmd(checkin))}</dd></div>
      <div><dt>Check-out</dt><dd>${fmtDay(parseYmd(checkout))}</dd></div>
      <div><dt>Stay</dt><dd>${plural(stay.nights, 'night')} · ${plural(+guests, 'guest')}</dd></div>`;
    $('success-screen').scrollIntoView({ block: 'start' });
  } catch(e) {
    showFormError(e.message || 'Something went wrong. Please try again.');
    btn.disabled    = false;
    btn.textContent = 'Request booking';
  }
}

// Reload availability, clear the selection and send the guest back to the
// calendar. Their details stay in the form for the next attempt.
async function datesJustTaken(message) {
  try {
    const avail = await fetch('/api/availability').then(r => r.json());
    blockedDates = new Set(avail.blocked || []);
  } catch(e) {}
  sel.in = sel.out = previewOut = '';
  onDatesChange();
  $('avail-msg').className   = 'avail-msg unavailable';
  $('avail-msg').textContent = message || 'Sorry, those dates have just been taken. Please choose different dates.';
  $('dates-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Start ─────────────────────────────────────────────────────
init();
