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

  // 2. Fetch activity and laps in parallel
  try {
    const headers = { Authorization: `Bearer ${access_token}` };
    const [activityRes, lapsRes] = await Promise.all([
      fetch(`https://www.strava.com/api/v3/activities/${activityId}`, { headers }),
      fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, { headers }),
    ]);

    if (activityRes.status === 404) {
      return res.status(404).json({ error: "Activity not found. It may be private or the ID is incorrect." });
    }
    if (!activityRes.ok) {
      return res.status(activityRes.status).json({ error: `Strava API error: ${activityRes.status}` });
    }

    const activity = await activityRes.json();
    const laps = lapsRes.ok ? await lapsRes.json() : [];

    return res.status(200).json({ activity, laps });
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch activity: ${err.message}` });
  }
}
