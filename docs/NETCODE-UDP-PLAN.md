# Netcode: the UDP-transport ceiling (and how to break it)

> Status: **Phase 1 (transport seam) shipped; Phase 2 (WebTransport datagram
> channel) built & locally verified on branch `netcode/udp-webtransport`,
> deployment gated on UDP ingress.** The seam (`sendUnreliable` /
> `onUnreliableBytes`, both sides) is in main-line code with zero behavior
> change. The datagram channel (server `WT_PORT` + `transport-wt.ts`, client
> `?wt=1` flag, AUTH/AUTH_OK slot binding, WS auto-fallback + starvation
> watchdog, E2E-proven by `scripts/wt-probe.ts`: 63 Hz state over datagrams,
> datagram pos uplink, WS fallback <1 s) waits on the §5 host decision —
> Railway has no UDP ingress.
> The current TCP/WebSocket stack — after the 64Hz
> pairing, lean+meta snapshot split, adaptive jitter buffer, and `TCP_NODELAY` —
> is genuinely good; this is about the *tail* (lossy wifi/mobile), not the median.

## 1. The ceiling: TCP head-of-line blocking

We run the game over **WebSocket, which is TCP**. TCP guarantees reliable,
in-order delivery — and that guarantee is exactly what hurts a realtime game:

- When one segment is lost, TCP **holds every later segment in the kernel buffer
  until the lost one is retransmitted** (~1 RTT later). Your 64Hz snapshot stream
  stops cold for that window, then delivers a burst.
- Our adaptive jitter buffer + dead-reckoning extrapolation hide brief stalls,
  but a sustained loss spike on wifi/cellular still produces the classic "freeze,
  then snap" you can't fully tune away over TCP.

UDP-based transports don't retransmit by default: a lost snapshot is simply
**skipped**, and we interpolate toward the next one. For a stream of *idempotent
absolute state* (which ours now is), losing a packet costs nothing — the next
one fully replaces it.

> Disabling Nagle (`TCP_NODELAY`, done) removes the *sender-side* batching delay,
> but it cannot remove head-of-line blocking — that's inherent to TCP's ordering
> guarantee. Only a different transport removes it.

## 2. Why we're already 90% ready

Everything that makes a UDP migration hard has already been done, for unrelated
smoothness reasons:

| Prerequisite | Status | Why it matters for UDP |
| --- | --- | --- |
| Snapshots are **idempotent absolute state**, not deltas | ✅ done | A dropped packet needs no recovery — just skip it. Delta streams can't tolerate loss without acks/baselines. |
| **Static profile split** onto a reliable `meta` channel | ✅ done | Identity/cosmetics still need reliability; only the high-rate `pos`/`state` go unreliable. Clean seam. |
| **Loss-tolerant client** (jitter buffer + capped extrapolation) | ✅ done | The client already glides through gaps instead of freezing. |
| Lag-comp keyed to a **client-reported `renderTime`** | ✅ done | Hit-reg is transport-agnostic: it rewinds to what you saw, however the bytes arrived. |

So the migration is "swap the pipe for the two hot message types," not "rewrite
the netcode."

## 3. The two real options

Both give browser↔server **unreliable datagrams**. Both require **UDP ingress**
to the server (see §5 — this is the gating operational question).

### Option A — WebTransport (HTTP/3 / QUIC datagrams)  ← recommended if infra allows

- One connection exposes both **reliable ordered streams** and **unreliable
  datagrams** (`writeable`/`datagrams`), over QUIC (UDP).
- **Now Baseline (March 2026):** Chrome 97+, Edge 98+, Firefox 114+, **Safari
  26.4+** (macOS/iOS), Opera, Samsung Internet. Cross-browser-safe today.
- No SDP/ICE/DTLS handshake — it's a `new WebTransport(url)` and away you go.
- **Server gap:** Node has **no built-in** WebTransport server. Use
  [`@fails-components/webtransport`](https://github.com/fails-components/webtransport)
  (native addon) in-process, or terminate QUIC in a small Go/Rust sidecar and
  forward to the game loop.
- **Caveats:** requires a valid TLS 1.3 cert (QUIC mandates it); the W3C spec is
  still a Working Draft (minor breaking changes possible); some corporate/mobile
  networks filter **UDP:443**, so a **WebSocket fallback is mandatory**.

### Option B — WebRTC DataChannel (unreliable mode)

- `RTCDataChannel` with `{ ordered: false, maxRetransmits: 0 }` = UDP-like.
  [`geckos.io`](https://github.com/geckosio/geckos.io) wraps this in a
  WebSocket-like client/server API built for exactly this (HTML5 games over UDP
  via Node).
- **Pros:** mature, battle-tested for browser games, works today everywhere
  WebRTC does.
- **Cons:** heavier setup — SDP offer/answer (exchanged over our existing WS),
  ICE candidate gathering, DTLS handshake, a **STUN** server (TURN is rarely
  needed since our server has a public IP). More moving parts than WebTransport.

## 4. Target architecture (hybrid, both options)

Keep WebSocket as the **reliable control channel**; add an **unreliable datagram
channel** for only the two hot message types.

```
reliable (WS / WT-stream):  hello join leave resume vote ping pong
                            welcome joined meta kill respawn beam
                            vote-* round chat   ← must not be lost/reordered
unreliable (WT-datagram / DataChannel):
                            up:   pos        (64Hz)
                            down: state      (64Hz, idempotent — loss = skip)
```

Client (`src/game/net.ts`): introduce a tiny transport seam —
`sendUnreliable(bytes)` / `onUnreliable(cb)` — with two implementations:
1. **WS-only** (today): unreliable == reliable, zero behavior change.
2. **WS + datagram**: `pos`/`state` ride the datagram channel; everything else
   stays on WS. If the datagram channel doesn't open within ~1.5s (UDP blocked),
   **auto-fall back** to impl #1 for the session.

Server: a datagram endpoint that feeds the **same** room/snapshot/lag-comp code.
`roomSnapshot()` and the `pos` handler don't change — only how their bytes travel.

## 5. The gating question: UDP ingress on the host

Both options need the platform to route **UDP** to the container. Today we're on
**Railway**, which is TCP/HTTP-oriented; UDP ingress is the open question and
likely the deciding constraint. Realistic shapes:

- **If Railway can't forward UDP:** keep the web app + reliable WS on Railway,
  and run the **datagram endpoint on a UDP-capable host** (Fly.io supports UDP;
  a small VPS; or a Go/Pion sidecar with a public UDP port). The client connects
  WS→Railway for control and datagram→that host for `pos`/`state`.
- **If we want one box:** move the whole game server to a UDP-capable host.

This is an ops decision with real cost; it's the main reason this is a *plan*.

## 6. Migration phases

- **Phase 0 — prerequisites:** ✅ done (idempotent lean snapshots, reliable meta,
  adaptive buffer, NODELAY, 64Hz). Already shipped on `feat/netcode-smoothness`.
- **Phase 1 — transport seam:** ✅ shipped — `sendUnreliable`/`onUnreliableBytes`
  on `NetClient`, `decodeUnreliable`/`sendUnreliable` server-side, both
  defaulting to the existing WS, plus a stale/duplicate-frame guard on the
  client snapshot buffer (inert over TCP, required once datagrams can reorder).
  Verified zero behavior change against the load-harness baselines.
- **Phase 2 — datagram endpoint:** ✅ built (Option A, WebTransport) on branch
  `netcode/udp-webtransport`: server `WT_PORT` + `server/transport-wt.ts`
  (self-signed dev cert or `WT_CERT_FILE`/`WT_KEY_FILE`, discovery via
  `/api/wt-info`), client `src/game/transport-wt.ts` behind `?wt=1`, slot
  binding by clientId+resumeToken over the datagram pipe, 1.5 s connect
  timeout, 2 s starvation watchdog, auto-fallback to WS. E2E:
  `scripts/wt-probe.ts`. **Merging it waits on UDP ingress** (§5) — Railway
  has none, so the endpoint needs a UDP-capable host (`PUBLIC_WT_URL`).
- **Phase 3 — measure & default:** collect real loss/jitter/RTT; tune the adaptive
  buffer's floor down further when on datagrams (no HoL → smaller buffer is safe);
  make datagrams the default where the channel establishes.

## 7. What does NOT change

The lag-comp contract (client-reported `renderTime` → server rewind), entity
interpolation, the adaptive jitter buffer, the snapshot/meta split, and all
anti-cheat. We're swapping the byte pipe for two message types, nothing else.

## 8. Expected payoff vs. cost

- **Payoff:** eliminates head-of-line freezes on lossy links — the connections
  that feel worst today. Lower tail latency; the adaptive buffer can run a smaller
  floor. On already-clean connections the gain is marginal (TCP+NODELAY is fine).
- **Cost:** a UDP-capable datagram endpoint (infra $ + ops), a server-side QUIC/
  WebRTC stack (sidecar or addon), and a fallback path to maintain. Non-trivial.

## 9. Recommendation

1. **Ship the current TCP stack** (64Hz + adaptive buffer + NODELAY) and judge it
   in real play first — it may be more than enough for our population.
2. If the tail (mobile/wifi loss) still bites, do **Phase 1** (the transport seam)
   regardless — it's cheap and de-risks everything after.
3. For Phase 2, **prefer WebTransport** now that it's Baseline (simpler than
   WebRTC, no SDP/ICE), *provided* we can get UDP:443 ingress; otherwise use
   **geckos.io/WebRTC**, which is proven and works on more network paths. Either
   way, **keep the WebSocket fallback** — UDP:443 is filtered on enough networks
   that reliability-of-connection beats latency for those users.

---

### Sources
- [TCP head-of-line / why UDP for games — MDN: WebRTC data channels](https://developer.mozilla.org/en-US/docs/Games/Techniques/WebRTC_data_channels)
- [WebTransport API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
- [WebTransport is now Baseline (2026)](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/)
- [`@fails-components/webtransport` (Node server)](https://github.com/fails-components/webtransport)
- [geckos.io — UDP for browser games over WebRTC + Node](https://github.com/geckosio/geckos.io)
- [Valve — Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
- [Gaffer On Games — Snapshot Interpolation / Compression](https://gafferongames.com/post/snapshot_interpolation/)
