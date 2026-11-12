# Changelog

All notable changes to StayView are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **Platform block check for direct bookings** — the dashboard warns when an upcoming direct booking's nights aren't blocked on Airbnb or Lekkeslaap yet, and flags in red any night where a platform has its own booking (a likely double booking). Bookings blocked everywhere StayView can check get a green badge. Booking.com isn't checked, because its calendar leaves out dates closed through a sync — #77
- **Turnaround gap per property** — `PROPERTY_N_TURNAROUND_GAP_DAYS` (or `TURNAROUND_GAP_DAYS` in the single-property format) sets how soon after a checkout an arrival triggers the "New guest arriving — confirm the unit is serviced and ready" reminder. Default 3 days; 0 turns the reminder off
- **Turnarounds this month** — a fourth figure in the occupancy panel, following the property switcher. On phones the four figures sit two by two

### Fixed
- **A mistake in `bookings.json` could wipe all direct bookings** — if the file couldn't be read (for example a typo after editing it by hand), it was silently treated as empty, and the next direct booking saved over it, losing every booking in it. Direct bookings are now paused instead: guests are asked to try again later, the dashboard shows a warning, and the file is not touched until it is fixed. Saves also go through a temporary file, so a crash mid-save can't leave a half-written file
- **Direct bookings when a platform is down** — the booking page and the booking check fetched every platform feed fresh and treated a feed that failed as having no bookings, so while Airbnb (say) was unreachable a guest could book nights already taken there. A booking now falls back to a cached feed under an hour old, and is otherwise refused with a "can't confirm availability" message. The booking page reuses feeds fetched in the last 10 minutes instead of hitting every platform on each visit, and says so when a platform has never been read — closes #65
- **Booking page missed events with wrapped lines** — availability used its own iCal reader, which didn't unwrap folded lines, so an event whose dates were wrapped onto a second line didn't block its nights. It now uses the same parser as the dashboard
- **Turnarounds mixed up between properties** — turnaround days were tracked one per date across all properties, so with more than one property a checkout could hide another property's same-day swap, a "new guest arriving" reminder could be dropped, and the month calendar could show a turnaround dot belonging to a property that wasn't selected. Turnarounds are now tracked per property — closes #61
- **One failing request could stop the server** — an unexpected error while handling any request ended the whole process, taking the dashboard and booking page down until it was restarted. The failing request now gets an error response, the error is logged with its details, and the server keeps running

## [1.4.0] — 2026-11-11

### Added
- **Booking diff engine** — every calendar fetch is compared against `known-uids.json` so newly arrived bookings can be detected. New bookings are logged for now; this is the groundwork for notifications — closes #53
- **`stayview.service`** — systemd unit for running StayView on a Raspberry Pi so it starts on boot and restarts after a crash, with a full walkthrough in the README
- Build instructions for the executables (`npm install`, `npm run build`) in the README

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
- **Dates a day out in UTC+ timezones** — calendar dates are now handled as local dates throughout, fixing false conflicts with direct bookings, a check-out minimum that was a night early, and yesterday being selectable after midnight — closes #63
- Impossible dates such as 30 February are rejected by `/api/book` instead of rolling forward
- iCal dates are parsed as local days, and turnaround gaps spanning a daylight-saving change count as whole days
- Calendar feeds on a non-default port were always fetched from port 443; relative redirects now keep their host and port

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