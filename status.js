// Watchpost — fetches the public Gist and renders Stoxopia + FNA ops state.
//
// Layout (post 2026-04-27 redesign):
//   ┌────────────────────────────────────┐
//   │ Banner (overall, both apps)        │
//   ├────────────────────────────────────┤
//   │ Shared strip: VPS · auto-restart · │
//   │ collector freshness                │
//   ├────────────────────────────────────┤
//   │ Tabs: [FNA] [STX]                  │
//   ├────────────────────────────────────┤
//   │ Tab content (FNA panels OR STX     │
//   │ panels — switched via #fna/#stx    │
//   │ URL hash)                          │
//   └────────────────────────────────────┘

// ─── Config ──────────────────────────────────────────────────────────────
const DEFAULT_GIST_URL = "https://gist.githubusercontent.com/narain39/caec144f52457dbe0b2b98b0552b5350/raw/status.json";
const POLL_INTERVAL_MS = 30 * 1000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

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
  switch (status) {
    case "ok": case "running": case "healthy":
      return { className: "ok", symbolClass: "symbol-ok", label: "ok" };
    case "warning": case "warn":
      return { className: "warn", symbolClass: "symbol-warn", label: "warn" };
    case "critical": case "crit": case "unhealthy":
      return { className: "crit", symbolClass: "symbol-crit", label: "critical" };
    case "none": case "":
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

// Partition containers by name prefix
function isFnaContainer(c) { return c.name && c.name.startsWith("news_"); }
function isStxContainer(c) { return c.name && c.name.startsWith("stoxopia_"); }

// Compute the worst signal in a list of containers (for tab dots)
function containerWorst(containers) {
  let worst = "ok";
  for (const c of containers) {
    if (c.state !== "running" || c.health === "unhealthy") return "crit";
    if (c.health === "starting") worst = worstOf(worst, "warn");
  }
  return worst;
}

function worstOf(a, b) {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

// Compute worst signal for the FNA tab (containers + watchdog + rss)
function fnaWorst(data) {
  let worst = "ok";
  worst = worstOf(worst, containerWorst((data.containers || []).filter(isFnaContainer)));
  for (const check of Object.values(data.watchdog || {})) {
    worst = worstOf(worst, check.status === "critical" ? "crit" : check.status);
  }
  if (data.rss_health?.critical > 0) worst = worstOf(worst, "crit");
  if (data.rss_health?.warning > 0) worst = worstOf(worst, "warn");
  return worst;
}

// Compute worst signal for the STX tab
function stxWorst(data) {
  let worst = containerWorst((data.containers || []).filter(isStxContainer));
  const p = data.stx_pipeline;
  if (p && p.available) {
    const h = p.overall_health_pct || 0;
    worst = worstOf(worst, h < 70 ? "crit" : h < 85 ? "warn" : "ok");
  }
  for (const ep of (data.stx_endpoints || [])) {
    const errorRate = ep.calls_24h > 0 ? ep.errors_24h / ep.calls_24h : 0;
    const avgIntervalHours = ep.calls_7d > 0 ? (7 * 24) / ep.calls_7d : Infinity;
    const lastFetchAgeHours = ep.last_fetched
      ? (Date.now() - new Date(ep.last_fetched).getTime()) / 3_600_000
      : Infinity;
    const overdue = lastFetchAgeHours > avgIntervalHours * 3;
    worst = worstOf(worst, ep.calls_7d === 0 ? "crit" : overdue || errorRate > 0.2 ? "warn" : "ok");
  }
  for (const h of (data.stx_http || [])) {
    worst = worstOf(worst, h.status === "ok" ? "ok" : "crit");
  }
  for (const proc of (data.stx_processes || [])) {
    worst = worstOf(worst, proc.status === "ok" ? "ok" : "crit");
  }
  return worst;
}

// ─── Tab routing ─────────────────────────────────────────────────────────

function getActiveTab() {
  const hash = (window.location.hash || "").replace("#", "");
  return ["fna", "stx"].includes(hash) ? hash : "fna";
}

function setActiveTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tab === name);
  });
  if (window.location.hash !== "#" + name) {
    history.replaceState(null, "", "#" + name);
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
});
window.addEventListener("hashchange", () => setActiveTab(getActiveTab()));
setActiveTab(getActiveTab());  // initial render

// ─── Renderers ───────────────────────────────────────────────────────────

function renderBanner(data) {
  const banner = $("banner");
  const text = $("banner-text");
  const meta = $("banner-meta");

  const generated = new Date(data.generated_at);
  const generatedValid = !isNaN(generated.getTime());
  const age = generatedValid ? Date.now() - generated.getTime() : Infinity;

  let overall = "ok";
  if (!generatedValid || age > STALE_THRESHOLD_MS) {
    overall = "stale";
  } else {
    overall = worstOf(overall, fnaWorst(data));
    overall = worstOf(overall, stxWorst(data));
  }

  banner.className = `banner ${overall}`;
  const symMap = { ok: "symbol-ok", warn: "symbol-warn", crit: "symbol-crit", stale: "symbol-dim" };
  const sym = symMap[overall];
  const labelMap = { ok: "All systems operational", warn: "Degraded", crit: "Critical", stale: "Status data is stale" };

  text.parentElement.innerHTML = `<span class="${sym}">&nbsp;</span><span id="banner-text">${labelMap[overall]}</span>`;
  meta.textContent = `Last updated: ${relativeTime(data.generated_at)}`;

  const titleSym = { ok: "✓", warn: "⚠", crit: "✗", stale: "○" };
  document.title = `${titleSym[overall]} Watchpost`;
  const colorMap = { ok: "%2322c55e", warn: "%23f59e0b", crit: "%23ef4444", stale: "%2364748b" };
  document.querySelector("link[rel=icon]").href =
    `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='${colorMap[overall]}'/%3E%3C/svg%3E`;
}

function renderTabDots(data) {
  const fnaDot = $("tab-dot-fna");
  const stxDot = $("tab-dot-stx");
  fnaDot.className = `tab-dot ${fnaWorst(data)}`;
  stxDot.className = `tab-dot ${stxWorst(data)}`;
}

function renderShared(data) {
  // VPS
  const v = data.vps || {};
  $("shared-vps").textContent = uptimeStr(v.uptime_seconds);
  $("shared-vps-sub").textContent = v.load_avg_1m !== undefined ? `Load: ${v.load_avg_1m}` : "—";

  // Auto-restart — symmetric per-app display (FNA tracked, STX not configured yet)
  const a = data.auto_restart || {};
  const fnaToday = a.today_count || 0;
  const fnaCap = a.daily_cap || 4;
  $("shared-autorestart").innerHTML = `FNA: <strong>${fnaToday}/${fnaCap}</strong> · STX: <span style="color:var(--text-faint);">not configured</span>`;
  const lastRestart = a.last_restart_at ? `FNA last restart ${relativeTime(a.last_restart_at)}` : "FNA: no restarts on record";
  $("shared-autorestart-sub").textContent = lastRestart;

  // Collector freshness — two timestamps tell different stories:
  //   generated_at      → "is the collector alive?" (always recent in healthy state)
  //   data_changed_at   → "has anything actually changed?" (could be hours ago and that's GOOD)
  const generated = data.generated_at;
  const dataChanged = data.data_changed_at;
  $("shared-collector").textContent = relativeTime(generated);
  if (generated) {
    const age = Date.now() - new Date(generated).getTime();
    if (age > STALE_THRESHOLD_MS) {
      $("shared-collector-sub").innerHTML = `<span style="color:var(--warn);">Stale — host cron may be down</span>`;
    } else if (dataChanged) {
      $("shared-collector-sub").textContent = `No changes in ${relativeTime(dataChanged).replace(" ago", "")}`;
    } else {
      $("shared-collector-sub").textContent = `Updates every 5 min`;
    }
  } else {
    $("shared-collector-sub").textContent = "—";
  }
}

function renderContainerList(elId, list) {
  const el = $(elId);
  if (!list.length) { el.innerHTML = `<div class="loading">No container data</div>`; return; }
  el.innerHTML = list.map((c) => {
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

function renderFnaContainers(data) {
  renderContainerList("fna-containers", (data.containers || []).filter(isFnaContainer));
}

function renderStxContainers(data) {
  renderContainerList("stx-containers", (data.containers || []).filter(isStxContainer));
}

function renderDeployBlock(elId, app) {
  const el = $(elId);
  if (!app || !app.current_sha) {
    el.innerHTML = `<div class="loading">No deploy data</div>`;
    return;
  }
  el.innerHTML = `
    <div class="deploy-sha">${escapeHtml(app.current_sha)}</div>
    <div class="deploy-msg">${escapeHtml(app.current_message || "—")}</div>
    <div class="deploy-time">Deployed ${relativeTime(app.last_deploy_at)}</div>
  `;
}

function renderDeploy(data) {
  const d = data.deploy || {};
  // Backwards compat: flat schema treated as FNA-only
  const apps = d.current_sha ? { fna: d } : d;
  renderDeployBlock("fna-deploy", apps.fna);
  renderDeployBlock("stx-deploy", apps.stx);
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

function renderStxPipeline(data) {
  const el = $("stx-pipeline");
  const p = data.stx_pipeline;
  const endpoints = data.stx_endpoints || [];

  if (!p || !p.available) {
    el.innerHTML = `<div class="loading">No pipeline data — phd_status.md not found on VPS</div>`;
    return;
  }

  const h = p.overall_health_pct || 0;
  const healthCls = h < 70 ? "crit" : h < 85 ? "warn" : "ok";
  const marketBadge = p.market === "OPEN"
    ? `<span style="color:var(--ok);font-weight:600;">● OPEN</span>`
    : `<span style="color:var(--text-faint);">○ ${escapeHtml(p.market || "—")}</span>`;

  // Per-source endpoint health rows (from fdr_raw_api_data — distinct from PHD stage/section metrics)
  // Status is cadence-aware: "idle 24h" is normal for weekly jobs (SEC EDGAR, FMP fundamentals, etc.)
  let endpointHtml;
  if (!endpoints.length) {
    endpointHtml = `<div class="loading" style="font-size:12px; font-style:italic;">No endpoint data yet</div>`;
  } else {
    endpointHtml = endpoints.map((ep) => {
      const errorRate = ep.calls_24h > 0 ? ep.errors_24h / ep.calls_24h : 0;
      // Derive expected fetch interval from 7-day call history
      const avgIntervalHours = ep.calls_7d > 0 ? (7 * 24) / ep.calls_7d : Infinity;
      const lastFetchAgeHours = ep.last_fetched
        ? (Date.now() - new Date(ep.last_fetched).getTime()) / 3_600_000
        : Infinity;
      // Overdue = silent for >3× the source's own average interval
      const overdue = lastFetchAgeHours > avgIntervalHours * 3;
      const status = ep.calls_7d === 0 ? "crit"          // never active this week
                   : overdue ? "warn"                      // late by its own cadence
                   : errorRate > 0.2 ? "warn"              // >20% errors
                   : "ok";
      const { className, symbolClass, label } = pillFor(status);
      const msStr = ep.avg_ms_24h > 0 ? ` · ${ep.avg_ms_24h}ms` : "";
      const detail = ep.calls_24h > 0
        ? `${fmtNum(ep.calls_24h)} calls · ${ep.errors_24h} err${msStr}`
        : `last ${relativeTime(ep.last_fetched)} · ${fmtNum(ep.calls_7d)} calls/7d`;
      return `
        <div class="check-row">
          <div style="flex:1; min-width:0;">
            <div class="check-name">${escapeHtml(ep.source)}</div>
            <div class="check-msg">${detail}</div>
          </div>
          <span class="pill ${className}"><span class="${symbolClass}"></span>${label}</span>
        </div>`;
    }).join("");
  }

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
      <span class="stat-value ${healthCls}" style="font-size:20px;">${h.toFixed(1)}%</span>
      <span style="font-size:12px; color:var(--text-dim);">PHD · ${marketBadge} · ${fmtNum(p.active_tickers)} tickers</span>
    </div>
    <div style="border-top:1px solid var(--border); padding-top:8px;">
      ${endpointHtml}
    </div>
    <div class="stat-row" style="margin-top:8px; padding-top:8px; border-top:1px solid var(--border);">
      <span class="stat-label">PHD updated</span>
      <span class="stat-value" style="font-size:12px; color:var(--text-dim);">${relativeTime(p.last_updated)}</span>
    </div>
  `;
}

function renderStxHttp(data) {
  const el = $("stx-http");
  const checks = data.stx_http || [];
  if (!checks.length) {
    el.innerHTML = `<div class="loading">No data — stoxopia_backend_vps not reachable</div>`;
    return;
  }
  el.innerHTML = checks.map((h) => {
    const { className, symbolClass, label } = pillFor(h.status);
    const latency = h.latency_ms > 0 ? `${h.latency_ms}ms` : "—";
    const code = h.http_code && h.http_code !== "000" ? ` · HTTP ${h.http_code}` : "";
    return `
      <div class="check-row">
        <div style="flex:1; min-width:0;">
          <div class="check-name">${escapeHtml(h.endpoint)}</div>
          <div class="check-msg">${latency}${code}</div>
        </div>
        <span class="pill ${className}"><span class="${symbolClass}"></span>${label}</span>
      </div>`;
  }).join("");
}

function renderStxProcesses(data) {
  const el = $("stx-processes");
  const procs = data.stx_processes || [];
  if (!procs.length) {
    el.innerHTML = `<div class="loading">No data — stoxopia_pipeline_vps not reachable</div>`;
    return;
  }
  el.innerHTML = procs.map((p) => {
    const { className, symbolClass, label } = pillFor(p.status);
    const displayName = escapeHtml(p.label || p.id || p.name);
    return `
      <div class="check-row">
        <div style="flex:1; min-width:0;">
          <div class="check-name">${displayName}</div>
        </div>
        <span class="pill ${className}"><span class="${symbolClass}"></span>${label}</span>
      </div>`;
  }).join("");
}

// ─── Main fetch loop ─────────────────────────────────────────────────────

async function fetchAndRender() {
  try {
    const url = `${GIST_URL}?nocache=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    renderBanner(data);
    renderTabDots(data);
    renderShared(data);
    renderFnaContainers(data);
    renderStxContainers(data);
    renderDeploy(data);
    renderBacklogs(data);
    renderBudgets(data);
    renderIngestion(data);
    renderRss(data);
    renderWatchdog(data);
    renderStxPipeline(data);
    renderStxHttp(data);
    renderStxProcesses(data);
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
