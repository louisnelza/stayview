# Changelog

All notable changes to StayView are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- **Dashboard redesign** — new "today" briefing with a plain-language summary, a 30-night occupancy strip, and a per-property stay timeline (bars coloured by platform; overlapping entries stack). Clicking a timeline bar jumps to its booking card; hovering a card spotlights its bar.
- **Booking cards** — check-in date tile, weekday dates, relative status ("In 5 days", "In house · 2 nights left"), and today's departures and arrivals listed first
- **Month calendar** — consecutive nights join into one run, overlaps show both platform colours, hover for guest names
- **Guest booking page redesign** — illustrated hero when no photo is set, inline two-month availability calendar with range selection (taken dates struck through, minimum stay enforced as you pick), guest stepper, and a stay summary on the confirmation screen
- New type and colour system shared by both pages; layouts adapt down to phone width and respect reduced-motion settings
- **Keyboard support** — arrow keys move between days in the guest availability calendar; the delete dialog keeps Tab inside it and returns focus when closed

### Fixed
- Guest names were blank on dashboard booking cards
- Delete button no longer builds inline handlers from guest names
- **Double bookings** — the server now refuses a direct booking for nights that are already taken (by a platform feed or another direct booking), for check-in dates in the past, and for stays under the minimum. If the dates are taken while a guest has the booking page open, the page says so and refreshes its calendar — closes #67
- **Packaged executables** — the build never bundled the CSS, JS or booking page, so an executable run on its own served an unstyled dashboard and no `/book` page. The build now reads the asset list in `package.json`, and the server falls back to the bundled copies — closes #68
- **Booking page ignored `PROPERTY_1_*` settings** — with the numbered config format the page showed "My Property" with no rate, minimum stay or guest limit, and direct bookings were saved without a total. It now reads property 1's settings, falling back to the legacy names
- Static file requests are limited to plain file names inside `js/` and `css/`

---

## [1.3.0] — 2026-07-17

### Added
- **Direct booking engine** — guest-facing `/book` page with live availability calendar, pricing summary and booking request form. Cuts platform commissions entirely.
- **Manual booking capture** — add bookings directly to `bookings.json` for phone/walk-in reservations. Format documented in README.
- **Direct bookings in dashboard** — appear in purple alongside Airbnb, Booking.com and Lekkeslaap bookings with delete (✕) button and confirmation modal
- **Turnaround day indicator** — amber banner between booking cards and dot on calendar when one guest checks out and another checks in on the same day, across all platforms — closes #39
- **Platform downtime resilience** — per-source iCal cache persisted to `ical-cache.json`. When a platform is temporarily unavailable (e.g. HTTP 503), last known good data is served. Cache primer retries uncached sources every 5 minutes — closes #37
- **Lekkeslaap provisional booking badge** — bookings without guest details are flagged as "Provisional" so hosts know not to rely on them — closes #30
- **Booking engine API** — `GET /api/property`, `GET /api/availability`, `POST /api/book`, `GET /api/bookings`, `DELETE /api/bookings/:uid`

### Fixed
- Checkout day incorrectly showing as "Past" instead of "Checking Out" — `DTEND` is exclusive in iCal spec
- Blocked dates appearing above "Upcoming" section label — hidden in upcoming view, grouped at bottom in "All" view — closes #32
- `DELETE` method missing from CORS allowed headers — direct booking delete failed with "Failed to fetch"
- Delete UI not updating after confirmation — `pendingDeleteUid` was cleared before filter ran
- Variable shadowing in `findTurnarounds` and `makeDemoBookings` sort causing turnaround detection to silently fail
- `turnaroundDays` TypeError in demo mode — reset to `new Set()` before computation

### Changed
- `bookings.json` added to `.gitignore` — never committed, contains guest data
- `book.html`, `js/booking.js`, `css/booking.css` added to pkg assets for executable builds
- Demo mode updated to show turnaround days between bookings

---

## [1.2.0] — 2026-04-07

### Added
- **Multi-property support** — manage multiple rentals from one dashboard using numbered config keys (`PROPERTY_1_*`, `PROPERTY_2_*` etc.) — closes #28
- **Property switcher** — tab bar in the header to switch between properties or view all combined
- **Slaapstad platform** — full support for Slaapstad iCal feeds (teal colour, filter button, legend, calendar highlight)
- **Dynamic platform visibility** — filter buttons and legend items are automatically hidden for platforms not configured in `.env` or `config.txt`
- **Debug endpoint** — `/debug` shows exactly what the server reads from config at runtime, useful for troubleshooting
- **Granular booking status** — check-in day shows "Checking In" (blue), mid-stay shows "Checked In" (green), checkout day shows "Checking Out" (amber) — closes #25
- **Full Lekkeslaap guest details** — booking cards show reference number, email, cell number and a direct supplier link — closes #21
- **Auto-refresh** — server-side polling re-fetches all iCal feeds on a configurable interval (`POLL_INTERVAL_MINUTES`, default 120) — closes #1
- **Page Visibility API** — stale data refreshes immediately when returning to the tab
- **Server-side cache** — `/calendars` serves cached results instantly; manual Refresh bypasses cache with `?force=1`
- **Stale data indicator** — "Updated X mins ago" label pulses amber when data exceeds half the poll interval
- **SETUP.md** — user-friendly setup guide for non-technical users running the packaged executable

### Fixed
- Windows CRLF line endings (`\r`) corrupting `.env` and `config.txt` URL values
- `config.txt` with empty `PROPERTY_1_*` keys no longer blocks `.env` credentials
- Legacy `.env` fallback now reads all `ICAL_*` keys dynamically — unknown platforms no longer silently dropped
- iCal line folding — multi-line SUMMARY values (Lekkeslaap) now correctly unfolded before parsing
- Lekkeslaap guest name truncation — name extraction stops at Email/Reference/BOOKING keywords
- Browser tab throttling — polling moved to server-side so overnight background tabs no longer show stale data

### Changed
- Codebase restructured into `js/shared.js`, `js/dashboard.js`, `css/shared.css`, `css/dashboard.css` for maintainability
- `.env` and `config.txt` responsibilities clarified — `config.txt` for executable users, `.env` for developers/Pi/cloud
- `config.txt`, `bookings.json`, `dist/`, `package-lock.json` added to `.gitignore`
- Section labels updated — "Currently Active" → "Checking In Today", "Currently Staying", "Checking Out Today"
- New multi-property config format (`PROPERTY_1_*`) — fully backwards compatible with legacy `ICAL_*` format

---

## [1.1.0] — 2026-03-29

### Added
- Auto-refresh with configurable poll interval and stale data indicator
- Granular booking status — Checking In, Checked In, Checking Out
- Full Lekkeslaap booking details — reference, email, cell, supplier link
- Modular codebase — JS and CSS split into separate files
- SETUP.md — setup guide for executable users

### Fixed
- iCal line folding for Lekkeslaap multi-line SUMMARY values
- Lekkeslaap guest name truncation
- `.env` not overridden by blank `config.txt`
- Browser tab throttling causing stale data overnight

### Changed
- `config.txt` and `.env` responsibilities clarified
- Section labels improved

---

## [1.0.0] — 2026-03-18

### Added
- Initial release
- Unified booking dashboard aggregating Airbnb, Booking.com and Lekkeslaap iCal feeds
- Mini calendar with colour-coded bookings per platform
- 30-day occupancy stats and booking counts
- Platform filter buttons and upcoming/all view toggle
- Demo mode with realistic sample data
- Live / Demo mode toggle in header
- Local proxy server — fetches iCal feeds server-side, no CORS issues
- Supports `.env` and `config.txt` for configuration
- Packaged executables for Windows, Mac and Linux via `pkg`
- Raspberry Pi deployment via systemd service
- Render deployment support
- MIT licence