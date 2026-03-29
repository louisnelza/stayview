# Changelog

All notable changes to StayView are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — feature/booking-engine

### Added
- Direct booking engine — guest-facing `/book` page with availability check, pricing summary and booking form
- Booking storage — direct bookings saved to `bookings.json` on the server
- Booking API — `POST /api/book`, `GET /api/bookings`, `DELETE /api/bookings/:uid`
- Availability API — `GET /api/availability` blocks dates from all iCal feeds for the booking form
- Property config — `PROPERTY_NAME`, `PROPERTY_DESCRIPTION`, `PROPERTY_LOCATION`, `NIGHTLY_RATE`, `MIN_NIGHTS`, `MAX_GUESTS`, `PROPERTY_PHOTO_URL` in config
- Delete direct bookings — ✕ button on direct booking cards with confirmation modal
- Direct bookings shown in dashboard alongside platform bookings (purple colour)

---

## [1.1.0] — 2026 (Unreleased — main branch)

### Added
- **Auto-refresh** — server-side polling re-fetches all iCal feeds on a configurable interval (`POLL_INTERVAL_MINUTES`, default 120). Polling runs on the server independently of any open browser tab (#1)
- **Server-side cache** — `/calendars` serves cached results instantly; manual Refresh uses `?force=1` to bypass cache
- **Page Visibility API** — when returning to the dashboard tab, stale data is refreshed immediately without waiting for the next poll cycle
- **Stale data indicator** — "Updated X mins ago" label in the header updates every 30 seconds and pulses amber when data exceeds half the poll interval
- **Granular booking status** — check-in day shows "Checking In" (blue), mid-stay shows "Checked In" (green), checkout day shows "Checking Out" (amber) (#25)
- **Full Lekkeslaap guest details** — booking cards now show reference number, email address, cell number and a direct link to the booking in the Lekkeslaap supplier dashboard (#21)
- **Modular codebase** — JS and CSS split into `js/shared.js`, `js/dashboard.js`, `css/shared.css`, `css/dashboard.css` for maintainability
- **SETUP.md** — user-friendly setup guide for non-technical users running the packaged executable

### Fixed
- iCal line folding — multi-line SUMMARY values (Lekkeslaap) now correctly unfolded before parsing
- Lekkeslaap guest name truncation — name extraction stops at Email/Reference/BOOKING keywords
- `.env` no longer overridden by a blank `config.txt` — iCal credentials fall through to `.env` if `config.txt` has no URLs set
- Browser tab throttling — polling moved to server-side so overnight background tabs no longer show stale data

### Changed
- `config.txt` and `.env` responsibilities clarified: `config.txt` for executable users, `.env` for developers/Pi/cloud
- `config.txt`, `bookings.json`, `dist/`, `package-lock.json` added to `.gitignore`
- Section labels in upcoming view updated: "Currently Active" → "Checking In Today", "Currently Staying", "Checking Out Today"

---

## [1.0.0] — 2026-03-18

### Added
- Initial release
- Unified booking dashboard aggregating Airbnb, Booking.com and Lekkeslaap iCal feeds
- Mini calendar with colour-coded bookings per platform
- 30-day occupancy stats and booking counts
- Platform filter buttons (All / Airbnb / Booking.com / Lekkeslaap)
- Upcoming / All view toggle
- Demo mode with realistic sample data — works without iCal credentials
- Live / Demo mode toggle in header
- Local proxy server (`server.js`) — fetches iCal feeds server-side, no CORS issues
- Supports `.env` and `config.txt` for configuration
- Packaged executables for Windows, Mac and Linux via `pkg` (no Node.js required)
- Raspberry Pi deployment via systemd service (`stayview.service`)
- Render deployment support with `npm start`
- Lekkeslaap guest names parsed from `Customer:` field in SUMMARY
- Airbnb "Reserved" shown as "Airbnb Guest"
- Booking.com "CLOSED - Not available" shown as "Booking.com Guest"
- Blocked dates correctly excluded from booking counts
- Silent empty calendar detection using localStorage booking count comparison
- Stricter iCal validation — distinguishes fetch failure, invalid feed, and empty calendar
- `.env` re-read on every request so changes apply without server restart
- MIT licence