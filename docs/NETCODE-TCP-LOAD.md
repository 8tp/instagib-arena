# TCP snapshot load testing

Use the headless load harness to compare snapshot delivery as room size changes:

```sh
PORT=8799 DATA_DIR=/tmp/instagib-netcode NETCODE_DIAG=1 npx tsx server/index.ts
npm run netcode:load -- --players 2 --duration 12 --warmup 2
npm run netcode:load -- --players 8 --duration 12 --warmup 2
```

The harness creates one FFA room, sends realistic moving position uploads at
64 Hz, decodes the viewer's binary state stream, and reports the same core
arrival/buffer metrics as the in-game net-debug overlay. It can model a
constrained TCP viewer link and periodic head-of-line stalls:

```sh
npm run netcode:load -- \
  --players 8 \
  --duration 12 \
  --warmup 2 \
  --link-kbps 140 \
  --stall-every-ms 2000 \
  --stall-ms 140
```

`NETCODE_DIAG=1` adds a five-second server log with actual snapshot timer
cadence, mean encoded frame bytes, maximum observed `socket.bufferedAmount`,
and skipped snapshots.

## June 2026 diagnosis

Unconstrained loopback showed that 8p resampling and encoding were not the
ceiling: the server held approximately 64 Hz, viewer extrapolation was 0%, and
`socket.bufferedAmount` stayed at 0. An 8p frame was 314 bytes, which is below a
typical TCP MSS, so the room-size regression was not caused by a state frame
spanning additional TCP segments.

The scaling failure reproduced when the viewer link was constrained to 140 kbps
with a 140 ms stall every two seconds. The old 8p stream used about 161 kbps,
fell to 52.6 effective snapshots/sec, extrapolated 100% of sampled render
frames, and averaged roughly -1.5 seconds of buffer headroom. The old 2p stream
remained mostly healthy under the same model.

The targeted changes are:

- Quantize downstream state positions to i16 at 1/256 metre precision and
  yaw/pitch to i16 angles. Client position uploads remain f32.
- Quantize the server's resampled position before writing both the snapshot and
  lag-comp history, preserving `render == rewind`.
- Scale the deterministic fixed interpolation delay from 110 ms at 2p to
  170 ms at 8p. Arrival jitter never drives the playback clock.
- Skip absolute state snapshots while a viewer socket has more than 1 KiB
  buffered, allowing a slow TCP queue to drain toward fresh truth.

After the changes, the 8p frame is 234 bytes (about 121 kbps). Under the same
constrained/stalling model, the viewer held 0% extrapolation with 30 ms p05
buffer headroom. Real-match subjective smoothness and the deployed overlay
still need validation because localhost cannot reproduce Railway and player
network paths exactly.
