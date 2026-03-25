# StayView Setup Guide

## What you need

Just **two files** in the same folder:

| File | What it does |
|---|---|
| `stayview.exe` / `stayview-mac` / `stayview-linux` | The app (dashboard included) |
| `config.txt` | Your iCal URLs and settings go here |

> **Developers / Raspberry Pi users:** use a `.env` file instead of `config.txt` — same format, same keys. See the README for details.

---

## Step 1 — Add your iCal URLs to config.txt

Open `config.txt` in any text editor (Notepad, TextEdit, etc.) and paste your iCal URLs:

```
ICAL_AIRBNB=https://www.airbnb.com/calendar/ical/...
ICAL_BOOKING=https://ical.booking.com/v1/export?t=...
ICAL_LEKKESLAAP=https://www.lekkeslaap.co.za/suppliers/icalendar.ics?t=...
```

Only fill in the platforms you use. Leave the others blank.

### Where to find your iCal URLs

**Airbnb**
1. Go to airbnb.com → Calendar
2. Click Availability settings
3. Scroll to Export calendar → Copy link

**Booking.com**
1. Go to your property extranet
2. Calendar → Export calendar
3. Copy the iCal link

**Lekkeslaap**
1. Log in to your supplier dashboard
2. Calendar → iCal export
3. Copy the link

---

## Step 2 — Run the app

**Windows:** Double-click `stayview-win.exe`

**Mac:** Open Terminal, drag `stayview-macos` into it, press Enter
> First time only: right-click → Open → Open (to bypass Gatekeeper)

**Linux:** Open a terminal in this folder and run `./stayview-linux`

---

## Step 3 — Open the dashboard

Once running you'll see:
```
StayView running!
  Local:   http://localhost:3456
  Network: http://192.168.x.x:3456
```

Open **http://localhost:3456** in your browser.

- Use the **Local** link on this computer
- Use the **Network** link from your phone or other devices on the same WiFi

---

## Updating your iCal URLs

Just edit `config.txt`, save it, and click **↻ Refresh** in the dashboard.
No need to restart the app.

---

## Stopping the app

Press `Ctrl+C` in the terminal, or just close the terminal window.

---

## Demo mode

Click **Demo** in the top right to see sample data without setting up any iCal URLs.