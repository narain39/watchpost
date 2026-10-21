// Watchpost — fetches the public Gist and renders FNA + STX + SPG ops state.
//
// Layout:
//   ┌────────────────────────────────────┐
//   │ Banner (overall, all apps)         │
//   ├────────────────────────────────────┤
//   │ Shared strip: VPS · auto-restart · │
//   │ collector freshness                │
//   ├────────────────────────────────────┤
//   │ Tabs: [FNA] [STX] [SPG]            │
//   ├────────────────────────────────────┤
//   │ Tab content — switched via         │
//   │ #fna/#stx/#spg URL hash            │
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

// DB containers (postgres/redis) run high memory by design (shared_buffers,
// page cache) — only alarm near the actual cap. Mirrors monitor.py's banner.
function memSeverity(pct, name) {
  const isDb = name && (name.includes("postgres") || name.includes("redis") || name.includes("db"));
  const critAt = isDb ? 95 : 90;
  const warnAt = isDb ? 85 : 75;
  if (pct >= critAt) return "crit";
  if (pct >= warnAt) return "warn";
  return "ok";
}

function fmtMb(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GiB";
  return mb + " MiB";
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
function isFnaContainer(c) { return c.name && (c.name.startsWith("news_") || c.name === "fna_backup"); }
function isStxContainer(c) { return c.name && c.name.startsWith("stoxopia_"); }
function isSpgContainer(c) { return c.name && c.name.startsWith("sharpignal-"); }

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
  // Check container memory utilization (DB containers excluded — their
  // cgroup fills with page cache by design; bars stay informational only)
  const res = data.resources;
  if (res && res.containers) {
    for (const [name, stats] of Object.entries(res.containers)) {
      if (isFnaContainer({name}) && !/postgres|redis|db/.test(name)) {
        worst = worstOf(worst, memSeverity(stats.mem_pct, name));
      }
    }
  }
  return worst;
}

// Derive endpoint status — cadence-aware but only when calls_24h == 0.
// If a source had calls today, only the error rate matters (avoids false
// warns on high-frequency sources where avg interval is seconds).
function epStatus(ep) {
  // paused config is advisory — auto-clear if source is actively making calls
  if (ep.paused && ep.calls_24h === 0) return "paused";
  const errorRate = ep.calls_24h > 0 ? ep.errors_24h / ep.calls_24h : 0;
  if (ep.calls_7d === 0) return "crit";
  if (ep.calls_24h > 0) return errorRate > 0.2 ? "warn" : "ok";
  // calls_24h == 0 but was active this week — check cadence
  const avgIntervalHours = (7 * 24) / ep.calls_7d;
  const ageHours = ep.last_fetched
    ? (Date.now() - new Date(ep.last_fetched).getTime()) / 3_600_000
    : Infinity;
  return ageHours > avgIntervalHours * 3 ? "warn" : "ok";
}

// Compute worst signal for the STX tab
function stxWorst(data) {
  let worst = containerWorst((data.containers || []).filter(isStxContainer));
  // Watchdog escalation = self-healing suspended for that process — always crit
  if ((data.stx_escalations || []).length) worst = "crit";
  // Broker queue depth / Redis evictions (Fix17c)
  worst = worstOf(worst, brokerSeverity(data.broker));
  const p = data.stx_pipeline;
  if (p && p.available) {
    const h = p.overall_health_pct || 0;
    worst = worstOf(worst, h < 70 ? "crit" : h < 85 ? "warn" : "ok");
  }
  for (const ep of (data.stx_endpoints || [])) {
    const s = epStatus(ep);
    if (s !== "paused") worst = worstOf(worst, s);
  }
  for (const h of (data.stx_http || [])) {
    worst = worstOf(worst, h.status === "ok" ? "ok" : "crit");
  }
  for (const proc of (data.stx_processes || [])) {
    // paused config is advisory — if process is running, count it normally
    if (proc.paused && proc.status !== "ok") continue;
    worst = worstOf(worst, proc.status === "ok" ? "ok" : "crit");
  }
  // Check container memory utilization
  const res = data.resources;
  if (res && res.containers) {
    for (const [name, stats] of Object.entries(res.containers)) {
      if (isStxContainer({name}) && !/postgres|redis|db/.test(name)) {
        worst = worstOf(worst, memSeverity(stats.mem_pct, name));
      }
    }
  }
  return worst;
}

// Compute worst signal for the SPG tab (containers + http + processes)
function spgWorst(data) {
  let worst = containerWorst((data.containers || []).filter(isSpgContainer));
  for (const h of (data.spg_http || [])) {
    worst = worstOf(worst, h.status === "ok" ? "ok" : "crit");
  }
  for (const proc of (data.spg_processes || [])) {
    if (proc.paused && proc.status !== "ok") continue;
    worst = worstOf(worst, proc.status === "ok" ? "ok" : "crit");
  }
  // Check container memory utilization
  const res = data.resources;
  if (res && res.containers) {
    for (const [name, stats] of Object.entries(res.containers)) {
      if (isSpgContainer({name}) && !/postgres|redis|db/.test(name)) {
        worst = worstOf(worst, memSeverity(stats.mem_pct, name));
      }
    }
  }
  return worst;
}

// ─── Tab routing ─────────────────────────────────────────────────────────

function getActiveTab() {
  const hash = (window.location.hash || "").replace("#", "");
  return ["fna", "stx", "spg"].includes(hash) ? hash : "fna";
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
    overall = worstOf(overall, spgWorst(data));
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
  $("tab-dot-fna").className = `tab-dot ${fnaWorst(data)}`;
  $("tab-dot-stx").className = `tab-dot ${stxWorst(data)}`;
  $("tab-dot-spg").className = `tab-dot ${spgWorst(data)}`;
}

function renderShared(data) {
  // VPS
  const v = data.vps || {};
  $("shared-vps").textContent = uptimeStr(v.uptime_seconds);
  $("shared-vps-sub").textContent = v.load_avg_1m !== undefined ? `Load: ${v.load_avg_1m}` : "—";

  // Auto-restart — symmetric per-app display (FNA via host_health_check.sh,
  // STX via vps-monitor stx_auto_restart_check)
  const a = data.auto_restart || {};
  const fnaToday = a.today_count || 0;
  const fnaCap = a.daily_cap || 4;
  const sa = data.stx_auto_restart;
  const stxPart = sa
    ? `STX: <strong>${sa.today_count || 0}/${sa.daily_cap || 4}</strong>`
    : `STX: <span style="color:var(--text-faint);">not configured</span>`;
  $("shared-autorestart").innerHTML = `FNA: <strong>${fnaToday}/${fnaCap}</strong> · ${stxPart}`;
  const parts = [];
  parts.push(a.last_restart_at ? `FNA last ${relativeTime(a.last_restart_at)}` : "FNA: none on record");
  if (sa) parts.push(sa.last_restart_at ? `STX last ${relativeTime(sa.last_restart_at)}` : "STX: none on record");
  $("shared-autorestart-sub").textContent = parts.join(" · ");

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

function renderSpgContainers(data) {
  renderContainerList("spg-containers", (data.containers || []).filter(isSpgContainer));
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
  renderDeployBlock("spg-deploy", apps.spg);
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
  const warnList = (r.warning_feeds || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("");
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
    ${warnList ? `<ul style="margin-top:4px; margin-bottom:6px; padding-left:18px; font-size:12px; color:var(--warn);">${warnList}</ul>` : ""}
    <div class="stat-row">
      <span class="stat-label">Critical</span>
      <span class="stat-value ${r.critical > 0 ? 'crit' : ''}">${fmtNum(r.critical)}</span>
    </div>
    ${critList ? `<ul style="margin-top:4px; margin-bottom:6px; padding-left:18px; font-size:12px; color:var(--crit);">${critList}</ul>` : ""}
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
      const status = epStatus(ep);
      const { className, symbolClass, label } = status === "paused"
        ? { className: "dim", symbolClass: "symbol-dim", label: "paused" }
        : pillFor(status);
      const msStr = ep.avg_ms_24h > 0 ? ` · ${ep.avg_ms_24h}ms` : "";
      // use derived status (not raw paused flag) so detail matches pill if source re-activates
      const resumeStr = ep.paused_until
        ? ` · resumes ${String(ep.paused_until).slice(0, 10)}`
        : "";
      const detail = status === "paused"
        ? `last ${relativeTime(ep.last_fetched)}${resumeStr}`
        : ep.calls_24h > 0
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
  // Fix17: active watchdog escalations — self-healing suspended, human needed
  const escRows = (data.stx_escalations || []).map((e) => `
      <div class="check-row" style="background:rgba(239,68,68,0.08);border-radius:6px;padding:8px 10px;">
        <div style="flex:1; min-width:0;">
          <div class="check-name" style="color:var(--crit);">⛔ ESCALATED: ${escapeHtml(e.process)}</div>
          <div class="check-msg">${escapeHtml(e.reason)} — since ${relativeTime(e.escalated_at)}</div>
        </div>
        <span class="pill crit"><span class="symbol-crit"></span>escalated</span>
      </div>`).join("");
  el.innerHTML = escRows + procs.map((p) => {
    // paused is advisory — if process is running, show its real status
    const { className, symbolClass, label } = (p.paused && p.status !== "ok")
      ? { className: "dim", symbolClass: "symbol-dim", label: "paused" }
      : pillFor(p.status);
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

function renderSpgHttp(data) {
  const el = $("spg-http");
  const checks = data.spg_http || [];
  if (!checks.length) {
    el.innerHTML = `<div class="loading">No data — sharpignal-api not reachable</div>`;
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

function renderSpgProcesses(data) {
  const el = $("spg-processes");
  const procs = data.spg_processes || [];
  if (!procs.length) {
    el.innerHTML = `<div class="loading">No data — SPG monitoring not yet enabled</div>`;
    return;
  }
  el.innerHTML = procs.map((p) => {
    const { className, symbolClass, label } = (p.paused && p.status !== "ok")
      ? { className: "dim", symbolClass: "symbol-dim", label: "paused" }
      : pillFor(p.status);
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

// ─── Resource renderers ─────────────────────────────────────────────────

function fmtMemUsage(raw) {
  if (!raw) return "—";
  return raw.replace(/([0-9.]+)\s*([KMGT])i?B/gi, (_, n, u) => {
    const v = parseFloat(n);
    const short = v % 1 === 0 ? v.toFixed(0) : v.toFixed(1);
    return short + u.toUpperCase();
  });
}

function renderContainerResources(elId, filterFn, data) {
  const el = $(elId);
  const res = data.resources;
  if (!res || !res.containers) {
    el.innerHTML = '<div class="loading">No resource data</div>';
    return;
  }

  const containers = Object.entries(res.containers)
    .filter(([name]) => filterFn({name}))
    .sort((a, b) => b[1].mem_pct - a[1].mem_pct);

  if (!containers.length) {
    el.innerHTML = '<div class="loading">No resource data for this app</div>';
    return;
  }

  const hdr = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text);opacity:0.5;';
  let html = `<div class="res-row" style="border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:2px;"><span style="${hdr}">Container</span><span style="${hdr}">Memory</span><span style="${hdr}text-align:right;">Mem %</span><span style="${hdr}text-align:right;">CPU</span><span style="${hdr}text-align:right;">Used / Limit</span></div>`;

  for (const [name, stats] of containers) {
    const sev = memSeverity(stats.mem_pct, name);
    const shortName = name.replace("stoxopia_", "").replace("_vps", "").replace("sharpignal-", "spg-");
    const usage = fmtMemUsage(stats.mem_usage);
    const pids = stats.pids != null ? `<span class="res-pids">(${stats.pids})</span>` : "";
    html += `
      <div class="res-row">
        <span class="res-name">${escapeHtml(shortName)}${pids}</span>
        <div class="res-bar"><div class="res-fill ${sev}" style="width:${Math.min(stats.mem_pct, 100).toFixed(1)}%"></div></div>
        <span class="res-pct ${sev}">${stats.mem_pct.toFixed(1)}%</span>
        <span class="res-cpu">${stats.cpu_pct.toFixed(1)}%</span>
        <span class="res-usage">${escapeHtml(usage)}</span>
      </div>`;
  }

  el.innerHTML = html;
}

function renderPipelineProcesses(data) {
  const el = $("stx-pipeline-procs");
  const res = data.resources;
  if (!res || !res.pipeline_processes || !res.pipeline_processes.length) {
    el.innerHTML = '<div class="loading">No process data</div>';
    return;
  }

  // Header
  let html = '<div class="proc-row" style="border-bottom:1px solid var(--border);padding-bottom:4px;margin-bottom:2px;"><span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text);opacity:0.5;">Process</span><span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text);opacity:0.5;text-align:right;">CPU</span><span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text);opacity:0.5;text-align:right;">RSS</span></div>';

  for (const proc of res.pipeline_processes) {
    const memColor = proc.rss_mb > 800 ? "color:var(--warn);" : "";
    html += `
      <div class="proc-row">
        <span class="proc-name">${escapeHtml(proc.name)}</span>
        <span class="proc-cpu">${proc.cpu_pct.toFixed(1)}%</span>
        <span class="proc-mem" style="${memColor}">${fmtMb(proc.rss_mb)}</span>
      </div>`;
  }

  el.innerHTML = html;
}

// Fix17c: Celery broker health — queue depths + Redis evictions.
// Deep queues add zero throughput (tasks re-query eligibility at execution);
// they only pressure Redis until allkeys-lru silently evicts data.
function brokerSeverity(broker) {
  if (!broker) return "ok";
  let worst = "ok";
  for (const depth of Object.values(broker.queues || {})) {
    if (depth > 10000) worst = "crit";
    else if (depth > 2000) worst = worstOf(worst, "warn");
  }
  if ((broker.evictions_delta || 0) > 0) worst = "crit";
  return worst;
}

function renderBroker(data) {
  const el = $("stx-broker");
  if (!el) return;
  const b = data.broker;
  if (!b || !b.queues || !Object.keys(b.queues).length) {
    el.innerHTML = "";
    return;
  }
  const qParts = Object.entries(b.queues).map(([q, depth]) => {
    const color = depth > 10000 ? "var(--crit)" : depth > 2000 ? "var(--warn)" : "var(--text-dim)";
    return `<span style="white-space:nowrap;">${escapeHtml(q)}: <strong style="color:${color};font-family:ui-monospace,monospace;">${depth.toLocaleString()}</strong></span>`;
  });
  let redisPart = "";
  if (b.redis_used_mb != null && b.redis_max_mb) {
    redisPart = `<span style="white-space:nowrap;">redis: <strong style="font-family:ui-monospace,monospace;">${b.redis_used_mb}M / ${b.redis_max_mb}M</strong></span>`;
  }
  let evicPart = "";
  if ((b.evictions_delta || 0) > 0) {
    evicPart = `<span style="color:var(--crit);font-weight:600;white-space:nowrap;">⚠ EVICTING (+${b.evictions_delta.toLocaleString()} keys)</span>`;
  }
  el.innerHTML = `
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text);opacity:0.5;margin-bottom:4px;">Broker Queues</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--text-dim);">
      ${qParts.join("")} ${redisPart} ${evicPart}
    </div>`;
}

function renderHostResources(data) {
  const res = data.resources;
  if (!res || !res.host) return;
  const h = res.host;

  // RAM
  if (h.ram_total_mb) {
    $("shared-ram").textContent = `${fmtMb(h.ram_used_mb)} / ${fmtMb(h.ram_total_mb)}`;
    $("shared-ram-sub").textContent = `${fmtMb(h.ram_available_mb)} available`;
  }

  // Swap
  if (h.swap_total_mb) {
    const swapPct = h.swap_total_mb > 0 ? ((h.swap_used_mb / h.swap_total_mb) * 100).toFixed(0) : 0;
    $("shared-swap").textContent = `${fmtMb(h.swap_used_mb)} / ${fmtMb(h.swap_total_mb)}`;
    const swapColor = swapPct > 80 ? "color:var(--warn);" : "";
    $("shared-swap-sub").innerHTML = `<span style="${swapColor}">${swapPct}% utilized</span>`;
  }

  // Disk
  if (h.disk_total_gb) {
    $("shared-disk").textContent = `${h.disk_used_gb} / ${h.disk_total_gb} GB`;
    const diskColor = h.disk_pct > 90 ? "color:var(--crit);" : h.disk_pct > 80 ? "color:var(--warn);" : "";
    $("shared-disk-sub").innerHTML = `<span style="${diskColor}">${h.disk_pct}% utilized</span>`;
  }
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
    renderSpgContainers(data);
    renderSpgHttp(data);
    renderSpgProcesses(data);
    renderHostResources(data);
    renderContainerResources("stx-resources", isStxContainer, data);
    renderContainerResources("fna-resources", isFnaContainer, data);
    renderContainerResources("spg-resources", isSpgContainer, data);
    renderPipelineProcesses(data);
    renderBroker(data);
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
