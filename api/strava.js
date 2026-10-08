// ─── Cost-of-running-on-grade model (Minetti et al. 2002) ────────────────────
// C(i) = energy cost in J/(kg·m) to run at gradient i (fraction, e.g. 0.1 = 10%)
function costOfRunning(i) {
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}
const FLAT_COST = costOfRunning(0);

function elevationFromAltitude(alt) {
  if (!alt || alt.length < 2) return { gain: 0, loss: 0 };
  let gain = 0, loss = 0;
  for (let i = 1; i < alt.length; i++) {
    const d = alt[i] - alt[i - 1];
    if (d > 0) gain += d; else loss += -d;
  }
  return { gain, loss };
}

// Returns grade-adjusted pace in seconds/km, or null if streams are insufficient.
function gradeAdjustedPaceSecPerKm(streams) {
  const dist = streams.distance?.data;
  const time = streams.time?.data;
  const grade = streams.grade_smooth?.data;
  const moving = streams.moving?.data;
  if (!dist || !time || !grade || dist.length < 2) return null;

  let adjustedDistance = 0;
  let movingTime = 0;

  for (let i = 1; i < dist.length; i++) {
    const dt = time[i] - time[i - 1];
    if (dt <= 0) continue;
    if (moving && moving[i] === false) continue;
    const dd = dist[i] - dist[i - 1];
    if (dd <= 0) continue;
    const g = ((grade[i] ?? 0) + (grade[i - 1] ?? 0)) / 2 / 100;
    adjustedDistance += dd * (costOfRunning(g) / FLAT_COST);
    movingTime += dt;
  }

  if (adjustedDistance <= 0) return null;
  return movingTime / (adjustedDistance / 1000);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

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
        `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=altitude,grade_smooth,distance,time,moving&key_by_type=true`,
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

    // Strava's plain-text copy (and its laps table) only ever reports elevation
    // *gain* — never loss, even on downhill laps. Derive a true +/- split and a
    // grade adjusted pace from the altitude/grade streams instead.
    let elevation = null;
    const gapSecPerKm = gradeAdjustedPaceSecPerKm(streams);
    const { gain: rawGain, loss: rawLoss } = elevationFromAltitude(streams.altitude?.data);
    if (rawGain > 0 || rawLoss > 0 || activity.total_elevation_gain != null) {
      // Strava smooths total_elevation_gain; raw GPS altitude deltas run noisy/high.
      // Scale loss by the same ratio so gain and loss stay on a consistent footing.
      const gain = activity.total_elevation_gain ?? rawGain;
      const smoothingRatio = rawGain > 0 ? gain / rawGain : 1;
      elevation = { gain: Math.round(gain), loss: Math.round(rawLoss * smoothingRatio) };
    }

    return res.status(200).json({ activity, laps, elevation, gradeAdjustedPaceSecPerKm: gapSecPerKm });
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch activity: ${err.message}` });
  }
}
