# Strava Formatter

A minimal web app that turns the messy wall of text you get when copying a Strava activity into clean, readable plain text — ready to paste into a training log, notes app, or anywhere else.

## What it does

When you highlight and copy a Strava activity from the browser, the clipboard picks up a lot of noise: concatenated stat labels, UI chrome like "Strava Labs" and "View Flybys", and inconsistent formatting. Strava Formatter strips all of that out and produces a consistently structured output with clearly labelled fields and an optional lap table.

**Input (raw Strava copy-paste):**
```
18:21 on Wednesday, 20 May 2026 Rotherham, United Kingdom
Warm Up
Strava Labs
View Flybys
0.95 km

5:11

5:26 /km

5
Elevation1 mCalories68
Elapsed Time5:46
```

**Output:**
```
18:21 on Wednesday, 20 May 2026 Rotherham, United Kingdom

Warm Up

Distance: 0.95 km
Moving Time: 5:11
Avg Pace: 5:26 /km
Relative Effort: 5
Elevation Gain: +1 m
Calories: 68
Elapsed Time: 5:46
```

There are two ways to get data in: paste the raw text (above), or use the **Activity URL** tab to fetch an activity directly from the Strava API (see below).

## Features

- Parses all standard Strava activity stats: distance, moving time, pace, relative effort, elevation, calories, elapsed time, and cadence
- Handles both short run times (`5:11`) and long run times (`1:55:53`)
- Strips UI noise lines (`Strava Labs`, `View Flybys`, etc.)
- Includes lap table in a code block when present
- One-click copy to clipboard
- Optionally fetches an activity directly from the Strava API by URL, including its tags (Race, Long Run, Workout, Recovery, Commute), signed per-lap elevation and estimated grade adjusted pace
- The paste path works entirely in the browser — no data is sent anywhere unless you use the Activity URL tab

## Per-lap elevation and grade adjusted pace

A lap table pasted from Strava's activity page is passed through as-is, including Strava's own `GAP` column and signed `Elev` values.

The Strava API doesn't return either of those for laps: its lap `total_elevation_gain` is gain-only (never negative) and there's no GAP field. The **Activity URL** tab therefore calls `api/strava.js`, a serverless function which:

- Fetches the activity, its laps, and its altitude/grade/distance/time streams from the Strava API
- Calculates each lap's signed `Elev` as its net altitude change, from the stream values at the lap's start and end
- Estimates each lap's GAP from the grade and distance streams and the lap's moving time

The overall **Grade Adjusted Pace** stat is Strava's own figure, combined from the grade-adjusted speed on each km split.

**The per-lap GAP values are estimates.** Strava doesn't publish its model, so the app uses a formula fitted to Strava's values on two runs. On two other runs it was typically within about 3 s/km of Strava's per-km splits, and within 7 s/km at worst. Short, steep laps can be further out. Use the pasted lap table when you need Strava's exact per-lap figures.

This requires a Strava API application and four environment variables (set in Vercel, or in `.env.local` for local dev via `vercel dev`):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
APP_PASSWORD=...
```

`APP_PASSWORD` protects `api/strava.js`, which uses your Strava token. Requests must send it as `Authorization: Bearer <password>`, and the route rejects everything if it isn't set. There's no rate limiting, so use a long random value:

```bash
openssl rand -base64 24
```

The refresh token needs `activity:read` (or `activity:read_all` for private activities) scope. Without these set, the Activity URL tab will show an error — the Paste stats tab works fine without it.

## Tech stack

- [React](https://react.dev/) via [Vite](https://vitejs.dev/)
- No external dependencies beyond React itself
- Fonts: [Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed) and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) via Google Fonts

## Getting started

### Prerequisites

- Node.js 20.12 or later ([nodejs.org](https://nodejs.org))

### Run locally

```bash
git clone https://github.com/YOUR_USERNAME/strava-formatter.git
cd strava-formatter
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

### Build for production

```bash
npm run build
```

The compiled output goes to the `dist/` folder.

## Deploying to Vercel

The easiest way to deploy is via the [Vercel dashboard](https://vercel.com):

1. Push the repo to GitHub
2. Go to Vercel → **Add New → Project**
3. Import the repository
4. Leave all settings as default — Vercel auto-detects Vite
5. Click **Deploy**

Any subsequent `git push` to `main` will trigger an automatic redeploy.

## Usage

**Paste stats tab:**
1. Open a Strava activity in your browser
2. Select all the text on the page (or just highlight the stats section) and copy it
3. Paste into the left panel of the app
4. The formatted output appears instantly on the right
5. Click **Copy** to copy it to your clipboard

The app identifies the activity by the timestamp/location header line (e.g. `18:21 on Wednesday, 20 May 2026 Rotherham, United Kingdom`). If that line is missing from the pasted text, the parser won't be able to find the activity — make sure it's included.

**Activity URL tab:**
1. Copy the activity's URL from Strava (e.g. `https://www.strava.com/activities/12345678901`)
2. Paste it into the field and click **Fetch activity** (requires the Strava API environment variables above)
3. Click **Copy** to copy the formatted output, which includes the activity's tags, signed per-lap elevation and estimated grade adjusted pace

## Limitations

- Lap data is parsed when pasted directly, but won't always copy cleanly from Strava as it's dynamically rendered on the page
- The parser expects km-based units; mile-based activities may not format correctly