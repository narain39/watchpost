// Watchpost — fetches the public Gist and renders Stoxopia + FNA ops state.
//
// Configure GIST_URL below. The page polls every POLL_INTERVAL_MS.
// "Stale" = data older than STALE_THRESHOLD_MS triggers the stale banner.

// ─── Config ──────────────────────────────────────────────────────────────
// Replace GIST_RAW_URL with the raw URL of your public gist's status.json.
// You can also pass ?gist=<url> in the query string to override at runtime
// (useful for testing without redeploying).
const DEFAULT_GIST_URL = "https://gist.githubusercontent.com/narain39/caec144f52457dbe0b2b98b0552b5350/raw/status.json";
const POLL_INTERVAL_MS = 30 * 1000;     // 30s
const STALE_THRESHOLD_MS = 10 * 60 * 1000;  // 10 min — data older than this = stale banner

const params = new URLSearchParams(window.location.search);
const GIST_URL = params.get("gist") || DEFAULT_GIST_URL;
document.getElementById("source-link").href = GIST_URL;

// ─── Helpers ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function relativeTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function uptimeStr(seconds) {
  if (!seconds || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

function pillFor(status) {
  // Returns { className, symbolClass, label } for any status string
  switch (status) {
    case "ok":
    case "running":
    case "healthy":
      return { className: "ok", symbolClass: "symbol-ok", label: "ok" };
    case "warning":
    case "warn":
      return { className: "warn", symbolClass: "symbol-warn", label: "warn" };
    case "critical":
    case "crit":
    case "unhealthy":
      return { className: "crit", symbolClass: "symbol-crit", label: "critical" };
    case "none":
    case "":
      return { className: "dim", symbolClass: "symbol-dim", label: "—" };
    default:
      return { className: "dim", symbolClass: "symbol-dim", label: status || "—" };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

// ─── Renderers ───────────────────────────────────────────────────────────

function renderBanner(data) {
  const banner = $("banner");
  const text = $("banner-text");
  const meta = $("banner-meta");

  const generated = new Date(data.generated_at);
  const generatedValid = !isNaN(generated.getTime());
  const age = generatedValid ? Date.now() - generated.getTime() : Infinity;

  // Compute overall status: stale > critical > warning > ok
  let overall = "ok";
  if (!generatedValid || age > STALE_THRESHOLD_MS) {
    overall = "stale";
  } else {
    // Container health
    for (const c of (data.containers || [])) {
      if (c.state !== "running") { overall = "crit"; break; }
      if (c.health === "unhealthy") { overall = "crit"; break; }
    }
    // Watchdog
    if (overall !== "crit") {
      const watchdog = data.watchdog || {};
      for (const check of Object.values(watchdog)) {
        if (check.status === "critical") { overall = "crit"; break; }
        if (check.status === "warning") overall = "warn";
      }
    }
    // RSS health
    if (overall !== "crit" && data.rss_health?.critical > 0) {
      overall = overall === "ok" ? "warn" : overall;
    }
  }

  banner.className = `banner ${overall}`;
  const symMap = { ok: "symbol-ok", warn: "symbol-warn", crit: "symbol-crit", stale: "symbol-dim" };
  const sym = symMap[overall];
  const labelMap = { ok: "All systems operational", warn: "Degraded", crit: "Critical", stale: "Status data is stale" };

  text.parentElement.innerHTML = `<span class="${sym}">&nbsp;</span><span id="banner-text">${labelMap[overall]}</span>`;
  meta.textContent = `Last updated: ${relativeTime(data.generated_at)}`;

  // Update document title + favicon
  const titleSym = { ok: "✓", warn: "⚠", crit: "✗", stale: "○" };
  document.title = `${titleSym[overall]} Watchpost`;
  const colorMap = { ok: "%2322c55e", warn: "%23f59e0b", crit: "%23ef4444", stale: "%2364748b" };
  document.querySelector("link[rel=icon]").href =
    `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='${colorMap[overall]}'/%3E%3C/svg%3E`;
}

function renderContainers(data) {
  const el = $("containers");
  const containers = data.containers || [];
  if (!containers.length) { el.innerHTML = `<div class="loading">No container data</div>`; return; }
  el.innerHTML = containers.map((c) => {
    let status = c.health === "healthy" ? "ok"
                : c.health === "unhealthy" ? "crit"
                : c.state === "running" ? "ok"
                : c.state === "missing" ? "crit"
                : "warn";
    const { className, symbolClass, label } = pillFor(status);
    return `
      <div class="container-row">
        <div>
          <span class="pill ${className}"><span class="${symbolClass}"></span>${label}</span>
          <span class="container-name" style="margin-left:8px;">${escapeHtml(c.name)}</span>
        </div>
        <span class="container-meta">${uptimeStr(c.uptime_s)}</span>
      </div>
    `;
  }).join("");
}

function renderDeploy(data) {
  const el = $("deploy");
  const d = data.deploy || {};
  el.innerHTML = `
    <div class="deploy-sha">${escapeHtml(d.current_sha || "unknown")}</div>
    <div class="deploy-msg">${escapeHtml(d.current_message || "—")}</div>
    <div class="deploy-time">Deployed ${relativeTime(d.last_deploy_at)}</div>
  `;
}

function renderBacklogs(data) {
  const el = $("backlogs");
  const b = data.backlogs || {};
  const rows = [
    { label: "Enrich pending", value: b.enrich_pending, warnAt: 1000, critAt: 10000 },
    { label: "Enhance (direct)", value: b.enhance_pending_direct, warnAt: 5000, critAt: 20000 },
    { label: "Enhance (google)", value: b.enhance_pending_google, warnAt: 20000, critAt: 50000 },
    { label: "Google source residual", value: b.source_google_news_residual, warnAt: 5000, critAt: 20000 },
    { label: "Total articles", value: b.total, warnAt: null, critAt: null },
  ];
  el.innerHTML = rows.map((r) => {
    let cls = "";
    if (r.critAt && r.value >= r.critAt) cls = "crit";
    else if (r.warnAt && r.value >= r.warnAt) cls = "warn";
    return `
      <div class="stat-row">
        <span class="stat-label">${r.label}</span>
        <span class="stat-value ${cls}">${fmtNum(r.value)}</span>
      </div>
    `;
  }).join("");
}

function renderBudgets(data) {
  const el = $("budgets");
  const b = data.budgets || {};
  const order = ["newsapi", "fmp", "finnhub", "marketaux", "newsdata"];
  el.innerHTML = order.filter((k) => b[k]).map((k) => {
    const { used, limit, pct } = b[k];
    const pctVal = (pct || 0) * 100;
    const fillCls = pctVal >= 95 ? "crit" : pctVal >= 80 ? "warn" : "";
    return `
      <div class="bar-row">
        <span class="bar-label">${k}</span>
        <span class="bar-track"><span class="bar-fill ${fillCls}" style="width:${Math.min(pctVal, 100).toFixed(1)}%"></span></span>
        <span class="bar-value">${used}/${limit}</span>
      </div>
    `;
  }).join("");
}

function renderIngestion(data) {
  const el = $("ingestion");
  const ing = data.ingestion_24h || {};
  const entries = Object.entries(ing).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!total) { el.innerHTML = `<div class="loading">No ingestion in last 24h</div>`; return; }
  el.innerHTML = entries.map(([k, v]) => {
    const pct = (v / total) * 100;
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(k)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="bar-value">${fmtNum(v)}</span>
      </div>
    `;
  }).join("") + `
    <div class="stat-row" style="margin-top:8px; padding-top:8px; border-top: 1px solid var(--border);">
      <span class="stat-label">Total</span>
      <span class="stat-value">${fmtNum(total)}</span>
    </div>
  `;
}

function renderRss(data) {
  const el = $("rss");
  const r = data.rss_health || {};
  if (!r.available) { el.innerHTML = `<div class="loading">No healthcheck report today</div>`; return; }
  const critList = (r.critical_feeds || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("");
  const lastCheck = relativeTime(r.last_check_at);
  el.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">Total feeds</span>
      <span class="stat-value">${fmtNum(r.total)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Healthy</span>
      <span class="stat-value">${fmtNum(r.healthy)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Warning</span>
      <span class="stat-value ${r.warning > 0 ? 'warn' : ''}">${fmtNum(r.warning)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Critical</span>
      <span class="stat-value ${r.critical > 0 ? 'crit' : ''}">${fmtNum(r.critical)}</span>
    </div>
    ${critList ? `<ul style="margin-top:8px; padding-left:18px; font-size:12px; color:var(--crit);">${critList}</ul>` : ""}
    <div class="stat-row" style="margin-top:8px; padding-top:8px; border-top: 1px solid var(--border);">
      <span class="stat-label">Last check</span>
      <span class="stat-value" style="font-size:12px; color:var(--text-dim);">${lastCheck}</span>
    </div>
  `;
}

function renderWatchdog(data) {
  const el = $("watchdog");
  const w = data.watchdog || {};
  const checks = Object.entries(w);
  if (!checks.length) { el.innerHTML = `<div class="loading">No watchdog data</div>`; return; }
  el.innerHTML = checks.map(([name, c]) => {
    const { className, symbolClass, label } = pillFor(c.status);
    return `
      <div class="check-row">
        <div style="flex:1; min-width:0;">
          <div class="check-name">${escapeHtml(name)}</div>
          <div class="check-msg">${escapeHtml(c.message || "")}</div>
        </div>
        <span class="pill ${className}"><span class="${symbolClass}"></span>${label}</span>
      </div>
    `;
  }).join("");
}

function renderAutoRestart(data) {
  const el = $("auto-restart");
  const a = data.auto_restart || {};
  const todayCls = a.today_count >= a.daily_cap ? "crit" : a.today_count >= 2 ? "warn" : "";
  const consecCls = a.consecutive_critical >= 2 ? "warn" : "";
  el.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">Last restart</span>
      <span class="stat-value" style="font-size:12px;">${relativeTime(a.last_restart_at)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Today</span>
      <span class="stat-value ${todayCls}">${a.today_count || 0}/${a.daily_cap || 4}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Consecutive CRITICAL</span>
      <span class="stat-value ${consecCls}">${a.consecutive_critical || 0}</span>
    </div>
  `;
}

// ─── Main fetch loop ─────────────────────────────────────────────────────

async function fetchAndRender() {
  try {
    const url = `${GIST_URL}?nocache=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    renderBanner(data);
    renderContainers(data);
    renderDeploy(data);
    renderBacklogs(data);
    renderBudgets(data);
    renderIngestion(data);
    renderRss(data);
    renderWatchdog(data);
    renderAutoRestart(data);
  } catch (err) {
    console.error("Fetch failed:", err);
    const banner = $("banner");
    banner.className = "banner stale";
    $("banner-text").textContent = `Cannot reach status source — ${err.message}`;
    $("banner-meta").textContent = "Check the gist URL or your connection";
  }
}

fetchAndRender();
setInterval(fetchAndRender, POLL_INTERVAL_MS);
