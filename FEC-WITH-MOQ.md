# FEC with MoQ in Playa (branch `fec-with-moq`)

This branch adds [FEC with MoQ](https://github.com/foucast/fec-with-moq) to Playa: receiver-chosen forward error correction, where repair data arrives on extra MoQ tracks and the player subscribes to as many of them as its path needs. How the tracks are laid out is in that repository's `DESIGN.md`.

The branch is one commit on upstream `4fdb6ea` (v0.6.0 + 1). Moving it onto current upstream is still to do.

## What is here

- **The FEC stage** (`packages/player/src/fec-stage.ts`), behind `config.fec` (default off; without it the player is upstream's). For a LOC video track whose MSF catalog entry carries `x-fec`, the player also subscribes to the repair tracks (`x-fec-repair`, received as datagrams), rebuilds each block's lost frames from repair, and hands frames to the normal LOC path in order. A block still incomplete at its deadline is given up, and playback resumes at the next group. Tests: `fec-stage.test.ts`, and the catalog changes in `packages/msf/src/catalog-fec.test.ts`.
- **The decoder** is not copied here: it is `web/fec-decoder` of the fec-with-moq repository. Clone that repository **next to this one** (so `../fec-with-moq` exists), or set `FEC_DECODER_SRC` to its `web/fec-decoder/src`. Without it, the FEC stage's tests skip and the examples build stops with a message.
- `examples/fec-with-moq/demo.html`: a demo page for watching in a browser, with an on-screen FEC counter (below).
- `examples/fec-with-moq/` (`index.html`): a headless test page that records each run on `window.playaRun`: WebTransport sessions, player events, and stats sampled every 100 ms.
- `fec-with-moq/playa_play.py`: a Playwright (Python) driver that opens the test page in headless Chromium or Firefox, plays for a set time and prints one JSON object.

## Build

```sh
git clone https://github.com/foucast/fec-with-moq.git      # next to this repository
pnpm install --frozen-lockfile && pnpm -r build             # also builds examples/dist/
```

## Run it against a relay

```sh
cd examples/dist && python3 -m http.server 8082 --bind 127.0.0.1 &
python3 fec-with-moq/playa_play.py https://RELAY:PORT/PATH NAMESPACE \
    --browser chromium --secs 60 --draft 18 [--hash SHA256HEX] [--cb subscribe] [--log info]
```

- **`--hash`:** the SHA-256 of a self-signed certificate (ECDSA P-256, valid at most 14 days),
  passed as `serverCertificateHashes`. Omit it for a publicly trusted certificate. To compute it:
  `openssl x509 -in cert.pem -outform der | sha256sum`.
- **`--draft`:** sets the WebTransport `protocols` offer (`moqt-18`). The selected protocol is in
  the output (`summary.protocol`).
- **`--cb`:** Playa's `catalogBootstrap`. The default `auto` works with an MSF publisher that
  answers a Joining FETCH for the catalog.
- **Firefox:** run with WebTransport and its datagrams enabled, and autoplay allowed. The driver sets
  these preferences.

The page relies on `autoplay: true` and does not call `play()` itself. A second `play()` is an
invalid state transition in Playa (`playing → playing`), and in testing it stopped the video track
from ever being subscribed.

## Watch it in a browser: the demo page

`examples/fec-with-moq/demo.html` (built with the examples) plays one broadcast for a person, with
an optional on-screen overlay. Serve `examples/dist` on localhost (a secure context, which
WebTransport needs) and open:

```
http://localhost:PORT/fec-with-moq/demo.html?url=https://RELAY:PORT/PATH&ns=NAMESPACE&ver=draft-18&fec=1&rungs=3&overlay=1&label=TEXT
```

- **Parameters** (named as in the Shaka fork's FEC page where Playa allows): `url`, `ns`, `ver`
  (`draft-18` or `18`), `fec` (1, the default, or 0 for the stock path), `rungs` (default 3),
  `deadline` (ms, default 600), `play` (1, the default: autoplay, muted; 0: click to start),
  `overlay`, `label` (`_` for spaces), `certHash` (hex SHA-256 of a self-signed relay certificate;
  omit it for a publicly trusted one), `log`. `catalogBootstrap` is `subscribe`.
- **Overlay** (`overlay=1`): the wall clock, behind-live (the wall clock minus the LOC capture time of
  the frame drawn last), and with FEC on, `FEC blocks seen N  recovered N  abandoned N`, refreshed
  once a second from the FEC stage's own counters.
- **Console:** `fecStats()` returns the stage's counters (null with `fec=0`); `fecStage`,
  `playaPlayer` and `demoLog` are also on `window`.

