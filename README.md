# Watchpost

Live ops dashboard for the [Stoxopia](https://stoxopia.com) + [FNA](https://api.scalethetop.com) services running on a single Vultr VPS.

Hosted at `https://narain39.github.io/watchpost/` (and `https://watchpost.scalethetop.com` once DNS is configured).

## How it works

```
┌────────────────────────────────────────┐
│ GitHub Pages: index.html + status.js  │  ← built once on push
│ (CDN-cached, instant load)            │
└────────────────────────────────────────┘
            │ fetch every 30s
            ▼
┌────────────────────────────────────────┐
│ Public Gist: status.json              │  ← updated every 5 min, no Pages build
└────────────────────────────────────────┘
            ▲ PATCH via GitHub API
            │
┌────────────────────────────────────────┐
│ VPS host cron: update_status_gist.sh   │  ← lives in narain39/financial-news-aggregator
└────────────────────────────────────────┘
```

The static page never rebuilds when data changes — it polls the Gist for live updates.

## Files

- `index.html` — single-page dashboard, vanilla HTML+CSS, no build step
- `status.js` — fetches the Gist, renders panels, handles stale-data fallback
- `sample_status.json` — reference data shape for testing without the Gist

## Local development

```bash
cd watchpost
python3 -m http.server 8765
```

Then open one of:
- `http://localhost:8765/` — production gist
- `http://localhost:8765/?gist=http://localhost:8765/sample_status.json` — local mock

The `?gist=<url>` query param overrides the default Gist URL — handy for testing alternate JSON shapes without a redeploy.

## Status semantics

| Color | Symbol | Meaning |
|---|---|---|
| Green | ✓ | All systems operational |
| Amber | ⚠ | Degraded — at least one warning, no critical failures |
| Red | ✗ | Critical — at least one container unhealthy or watchdog critical |
| Gray | ○ | Stale data — collector hasn't reported in >10 min |

## Background

Built after a 2026-04-25 ~11-hour silent FNA outage where the watchdog detected the failure but had no visible push channel. See `doc/uvicorn_deadlock_postmortem_and_fix.md` in the FNA repo.

The collector script and full design doc live in [`narain39/financial-news-aggregator`](https://github.com/narain39/financial-news-aggregator).
