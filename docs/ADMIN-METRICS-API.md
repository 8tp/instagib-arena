# Admin Metrics API

A read-only HTTP API for pulling game metrics + traffic, designed for scripts,
dashboards, and agents (no browser login required). It exposes the same
aggregates the in-app `/admin` dashboard renders, plus a one-call consolidated
report.

All endpoints live under `/api/admin` and accept **either** auth:

1. **A logged-in admin session** (cookie) — the browser dashboard path; can do
   everything including mutations.
2. **A bearer token** equal to the `ADMIN_API_TOKEN` env var — the headless path.
   **Read-only**: the mutating routes (`/verify`, `/grant`) reject token auth with
   `403 session_required`, so a leaked read token can never change accounts.

If `ADMIN_API_TOKEN` is unset, token auth is disabled entirely (session-only).

## Setup

```bash
# generate a strong token
openssl rand -hex 32
```

- **Local:** add `ADMIN_API_TOKEN=<token>` to your env (or `.env`) and start the server.
- **Production (Railway):** set `ADMIN_API_TOKEN` as a service variable and redeploy.
  The boot log prints `metrics api: … (token auth ENABLED)` when it's active.

Pass it as a header (either form works):

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://instagib.win/api/admin/metrics/report
curl -H "X-Admin-Token: $ADMIN_API_TOKEN"        https://instagib.win/api/admin/metrics/report
```

## Endpoints (read-only — token or admin session)

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/api/admin/metrics/report` | `days` (def 14), `sample` (def 200, max 200) | **One-call snapshot:** `{generatedAt, via, live, overview, timeseries, recentModeBreakdown, weekly}` |
| GET | `/api/admin/metrics/overview` | — | KPIs: accounts, matches, kills/deaths, global accuracy, XP, avg lifetime, DAU/MAU stickiness, + 24h/7d/30d windows |
| GET | `/api/admin/metrics/timeseries` | `days` (def 30) | Dense daily series: matches / logins / registrations / active players (zero-filled) |
| GET | `/api/admin/metrics/retention` | `days` (def 14) | D1/D7 cohort retention by registration day |
| GET | `/api/admin/metrics/matches` | `limit` (def 50, max 200), `before` (keyset id) | Recent recorded matches (kills/deaths/won/headshots/accuracy/offline/xp/mode) |
| GET | `/api/admin/metrics/players` | `sort` (kills\|games\|level\|accuracy\|xp\|recent), `q`, `limit` (def 100) | Searchable player table |
| GET | `/api/admin/metrics/weekly` | — | This week's challenge: participants, runs, winners, fastest clear, top kills, replays stored + bytes, map, fragLimit |
| GET | `/api/admin/metrics/live` | — | `{online, inMatch, rooms}` right now (same as the public `/api/live`) |
| GET | `/api/admin/audit` | `event`, `limit` (def 100) | Recent audit events (logins, registrations, matches, ranked, admin actions) |

### Admin-session-only (mutations — token gets `403 session_required`)

| Method | Path | Body |
|---|---|---|
| GET | `/api/admin/lookup` | `?username=` → that account's admin/verified flags |
| POST | `/api/admin/verify` | `{username, verified?}` |
| POST | `/api/admin/grant` | `{username, admin?}` |

## The consolidated report

`GET /api/admin/metrics/report` is the recommended single call for analysis. Shape:

```jsonc
{
  "generatedAt": 1717800000000,
  "via": "token",                  // or "session"
  "live": { "online": 12, "inMatch": 8, "rooms": 3 },
  "overview": { "totalAccounts": …, "totalMatches": …, "globalAccuracy": …,
                "stickiness": …, "windows": { "day": …, "week": …, "month": … } },
  "timeseries": [ { "day": "2026-06-01", "matches": …, "logins": …,
                    "registrations": …, "activePlayers": … }, … ],
  "recentModeBreakdown": { "sampled": 200, "byMode": { "ffa": …, "duel": …,
                           "tdm": …, "ranked": …, "unknown": … },
                           "online": …, "offline": … },
  "weekly": { "week": "w:2026-06-01", "participants": …, "runs": …, "winners": …,
              "bestTimeMs": …, "topKills": …, "replaysStored": …, "replayBytes": …,
              "map": "causeway", "fragLimit": 20 }
}
```

## Notes & caveats

- Token comparison is constant-time (`crypto.timingSafeEqual`); a wrong/missing
  token returns `403 forbidden`.
- The `/audit` log contains client IPs — treat the token as a sensitive secret.
- Match `mode` is read from the match audit detail; rows logged before mode
  tracking fall under `"unknown"` in `recentModeBreakdown`.
- All aggregates are read-only over data already stored (no new write paths); the
  API adds no load beyond the queries themselves.
