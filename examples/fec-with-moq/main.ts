/**
 * Headless test harness: one Player, driven by URL parameters, with what a run needs exposed on
 * `window.playaRun` for a driver (fec-with-moq/playa_play.py) to read. Uses only the public Player
 * API; the WebTransport constructor is wrapped to record the options passed and the protocol the
 * server selected.
 *
 *   ?url=https://host:port/path  relay WebTransport URL
 *   &ns=live                     namespace (slash-separated)
 *   &v=18                        MOQT draft
 *   &hash=<hex>                  SHA-256 of a self-signed certificate (serverCertificateHashes)
 *   &latency=<ms>                targetLatencyMs (omitted: Playa's default)
 *   &log=info                    Playa log level
 *   &cb=subscribe                moqtPlayerConfig.catalogBootstrap (omitted: Playa's 'auto')
 *   &fec=2                       FEC on (moqtPlayerConfig.fec), with this many repair rungs
 *                                (omitted: FEC off, the stock path)
 *   &deadline=600                FEC block deadline, ms
 *
 * Frames drawn: every new `videoPresentation` (the canvas renderer's last draw) is logged as
 * [draw time ms, behind-live ms], polled each animation frame; stalls are measured from the gaps
 * between draws by the driver, not from Playa's `stall` event (detection time only, no unstall).
 * Behind-live = wall clock − the frame's LOC capture timestamp.
 */

import { Player } from '@openmoq/playa';
import type { FecStage } from '@openmoq/player';
import { recoverSymbols } from 'fec-decoder/decoder.ts';
import { layoutBlock, symbolsForObject } from 'fec-decoder/layout.ts';
import { parseRepairObject } from 'fec-decoder/wire.ts';

declare const __PLAYA_BUILD__: string;

const params = new URLSearchParams(location.search);
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);

const run = {
  build: __PLAYA_BUILD__,
  userAgent: navigator.userAgent,
  params: Object.fromEntries(params),
  webtransport: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  stats: [] as Array<Record<string, unknown>>,
  errors: [] as string[],
  state: 'init',
  /** [renderer draw time ms (renderedAtUs / 1000), behind-live ms at the poll] per new frame. */
  frames: [] as Array<[number, number]>,
  /** performance.timeOrigin: wall-clock ms = timeOrigin + a draw time. */
  timeOrigin: performance.timeOrigin,
  fec: null as null | Record<string, unknown>,
};
(window as any).playaRun = run;

// Record each WebTransport session: options offered, protocol selected, outcome.
const NativeWT = (window as any).WebTransport;
if (NativeWT) {
  (window as any).WebTransport = function (url: string, options?: any) {
    const rec: Record<string, unknown> = {
      atMs: now(), url,
      protocols: options?.protocols ?? null,
      certHashes: options?.serverCertificateHashes?.length ?? 0,
    };
    run.webtransport.push(rec);
    const wt = new NativeWT(url, options);
    wt.ready.then(() => {
      rec.readyMs = now();
      rec.protocol = wt.protocol ?? null;
    }, (e: unknown) => {
      rec.failedMs = now();
      rec.error = String(e);
    });
    return wt;
  } as any;
  (window as any).WebTransport.prototype = NativeWT.prototype;
}

function hexToBuffer(hex: string): ArrayBuffer {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out.buffer;
}

async function main(): Promise<void> {
  const hash = params.get('hash');
  const fecRungs = params.get('fec');
  let stage: FecStage | null = null;
  const latency = params.get('latency');
  const player = new Player(document.getElementById('player'), {
    url: params.get('url') ?? '',
    namespace: params.get('ns') ?? 'live',
    draftVersion: Number(params.get('v') ?? 18) as 14 | 16 | 18 | 22,
    ...(hash ? { certHash: hexToBuffer(hash) } : {}),
    ...(latency ? { targetLatencyMs: Number(latency) } : {}),
    autoplay: true,
    muted: true,
    moqtPlayerConfig: {
      ...(params.get('cb') ? { catalogBootstrap: params.get('cb') as 'auto' | 'joining-fetch' | 'strict' | 'subscribe' } : {}),
      logLevel: (params.get('log') ?? 'warn') as 'none' | 'error' | 'warn' | 'info' | 'debug',
      ...(fecRungs !== null ? {
        fec: {
          enabled: true,
          rungs: Number(fecRungs),
          deadlineMs: Number(params.get('deadline') ?? 600),
          decoder: { parseRepairObject, layoutBlock, symbolsForObject, recoverSymbols },
          onStage: (s: FecStage) => { stage = s; (window as any).playaFecStage = s; },
        },
      } : {}),
    },
  });
  (window as any).playaPlayer = player;

  const events = ['ready', 'play', 'pause', 'playing', 'ended', 'levelsloaded', 'qualitychange',
    'stall', 'unstall', 'error', 'statechange'] as const;
  for (const type of events) {
    player.on(type as any, (e: any) => {
      const ev: Record<string, unknown> = { atMs: now(), type };
      if (e && typeof e === 'object') {
        for (const [k, v] of Object.entries(e)) {
          if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) ev[k] = v;
        }
      }
      run.events.push(ev);
    });
  }

  // Each new draw, once: poll the renderer's last-draw record every animation frame.
  let lastDraw = -1;
  const poll = (): void => {
    const p = player.videoPresentation;
    if (p && p.renderedAtUs !== lastDraw) {
      lastDraw = p.renderedAtUs;
      const behind = p.frameTimestampUs !== null ? Date.now() - Number(p.frameTimestampUs) / 1000 : NaN;
      run.frames.push([Math.round(p.renderedAtUs / 100) / 10, Math.round(behind)]);
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);

  setInterval(() => {
    const s = player.stats;
    if (stage) {
      const { decodeLog, ...counters } = stage.stats;
      run.fec = { ...counters, decodeLog, blockLog: stage.blockLog };
    }
    run.stats.push({
      atMs: now(), state: player.state, currentTimeMs: player.currentTime,
      framesDecoded: s.framesDecoded, framesRendered: s.framesRendered, framesDropped: s.framesDropped,
      stallCount: s.stallCount, timeToFirstFrameMs: s.timeToFirstFrameMs, bitrate: s.bitrate,
      videoCodec: s.videoCodec, resolution: s.resolution ? `${s.resolution.width}x${s.resolution.height}` : null,
      media: player.activeMediaType,
    });
    run.state = player.state;
  }, 100);

  try {
    await player.load();
    // autoplay starts playback once the catalog is in; a second play() is an invalid transition
    run.events.push({ atMs: now(), type: 'loaded' });
  } catch (e) {
    run.errors.push(String(e));
    run.state = 'load-failed';
  }
}

window.addEventListener('error', (e) => run.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => run.errors.push(String(e.reason)));
void main();
