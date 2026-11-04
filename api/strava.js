import { createHash, timingSafeEqual } from "node:crypto";
import process from "node:process";

// Strava doesn't publish its GAP model or return GAP for laps. These constants are fitted
// to Strava's own GAP values, so re-check them against real activities if changing them.
const GRADE_SMOOTHING_SAMPLES = 21;
const MAX_GRADE = 0.3;

// Flat-equivalent distance per metre run at gradient g (fraction, e.g. 0.1 = 10%).
function gapFactor(g) {
  const grade = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
  return grade >= 0
    ? 1 + 3.25 * grade + 15 * grade ** 2
    : 1 + 2.25 * grade + 12 * grade ** 2;
}

export function smoothGrades(grades) {
  const half = Math.floor(GRADE_SMOOTHING_SAMPLES / 2);
  const totals = [0];
  for (const g of grades) totals.push(totals[totals.length - 1] + (g ?? 0));
  return grades.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(grades.length, i + half + 1);
    return (totals[to] - totals[from]) / (to - from);
  });
}

// Estimated GAP (sec/km) between two stream indexes. Takes moving time from the lap rather
// than the `moving` stream, which flags samples as stopped that Strava counts as moving.
export function lapGapSecPerKm(distance, smoothedGrades, startIndex, endIndex, movingTime) {
  if (!distance || !smoothedGrades || !movingTime) return null;
  const end = Math.min(endIndex, distance.length - 1);
  let adjustedDistance = 0;
  for (let i = Math.max(startIndex, 1); i <= end; i++) {
    const metres = distance[i] - distance[i - 1];
    if (metres <= 0) continue;
    const grade = (smoothedGrades[i] + smoothedGrades[i - 1]) / 2 / 100;
    adjustedDistance += metres * gapFactor(grade);
  }
  return adjustedDistance > 0 ? movingTime / (adjustedDistance / 1000) : null;
}

// Net elevation change (signed) over stream index range [startIndex, endIndex].
function netElevation(altitude, startIndex, endIndex) {
  if (!altitude || altitude.length === 0) return null;
  const start = altitude[startIndex];
  const end = altitude[Math.min(endIndex, altitude.length - 1)];
  if (start == null || end == null) return null;
  return Math.round(end - start);
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function isAuthorized(req, password) {
  const supplied = (req.headers.authorization || "").replace(/^Bearer /, "");
  return timingSafeEqual(sha256(supplied), sha256(password));
}

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

const ACTIVITY_FIELDS = [
  "start_date_local", "name", "description", "distance", "moving_time", "average_speed",
  "suffer_score", "calories", "elapsed_time", "average_cadence", "workout_type", "tags", "commute",
];
const SPLIT_FIELDS = ["distance", "average_grade_adjusted_speed"];
const LAP_FIELDS = ["lap_index", "distance", "moving_time", "average_speed", "average_heartrate"];

export default async function handler(req, res) {
  const { APP_PASSWORD } = process.env;
  if (!APP_PASSWORD) {
    return res.status(503).json({ error: "APP_PASSWORD is not configured on the server." });
  }
  if (!isAuthorized(req, APP_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const { activityId } = req.query;
  if (!activityId || !/^\d+$/.test(activityId)) {
    return res.status(400).json({ error: "Invalid or missing activityId." });
  }

  const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN } = process.env;
  if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_REFRESH_TOKEN) {
    return res.status(500).json({ error: "Strava API credentials are not configured." });
  }

  // 1. Refresh access token
  let access_token;
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        refresh_token: STRAVA_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(401).json({ error: "Failed to obtain access token. Check your Strava credentials." });
    }
    access_token = tokenData.access_token;
  } catch (err) {
    return res.status(500).json({ error: `Token refresh failed: ${err.message}` });
  }

  // 2. Fetch activity, laps, and streams in parallel
  try {
    const headers = { Authorization: `Bearer ${access_token}` };
    const [activityRes, lapsRes, streamsRes] = await Promise.all([
      fetch(`https://www.strava.com/api/v3/activities/${activityId}`, { headers }),
      fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, { headers }),
      fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=altitude,grade_smooth,distance&key_by_type=true`,
        { headers }
      ),
    ]);

    if (activityRes.status === 404) {
      return res.status(404).json({ error: "Activity not found. It may be private or the ID is incorrect." });
    }
    if (!activityRes.ok) {
      return res.status(activityRes.status).json({ error: `Strava API error: ${activityRes.status}` });
    }

    const activity = await activityRes.json();
    const laps = lapsRes.ok ? await lapsRes.json() : [];
    const streams = streamsRes.ok ? await streamsRes.json() : {};

    // The API's laps have no GAP and only a gain-only elevation figure, so derive both from streams.
    const elevationGain = activity.total_elevation_gain != null
      ? Math.round(activity.total_elevation_gain) : null;

    const distance = streams.distance?.data;
    const grades = streams.grade_smooth?.data;
    const smoothedGrades = grades ? smoothGrades(grades) : null;

    const lapMetrics = Array.isArray(laps)
      ? laps.map(lap => ({
          elevation: netElevation(streams.altitude?.data, lap.start_index, lap.end_index),
          gradeAdjustedPaceSecPerKm: lapGapSecPerKm(distance, smoothedGrades, lap.start_index, lap.end_index, lap.moving_time),
        }))
      : [];

    return res.status(200).json({
      activity: {
        ...pick(activity, ACTIVITY_FIELDS),
        splits_metric: (activity.splits_metric || []).map(split => pick(split, SPLIT_FIELDS)),
      },
      laps: Array.isArray(laps) ? laps.map(lap => pick(lap, LAP_FIELDS)) : [],
      lapMetrics,
      elevationGain,
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch activity: ${err.message}` });
  }
}
