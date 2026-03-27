// ── dashboard.js ──────────────────────────────────────────────
// Dashboard logic for index.html.
// Depends on: js/shared.js (loaded first via <script> tag)

let allBookings   = [];
let currentFilter = 'all';
let currentView   = 'upcoming';
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();

// ── Auto-refresh ──────────────────────────────────────────────
let pollInterval    = null;   // setInterval handle
let pollMs          = 0;      // 0 = disabled
let lastLoadedAt    = null;   // Date of last successful fetch
let stalenessTimer  = null;   // setInterval for "X min ago" display

// ── Data loading ──────────────────────────────────────────────

async function loadAll(force = false) {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  document.getElementById('bookings-area').innerHTML =
    '<div class="loading"><div class="spinner"></div>Fetching calendars…</div>';
  document.getElementById('error-area').innerHTML = '';

  try {
    const url = force ? '/calendars?force=1' : '/calendars';
    const res = await fetch(`${window.location.origin}${url}`);
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const results = await res.json();
    allBookings = [];
    const warnings = [];

    // localStorage tracking to detect silently empty responses
    let prevCounts = {};
    try { prevCounts = JSON.parse(localStorage.getItem('stayview_counts') || '{}'); } catch(e) {}
    const newCounts = {};

    for (const r of results) {
      if (!r.success) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: ${r.error || 'fetch failed'}`);
        continue;
      }
      if (!r.data || !r.data.includes('BEGIN:VCALENDAR')) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: response was not a valid iCal feed`);
        continue;
      }
      const parsed = parseIcal(r.data, r.name);
      newCounts[r.name] = parsed.length;
      if (parsed.length === 0 && prevCounts[r.name] > 0) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: previously had ${prevCounts[r.name]} booking(s) but now returns empty — possible broken sync or expired iCal URL`);
      } else if (parsed.length === 0 && !r.data.includes('BEGIN:VEVENT')) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: calendar connected but contains no events`);
      }
      allBookings.push(...parsed);
    }

    // Save non-zero counts for next comparison
    const updatedCounts = { ...prevCounts };
    for (const [name, count] of Object.entries(newCounts)) {
      if (count > 0) updatedCounts[name] = count;
    }
    try { localStorage.setItem('stayview_counts', JSON.stringify(updatedCounts)); } catch(e) {}

    // Direct bookings fetch — enabled when booking engine is released
    // try {
    //   const directRes  = await fetch('/api/bookings');
    //   const directData = await directRes.json();
    //   directData.forEach(b => { allBookings.push({ ...b }); });
    // } catch(e) { console.warn('Could not load direct bookings:', e); }

    allBookings.sort((a, b) => a.start - b.start);

    if (warnings.length) {
      document.getElementById('error-area').innerHTML =
        `<div class="error-box">⚠️ Some calendars had issues:<br><br>${warnings.join('<br>')}</div>`;
    }
    lastLoadedAt = new Date();
    // Sync with server's actual fetch time if available
    try {
      const tsRes = await fetch('/last-updated');
      const tsData = await tsRes.json();
      if (tsData.lastFetchedAt) lastLoadedAt = new Date(tsData.lastFetchedAt);
    } catch(e) {}
    updateLastUpdatedLabel();
    startStalenessTimer();
    updateStats();
    renderBookings();
    renderCalendar();
  } catch(e) {
    document.getElementById('bookings-area').innerHTML = '';
    document.getElementById('error-area').innerHTML = `
      <div class="error-box">
        <strong>Cannot connect to server.</strong><br><br>
        Make sure the server is running on your Raspberry Pi:<br><br>
        <code>node server.js</code><br><br>
        Then refresh this page.
      </div>`;
  }
  btn.disabled = false;
  btn.textContent = '↻ Refresh';
}

// ── Stats ─────────────────────────────────────────────────────

function updateStats() {
  const now  = today();
  const in30 = new Date(now);
  in30.setDate(in30.getDate() + 30);

  const real    = allBookings.filter(b => !b.isBlocked);
  const active  = real.filter(b => ['checking-in', 'active', 'checking-out'].includes(getStatus(b))).length;
  const up30    = real.filter(b => b.start >= now && b.start < in30).length;

  let bookedNights = 0;
  for (let d = new Date(now); d < in30; d.setDate(d.getDate() + 1)) {
    if (real.some(b => b.start <= d && b.end > d)) bookedNights++;
  }
  const occ = Math.round((bookedNights / 30) * 100);

  document.getElementById('s-total').textContent   = real.length;
  document.getElementById('s-active').textContent  = active;
  document.getElementById('s-upcoming').textContent = up30;
  document.getElementById('s-occ').textContent     = occ + '%';
  document.getElementById('s-occ-sub').textContent = bookedNights + ' of 30 nights';

  setTimeout(() => {
    document.getElementById('occ-fill').style.width = occ + '%';
    document.getElementById('occ-text').textContent =
      bookedNights + ' of 30 nights booked (' + occ + '%)';
  }, 100);
}

// ── Filters & view ────────────────────────────────────────────

function setFilter(f, el) {
  currentFilter = f;
  document.querySelectorAll('#src-filters .filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderBookings();
}

function setView(v, el) {
  currentView = v;
  document.querySelectorAll('.view-group .filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderBookings();
}

// ── Bookings list ─────────────────────────────────────────────

function renderBookings() {
  const now = today();
  const filtered = allBookings.filter(b => {
    if (currentFilter !== 'all' && b.source !== currentFilter) return false;
    if (currentView === 'upcoming') return b.end >= now;
    return true;
  });

  const area = document.getElementById('bookings-area');
  if (!filtered.length) {
    area.innerHTML = '<div class="empty">No bookings for selected filters.</div>';
    return;
  }

  let html = '<div class="bookings-list">';
  let lastStatus = null;

  for (const b of filtered) {
    const status   = getStatus(b);
    const isDirect = false; // b.source === 'direct' — enabled when booking engine is released

    if (currentView === 'upcoming' && status !== lastStatus) {
      if (status === 'checking-in')  html += '<div class="section-label">Checking In Today</div>';
      if (status === 'checking-out') html += '<div class="section-label">Checking Out Today</div>';
      if (status === 'active')       html += '<div class="section-label">Currently Staying</div>';
      if (status === 'upcoming')     html += '<div class="section-label">Upcoming</div>';
      lastStatus = status;
    }

    const name     = b.isBlocked ? (b.summary || 'Blocked') : b.summary.split('(')[0].trim();
    const srcKey   = b.isBlocked ? 'blocked' : b.source;
    const srcLabel = b.isBlocked ? 'Blocked' : (SOURCE_LABELS[b.source] || b.source);
    const statusLabel = {
      'checking-in':  'Checking In',
      'active':       'Checked In',
      'checking-out': 'Checking Out',
      'upcoming':     'Upcoming',
      'past':         'Past',
    }[status] || status;

    // Extra details for Lekkeslaap bookings
    const d = b.details;
    const extraDetails = (d && !b.isBlocked) ? `
      <div class="booking-extra">
        ${d.reference ? `<span class="booking-ref">${escHtml(d.reference)}</span>` : ''}
        ${d.email     ? `<a href="mailto:${escHtml(d.email)}" class="booking-detail-link">${escHtml(d.email)}</a>` : ''}
        ${d.cell      ? `<a href="tel:${escHtml(d.cell)}" class="booking-detail-link">${escHtml(d.cell)}</a>` : ''}
        ${d.viewUrl   ? `<a href="${escHtml(d.viewUrl)}" target="_blank" rel="noopener" class="booking-detail-link booking-view-link">View on Lekkeslaap ↗</a>` : ''}
      </div>` : '';

    html += `
      <div class="booking-card src-${srcKey}">
        <div>
          <div class="guest-name">${escHtml(name)}</div>
          <div class="booking-dates">${fmtShort(b.start)} → ${fmtShort(b.end)}</div>
          <div class="badge-row">
            <span class="badge badge-${srcKey}">${srcLabel}</span>
            <span class="badge badge-${status}">${statusLabel}</span>
          </div>
          ${extraDetails}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div style="text-align:right">
            <div class="nights-num">${b.nights}</div>
            <div class="nights-lbl">nights</div>
          </div>
          ${isDirect ? `<button class="delete-btn" onclick="openDeleteModal('${escHtml(b.uid)}','${escHtml(name)}','${fmtShort(b.start)}','${fmtShort(b.end)}')" title="Delete booking">✕</button>` : ''}
        </div>
      </div>`;
  }
  html += '</div>';
  area.innerHTML = html;
}

// ── Calendar ──────────────────────────────────────────────────

function renderCalendar() {
  document.getElementById('cal-title').textContent = MONTHS[calMonth] + ' ' + calYear;
  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay  = new Date(calYear, calMonth + 1, 0);
  let dow = firstDay.getDay();
  dow = dow === 0 ? 6 : dow - 1; // Mon = 0

  const grid = document.getElementById('cal-grid');
  while (grid.children.length > 7) grid.removeChild(grid.lastChild);

  const now = today();
  for (let i = 0; i < dow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day other';
    grid.appendChild(el);
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date = new Date(calYear, calMonth, d);
    const el   = document.createElement('div');
    el.className  = 'cal-day';
    el.textContent = d;
    if (date.getTime() === now.getTime()) el.classList.add('today');
    const matching = allBookings.filter(b => b.start <= date && b.end > date);
    if (matching.length > 0) {
      const srcs = [...new Set(matching.map(b => b.isBlocked ? 'blocked' : b.source))];
      el.classList.add(srcs.length === 1 ? 'src-' + srcs[0] : 'multi');
      el.title = matching.map(b => b.summary).join(', ');
    }
    grid.appendChild(el);
  }
}

function changeMonth(dir) {
  calMonth += dir;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  if (calMonth < 0)  { calMonth = 11; calYear--; }
  renderCalendar();
}

// ── Delete booking — enabled when booking engine is released ──
// let pendingDeleteUid = null;
// function openDeleteModal(uid, name, checkin, checkout) { ... }
// function closeDeleteModal() { ... }
// async function confirmDelete() { ... }

// ── Demo mode ─────────────────────────────────────────────────

function makeDemoBookings() {
  const base = today();
  const d = offset => { const x = new Date(base); x.setDate(x.getDate() + offset); return x; };
  let uid = 1;
  const b = (source, name, startOff, nights, isBlocked = false, details = null) => ({
    uid: 'demo-' + uid++, source, summary: name,
    start: d(startOff), end: d(startOff + nights),
    nights, isBlocked, details,
  });
  const ls = (ref, name, email, cell) => ({
    reference: ref, name, email, cell,
    viewUrl: `https://www.lekkeslaap.co.za/suppliers/bookings/quotation/${ref}`,
  });
  return [
    b('lekkeslaap',  'Mia Pretorius',                   -3, 4, false, ls('LS-DEMO05', 'Mia Pretorius',     'mia@example.co.za',    '+27845556666')), // checking out today (day 4 of 4)
    b('airbnb',      'Airbnb Guest',                    -2, 5),        // checked in (mid-stay)
    b('lekkeslaap',  'Pieter van Wyk',                   0, 3, false, ls('LS-DEMO01', 'Pieter van Wyk',    'pieter@example.co.za', '+27821234567')), // checking in today
    b('booking',     'Booking.com Guest',                2, 2),
    b('airbnb',      'Airbnb Guest',                     5, 5),
    b('lekkeslaap',  'Anri Botha',                       9, 7, false, ls('LS-DEMO02', 'Anri Botha',        'anri@example.co.za',   '+27839876543')),
    b('booking',     'Booking.com Guest',               14, 3),
    b('airbnb',      'Airbnb Guest',                    20, 4),
    b('lekkeslaap',  'Kobus Joubert',                   24, 2, false, ls('LS-DEMO03', 'Kobus Joubert',     'kobus@example.co.za',  '+27711112222')),
    b('booking',     'Booking.com Guest',               27, 6),
    b('airbnb',      'Airbnb Guest',                    33, 3),
    b('lekkeslaap',  'Sarel du Plessis',                38, 5, false, ls('LS-DEMO04', 'Sarel du Plessis',  'sarel@example.co.za',  '+27723334444')),
    b('booking',     'Booking.com Guest',               44, 4),
    b('airbnb',      'Airbnb Guest',                    50, 3),
    b('airbnb',      null,  6, 2, true),
    b('lekkeslaap',  null, 18, 1, true),
  ].sort((a, b) => a.start - b.start);
}

let currentMode = 'live';

function setMode(mode) {
  currentMode = mode;
  document.getElementById('btn-live').classList.toggle('active', mode === 'live');
  document.getElementById('btn-demo').classList.toggle('active', mode === 'demo');
  const demoTag = document.getElementById('demo-tag');
  if (mode === 'demo') {
    if (!demoTag) {
      const tag = document.createElement('span');
      tag.id        = 'demo-tag';
      tag.className = 'demo-badge';
      tag.textContent = '⬡ Demo mode';
      document.querySelector('.logo').appendChild(tag);
    }
    stopPolling();
    allBookings = makeDemoBookings();
    document.getElementById('error-area').innerHTML = '';
    document.getElementById('last-updated').textContent = 'Demo data';
    updateStats();
    renderBookings();
    renderCalendar();
  } else {
    if (demoTag) demoTag.remove();
    loadAll();
  }
}

// ── Auto-refresh & staleness ─────────────────────────────────

function updateLastUpdatedLabel() {
  if (!lastLoadedAt) return;
  const el = document.getElementById('last-updated');
  const mins = Math.floor((Date.now() - lastLoadedAt) / 60000);
  if (mins < 1)       el.textContent = 'Updated just now';
  else if (mins < 60) el.textContent = `Updated ${mins} min${mins > 1 ? 's' : ''} ago`;
  else {
    const hrs = Math.floor(mins / 60);
    el.textContent = `Updated ${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  }
  // Pulse the label amber when stale (older than half the poll interval)
  const staleThresholdMs = pollMs > 0 ? pollMs / 2 : 30 * 60 * 1000;
  const isStale = (Date.now() - lastLoadedAt) > staleThresholdMs;
  el.classList.toggle('stale', isStale);
}

function startStalenessTimer() {
  if (stalenessTimer) clearInterval(stalenessTimer);
  stalenessTimer = setInterval(updateLastUpdatedLabel, 30000); // update label every 30s
}

function startPolling(intervalMs) {
  if (pollInterval) clearInterval(pollInterval);
  pollMs = intervalMs;
  if (intervalMs <= 0) return;
  pollInterval = setInterval(() => {
    if (currentMode === 'live') {
      console.log('[StayView] Auto-refresh triggered');
      loadAll();
    }
  }, intervalMs);
  console.log(`[StayView] Auto-refresh enabled every ${Math.round(intervalMs / 60000)} minutes`);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (stalenessTimer) { clearInterval(stalenessTimer); stalenessTimer = null; }
}

// ── Init ──────────────────────────────────────────────────────

renderCalendar();

fetch('/config')
  .then(r => r.json())
  .then(cfg => {
    if (cfg.hasLiveData) setMode('live');
    else setMode('demo');
    // Start auto-refresh if configured (only in live mode)
    if (cfg.pollIntervalMs > 0 && cfg.hasLiveData) {
      startPolling(cfg.pollIntervalMs);
    }
  })
  .catch(() => setMode('demo'));

// ── Page Visibility — catch up when tab becomes active again ──
// Browsers throttle or pause setInterval in background tabs.
// When the user returns, check if data is stale and refresh immediately.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (currentMode !== 'live') return;
  if (!lastLoadedAt) return;
  const staleThresholdMs = pollMs > 0 ? pollMs : 2 * 60 * 60 * 1000;
  const ageMs = Date.now() - lastLoadedAt;
  if (ageMs >= staleThresholdMs) {
    console.log(`[StayView] Tab resumed — data is ${Math.round(ageMs / 60000)} mins old, refreshing now`);
    loadAll();
  }
});