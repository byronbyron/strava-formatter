import { useState, useCallback } from "react";

// ─── Clipboard helper ─────────────────────────────────────────────────────────
async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { return document.execCommand("copy"); }
  catch { return false; }
  finally { document.body.removeChild(ta); }
}

// ─── Strava URL helpers ───────────────────────────────────────────────────────
const STRAVA_URL_RE = /strava\.com\/activities\/(\d+)/i;

function extractActivityId(url) {
  const m = url.match(STRAVA_URL_RE);
  return m ? m[1] : null;
}

// ─── API response formatters ──────────────────────────────────────────────────
function secsToTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function mpsToMinKm(mps) {
  if (!mps || mps <= 0) return null;
  const total = Math.round(1000 / mps);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} /km`;
}

function metresToKm(m) {
  return (m / 1000).toFixed(2) + " km";
}

// Strava returns start_date_local as ISO string but in local time — parse manually
function formatDateLocal(iso) {
  const [datePart, timePart] = iso.replace("Z", "").split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(":").map(Number);
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const dow = DAYS[new Date(year, month - 1, day).getDay()];
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} on ${dow}, ${day} ${MONTHS[month - 1]} ${year}`;
}

function buildFromApi(activity, laps) {
  const header = activity.start_date_local ? formatDateLocal(activity.start_date_local) : "";
  const title  = activity.name || "";
  const desc   = activity.description || "";

  const stats = {
    distance:       activity.distance       ? metresToKm(activity.distance)             : null,
    movingTime:     activity.moving_time    ? secsToTime(activity.moving_time)           : null,
    avgPace:        activity.average_speed  ? mpsToMinKm(activity.average_speed)         : null,
    relativeEffort: activity.suffer_score   ? String(activity.suffer_score)              : null,
    elevation:      activity.total_elevation_gain != null
                                            ? `${Math.round(activity.total_elevation_gain)} m` : null,
    calories:       activity.calories       ? activity.calories.toLocaleString()         : null,
    elapsedTime:    activity.elapsed_time   ? secsToTime(activity.elapsed_time)          : null,
    // Strava stores running cadence as one-foot SPM — multiply by 2 for total
    cadence:        activity.average_cadence
                                            ? `${Math.round(activity.average_cadence * 2)} spm` : null,
  };

  let lapTable = "";
  if (Array.isArray(laps) && laps.length > 0) {
    const rows = laps.map(lap => {
      const idx      = String(lap.lap_index).padStart(3);
      const dist     = metresToKm(lap.distance).padStart(9);
      const time     = secsToTime(lap.moving_time).padStart(7);
      const pace     = (mpsToMinKm(lap.average_speed) || "").padStart(10);
      const elev     = (lap.total_elevation_gain != null
                        ? `${Math.round(lap.total_elevation_gain) >= 0
                            ? "+" : ""}${Math.round(lap.total_elevation_gain)} m`
                        : "").padStart(7);
      const hr       = lap.average_heartrate
                        ? `${Math.round(lap.average_heartrate)} bpm`.padStart(9)
                        : "".padStart(9);
      return `${idx}\t${dist}\t${time}\t${pace}\t${elev}\t${hr}`;
    });
    lapTable = "Lap\tDistance\tTime\tPace\tElev\tHR\n" + rows.join("\n");
  }

  return { header, title, description: desc, stats, lapTable };
}

// ─── Paste parser (unchanged) ─────────────────────────────────────────────────
const NOISE = [
  /^strava labs$/i, /^view flybys$/i, /^share$/i,
  /^give kudos$/i, /^similar activities$/i,
  /^segment efforts$/i, /^achievements$/i,
  /^this activity is private/i,
];
function isNoise(line) { return NOISE.some(r => r.test(line.trim())); }

const RE = {
  header:      /^\d{1,2}:\d{2}\s+on\s+\w+,\s+\d+\s+\w+\s+\d{4}/,
  distance:    /^(\d+\.?\d*)\s*km$/,
  movingTime:  /^(\d+:\d{2}(:\d{2})?)$/,
  pace:        /^\d+:\d{2}\s*\/km$/,
  effort:      /^\d{1,4}$/,
  cadence:     /^(\d{2,3})\s*spm$/i,
  lapHeader:   /^Lap[\s\t]+Distance/,
};

function parseStrava(raw) {
  const lines = raw.split("\n").map(l => l.trimEnd());
  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RE.header.test(lines[i].trim())) { hi = i; break; }
  }
  if (hi === -1) return null;

  const header = lines[hi].trim();
  let title = "", ti = hi + 1;
  while (ti < lines.length) {
    const t = lines[ti].trim();
    if (t && !isNoise(t)) { title = t; ti++; break; }
    ti++;
  }

  let descLines = [], statsStart = -1;
  for (let i = ti; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || isNoise(t)) continue;
    if (RE.distance.test(t) || RE.movingTime.test(t)) { statsStart = i; break; }
    descLines.push(t);
  }

  const stats = {};
  let lapTable = "";

  if (statsStart !== -1) {
    const rawLines = lines.slice(statsStart);
    let lapStart = -1;
    for (let i = 0; i < rawLines.length; i++) {
      if (RE.lapHeader.test(rawLines[i].trim())) { lapStart = i; break; }
    }
    const statsLines = lapStart === -1 ? rawLines : rawLines.slice(0, lapStart);
    if (lapStart !== -1) lapTable = rawLines.slice(lapStart).map(l => l.trimEnd()).join("\n").trim();
    const blob = statsLines.map(l => l.trim()).filter(Boolean).join("\n");
    const flat = statsLines.map(l => l.trim()).filter(Boolean);

    const dm = flat.find(l => RE.distance.test(l));    if (dm) stats.distance = dm;
    const tl = flat.filter(l => RE.movingTime.test(l) && !RE.pace.test(l));
    if (tl.length) stats.movingTime = tl[0];
    const pm = flat.find(l => RE.pace.test(l));        if (pm) stats.avgPace = pm;
    const em = flat.find(l => RE.effort.test(l) && parseInt(l) < 1000); if (em) stats.relativeEffort = em;

    const ecM = blob.replace(/\n/g, "").match(/Elevation([\d,]+)\s*m.*?Calories([\d,]+)/);
    if (ecM) { stats.elevation = ecM[1] + " m"; stats.calories = ecM[2]; }
    else {
      const el = flat.find(l => /^Elevation\d/i.test(l));
      if (el) { const m = el.match(/Elevation([\d,]+)\s*m/i); if (m) stats.elevation = m[1] + " m"; }
      const cl = flat.find(l => /^Calories\d/i.test(l));
      if (cl) { const m = cl.match(/Calories([\d,]+)/i); if (m) stats.calories = m[1]; }
    }

    const etM = blob.replace(/\n/g, "").match(/Elapsed\s*Time(\d+:\d{2}(?::\d{2})?)/i);
    if (etM) stats.elapsedTime = etM[1];
    const cadL = flat.find(l => RE.cadence.test(l)); if (cadL) stats.cadence = cadL;
  }

  return { header, title, description: descLines.join("\n"), stats, lapTable };
}

// ─── Shared formatter ─────────────────────────────────────────────────────────
function formatOutput({ header, title, description, stats, lapTable }) {
  const lines = [header, ""];
  if (title)       { lines.push(title); lines.push(""); }
  if (description) { lines.push(description); lines.push(""); }

  if (stats.distance)       lines.push(`Distance: ${stats.distance}`);
  if (stats.movingTime)     lines.push(`Moving Time: ${stats.movingTime}`);
  if (stats.avgPace)        lines.push(`Avg Pace: ${stats.avgPace}`);
  if (stats.relativeEffort) lines.push(`Relative Effort: ${stats.relativeEffort}`);
  if (stats.elevation)      lines.push(`Elevation: ${stats.elevation}`);
  if (stats.calories)       lines.push(`Calories: ${stats.calories}`);
  if (stats.elapsedTime)    lines.push(`Elapsed Time: ${stats.elapsedTime}`);
  if (stats.cadence)        lines.push(`Avg Cadence: ${stats.cadence}`);
  if (lapTable) { lines.push(""); lines.push("```"); lines.push(lapTable); lines.push("```"); }

  return lines.join("\n");
}

// ─── Stat row ─────────────────────────────────────────────────────────────────
function StatRow({ label, value }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.05)",
    }}>
      <span style={{ fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase",
        color: "#666", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: "13px", color: "#d0d0d0",
        fontFamily: "'JetBrains Mono', monospace", fontWeight: 400 }}>{value}</span>
    </div>
  );
}

// ─── Placeholder ──────────────────────────────────────────────────────────────
const PASTE_PLACEHOLDER = `18:21 on Wednesday, 20 May 2026 Rotherham, United Kingdom
Warm Up

Strava Labs
View Flybys
0.95 km

5:11

5:26 /km

5
Elevation1 mCalories68
Elapsed Time5:46`;

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,        setTab]        = useState("url");
  const [urlInput,   setUrlInput]   = useState("");
  const [pasteInput, setPasteInput] = useState("");
  const [urlParsed,  setUrlParsed]  = useState(null);   // { header, title, ... }
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [copyState,  setCopyState]  = useState("idle"); // idle | success | fail

  const pasteParsed = pasteInput.trim() ? parseStrava(pasteInput) : null;
  const pasteOutput = pasteParsed ? formatOutput(pasteParsed) : null;

  const urlOutput   = urlParsed  ? formatOutput(urlParsed)  : null;
  const activeOutput = tab === "url" ? urlOutput : pasteOutput;
  const activeParsed = tab === "url" ? urlParsed : pasteParsed;

  const preview = activeParsed ? (() => {
    const { header, title, description, stats, lapTable } = activeParsed;
    const rows = [];
    if (stats.distance)       rows.push(["Distance",        stats.distance]);
    if (stats.movingTime)     rows.push(["Moving Time",     stats.movingTime]);
    if (stats.avgPace)        rows.push(["Avg Pace",        stats.avgPace]);
    if (stats.relativeEffort) rows.push(["Relative Effort", stats.relativeEffort]);
    if (stats.elevation)      rows.push(["Elevation",       stats.elevation]);
    if (stats.calories)       rows.push(["Calories",        stats.calories]);
    if (stats.elapsedTime)    rows.push(["Elapsed Time",    stats.elapsedTime]);
    if (stats.cadence)        rows.push(["Avg Cadence",     stats.cadence]);
    return { header, title, description, rows, lapTable };
  })() : null;

  const handleFetch = async () => {
    const id = extractActivityId(urlInput.trim());
    if (!id) return;
    setLoading(true);
    setError("");
    setUrlParsed(null);
    setCopyState("idle");
    try {
      const res = await fetch(`/api/strava?activityId=${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setUrlParsed(buildFromApi(data.activity, data.laps));
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = useCallback(async () => {
    if (!activeOutput) return;
    const ok = await copyToClipboard(activeOutput);
    setCopyState(ok ? "success" : "fail");
    setTimeout(() => setCopyState("idle"), 2000);
  }, [activeOutput]);

  const isValidUrl  = !!extractActivityId(urlInput.trim());
  const badPaste    = pasteInput.trim() && !pasteParsed;
  const copyLabel   = copyState === "success" ? "Copied!" : copyState === "fail" ? "Failed" : "Copy";
  const copyColor   = copyState === "success" ? "#4ade80" : copyState === "fail" ? "#f87171" : "#FC4C02";

  const tabBtn = (t, icon, label) => (
    <button onClick={() => setTab(t)} style={{
      fontSize: "13px", fontWeight: tab === t ? 600 : 400,
      padding: "6px 14px", cursor: "pointer",
      color: tab === t ? "#f0f0f0" : "#555",
      background: "none", border: "none",
      borderBottom: tab === t ? "2px solid #FC4C02" : "2px solid transparent",
      marginBottom: "-1px", fontFamily: "'Barlow Condensed', sans-serif",
      letterSpacing: "0.06em", textTransform: "uppercase",
    }}>
      {icon}
      {label}
    </button>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .sf-root {
          min-height: 100vh;
          background: #0d0d0d;
          background-image: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(252,76,2,0.12) 0%, transparent 60%);
          padding: 28px 24px 48px;
          font-family: 'Barlow Condensed', sans-serif;
        }
        .sf-header { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
        .sf-logo { width: 32px; height: 32px; background: #FC4C02; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
        .sf-title { font-size: 22px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #f0f0f0; }
        .sf-title span { color: #FC4C02; }
        .sf-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 20px; }
        .sf-panel { background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; overflow: hidden; }
        .sf-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a2a2a; background: #111; }
        .sf-panel-label { font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #555; }
        .sf-tabs { border-bottom: 1px solid #2a2a2a; background: #111; padding: 0 12px; display: flex; gap: 2px; }
        .sf-textarea { width: 100%; height: 500px; resize: none; background: transparent; border: none; outline: none; padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.7; color: #aaa; caret-color: #FC4C02; display: block; }
        .sf-textarea::placeholder { color: #2e2e2e; }
        .sf-textarea:focus { color: #ddd; }
        .sf-url-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .sf-url-input { width: 100%; padding: 10px 14px; background: #111; border: 1px solid #2a2a2a; border-radius: 7px; outline: none; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #ccc; caret-color: #FC4C02; transition: border-color 0.15s; }
        .sf-url-input:focus { border-color: #FC4C02; }
        .sf-url-input::placeholder { color: #333; }
        .sf-fetch-btn { padding: 9px 18px; background: #FC4C02; border: none; border-radius: 7px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: white; display: flex; align-items: center; gap: 8px; transition: opacity 0.15s, background 0.15s; align-self: flex-start; }
        .sf-fetch-btn:hover:not(:disabled) { background: #e04400; }
        .sf-fetch-btn:disabled { opacity: 0.35; cursor: default; }
        .sf-copy-btn { display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 5px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; transition: all 0.15s ease; }
        .sf-copy-btn:disabled { opacity: 0.3; cursor: default; }
        .sf-clear-btn { background: none; border: none; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #555; padding: 3px 8px; border-radius: 4px; transition: color 0.15s; }
        .sf-clear-btn:hover { color: #aaa; }
        .sf-preview { height: 554px; overflow-y: auto; padding: 16px; }
        .sf-preview::-webkit-scrollbar { width: 4px; }
        .sf-preview::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .sf-preview-header { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #FC4C02; margin-bottom: 4px; line-height: 1.5; }
        .sf-preview-title { font-size: 20px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: #f0f0f0; margin-bottom: 4px; }
        .sf-preview-desc { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #666; margin-bottom: 14px; line-height: 1.6; }
        .sf-divider { height: 1px; background: linear-gradient(to right, #FC4C02, transparent); margin: 12px 0; opacity: 0.4; }
        .sf-section-label { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #FC4C02; margin-bottom: 6px; opacity: 0.8; }
        .sf-lap-table { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #888; white-space: pre; overflow-x: auto; background: #111; border: 1px solid #222; border-radius: 6px; padding: 10px 12px; margin-top: 8px; line-height: 1.7; }
        .sf-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 10px; }
        .sf-empty-text { font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #2d2d2d; }
        .sf-error { padding: 10px 12px; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); border-radius: 6px; font-size: 12px; color: #f87171; font-family: 'JetBrains Mono', monospace; line-height: 1.5; }
        .sf-note { padding: 10px 14px; background: rgba(252,76,2,0.06); border: 1px solid rgba(252,76,2,0.15); border-radius: 7px; font-size: 12px; color: #888; line-height: 1.6; }
        .sf-note strong { color: #FC4C02; font-weight: 600; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
      `}</style>

      <div className="sf-root">
        <div className="sf-header">
          <div className="sf-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
              <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066l-2.084 4.116zM8.163 5.846l2.256-4.43L16.878 14H20L10.42 0 0 14h3.134L8.163 5.846z"/>
            </svg>
          </div>
          <h1 className="sf-title">Strava <span>Formatter</span></h1>
        </div>

        <div className="sf-grid">

          {/* ── Left panel ── */}
          <div className="sf-panel">
            <div className="sf-tabs">
              {tabBtn("url",
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight:6,verticalAlign:"-2px"}}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
                "Activity URL"
              )}
              {tabBtn("paste",
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight:6,verticalAlign:"-2px"}}><path d="M9 2h6a1 1 0 011 1v1H8V3a1 1 0 011-1z"/><rect x="4" y="4" width="16" height="18" rx="2"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>,
                "Paste stats"
              )}
            </div>

            {tab === "url" ? (
              <div className="sf-url-body">
                <input
                  className="sf-url-input"
                  type="url"
                  value={urlInput}
                  onChange={e => { setUrlInput(e.target.value); setError(""); }}
                  onKeyDown={e => e.key === "Enter" && handleFetch()}
                  placeholder="https://www.strava.com/activities/..."
                  spellCheck={false}
                />
                <button className="sf-fetch-btn" onClick={handleFetch} disabled={!isValidUrl || loading}>
                  {loading ? (
                    <>
                      <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                      Fetching…
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29"/></svg>
                      Fetch activity
                    </>
                  )}
                </button>
                {error && <div className="sf-error">⚠ {error}</div>}
                <div className="sf-note">
                  <strong>Note:</strong> requires Strava API credentials configured as environment variables. See the README for setup instructions.
                </div>
              </div>
            ) : (
              <div style={{ position: "relative" }}>
                {pasteInput && (
                  <button className="sf-clear-btn" onClick={() => setPasteInput("")}
                    style={{ position: "absolute", top: 10, right: 12, zIndex: 1 }}>
                    Clear
                  </button>
                )}
                <textarea
                  className="sf-textarea"
                  value={pasteInput}
                  onChange={e => setPasteInput(e.target.value)}
                  placeholder={PASTE_PLACEHOLDER}
                  spellCheck={false}
                />
                {badPaste && (
                  <div style={{ margin: "0 16px 12px", fontSize: "12px", color: "#f87171",
                    fontFamily: "'JetBrains Mono', monospace" }}>
                    ⚠ Couldn't find a Strava header. Make sure the date/time line is included.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Right panel ── */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <span className="sf-panel-label">Formatted output</span>
              <button
                className="sf-copy-btn"
                onClick={handleCopy}
                disabled={!activeOutput}
                style={{ color: copyColor, border: `1px solid ${copyColor}66`, background: `${copyColor}14` }}
              >
                {copyState === "success" ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                )}
                {copyLabel}
              </button>
            </div>

            <div className="sf-preview">
              {preview ? (
                <>
                  <div className="sf-preview-header">{preview.header}</div>
                  {preview.title && <div className="sf-preview-title">{preview.title}</div>}
                  {preview.description && <div className="sf-preview-desc">{preview.description}</div>}
                  {preview.rows.length > 0 && (
                    <>
                      <div className="sf-divider" />
                      <div className="sf-section-label">Stats</div>
                      {preview.rows.map(([l, v]) => <StatRow key={l} label={l} value={v} />)}
                    </>
                  )}
                  {preview.lapTable && (
                    <>
                      <div className="sf-divider" />
                      <div className="sf-section-label">Laps</div>
                      <div className="sf-lap-table">{preview.lapTable}</div>
                    </>
                  )}
                </>
              ) : loading ? (
                <div className="sf-empty">
                  <svg className="spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FC4C02" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                  <span className="sf-empty-text">Fetching from Strava…</span>
                </div>
              ) : (
                <div className="sf-empty">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2d2d2d" strokeWidth="1.5">
                    <path d="M9 17H7A5 5 0 017 7h2M15 7h2a5 5 0 010 10h-2M8 12h8"/>
                  </svg>
                  <span className="sf-empty-text">Output appears here</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
