# Strava Formatter

A minimal web app that turns a Strava activity URL into clean, readable plain text — ready to paste into a training log, notes app, or anywhere else.

## What it does

Enter the URL of a public Strava activity and the app fetches it through the Strava API and formats it:

```
18:19 on Wednesday, 7 October 2026

HRRC Middlewood Spirals

Distance: 9.10 km
Moving Time: 1:00:04
Avg Pace: 6:36 /km
Grade Adjusted Pace: 6:04 /km
Relative Effort: 33
Elevation Gain: +229 m
Calories: 696
Elapsed Time: 1:05:20
Avg Cadence: 179 spm
```

A lap table follows in a code block when the activity has laps:

```
Lap	Distance	Time	Pace	GAP	Elev	HR
  0	3.25 km	17:59	5:32 /km	5:34 /km	-47 m	134 bpm
  1	0.24 km	1:21	5:37 /km	3:06 /km	36 m	153 bpm
```

## Features

- Shows distance, moving time, pace, grade adjusted pace, relative effort, elevation gain, calories, elapsed time and cadence
- Shows the activity's tags (Race, Long Run, Workout, Recovery, Commute) when it has any
- Includes a lap table with signed elevation and estimated grade adjusted pace
- One-click copy to clipboard

## Grade adjusted pace and lap elevation

The Strava API doesn't return signed elevation or GAP for laps: its lap `total_elevation_gain` is gain-only (never negative) and there's no GAP field. `api/strava.js`, a serverless function, therefore:

- Fetches the activity, its laps, and its altitude/grade/distance streams from the Strava API
- Calculates each lap's signed `Elev` as its net altitude change, from the stream values at the lap's start and end
- Estimates each lap's GAP from the grade and distance streams and the lap's moving time

The overall **Grade Adjusted Pace** stat is Strava's own figure, combined from the grade-adjusted speed on each km split.

**The per-lap GAP values are estimates.** Strava doesn't publish its model, so the app uses a formula fitted to Strava's values on two runs. On two other runs it was typically within about 3 s/km of Strava's per-km splits, and within 7 s/km at worst. Short, steep laps can be further out, and very short laps can be well out.

## Setup and access

This requires a Strava API application and three environment variables (set in Vercel, or in `.env.local` for local dev via `vercel dev`):

```
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_REFRESH_TOKEN=...
```

The refresh token needs `activity:read` scope.

`api/strava.js` has no login, so anyone can call it. To limit what that exposes, it refuses any activity that isn't set to public on Strava (including followers-only activities), and returns only the fields the app displays, with no GPS or location data. It has no rate limiting, so heavy use by someone else could use up your Strava API limit.

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
npx vercel dev
```

`npm run dev` also starts the app, but it doesn't serve `api/strava.js`, so fetching won't work.

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

Any subsequent `git push` to `master` will trigger an automatic redeploy.

## Usage

1. Copy the activity's URL from Strava (e.g. `https://www.strava.com/activities/12345678901`)
2. Paste it into the field, and the activity is fetched straight away (or type it and click **Fetch**)
3. Click **Copy text** to copy the formatted output

## Limitations

- Only activities set to public on Strava can be fetched
- Output is always in km, whatever your Strava units are set to
- Per-lap GAP is an estimate (see above)
