// ── booking.js ────────────────────────────────────────────────
// Booking engine logic for book.html.
// Depends on: js/shared.js (loaded first via <script> tag)

let blockedDates = [];
let property     = {};

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const [propRes, availRes] = await Promise.all([
      fetch('/api/property').then(r => r.json()),
      fetch('/api/availability').then(r => r.json()),
    ]);
    property     = propRes;
    blockedDates = availRes.blocked || [];

    // Property info
    document.getElementById('prop-name').textContent  = property.name;
    document.getElementById('hero-title').textContent = property.name;
    document.getElementById('prop-desc').textContent  = property.description;
    document.title = 'Book — ' + property.name;

    if (property.location) {
      document.getElementById('prop-location').style.display = 'flex';
      document.getElementById('prop-location-text').textContent = property.location;
      document.getElementById('hero-location').textContent     = property.location;
    }

    if (property.photo_url) {
      const img = document.createElement('img');
      img.src = property.photo_url;
      img.alt = property.name;
      const hero = document.getElementById('hero');
      hero.insertBefore(img, hero.firstChild);
      document.getElementById('hero-placeholder').style.display = 'none';
    }

    if (property.nightly_rate > 0) {
      const rateEl = document.getElementById('rate-display');
      rateEl.style.display = 'block';
      rateEl.innerHTML = `${fmtCurrency(property.nightly_rate)} <span>/ night</span>`;
    }

    // Date constraints
    const todayStr = new Date().toISOString().slice(0, 10);
    document.getElementById('checkin').min  = todayStr;
    document.getElementById('checkout').min = todayStr;

    // Guest count options
    const guestSel = document.getElementById('guests');
    guestSel.innerHTML = '';
    for (let i = 1; i <= (property.max_guests || 10); i++) {
      guestSel.innerHTML += `<option value="${i}">${i} guest${i > 1 ? 's' : ''}</option>`;
    }
  } catch(e) {
    console.error('Init failed:', e);
  }
}

// ── Currency formatting ───────────────────────────────────────

function fmtCurrency(amount) {
  if (!amount) return '';
  const sym = property.currency === 'ZAR' ? 'R' : (property.currency || '') + ' ';
  return sym + amount.toLocaleString('en-ZA', { minimumFractionDigits: 0 });
}

// ── Availability ──────────────────────────────────────────────

function isDateBlocked(dateStr) {
  return blockedDates.includes(dateStr);
}

function datesInRange(checkin, checkout) {
  const dates = [];
  let d = new Date(checkin + 'T00:00:00');
  const end = new Date(checkout + 'T00:00:00');
  while (d < end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function onDatesChange() {
  const checkin  = document.getElementById('checkin').value;

  // Enforce min checkout = checkin + min_nights
  if (checkin) {
    const minCheckout = new Date(checkin + 'T00:00:00');
    minCheckout.setDate(minCheckout.getDate() + (property.min_nights || 1));
    const minStr = minCheckout.toISOString().slice(0, 10);
    document.getElementById('checkout').min = minStr;
    const checkout = document.getElementById('checkout').value;
    if (checkout && checkout <= checkin) {
      document.getElementById('checkout').value = minStr;
    }
  }

  updateSummary();
  checkAvailability();
}

function checkAvailability() {
  const checkin  = document.getElementById('checkin').value;
  const checkout = document.getElementById('checkout').value;
  const msg       = document.getElementById('avail-msg');
  const guestForm = document.getElementById('guest-form');
  const step2     = document.getElementById('step2');
  const step3     = document.getElementById('step3');

  if (!checkin || !checkout || checkout <= checkin) {
    msg.className = 'avail-msg';
    guestForm.style.display = 'none';
    step2.className = 'step';
    step3.className = 'step';
    return;
  }

  const nights = nightsBetween(
    new Date(checkin  + 'T00:00:00'),
    new Date(checkout + 'T00:00:00')
  );

  if (property.min_nights && nights < property.min_nights) {
    msg.className   = 'avail-msg unavailable';
    msg.textContent = `Minimum stay is ${property.min_nights} night${property.min_nights > 1 ? 's' : ''}.`;
    guestForm.style.display = 'none';
    return;
  }

  const conflicting = datesInRange(checkin, checkout).filter(isDateBlocked);
  if (conflicting.length > 0) {
    msg.className   = 'avail-msg unavailable';
    msg.textContent = 'Sorry, these dates are not available. Please choose different dates.';
    guestForm.style.display = 'none';
    step2.className = 'step';
    step3.className = 'step';
  } else {
    msg.className   = 'avail-msg available';
    msg.textContent = `✓ Available for ${nights} night${nights > 1 ? 's' : ''}! Fill in your details below.`;
    guestForm.style.display = 'block';
    step2.className = 'step done';
    step3.className = 'step active';
  }
}

// ── Pricing summary ───────────────────────────────────────────

function updateSummary() {
  const checkin  = document.getElementById('checkin').value;
  const checkout = document.getElementById('checkout').value;
  const lines    = document.getElementById('summary-lines');
  const empty    = document.getElementById('summary-empty');

  if (!checkin || !checkout || checkout <= checkin) {
    lines.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  const nights = nightsBetween(
    new Date(checkin  + 'T00:00:00'),
    new Date(checkout + 'T00:00:00')
  );
  empty.style.display = 'none';

  if (property.nightly_rate > 0) {
    const total = property.nightly_rate * nights;
    document.getElementById('sl-nights').textContent = `${nights} night${nights > 1 ? 's' : ''} × ${fmtCurrency(property.nightly_rate)}`;
    document.getElementById('sl-total').textContent  = fmtCurrency(total);
  } else {
    document.getElementById('sl-nights').textContent = `${nights} night${nights > 1 ? 's' : ''}`;
    document.getElementById('sl-total').textContent  = 'Contact for pricing';
  }
  lines.style.display = 'flex';
}

// ── Form submission ───────────────────────────────────────────

async function submitBooking() {
  const btn    = document.getElementById('submit-btn');
  const errEl  = document.getElementById('form-error');
  errEl.className = 'error-msg';

  const name     = document.getElementById('g-name').value.trim();
  const email    = document.getElementById('g-email').value.trim();
  const phone    = document.getElementById('g-phone').value.trim();
  const message  = document.getElementById('g-message').value.trim();
  const checkin  = document.getElementById('checkin').value;
  const checkout = document.getElementById('checkout').value;
  const guests   = document.getElementById('guests').value;

  if (!name || !email) {
    errEl.textContent = 'Please fill in your name and email address.';
    errEl.className   = 'error-msg show';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'Please enter a valid email address.';
    errEl.className   = 'error-msg show';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Sending…';
  document.getElementById('step3').className = 'step done';

  try {
    const res  = await fetch('/api/book', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, phone, guests, checkin, checkout, message }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Booking failed');

    // Show success screen
    document.querySelector('.page').style.display          = 'none';
    document.getElementById('success-screen').style.display = 'block';
    document.getElementById('conf-email').textContent      = email;
    document.getElementById('conf-ref').textContent        = 'Reference: ' + data.booking.uid;
  } catch(e) {
    errEl.textContent = e.message || 'Something went wrong. Please try again.';
    errEl.className   = 'error-msg show';
    btn.disabled      = false;
    btn.textContent   = 'Request Booking';
  }
}

// ── Start ─────────────────────────────────────────────────────
init();
