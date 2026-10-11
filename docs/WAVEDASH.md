# Wavedash distribution

Public game: https://wavedash.com/games/instagib-arena

Developer Portal: https://wavedash.com/dev-portal/8tp/instagib-arena

`wavedash.toml` targets the Instagib Arena project under the **8tp** team. The
Wavedash build hosts the browser client; the authoritative server and APIs stay
at `https://instagib.win`. `.env.wavedash` contains public build settings only.
The Wavedash SDK is injected by the platform and initialized when the game menu
mounts. Memory routing handles Wavedash's `/embed` entrypoint.

## Upload an update

Install the official CLI: https://docs.wavedash.com/getting-started/quickstart

Authenticate with `wavedash auth login`, or supply `WAVEDASH_TOKEN` through your
shell's secret manager. Never add the API key to a Vite environment variable,
source file, build, or commit.

```sh
npm run build:wavedash
wavedash build push -m "Describe the update"
```

Open the returned playtest URL. Read the game iframe's **origin** (the URL's
scheme and hostname, excluding query parameters). Add that exact HTTPS origin
to the server's comma-separated `PORTAL_ORIGINS` variable and redeploy. Keep
the currently published origin listed while testing the new build.

Verify loading, guest multiplayer, solo play, and optional accounts. Then:

```sh
wavedash publish BUILD_ID --yes
```

The published game has a different origin from its playtest. Add the public
game iframe's exact origin to `PORTAL_ORIGINS` and redeploy before sharing the
release. Each new build changes both origins, so repeat this for every upload.
Do not allow every `*.builds.wavedashcdn.com` game to access account sessions.

Railway's variable changes rebuild the configured GitHub branch. Until this
server patch is merged there, use `railway variable set --skip-deploys` and
deploy the patched checkout with `railway up --detach` after changing origins.
Otherwise an automatic rebuild can replace the portal support with older code.

## Accounts and server permissions

Trusted portal origins receive credentialed CORS, the resource-policy header
required by Wavedash's isolated frame, permission for API writes, and WebSocket
access. Other cross-site writes remain blocked. Portal login creates a Secure,
HttpOnly, SameSite=None, Partitioned cookie; the ordinary website retains its
first-party SameSite=Lax session. Wavedash builds automatically exchange the signed-in player's gameplay JWT
for an Instagib session. The server verifies RS256 against Wavedash's JWKS,
issuer, audience, expiry, gameplay scope, and `WAVEDASH_GAME_CLOUD_IDS`.
Configure both the public and playtest cloud IDs (not the developer project ID):

```
WAVEDASH_GAME_CLOUD_IDS=mx766dp51dw5hdazmky9js6k3s8g28j3,mx71jy4adp5eh9p0hap6c3qk5s8g2wqc
```

The stable Wavedash user ID maps to a separate Instagib account. Existing names
are never automatically linked or promoted to staff. The account shares the
same server-backed XP, inventory, career, ranked access, and site leaderboards
as a regular account. Passwordless platform accounts cannot use password login.
Ordinary username/password accounts remain available in both builds.

## Platform career

Six numeric stats are defined: `total_kills`, `total_deaths`, `total_games`,
`total_wins`, `best_kill_streak`, and `headshots`. The visible numeric descending
leaderboards are `career-frags`, `career-wins`, and `best-kill-streak`.
Achievements: `first_frag` (1 frag), `first_win` (1 win), `centurion` (100 frags),
`rail_master` (1,000 frags), and `unstoppable` (10-frag streak).

The client reads authenticated server career totals on sign-in, every 15 seconds,
and when the page becomes visible. Bot/practice XP never enters these totals.
It writes through the injected SDK, checks stat readiness, flushes immediately,
and reports failed persistence. Best-score updates are idempotent. Instagib's
server remains the canonical source of progress; no client POST can submit
online career totals. Wavedash's public SDK permits client score writes, so its
platform boards do not add a separate server-verified anti-cheat guarantee.
No developer API key is needed or included in the browser or game backend.

## Store assets

The listing uses `public/wavedash-cover.webp` as its cover and a ten-second
clip from the existing Instagib Arena trailer as its preview. Description,
cover, preview, FPS/Multiplayer/Arena Shooter/Competitive/Fast-Paced tags, Keyboard + Mouse input, and English are
configured in the Developer Portal. The description and built-in imagegen prompt
are saved under `design/marketing/`; site social previews use the same cover. New releases require no store changes
unless their content or supported controls/languages change.
