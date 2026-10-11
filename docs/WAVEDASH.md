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
first-party SameSite=Lax session. Portal accounts remain Instagib accounts;
Wavedash account identity and platform achievements are separate integrations.

## Store assets

The initial listing uses `public/og-image.png` as its cover and a ten-second
clip from the existing Instagib Arena trailer as its preview. Description,
cover, preview, FPS/Multiplayer tags, Keyboard + Mouse input, and English are
configured in the Developer Portal. New releases require no store changes
unless their content or supported controls/languages change.
