# FEC with MoQ: test kit

Work in progress on forward error correction for MoQ media in Playa: a test harness, a driver and a
FEC stage behind `config.fec` (default off). The publisher, the repair layer and the design are in
[foucast/fec-with-moq](https://github.com/foucast/fec-with-moq).

This branch (`fec-with-moq-v2`, Nov 2026) starts from upstream Playa `f6dcd57` (Nov 19, 2026) and reads
the three-track catalog below. The older branch `fec-with-moq` (Nov 13) starts from upstream
`4fdb6ea` and reads the earlier catalog, so it won't play the current publisher.

## What is here

- `examples/fec-with-moq/`: a headless test page. It creates one `Player` from URL parameters and
  records what a run needs on `window.playaRun`:
  - each WebTransport session: protocols offered, protocol selected, outcome;
  - player events: state, stall, unstall, error, levels;
  - stats sampled every 100 ms: frames decoded / rendered / dropped, stall count, current time,
    codec, resolution.

  It is built with the other examples (`examples/vite.config.ts`).
- `fec-with-moq/playa_play.py`: a Playwright (Python) driver. It opens the page in headless Chromium
  or Firefox, plays for a set time and prints one JSON object (the page's record plus a summary).
- `examples/fec-with-moq/demo.html`: a demo page for watching in a browser (below).

## Build

The FEC stage's decoder comes from the fec-with-moq repository: the examples build imports its
`web/fec-decoder/src` from a checkout next to this one (or from `FEC_DECODER_SRC`, if set), and stops
with a message naming both when there is none.

```sh
git clone --branch fec-with-moq-v2 https://github.com/foucast/moq-playa.git
git clone --recursive https://github.com/foucast/fec-with-moq.git    # beside moq-playa
cd moq-playa
pnpm install --frozen-lockfile && pnpm -r build          # also builds examples/dist/
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
- **`--cb`:** Playa's `catalogBootstrap`. The default `auto` (SUBSCRIBE plus a Joining FETCH for the
  catalog) works with the fec-with-moq publisher, which answers that FETCH and also sends the catalog
  again as a new group every 2 s.
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
  omit it for a publicly trusted one), `log`. `catalogBootstrap` is Playa's default (`auto`).
- **Overlay** (`overlay=1`): the wall clock, behind-live (the wall clock minus the LOC capture time of
  the frame drawn last), and with FEC on, `FEC blocks seen N  recovered N  abandoned N`, refreshed
  once a second from the FEC stage's own counters.
- **Console:** `fecStats()` returns the stage's counters (null with `fec=0`); `fecStage`,
  `playaPlayer` and `demoLog` are also on `window`.


## The catalog the FEC stage reads (three kinds of track)

The FEC publisher's catalog (version `draft-02`) has three kinds of track:

- **a plain track** (e.g. `video`): `packaging: loc`, a stream per group, one frame per object.
  Any player plays it; with FEC off, Playa plays it on the stock path;
- **the FEC source track** (e.g. `src`): `packaging: x-fec-source`, the same frames as FEC source
  symbols on datagrams. Its `packagingMetadata` (MSF-02 §5.2.5) carries the parameters, e.g.
  `scheme=rs-cauchy-gf256;symbolSize=1100;blockObjects=12;blockSeconds=0.2;blocksPerGroup=10;objectStride=256;rungs=3;plainTrack=video`;
- **repair tracks** (e.g. `rep1`..`rep3`): `packaging: x-fec-repair`, each naming its source and
  rung, e.g. `source=src;rung=1;fraction=0.15`.

Upstream parses `draft-02` and keeps tracks of unknown packaging, leaving them out of selection, but
it drops their `packagingMetadata` (defined only for `loc`). So with `fec` on, the parser leaves the
two FEC kinds out of the catalog's tracks and hands them to the player raw
(`MsfParseOptions.skipPackaging`, `onSkipped`). With `fec` off the catalog parses as upstream. The player selects the plain track as usual, then subscribes to the source track
named for it in its place, and to the repair tracks; the plain track itself is never subscribed.
