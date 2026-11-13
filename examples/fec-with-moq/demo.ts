/**
 * FEC demo page: one Player on a live MSF broadcast whose video track carries FEC source symbols,
 * with repair rungs, for a person watching in a browser. The counterpart of the Shaka fork's
 * fec-with-moq/fec-player.html; the parameter names follow it where Playa allows. Uses only the
 * public Player API (the FEC stage comes from `fec.onStage`). The headless test page is index.html.
 *
 *   ?url=https://host:port/path  relay WebTransport URL (a publicly trusted certificate needs nothing more)
 *   &ns=live                     namespace (slash-separated)
 *   &ver=draft-18                MOQT draft: draft-14 | draft-16 | draft-18 | draft-22, or the number (default 18)
 *   &fec=1                       FEC stage on (default); 0 = the stock path, no stage
 *   &rungs=3                     repair rungs to subscribe (default 3)
 *   &deadline=600                FEC block deadline, ms (default 600)
 *   &play=1                      start on its own (default): autoplay, muted. 0 = no autoplay; click the
 *                                video to start. The page never calls play() on top of autoplay: in Playa
 *                                that is an invalid transition (playing -> playing) and the video track is
 *                                never subscribed.
 *   &overlay=1                   draw over the video: the wall clock, behind-live, and with the FEC stage on
 *                                its line "FEC blocks seen N  recovered N  abandoned N", refreshed once a
 *                                second from the stage's own counters (left out with fec=0)
 *   &label=text                  caption for the overlay (_ for spaces)
 *   &certHash=<hex>              SHA-256 of a self-signed relay certificate (serverCertificateHashes)
 *   &log=warn                    Playa log level
 *
 * catalogBootstrap is "subscribe" (the publisher answers no Joining FETCH for the catalog).
 *
 * Behind-live = the wall clock (Date.now()) - the LOC capture timestamp of the frame the renderer
 * drew last (`player.videoPresentation.frameTimestampUs`), as in the headless harness. Unlike the
 * Shaka page's overlay, it doesn't add the FEC publisher's block-stamping offset (11/60 s).
 *
 * Console: window.fecStats() returns a copy of the FEC stage's counters with the subscribed rung
 * count (null with fec=0, or before the stage exists); window.fecStage is the stage itself and
 * window.playaPlayer the Player. window.demoLog lists player events and errors.
 */

import { Player } from '@openmoq/playa';
import type { FecStage } from '@openmoq/player';
import { recoverSymbols } from 'fec-decoder/decoder.ts';
import { layoutBlock, symbolsForObject } from 'fec-decoder/layout.ts';
import { parseRepairObject } from 'fec-decoder/wire.ts';

const q = new URLSearchParams(location.search);
const demoLog: string[] = [];
const log = (...a: unknown[]): void => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  demoLog.push(`${new Date().toISOString()} ${s}`);
  console.log(`[demo] ${s}`);
};
(window as any).demoLog = demoLog;

function hexToBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out.buffer;
}

const fecOn = q.get('fec') !== '0';
const rungs = Number(q.get('rungs') ?? 3);
let stage: FecStage | null = null;
(window as any).fecStats = () => (stage ? { rungs, ...stage.stats } : null);

function main(): void {
  const certHash = q.get('certHash');
  const autoplay = q.get('play') !== '0';
  const draft = Number((q.get('ver') ?? '18').replace(/^draft-/, ''));
  const player = new Player(document.getElementById('player'), {
    url: q.get('url') ?? '',
    namespace: q.get('ns') ?? 'live',
    draftVersion: draft as 14 | 16 | 18 | 22,
    ...(certHash ? { certHash: hexToBuffer(certHash) } : {}),
    autoplay,
    muted: true,
    moqtPlayerConfig: {
      catalogBootstrap: 'subscribe',
      logLevel: (q.get('log') ?? 'warn') as 'none' | 'error' | 'warn' | 'info' | 'debug',
      ...(fecOn ? {
        fec: {
          enabled: true,
          rungs,
          deadlineMs: Number(q.get('deadline') ?? 600),
          decoder: { parseRepairObject, layoutBlock, symbolsForObject, recoverSymbols },
          onStage: (s: FecStage) => { stage = s; (window as any).fecStage = s; },
        },
      } : {}),
    },
  });
  (window as any).playaPlayer = player;
  for (const type of ['ready', 'playing', 'stall', 'unstall', 'error', 'statechange'] as const) {
    player.on(type as any, (e: any) => {
      const f: Record<string, unknown> = {};
      if (e && typeof e === 'object') {
        for (const [k, v] of Object.entries(e)) {
          if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) f[k] = v;
        }
      }
      log('event', type, f);
    });
  }
  if (!autoplay) {
    document.getElementById('box')!.addEventListener('click', () => {
      if (player.state !== 'playing') void player.play();
    });
  }

  if (q.get('overlay') === '1') {
    const o = document.getElementById('o')!;
    o.style.display = 'block';
    const label = (q.get('label') ?? '').replace(/_/g, ' ');
    // The FEC stage's counters, the same numbers as window.fecStats(), refreshed once a second.
    let fecLine = '';
    setInterval(() => {
      const s = stage?.stats;
      fecLine = s ? `\nFEC blocks seen ${s.blocksSeen}  recovered ${s.blocksRecovered}`
        + `  abandoned ${s.blocksAbandoned}` : '';
    }, 1000);
    setInterval(() => {
      const now = Date.now();
      const wall = new Date(now).toISOString().slice(11, 23);
      const ts = player.videoPresentation?.frameTimestampUs;
      const behind = ts != null ? `behind live ${((now - Number(ts) / 1000) / 1000).toFixed(2)} s` : 'waiting';
      o.textContent = `${label}\nwall ${wall} UTC\n${behind}${fecLine}`;
    }, 50);
  }

  player.load().then(() => log('loaded'), (e: unknown) => log('LOAD FAILED', String(e)));
}

window.addEventListener('error', (e) => log('error', String(e.message)));
window.addEventListener('unhandledrejection', (e) => log('unhandledrejection', String(e.reason)));
main();
