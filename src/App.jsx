import { useRef, useState } from "react";
import "./App.css";

// ─── Clipboard helper ─────────────────────────────────────────────────────────
async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back to execCommand */ }
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

function formatPaceFromSeconds(sec) {
  if (sec == null || !isFinite(sec)) return null;
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")} /km`;
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

// Strava splits tags across two fields: Race/Long Run/Workout are in workout_type, the rest in tags.
const WORKOUT_TYPE_TAGS = { 1: "Race", 2: "Long Run", 3: "Workout", 11: "Race", 12: "Workout" };

function activityTags(activity) {
  const tags = [
    WORKOUT_TYPE_TAGS[activity.workout_type],
    ...(activity.tags || []).map(t => String(t).replace(/([a-z])([A-Z])/g, "$1 $2")),
    activity.commute ? "Commute" : null,
  ].filter(Boolean);
  return [...new Set(tags)].join(", ") || null;
}

function lapTime(s) {
  return s < 60 ? `${s}s` : secsToTime(s);
}

// Strava's own GAP is only exposed per km split, so combine those into an overall figure.
function overallGapSecPerKm(activity) {
  const splits = (activity.splits_metric || []).filter(s => s.average_grade_adjusted_speed > 0);
  const metres = splits.reduce((sum, s) => sum + s.distance, 0);
  if (metres <= 0) return null;
  const seconds = splits.reduce((sum, s) => sum + s.distance / s.average_grade_adjusted_speed, 0);
  return seconds / (metres / 1000);
}

const LAP_COLUMNS = ["Lap", "Distance", "Time", "Pace", "GAP", "Elev", "HR"];

function buildFromApi(activity, laps, elevationGain, lapMetrics) {
  const header = activity.start_date_local ? formatDateLocal(activity.start_date_local) : "";
  const title  = activity.name || "";
  const desc   = activity.description || "";

  const stats = {
    tag:               activityTags(activity),
    distance:          activity.distance       ? metresToKm(activity.distance)             : null,
    movingTime:        activity.moving_time    ? secsToTime(activity.moving_time)           : null,
    avgPace:           activity.average_speed  ? mpsToMinKm(activity.average_speed)         : null,
    gradeAdjustedPace: formatPaceFromSeconds(overallGapSecPerKm(activity)),
    relativeEffort:    activity.suffer_score   ? String(activity.suffer_score)              : null,
    elevationGain:     elevationGain != null   ? `+${elevationGain} m`                      : null,
    calories:          activity.calories       ? activity.calories.toLocaleString()         : null,
    elapsedTime:       activity.elapsed_time   ? secsToTime(activity.elapsed_time)          : null,
    // Strava stores running cadence as one-foot SPM — multiply by 2 for total
    cadence:           activity.average_cadence
                                            ? `${Math.round(activity.average_cadence * 2)} spm` : null,
  };

  const lapRows = (Array.isArray(laps) ? laps : []).map((lap, i) => {
    const metrics = lapMetrics?.[i];
    return [
      String(lap.lap_index).padStart(3),
      metresToKm(lap.distance),
      lapTime(lap.moving_time),
      mpsToMinKm(lap.average_speed) || "",
      formatPaceFromSeconds(metrics?.gradeAdjustedPaceSecPerKm) || "",
      metrics?.elevation != null ? `${metrics.elevation} m` : "",
      lap.average_heartrate ? `${Math.round(lap.average_heartrate)} bpm` : "",
    ];
  });
  const lapTable = lapRows.length
    ? [LAP_COLUMNS, ...lapRows].map(row => row.join("\t")).join("\n")
    : "";

  return { header, title, description: desc, stats, lapRows, lapTable };
}

// ─── Output formatter ─────────────────────────────────────────────────────────
function formatOutput({ header, title, description, stats, lapTable }) {
  const lines = [header, ""];
  if (title)       { lines.push(title); lines.push(""); }
  if (description) { lines.push(description); lines.push(""); }

  if (stats.tag)               lines.push(`Tag: ${stats.tag}`);
  if (stats.distance)          lines.push(`Distance: ${stats.distance}`);
  if (stats.movingTime)        lines.push(`Moving Time: ${stats.movingTime}`);
  if (stats.avgPace)           lines.push(`Avg Pace: ${stats.avgPace}`);
  if (stats.gradeAdjustedPace) lines.push(`Grade Adjusted Pace: ${stats.gradeAdjustedPace}`);
  if (stats.relativeEffort)    lines.push(`Relative Effort: ${stats.relativeEffort}`);
  if (stats.elevationGain)     lines.push(`Elevation Gain: ${stats.elevationGain}`);
  if (stats.calories)          lines.push(`Calories: ${stats.calories}`);
  if (stats.elapsedTime)       lines.push(`Elapsed Time: ${stats.elapsedTime}`);
  if (stats.cadence)           lines.push(`Avg Cadence: ${stats.cadence}`);
  if (lapTable) { lines.push(""); lines.push("```"); lines.push(lapTable); lines.push("```"); }

  return lines.join("\n");
}

// ─── UI ───────────────────────────────────────────────────────────────────────
const PRIMARY_STATS = [
  ["Distance", "distance"],
  ["Moving Time", "movingTime"],
  ["Avg Pace", "avgPace"],
  ["Grade Adjusted Pace", "gradeAdjustedPace"],
];
const SECONDARY_STATS = [
  ["Elevation Gain", "elevationGain"],
  ["Elapsed Time", "elapsedTime"],
  ["Relative Effort", "relativeEffort"],
  ["Calories", "calories"],
  ["Avg Cadence", "cadence"],
];

function StatList({ items, stats, className }) {
  const visible = items.filter(([, key]) => stats[key]);
  if (!visible.length) return null;
  return (
    <dl className={`sf-stats ${className}`}>
      {visible.map(([label, key]) => (
        <div className="sf-stat" key={key}>
          <dt>{label}</dt>
          <dd>{stats[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

// Units move to the column headings so all seven columns fit on a phone.
const LAP_HEADINGS = [
  ["Lap"], ["Dist", "km"], ["Time"], ["Pace", "/km"], ["GAP", "/km"], ["Elev", "m"], ["HR", "bpm"],
];
const UNIT_SUFFIX = / (km|\/km|m|bpm)$/;

function elevationClass(value) {
  if (value.startsWith("-")) return "sf-descent";
  return value && value !== "0 m" ? "sf-climb" : undefined;
}

function LapTable({ rows }) {
  return (
    <>
      <h3 className="sf-section-title">Laps</h3>
      <div className="sf-table-wrap" tabIndex={0} role="region" aria-label="Lap table">
        <table className="sf-table">
          <thead>
            <tr>
              {LAP_HEADINGS.map(([label, unit]) => (
                <th key={label} scope="col">{label}{unit && <span className="sf-unit">{unit}</span>}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row[0]}>
                {row.map((cell, i) => (
                  <td key={LAP_COLUMNS[i]} className={LAP_COLUMNS[i] === "Elev" ? elevationClass(cell) : undefined}>
                    {cell.trim().replace(UNIT_SUFFIX, "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sf-footnote">Lap GAP is an estimate. The overall Grade Adjusted Pace is Strava's own figure.</p>
    </>
  );
}

const COPY_LABELS = { idle: "Copy text", success: "Copied", fail: "Couldn't copy" };

function Result({ activity, copyState, onCopy }) {
  const { header, title, description, stats, lapRows } = activity;
  return (
    <article className="sf-card">
      <div className="sf-result-bar">
        <span className="sf-result-date">{header}</span>
        <button
          type="button"
          className={`sf-copy ${copyState === "success" ? "is-success" : copyState === "fail" ? "is-fail" : ""}`}
          onClick={onCopy}
        >
          {copyState === "success" ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          )}
          {COPY_LABELS[copyState]}
        </button>
      </div>
      <div className="sf-result-body">
        <h2 className="sf-activity-title">{title}</h2>
        {description && <p className="sf-description">{description}</p>}
        {stats.tag && (
          <div className="sf-tags">
            {stats.tag.split(", ").map(tag => <span className="sf-tag" key={tag}>{tag}</span>)}
          </div>
        )}
        <StatList items={PRIMARY_STATS} stats={stats} className="sf-stats-primary" />
        <StatList items={SECONDARY_STATS} stats={stats} className="sf-stats-secondary" />
        {lapRows.length > 0 && <LapTable rows={lapRows} />}
      </div>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="sf-card sf-skeleton" role="status" aria-label="Fetching activity from Strava">
      <div className="sf-skeleton-title" />
      <div className="sf-skeleton-tiles"><div /><div /><div /><div /></div>
      <div className="sf-skeleton-table" />
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [url,       setUrl]       = useState("");
  const [activity,  setActivity]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [copyState, setCopyState] = useState("idle"); // idle | success | fail
  const latestRequest = useRef(0);
  const copyTimer = useRef(null);

  const load = async id => {
    const request = ++latestRequest.current;
    setLoading(true);
    setError("");
    setActivity(null);
    setCopyState("idle");
    try {
      const res = await fetch(`/api/strava?activityId=${id}`);
      const data = await res.json().catch(() => null);
      if (request !== latestRequest.current) return;
      if (!res.ok || !data) {
        setError(data?.error || `Something went wrong (error ${res.status}). Try again.`);
        return;
      }
      setActivity(buildFromApi(data.activity, data.laps, data.elevationGain, data.lapMetrics));
    } catch {
      if (request === latestRequest.current) {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  };

  const handleSubmit = e => {
    e.preventDefault();
    const value = url.trim();
    if (!value) {
      setError("Paste a Strava activity link first.");
      return;
    }
    const id = extractActivityId(value);
    if (!id) {
      setError("That doesn't look like an activity link. It should look like https://www.strava.com/activities/12345678901");
      return;
    }
    load(id);
  };

  const handlePaste = e => {
    const pasted = e.clipboardData.getData("text").trim();
    const id = extractActivityId(pasted);
    if (!id) return;
    e.preventDefault();
    setUrl(pasted);
    load(id);
  };

  const handleCopy = async () => {
    const ok = await copyToClipboard(formatOutput(activity));
    setCopyState(ok ? "success" : "fail");
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <main className="sf-page">
      <header className="sf-header">
        <div className="sf-logo" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 64 64" fill="none" stroke="white">
            <path strokeWidth="9" d="M7 37 23 13 39 37"/>
            <path strokeWidth="7" d="M38 44 46 55 54 44"/>
          </svg>
        </div>
        <div>
          <h1 className="sf-title">Strava <span>Formatter</span></h1>
          <p className="sf-tagline">Turn an activity into clean text for your training log.</p>
        </div>
      </header>

      <form className="sf-form" onSubmit={handleSubmit} noValidate>
        <label className="sf-label" htmlFor="activity-url">Strava activity link</label>
        <div className="sf-form-row">
          <input
            id="activity-url"
            className="sf-input"
            type="url"
            inputMode="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(""); }}
            onPaste={handlePaste}
            placeholder="https://www.strava.com/activities/…"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            aria-describedby="activity-url-help"
            aria-invalid={error ? "true" : undefined}
          />
          <button className="sf-button" type="submit" disabled={loading}>
            {loading ? "Fetching…" : "Fetch"}
          </button>
        </div>
        <p className="sf-help" id="activity-url-help">Paste a link to fetch it straight away. Public activities only.</p>
        {error && <p className="sf-error" role="alert">{error}</p>}
      </form>

      <p className="sf-visually-hidden" role="status">
        {copyState === "success" ? "Copied to clipboard" : copyState === "fail" ? "Couldn't copy to clipboard" : ""}
      </p>

      {loading ? (
        <Skeleton />
      ) : activity ? (
        <Result activity={activity} copyState={copyState} onCopy={handleCopy} />
      ) : !error && (
        <div className="sf-card sf-empty">
          <h2>No activity yet</h2>
          <p>Your stats and lap table will appear here, ready to copy.</p>
        </div>
      )}
    </main>
  );
}
