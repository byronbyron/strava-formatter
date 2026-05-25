import { useState, useCallback, useRef } from "react";

// ─── Clipboard helper (navigator + execCommand fallback) ──────────────────────
async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { return document.execCommand("copy"); }
  catch { return false; }
  finally { document.body.removeChild(ta); }
}

// ─── Noise lines to discard ────────────────────────────────────────────────────
const NOISE = [
  /^strava labs$/i, /^view flybys$/i, /^share$/i,
  /^give kudos$/i, /^similar activities$/i,
  /^segment efforts$/i, /^achievements$/i,
  /^this activity is private/i,
];
function isNoise(line) { return NOISE.some(r => r.test(line.trim())); }

// ─── Regexes ──────────────────────────────────────────────────────────────────
const RE = {
  header:      /^\d{1,2}:\d{2}\s+on\s+\w+,\s+\d+\s+\w+\s+\d{4}/,
  distance:    /^(\d+\.?\d*)\s*km$/,
  movingTime:  /^(\d+:\d{2}(:\d{2})?)$/,
  pace:        /^\d+:\d{2}\s*\/km$/,
  effort:      /^\d{1,4}$/,
  cadence:     /^(\d{2,3})\s*spm$/i,
  lapHeader:   /^Lap[\s\t]+Distance/,
  weatherCond: /^(Cloudy|Sunny|Overcast|Rain|Drizzle|Snow|Fog|Clear|Partly Cloudy|Mostly Cloudy|Light Rain|Heavy Rain|Thunderstorm|Windy|Haze|Mist)$/i,
  temperature: /^Temperature$/i,
  humidity:    /^Humidity$/i,
  feelsLike:   /^Feels like$/i,
  windSpeed:   /^Wind Speed$/i,
  windDir:     /^Wind Direction$/i,
  deviceShoes: /^(Garmin|Wahoo|Apple|Polar|Suunto|Coros|Fitbit)/i,
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

  const stats = {}, weather = {};
  let device = "", shoes = "", lapTable = "";

  if (statsStart !== -1) {
    const raw_lines = lines.slice(statsStart);
    let lapStart = -1;
    for (let i = 0; i < raw_lines.length; i++) {
      if (RE.lapHeader.test(raw_lines[i].trim())) { lapStart = i; break; }
    }
    const statsLines = lapStart === -1 ? raw_lines : raw_lines.slice(0, lapStart);
    if (lapStart !== -1) lapTable = raw_lines.slice(lapStart).map(l => l.trimEnd()).join("\n").trim();
    const blob = statsLines.map(l => l.trim()).filter(Boolean).join("\n");
    const flat = statsLines.map(l => l.trim()).filter(Boolean);

    const dm = flat.find(l => RE.distance.test(l)); if (dm) stats.distance = dm;
    const tl = flat.filter(l => RE.movingTime.test(l) && !RE.pace.test(l));
    if (tl.length) stats.movingTime = tl[0];
    const pm = flat.find(l => RE.pace.test(l)); if (pm) stats.avgPace = pm;
    const em = flat.find(l => RE.effort.test(l) && parseInt(l) < 1000); if (em) stats.relativeEffort = em;

    const ecMatch = blob.replace(/\n/g, "").match(/Elevation([\d,]+)\s*m.*?Calories([\d,]+)/);
    if (ecMatch) { stats.elevation = ecMatch[1] + " m"; stats.calories = ecMatch[2]; }
    else {
      const el = flat.find(l => /^Elevation\d/i.test(l));
      if (el) { const m = el.match(/Elevation([\d,]+)\s*m/i); if (m) stats.elevation = m[1] + " m"; }
      const cl = flat.find(l => /^Calories\d/i.test(l));
      if (cl) { const m = cl.match(/Calories([\d,]+)/i); if (m) stats.calories = m[1]; }
    }

    const etM = blob.replace(/\n/g, "").match(/Elapsed\s*Time(\d+:\d{2}(?::\d{2})?)/i);
    if (etM) stats.elapsedTime = etM[1];
    const cadL = flat.find(l => RE.cadence.test(l)); if (cadL) stats.cadence = cadL;

    for (let i = 0; i < flat.length; i++) {
      const l = flat[i];
      if (RE.weatherCond.test(l))          weather.condition   = l;
      if (RE.temperature.test(l) && flat[i+1]) weather.temperature = flat[++i];
      if (RE.humidity.test(l)    && flat[i+1]) weather.humidity    = flat[++i];
      if (RE.feelsLike.test(l)   && flat[i+1]) weather.feelsLike   = flat[++i];
      if (RE.windSpeed.test(l)   && flat[i+1]) weather.windSpeed   = flat[++i];
      if (RE.windDir.test(l)     && flat[i+1]) weather.windDir     = flat[++i];
    }

    const devLine = flat.find(l => RE.deviceShoes.test(l));
    if (devLine) {
      const sm = devLine.match(/Shoes?:\s*(.+)/i);
      if (sm) shoes = sm[1].trim();
      const dp = devLine.replace(/Shoes?:.+/i, "").trim();
      if (dp) device = dp;
    }
    if (!shoes) {
      const sl = flat.find(l => /^Shoes?:/i.test(l));
      if (sl) shoes = sl.replace(/^Shoes?:\s*/i, "").trim();
    }
  }

  return { header, title, description: descLines.join("\n"), stats, weather, device, shoes, lapTable };
}

function formatOutput({ header, title, description, stats, weather, device, shoes, lapTable }) {
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

const PLACEHOLDER = `18:21 on Wednesday, 20 May 2026 Rotherham, United Kingdom
Warm Up

Strava Labs
View Flybys
0.95 km

5:11

5:26 /km

5
Elevation1 mCalories68
Elapsed Time5:46
Cloudy
Temperature
16 ℃
Humidity
64%
Feels like
13 ℃
Wind Speed
18.7 km/h
Wind Direction
WSW
Garmin Forerunner 165Shoes: Nike VaporFly 3 Black Oatmeal (442.5 km)`;

// ─── Stat row component ───────────────────────────────────────────────────────
function StatRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <span style={{ fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase",
        color: "#888", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: "13px", color: "#f0f0f0", fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 400 }}>{value}</span>
    </div>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [copyState, setCopyState] = useState("idle"); // idle | success | fail
  const outputRef = useRef(null);

  const parsed   = input.trim() ? parseStrava(input) : null;
  const output   = parsed ? formatOutput(parsed) : null;
  const badParse = input.trim() && !parsed;

  const handleCopy = useCallback(async () => {
    if (!output) return;
    const ok = await copyToClipboard(output);
    setCopyState(ok ? "success" : "fail");
    setTimeout(() => setCopyState("idle"), 2000);
  }, [output]);

  // ── Structured preview sections ──────────────────────────────────────────────
  const preview = parsed ? (() => {
    const { header, title, description, stats, weather, device, shoes, lapTable } = parsed;
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

  const copyLabel = copyState === "success" ? "Copied!" : copyState === "fail" ? "Failed" : "Copy";
  const copyColor = copyState === "success" ? "#4ade80" : copyState === "fail" ? "#f87171" : "#FC4C02";

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

        .sf-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 28px;
        }

        .sf-logo {
          width: 32px; height: 32px;
          background: #FC4C02;
          border-radius: 6px;
          display: flex; align-items: center; justify-content: center;
        }

        .sf-title {
          font-size: 22px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #f0f0f0;
        }

        .sf-title span { color: #FC4C02; }

        .sf-grid {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(0,1fr);
          gap: 20px;
        }

        .sf-panel {
          background: #161616;
          border: 1px solid #2a2a2a;
          border-radius: 10px;
          overflow: hidden;
        }

        .sf-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid #2a2a2a;
          background: #111;
        }

        .sf-panel-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #555;
        }

        .sf-panel-body {
          padding: 0;
        }

        .sf-textarea {
          width: 100%;
          height: 560px;
          resize: none;
          background: transparent;
          border: none;
          outline: none;
          padding: 16px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          line-height: 1.7;
          color: #aaa;
          caret-color: #FC4C02;
          display: block;
        }

        .sf-textarea::placeholder { color: #333; }
        .sf-textarea:focus { color: #ddd; }

        .sf-copy-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 12px;
          border-radius: 5px;
          border: 1px solid rgba(252,76,2,0.4);
          background: rgba(252,76,2,0.08);
          cursor: pointer;
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transition: all 0.15s ease;
        }

        .sf-copy-btn:hover:not(:disabled) {
          background: rgba(252,76,2,0.18);
          border-color: rgba(252,76,2,0.7);
        }

        .sf-copy-btn:disabled { opacity: 0.3; cursor: default; }

        .sf-clear-btn {
          background: none;
          border: none;
          cursor: pointer;
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #555;
          padding: 3px 8px;
          border-radius: 4px;
          transition: color 0.15s;
        }

        .sf-clear-btn:hover { color: #aaa; }

        .sf-preview {
          height: 560px;
          overflow-y: auto;
          padding: 16px;
        }

        .sf-preview::-webkit-scrollbar { width: 4px; }
        .sf-preview::-webkit-scrollbar-track { background: transparent; }
        .sf-preview::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

        .sf-preview-header {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #FC4C02;
          margin-bottom: 4px;
          line-height: 1.5;
        }

        .sf-preview-title {
          font-size: 20px;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: #f0f0f0;
          margin-bottom: 4px;
          line-height: 1.2;
        }

        .sf-preview-desc {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #666;
          margin-bottom: 14px;
          line-height: 1.6;
        }

        .sf-divider {
          height: 1px;
          background: linear-gradient(to right, #FC4C02, transparent);
          margin: 12px 0;
          opacity: 0.4;
        }

        .sf-section-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #FC4C02;
          margin-bottom: 6px;
          opacity: 0.8;
        }

        .sf-lap-table {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #888;
          white-space: pre;
          overflow-x: auto;
          background: #111;
          border: 1px solid #222;
          border-radius: 6px;
          padding: 10px 12px;
          margin-top: 8px;
          line-height: 1.7;
        }

        .sf-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          gap: 10px;
          color: #2d2d2d;
        }

        .sf-empty-icon {
          font-size: 32px;
          opacity: 0.4;
        }

        .sf-empty-text {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #2d2d2d;
        }

        .sf-error {
          margin: 12px 16px 0;
          padding: 10px 12px;
          background: rgba(248,113,113,0.08);
          border: 1px solid rgba(248,113,113,0.2);
          border-radius: 6px;
          font-size: 11px;
          color: #f87171;
          font-family: 'JetBrains Mono', monospace;
          line-height: 1.5;
        }

        .sf-device-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 5px 0;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
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

          {/* ── Input panel ── */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <span className="sf-panel-label">Paste activity</span>
              {input && (
                <button className="sf-clear-btn" onClick={() => setInput("")}>Clear</button>
              )}
            </div>
            <div className="sf-panel-body">
              <textarea
                className="sf-textarea"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={PLACEHOLDER}
                spellCheck={false}
              />
            </div>
            {badParse && (
              <div className="sf-error">
                ⚠ Couldn't find a Strava header. Make sure the date/time line is included.
              </div>
            )}
          </div>

          {/* ── Output panel ── */}
          <div className="sf-panel">
            <div className="sf-panel-header">
              <span className="sf-panel-label">Formatted output</span>
              <button
                className="sf-copy-btn"
                onClick={handleCopy}
                disabled={!output}
                style={{ color: copyColor, borderColor: `${copyColor}66`, background: `${copyColor}14` }}
              >
                {copyState === "success" ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                )}
                {copyLabel}
              </button>
            </div>
            <div className="sf-panel-body">
              {preview ? (
                <div className="sf-preview">
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
                </div>
              ) : (
                <div className="sf-preview">
                  <div className="sf-empty">
                    <svg className="sf-empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M9 17H7A5 5 0 017 7h2M15 7h2a5 5 0 010 10h-2M8 12h8"/>
                    </svg>
                    <span className="sf-empty-text">Output appears here</span>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
