// ── dashboard.js ──────────────────────────────────────────────
// Dashboard logic for index.html.
// Depends on: js/shared.js (loaded first via <script> tag)

let allBookings   = [];
let currentFilter = 'all';
let currentView   = 'upcoming';
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();

// ── Multi-property state ──────────────────────────────────────
let properties       = [];   // array of { id, name, location } from /config
let currentProperty  = 'all'; // 'all' or property id (number)

// ── Turnaround state ──────────────────────────────────────────
let turnaroundDays   = new Map(); // Map of propertyId -> Map of dateStr -> { type, propertyId }

// ── Auto-refresh ──────────────────────────────────────────────
let pollInterval    = null;   // setInterval handle
let pollMs          = 0;      // 0 = disabled
let lastLoadedAt    = null;   // Date of last successful fetch
let stalenessTimer  = null;   // setInterval for "X min ago" display

// ── Data loading ──────────────────────────────────────────────

async function loadAll(force = false) {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('is-loading');
  document.getElementById('bookings-area').innerHTML =
    '<div class="bookings-list" aria-busy="true" aria-label="Fetching calendars"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
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
      // Stale cache — source failed but serving last known good data
      if (r.stale) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: using cached data — ${r.staleReason || 'platform temporarily unavailable'}`);
      }
      if (!r.success) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: ${r.error || 'fetch failed'}`);
        continue;
      }
      if (!r.data || !r.data.includes('BEGIN:VCALENDAR')) {
        warnings.push(`<strong>${SOURCE_LABELS[r.name] || r.name}</strong>: response was not a valid iCal feed`);
        continue;
      }
      const parsed = parseIcal(r.data, r.name, r.propertyId || 1);
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

    // Load direct bookings from server
    try {
      const directRes  = await fetch('/api/bookings');
      const directData = await directRes.json();
      directData.forEach(b => {
        allBookings.push({
          uid:       b.uid,
          source:    'direct',
          summary:   b.name,
          start:     parseYmd(b.checkin),
          end:       parseYmd(b.checkout),
          nights:    b.nights,
          isBlocked: false,
          details:   null,
          propertyId: b.propertyId || 1,
          status:    b.status,
          email:     b.email,
          phone:     b.phone,
        });
      });
    } catch(e) { console.warn('Could not load direct bookings:', e); }

    allBookings.sort((a, b) => a.start - b.start);
    turnaroundDays = findTurnarounds(allBookings);

    if (warnings.length) {
      document.getElementById('error-area').innerHTML =
        `<div class="error-box">${icon('alert')}<div class="error-title">Some calendars had issues</div><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>`;
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
    renderAll();
  } catch(e) {
    document.getElementById('bookings-area').innerHTML = '';
    document.getElementById('error-area').innerHTML = `
      <div class="error-box">
        ${icon('alert')}<div class="error-title">Cannot connect to server</div>
        <p>Make sure the server is running on your Raspberry Pi with <code>node server.js</code>, then refresh this page.</p>
      </div>`;
    document.getElementById('hero-brief').textContent = 'Calendars could not be loaded.';
  }
  btn.disabled = false;
  btn.classList.remove('is-loading');
}

// ── Small helpers ─────────────────────────────────────────────

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDay(d)     { return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; }
function plural(n, w)  { return `${n} ${w}${n === 1 ? '' : 's'}`; }

const ICONS = {
  alert:    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  mail:     '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  external: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  trash:    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  swap:     '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  clean:    '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/>',
  arrive:   '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; }

// Count a number up to its new value
function setNumber(el, to) {
  const from = Number(el.dataset.v);
  el.dataset.v = to;
  if (reducedMotion || from === to) { el.textContent = to; return; }
  const start = isFinite(from) ? from : 0;
  const t0 = performance.now();
  const step = t => {
    const p = Math.min(1, (t - t0) / 650);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (to - start) * eased);
    if (p < 1 && Number(el.dataset.v) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function visibleBookings() {
  return currentProperty === 'all'
    ? allBookings
    : allBookings.filter(b => b.propertyId === currentProperty);
}

function propertyName(id) {
  return (properties.find(p => p.id === id) || {}).name || null;
}

// ── Today ─────────────────────────────────────────────────────

function renderHeroDate() {
  const now = today();
  document.getElementById('hero-weekday').textContent =
    now.toLocaleDateString('en-ZA', { weekday: 'long' }) + ' · ' + now.getFullYear();
  document.getElementById('hero-date').innerHTML =
    `${now.getDate()} <em>${MONTHS[now.getMonth()]}</em>`;
}

// One plain-language sentence about what today holds
function renderBrief(real) {
  const now = today();
  const by  = s => real.filter(b => getStatus(b) === s);
  const arrivals = by('checking-in'), departures = by('checking-out'), staying = by('active');

  let html;
  if (arrivals.length || departures.length) {
    const parts = [];
    if (arrivals.length)   parts.push(`<strong>${plural(arrivals.length, 'arrival')}</strong>`);
    if (departures.length) parts.push(`<strong>${plural(departures.length, 'departure')}</strong>`);
    html = parts.join(' and ') + ' today';
    if (staying.length) html += `, with ${plural(staying.length, 'other stay')} in progress`;
    html += '.';
    const swap = arrivals.find(a => departures.some(d => d.propertyId === a.propertyId));
    if (swap) {
      const name = properties.length > 1 ? propertyName(swap.propertyId) : null;
      html += name
        ? ` Same-day turnaround at <strong>${escHtml(name)}</strong>.`
        : ' It’s a same-day turnaround.';
    }
  } else if (staying.length) {
    html = `No arrivals or departures today. <strong>${plural(staying.length, 'stay')}</strong> in progress.`;
  } else {
    const next = real.filter(b => b.start > now).sort((a, b) => a.start - b.start)[0];
    html = next
      ? `A quiet day. Next arrival is <strong>${escHtml(next.summary)}</strong> on ${fmtDay(next.start)}.`
      : 'A quiet day — nothing on the books yet.';
  }
  document.getElementById('hero-brief').innerHTML = html;
}

// ── Stats ─────────────────────────────────────────────────────

function updateStats() {
  const now  = today();
  const in30 = addDays(now, 30);

  const real    = visibleBookings().filter(b => !b.isBlocked);
  const active  = real.filter(b => ['checking-in', 'active', 'checking-out'].includes(getStatus(b))).length;
  const up30    = real.filter(b => b.start >= now && b.start < in30).length;

  let bookedNights = 0;
  let strip = '';
  for (let i = 0; i < 30; i++) {
    const d = addDays(now, i);
    const booked = real.some(b => b.start <= d && b.end > d);
    if (booked) bookedNights++;
    const we = d.getDay() === 5 || d.getDay() === 6; // Friday and Saturday nights
    strip += `<i class="night${booked ? ' on' : ''}${we ? ' we' : ''}" style="--i:${i}" data-tip="<b>${fmtDay(d)}</b>${booked ? 'Booked' : 'Free night'}"></i>`;
  }
  const occ = Math.round((bookedNights / 30) * 100);

  setNumber(document.getElementById('s-total'), real.length);
  setNumber(document.getElementById('s-active'), active);
  setNumber(document.getElementById('s-upcoming'), up30);
  setNumber(document.getElementById('s-occ'), occ);
  document.getElementById('s-occ-sub').textContent = bookedNights + ' of 30 nights booked';
  document.getElementById('night-strip').innerHTML = strip;
  document.getElementById('strip-end').textContent = fmtShort(addDays(now, 29));

  renderBrief(real);
}

// ── Property switcher ─────────────────────────────────────────

// Show only filter buttons and legend items for platforms that are configured.
// Elements are tagged with data-platform="airbnb" etc. in index.html.
function applyActivePlatforms(platforms) {
  if (!platforms || platforms.length === 0) return;
  // Direct bookings come from StayView itself, so they are always available
  const shown = [...platforms, 'direct'];
  document.querySelectorAll('#src-filters .filter-btn[data-platform], .legend-item[data-platform]').forEach(el => {
    el.style.display = shown.includes(el.dataset.platform) ? '' : 'none';
  });
}

function buildPropertySwitcher(props) {
  const container = document.getElementById('property-switcher');
  if (!container) return;
  if (props.length <= 1) { container.style.display = 'none'; return; }
  container.style.display = '';
  container.innerHTML = '';
  // All properties button
  const allBtn = document.createElement('button');
  allBtn.className = 'prop-btn active';
  allBtn.textContent = 'All properties';
  allBtn.onclick = () => setProperty('all', allBtn);
  container.appendChild(allBtn);
  // Individual property buttons
  props.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'prop-btn';
    btn.textContent = p.name;
    btn.dataset.propertyId = p.id;
    btn.onclick = () => setProperty(p.id, btn);
    container.appendChild(btn);
  });
}

function setProperty(id, el) {
  currentProperty = id;
  document.querySelectorAll('.prop-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  // Reset source filter to 'all' when switching property
  currentFilter = 'all';
  syncFilterButtons();
  renderAll();
}

function renderAll() {
  updateStats();
  renderTimeline();
  renderBookings();
  renderCalendar();
}

// ── Filters & view ────────────────────────────────────────────

function syncFilterButtons() {
  document.querySelectorAll('#src-filters .filter-btn').forEach(b =>
    b.classList.toggle('active', (b.dataset.platform || 'all') === currentFilter));
  document.querySelectorAll('.view-group .view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
}

function setFilter(f) {
  currentFilter = f;
  syncFilterButtons();
  renderBookings();
  applyTimelineFilter();
}

function setView(v) {
  currentView = v;
  syncFilterButtons();
  renderBookings();
}

// ── Timeline ──────────────────────────────────────────────────
// One row per property, one bar per stay. Bars run from the middle of the
// check-in day to the middle of the check-out day, so a same-day turnaround
// shows as two bars meeting inside one cell.

const TL_BEFORE = 2;   // days shown before today
const TL_DAYS   = 40;  // total days in the window

function tipFor(b) {
  const src = b.isBlocked ? 'blocked' : b.source;
  const label = b.isBlocked ? 'Blocked' : (SOURCE_LABELS[b.source] || b.source);
  return `<b>${escHtml(b.summary || (b.isBlocked ? 'Unavailable' : 'Guest'))}</b>`
    + `<span class="tip-src src-${escHtml(src)}">${escHtml(label)}</span><br>`
    + `${fmtDay(b.start)} → ${fmtDay(b.end)} · ${plural(b.nights, 'night')}`;
}

function renderTimeline() {
  const el    = document.getElementById('timeline');
  const now   = today();
  const first = addDays(now, -TL_BEFORE);
  const idx   = d => nightsBetween(first, d);
  const keyOf = new Map(allBookings.map((b, i) => [b, i]));

  document.getElementById('tl-range').textContent =
    `${fmtShort(first)} – ${fmtShort(addDays(first, TL_DAYS - 1))}`;

  // Header: month spans and day cells
  let months = '', days = '', cols = '';
  let spanStart = 0;
  for (let i = 0; i < TL_DAYS; i++) {
    const d   = addDays(first, i);
    const cls = (d.getDay() === 0 || d.getDay() === 6 ? ' we' : '') + (i === TL_BEFORE ? ' today' : '');
    days += `<div class="tl-day${cls}"><span class="dow">${DOW_SHORT[d.getDay()][0]}</span><span class="num">${d.getDate()}</span></div>`;
    cols += `<div class="tl-col${cls}"></div>`;
    const next = addDays(d, 1);
    if (i === TL_DAYS - 1 || next.getMonth() !== d.getMonth()) {
      const len  = i + 1 - spanStart;
      const name = len >= 4 ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : len >= 2 ? MONTHS[d.getMonth()].slice(0, 3) : '';
      months += `<div class="tl-month" style="grid-column:${spanStart + 1} / ${i + 2}">${name}</div>`;
      spanStart = i + 1;
    }
  }

  // Rows
  const multi = currentProperty === 'all' && properties.length > 1;
  let rows;
  if (multi) {
    rows = properties.map(p => ({ name: p.name, sub: p.location, items: allBookings.filter(b => b.propertyId === p.id) }));
    const orphans = allBookings.filter(b => !properties.some(p => p.id === b.propertyId));
    if (orphans.length) rows.push({ name: 'Other', sub: '', items: orphans });
  } else {
    const p = currentProperty === 'all' ? properties[0] : properties.find(x => x.id === currentProperty);
    rows = [{ name: p ? p.name : 'All stays', sub: p ? p.location : '', items: visibleBookings() }];
  }

  let n = 0;
  const rowsHtml = rows.map(row => {
    const items = row.items
      .filter(b => b.nights > 0 && idx(b.end) >= 0 && idx(b.start) < TL_DAYS)
      .sort((a, b) => a.start - b.start || a.isBlocked - b.isBlocked);

    // Greedy lane packing — overlapping entries stack instead of hiding each other
    const laneEnds = [];
    const bars = items.map(b => {
      let lane = laneEnds.findIndex(end => end <= b.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = b.end;

      const clipL = idx(b.start) < 0, clipR = idx(b.end) > TL_DAYS - 1;
      const s = clipL ? -0.5 : idx(b.start);
      const e = clipR ? TL_DAYS - 0.5 : idx(b.end);
      const src = b.isBlocked ? 'blocked' : b.source;
      const cls = [
        'tl-bar', 'src-' + src,
        clipL && 'clip-l', clipR && 'clip-r',
        e - s < 2 && 'short',
        b.isBlocked && 'is-blocked',
        b.provisional && 'is-provisional',
        b.end < now && 'is-past',
      ].filter(Boolean).join(' ');
      const label = b.isBlocked ? 'Blocked' : (b.summary || 'Guest');
      return `<button class="${escHtml(cls)}" data-k="${keyOf.get(b)}" data-src="${escHtml(src)}"`
        + ` style="--s:${s};--e:${e};--lane:${lane};--i:${n++}"`
        + ` data-tip="${escHtml(tipFor(b))}" aria-label="${escHtml(`${label}, ${fmtDay(b.start)} to ${fmtDay(b.end)}`)}">${escHtml(label)}</button>`;
    }).join('');

    return `<div class="tl-row">
      <div class="tl-label"><span class="tl-prop">${escHtml(row.name)}</span>${row.sub ? `<span class="tl-loc">${escHtml(row.sub)}</span>` : ''}</div>
      <div class="tl-track" style="--lanes:${Math.max(1, laneEnds.length)}">
        <div class="tl-cols">${cols}</div>
        ${bars || '<div class="tl-empty">No stays in this window</div>'}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="tl" style="--n:${TL_DAYS}">
    <div class="tl-row"><div class="tl-label"></div><div class="tl-months">${months}</div></div>
    <div class="tl-row"><div class="tl-label"></div><div class="tl-days">${days}</div></div>
    ${rowsHtml}
  </div>`;
  applyTimelineFilter();
}

// Dim bars that don't match the platform filter (no re-render, so no re-animation)
function applyTimelineFilter() {
  document.querySelectorAll('#timeline .tl-bar').forEach(bar =>
    bar.classList.toggle('dim', currentFilter !== 'all' && bar.dataset.src !== currentFilter));
}

// Clicking a bar jumps to its card in the list, widening the filters if needed
function focusBooking(k) {
  const find = () => document.querySelector(`#bookings-area .booking-card[data-k="${k}"]`);
  let card = find();
  if (!card) {
    currentFilter = 'all';
    currentView   = 'all';
    syncFilterButtons();
    renderBookings();
    applyTimelineFilter();
    card = find();
  }
  if (!card) return;
  card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('flash');
  void card.offsetWidth; // restart the animation
  card.classList.add('flash');
}

// ── Bookings list ─────────────────────────────────────────────

const STATUS_ORDER   = { 'checking-out': 0, 'checking-in': 1, 'active': 2, 'upcoming': 3, 'past': 4 };
const STATUS_HEADING = {
  'checking-out': 'Checking out today',
  'checking-in':  'Checking in today',
  'active':       'In house',
  'upcoming':     'Upcoming',
};

// Status badge text — says when, not just what
function statusLabel(b, status) {
  const now = today();
  if (status === 'checking-in')  return 'Arrives today';
  if (status === 'checking-out') return 'Leaves today';
  if (status === 'past')         return 'Past';
  if (status === 'active') {
    const left = nightsBetween(now, b.end);
    return `In house · ${plural(left, 'night')} left`;
  }
  const days = nightsBetween(now, b.start);
  return days === 1 ? 'Tomorrow' : `In ${days} days`;
}

function renderBookings() {
  const now = today();
  const filtered = visibleBookings().filter(b => {
    if (currentFilter !== 'all' && b.source !== currentFilter) return false;
    if (currentView === 'upcoming') {
      // Hide blocked dates in upcoming view — they clutter the guest list
      if (b.isBlocked) return false;
      return b.end >= now;
    }
    return true;
  });

  const area = document.getElementById('bookings-area');
  if (!filtered.length) {
    area.innerHTML = `<div class="empty"><b>Nothing here</b>No bookings match the selected filters.</div>`;
    return;
  }

  // Upcoming view: today's departures, then arrivals, then guests in house,
  // then future stays. All view: chronological, blocked dates at the bottom
  // so they don't interrupt the guest list.
  const sorted = currentView === 'upcoming'
    ? [...filtered].sort((a, b) => STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)] || a.start - b.start)
    : [...filtered.filter(b => !b.isBlocked), ...filtered.filter(b => b.isBlocked)];

  const counts = {};
  sorted.forEach(b => { const s = getStatus(b); counts[s] = (counts[s] || 0) + 1; });
  const blockedCount = sorted.filter(b => b.isBlocked).length;
  const keyOf = new Map(allBookings.map((b, i) => [b, i]));
  const sectionLabel = (text, count) =>
    `<div class="section-label">${text}<span class="count">${count}</span></div>`;

  let html = '<div class="bookings-list">';
  let lastStatus = null;
  let blockedSectionShown = false;
  let i = 0;

  for (const b of sorted) {
    const status   = getStatus(b);
    const isDirect = b.source === 'direct';
    const name     = b.summary || (b.isBlocked ? 'Unavailable' : 'Guest');

    // Show property name on card when viewing all properties
    const propName = currentProperty === 'all' && properties.length > 1
      ? propertyName(b.propertyId)
      : null;

    // Section labels — never show status labels for blocked dates
    if (!b.isBlocked && currentView === 'upcoming' && status !== lastStatus) {
      if (STATUS_HEADING[status]) html += sectionLabel(STATUS_HEADING[status], counts[status]);
      lastStatus = status;
    }
    // Show turnaround banners based on booking status and turnaround map
    if (!b.isBlocked) {
      const checkoutEntry = turnaroundOn(turnaroundDays, b.propertyId, localYmd(b.end));
      const checkinEntry  = turnaroundOn(turnaroundDays, b.propertyId, localYmd(b.start));
      // Before checkout card — unit needs cleaning
      if (status === 'checking-out' && checkoutEntry) {
        html += checkoutEntry.type === 'swap'
          ? `<div class="turnaround-banner">${icon('swap')}Same-day turnaround — guest checking out, new guest arriving today</div>`
          : `<div class="turnaround-banner">${icon('clean')}Checkout today — clean and prepare the unit</div>`;
      }
      // Before checkin card after a gap — remind host to check unit is ready
      if (status === 'checking-in' && checkinEntry && checkinEntry.type === 'checkin') {
        html += `<div class="turnaround-banner">${icon('arrive')}New guest arriving — confirm the unit is serviced and ready</div>`;
      }
    }

    // In 'all' view, show a single "Blocked dates" label before the first blocked entry
    if (b.isBlocked && currentView === 'all' && !blockedSectionShown) {
      html += sectionLabel('Blocked dates', blockedCount);
      blockedSectionShown = true;
    }
    const srcKey   = b.isBlocked ? 'blocked' : b.source;
    const srcLabel = b.isBlocked ? 'Blocked' : (SOURCE_LABELS[b.source] || b.source);

    // Extra details for Lekkeslaap bookings
    const d = b.details;
    const extraDetails = (d && !b.isBlocked && (d.reference || d.email || d.cell || d.viewUrl)) ? `
      <div class="booking-extra">
        ${d.reference ? `<span class="booking-ref">${escHtml(d.reference)}</span>` : ''}
        ${d.email     ? `<a href="mailto:${escHtml(d.email)}" class="booking-detail-link">${icon('mail')}${escHtml(d.email)}</a>` : ''}
        ${d.cell      ? `<a href="tel:${escHtml(d.cell)}" class="booking-detail-link">${icon('phone')}${escHtml(d.cell)}</a>` : ''}
        ${d.viewUrl   ? `<a href="${escHtml(d.viewUrl)}" target="_blank" rel="noopener" class="booking-detail-link booking-view-link">View on Lekkeslaap${icon('external')}</a>` : ''}
      </div>` : '';

    html += `
      <article class="booking-card src-${escHtml(srcKey)}${status === 'past' ? ' is-past' : ''}" data-k="${keyOf.get(b)}" style="--i:${Math.min(i++, 14)}">
        <div class="bk-date" aria-hidden="true">
          <span class="bk-day">${b.start.getDate()}</span>
          <span class="bk-mon">${MONTHS[b.start.getMonth()].slice(0, 3)}</span>
        </div>
        <div class="bk-main">
          <div class="guest-name">${escHtml(name)}</div>
          <div class="booking-dates">${fmtDay(b.start)}<span class="arrow">→</span>${fmtDay(b.end)}</div>
          <div class="badge-row">
            <span class="badge badge-src">${escHtml(srcLabel)}</span>
            ${b.isBlocked ? '' : `<span class="badge badge-${status}">${statusLabel(b, status)}</span>`}
            ${b.provisional ? '<span class="badge badge-provisional">Provisional</span>' : ''}
            ${propName ? `<span class="badge badge-property">${escHtml(propName)}</span>` : ''}
          </div>
          ${extraDetails}
        </div>
        <div class="bk-side">
          <div class="nights">
            <div class="nights-num">${b.nights}</div>
            <div class="nights-lbl">${b.nights === 1 ? 'night' : 'nights'}</div>
          </div>
          ${isDirect ? `<button class="delete-btn" data-delete="${keyOf.get(b)}" title="Delete booking" aria-label="Delete booking for ${escHtml(name)}">${icon('trash')}</button>` : ''}
        </div>
      </article>`;
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
  const calBookings = visibleBookings();
  const on = date => calBookings.filter(b => b.start <= date && b.end > date);
  const sourcesOn = date => [...new Set(on(date).map(b => b.isBlocked ? 'blocked' : b.source))].sort();

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
    if (hasTurnaroundOn(turnaroundDays, localYmd(date), currentProperty)) el.classList.add('turnaround');

    const matching = on(date);
    if (matching.length > 0) {
      const srcs = sourcesOn(date);
      const key  = srcs.join('|');
      if (srcs.length === 1) {
        el.classList.add('booked', 'src-' + srcs[0]);
      } else {
        el.classList.add('multi');
        el.style.setProperty('--c1', `var(--${srcs[0]})`);
        el.style.setProperty('--c2', `var(--${srcs[1]})`);
      }
      // Round the ends of each run so consecutive nights read as one stay
      if (sourcesOn(addDays(date, -1)).join('|') !== key) el.classList.add('cap-l');
      if (sourcesOn(addDays(date, 1)).join('|')  !== key) el.classList.add('cap-r');
      el.dataset.tip = `<b>${fmtDay(date)}</b>` + matching.map(b => {
        const src = b.isBlocked ? 'blocked' : b.source;
        return `<span class="tip-src src-${escHtml(src)}">${escHtml(b.isBlocked ? 'Blocked' : (b.summary || 'Guest'))}</span>`;
      }).join('<br>');
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

// ── Tooltip ───────────────────────────────────────────────────
// Elements opt in with data-tip (HTML built from escaped values).

const tipEl = document.getElementById('tip');

function showTip(target) {
  tipEl.innerHTML = target.dataset.tip;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
  const above = r.top - t.height - 10;
  tipEl.style.left = left + 'px';
  tipEl.style.top  = (above < 8 ? r.bottom + 10 : above) + 'px';
}
function hideTip() { tipEl.hidden = true; }

document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t); else hideTip();
});
document.addEventListener('focusin',  e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', hideTip);
document.addEventListener('scroll', hideTip, true);

// ── List ↔ timeline interactions ──────────────────────────────

document.getElementById('timeline').addEventListener('click', e => {
  const bar = e.target.closest('.tl-bar');
  if (bar) focusBooking(bar.dataset.k);
});

// Hovering a card spotlights its bar on the timeline
const bookingsArea = document.getElementById('bookings-area');
function spotlight(k) {
  const tl = document.querySelector('#timeline .tl');
  if (!tl) return;
  tl.querySelectorAll('.tl-bar.is-hl').forEach(b => b.classList.remove('is-hl'));
  const bar = k == null ? null : tl.querySelector(`.tl-bar[data-k="${k}"]`);
  if (bar) bar.classList.add('is-hl');
  tl.classList.toggle('has-hl', !!bar);
}
bookingsArea.addEventListener('mouseover', e => {
  const card = e.target.closest('.booking-card');
  spotlight(card ? card.dataset.k : null);
});
bookingsArea.addEventListener('mouseleave', () => spotlight(null));

bookingsArea.addEventListener('click', e => {
  const btn = e.target.closest('[data-delete]');
  if (btn) openDeleteModal(allBookings[btn.dataset.delete]);
});

// ── Delete booking ────────────────────────────────────────────
let pendingDeleteUid = null;
let deleteTrigger    = null; // element to hand focus back to when the dialog closes

function openDeleteModal(b) {
  if (!b) return;
  pendingDeleteUid = b.uid;
  deleteTrigger    = document.activeElement;
  document.getElementById('delete-modal-body').innerHTML =
    `The direct booking for <strong>${escHtml(b.summary || 'Guest')}</strong>, ${fmtDay(b.start)} → ${fmtDay(b.end)}, will be removed and its dates reopened. This can’t be undone.`;
  document.getElementById('delete-modal-error').hidden = true;
  document.getElementById('delete-modal').style.display = 'flex';
  document.getElementById('delete-cancel-btn').focus();
}

function closeDeleteModal() {
  document.getElementById('delete-modal').style.display = 'none';
  pendingDeleteUid = null;
  if (deleteTrigger && deleteTrigger.isConnected) deleteTrigger.focus();
  deleteTrigger = null;
}

document.addEventListener('keydown', e => {
  if (!pendingDeleteUid) return;
  if (e.key === 'Escape') { closeDeleteModal(); return; }
  // Keep Tab inside the dialog while it is open
  if (e.key === 'Tab') {
    const btns  = [...document.querySelectorAll('#delete-modal button:not(:disabled)')];
    const first = btns[0], last = btns[btns.length - 1];
    if (!btns.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

async function confirmDelete() {
  if (!pendingDeleteUid) return;
  const btn = document.getElementById('delete-confirm-btn');
  const err = document.getElementById('delete-modal-error');
  btn.textContent = 'Deleting…'; btn.disabled = true;
  try {
    // Sample bookings only exist in the browser — nothing to delete on the server
    if (currentMode !== 'demo') {
      const res  = await fetch('/api/bookings/' + encodeURIComponent(pendingDeleteUid), { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
    }
    const deletedUid = pendingDeleteUid;
    closeDeleteModal();
    allBookings = allBookings.filter(b => b.uid !== deletedUid);
    turnaroundDays = findTurnarounds(allBookings);
    renderAll();
  } catch(e) {
    err.textContent = 'Could not delete booking: ' + e.message;
    err.hidden = false;
  }
  btn.textContent = 'Delete'; btn.disabled = false;
}

// ── Demo mode ─────────────────────────────────────────────────

function makeDemoBookings() {
  // Also set demo properties for the switcher
  properties = [
    { id: 1, name: 'Scottburgh Beach House', location: 'Scottburgh, KZN' },
    { id: 2, name: 'Durban City Apartment',  location: 'Durban, KZN' },
  ];
  buildPropertySwitcher(properties);

  const base = today();
  const d = offset => { const x = new Date(base); x.setDate(x.getDate() + offset); return x; };
  let uid = 1;
  const b = (source, name, startOff, nights, isBlocked = false, details = null, propertyId = 1) => ({
    uid: 'demo-' + uid++, source, summary: name,
    start: d(startOff), end: d(startOff + nights),
    nights, isBlocked, details, propertyId,
  });
  const ls = (ref, name, email, cell) => ({
    reference: ref, name, email, cell,
    viewUrl: `https://www.lekkeslaap.co.za/suppliers/bookings/quotation/${ref}`,
  });
  return [
    // Property 1 — Scottburgh Beach House
    b('lekkeslaap', 'Mia Pretorius',     -3, 3, false, ls('LS-DEMO05', 'Mia Pretorius',    'mia@example.co.za',    '+27845556666'), 1), // checks out today → same-day swap turnaround
    b('airbnb',     'Airbnb Guest',       0, 5, false, null, 1),                                                                          // checks in today → same-day swap
    b('lekkeslaap', 'Pieter van Wyk',     5, 3, false, ls('LS-DEMO01', 'Pieter van Wyk',   'pieter@example.co.za', '+27821234567'), 1),   // checks out day 8 → checkout only
    b('booking',    'Booking.com Guest', 10, 2, false, null, 1),                                                                          // checks in day 10 → checkin after gap
    b('direct',     'Thandi Nkosi',      12, 2, false, null, 1),
    b('airbnb',     'Airbnb Guest',      14, 5, false, null, 1),
    b('lekkeslaap', 'Anri Botha',        19, 7, false, ls('LS-DEMO02', 'Anri Botha',       'anri@example.co.za',   '+27839876543'), 1),
    b('booking',    'Booking.com Guest', 26, 3, false, null, 1),
    b('lekkeslaap', 'Kobus Joubert',     32, 2, false, ls('LS-DEMO03', 'Kobus Joubert',    'kobus@example.co.za',  '+27711112222'), 1),
    b('airbnb',     null,  6, 2, true,   null, 1),
    // Property 2 — Durban City Apartment
    b('airbnb',     'Airbnb Guest',       1, 3, false, null, 2),
    b('booking',    'Booking.com Guest',  4, 4, false, null, 2), // checks out day 4 → same-day swap
    b('lekkeslaap', 'Sarel du Plessis',   4, 5, false, ls('LS-DEMO04', 'Sarel du Plessis', 'sarel@example.co.za',  '+27723334444'), 2), // checks in day 4 → same-day swap
    b('airbnb',     'Airbnb Guest',      20, 3, false, null, 2),
    b('booking',    'Booking.com Guest', 28, 6, false, null, 2),
    b('lekkeslaap', null, 18, 1, true,   null, 2),
  ].sort((x, y) => x.start - y.start);
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
      tag.textContent = 'Demo';
      document.querySelector('.logo').appendChild(tag);
    }
    stopPolling();
    currentProperty = 'all';
    turnaroundDays = new Map();
    allBookings = makeDemoBookings();
    turnaroundDays = findTurnarounds(allBookings);
    console.log('[demo] allBookings count:', allBookings.length);
    console.log('[demo] turnaroundDays:', [...turnaroundDays].map(([pid, days]) => ({ pid, dates: [...days.keys()] })));
    console.log('[demo] sample starts/ends:', allBookings.slice(0,4).map(b => ({
      name: b.summary, start: localYmd(b.start),
      end: localYmd(b.end), pid: b.propertyId
    })));
    document.getElementById('error-area').innerHTML = '';
    const label = document.getElementById('last-updated');
    label.textContent = 'Sample data';
    label.classList.remove('stale');
    label.classList.add('demo');
    currentFilter = 'all';
    syncFilterButtons();
    renderAll();
  } else {
    if (demoTag) demoTag.remove();
    document.getElementById('last-updated').classList.remove('demo');
    document.getElementById('last-updated').textContent = '';
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

renderHeroDate();
renderTimeline();
renderCalendar();

fetch('/config')
  .then(r => r.json())
  .then(cfg => {
    properties = cfg.properties || [];
    buildPropertySwitcher(properties);
    // Show only filter buttons and legend items for configured platforms
    applyActivePlatforms(cfg.activePlatforms || []);
    if (cfg.hasLiveData) setMode('live');
    else setMode('demo');
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