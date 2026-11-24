/**
 * fec-with-moq: forward error correction for a LOC video track whose catalog entry carries an
 * `x-fec` description. Behind `config.fec` (default off).
 *
 * The track's Objects are source symbols of blocks of LOC frames; repair symbols come on separate
 * rung tracks (`x-fec.rungs`), as OBJECT_DATAGRAMs. Every symbol Object, source or repair, is
 *
 *   codec:u8 | n_frames:u8 | size[0]:u16 ... size[n-1]:u16 | [index:u16] | symbol
 *
 * so one of them is enough to rebuild the block's symbol layout. Each frame is
 * `props_len:u16 | LOC properties | payload`, the properties already in the session's encoding.
 *
 * A frame is released to the normal LOC path as soon as its own symbols are all present and every
 * earlier frame of the block has been released. Once a block holds as many symbols as it has
 * source symbols, the rest are decoded. A block still incomplete at the deadline, with a later
 * block already arriving, is given up: its remaining frames are dropped and playback resumes at the
 * next group (key frame). The stage emits END_OF_GROUP after each group, because the LOC pipeline
 * otherwise waits out its gap timeout before every group.
 *
 * The Reed-Solomon arithmetic is injected (`FecConfig.decoder`): the fec-with-moq project's
 * `web/fec-decoder`, consumed from that repository, not copied here.
 *
 * Group and object numbering: a MoQ group is a GOP of `blocksPerGroup` blocks; symbol j of the
 * group's q-th block is Object q * objectStride + j. Released frame i of block q is Object
 * q * blockObjects + i of the same group.
 */

import type { MoqtObject, MoqtObjectData } from '@openmoq/transport';
import { ObjectStatus, varint } from '@openmoq/transport';

/** The decoder interface the stage needs (web/fec-decoder's exports). */
export interface FecDecoder {
  parseRepairObject(p: Uint8Array): { sizes: number[]; index: number | null; symbol: Uint8Array };
  layoutBlock(sizes: number[], symbolSize?: number): FecLayout;
  symbolsForObject(layout: FecLayout, i: number): number[];
  recoverSymbols(
    k: number,
    source: Map<number, Uint8Array>,
    repair: Map<number, Uint8Array>,
  ): { ok: true; value: Uint8Array[] } | { ok: false; reason: string };
}

export interface FecLayout {
  symbolSize: number;
  sizes: number[];
  starts: number[];
  k: number;
}

/** `config.fec`: the flag and its settings. */
export interface FecConfig {
  /** Off unless true: without it the catalog, routing and playback are upstream's. */
  readonly enabled: boolean;
  readonly decoder: FecDecoder;
  /** Give a block up this long after its first symbol, once a later block is arriving. Default 600. */
  readonly deadlineMs?: number;
  /** Repair rungs to subscribe (the first N of `x-fec.rungs`). Default: all. */
  readonly rungs?: number;
  /** Called with each stage the player creates (counters, block log). */
  readonly onStage?: (stage: FecStage) => void;
}

/** The parts of the catalog's `x-fec` the stage uses. */
export interface FecInfo {
  readonly symbolSize: number;
  readonly blockObjects: number;
  readonly blocksPerGroup: number;
  readonly objectStride: number;
  readonly rungs: readonly string[];
}

/** `x-fec` from a source track's catalog entry (the catalog before packagingMetadata), or null. */
export function parseFecInfo(raw: unknown): FecInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const x = raw as Record<string, unknown>;
  if (x['scheme'] !== 'rs-cauchy-gf256' || Number(x['codec'] ?? 2) !== 2) return null;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && v > 0 ? v : d);
  return {
    symbolSize: num(x['symbolSize'], 1100),
    blockObjects: num(x['blockObjects'], 12),
    blocksPerGroup: Math.max(1, Math.floor(num(x['blocksPerGroup'], 1))),
    objectStride: num(x['objectStride'], 256),
    rungs: Array.isArray(x['rungs']) ? x['rungs'].filter((r): r is string => typeof r === 'string') : [],
  };
}

/** MSF-02 §5.2.5 packagingMetadata: `key=value` pairs separated by `;`, the first occurrence wins. */
export function parsePackagingMetadata(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'string') return out;
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const key = pair.slice(0, eq);
    if (!(key in out)) out[key] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * The FEC description of a plain LOC track `plainName` from the catalog's FEC tracks (the raw
 * track objects the parser left out): the `x-fec-source` track whose packagingMetadata names it
 * (`plainTrack=`), with its parameters, and the `x-fec-repair` tracks naming that source
 * (`source=`), in rung order. Null when there is none, or its scheme isn't this decoder's.
 */
export function fecInfoFromCatalog(
  plainName: string, tracks: Iterable<Readonly<Record<string, unknown>>>,
): (FecInfo & { readonly source: string }) | null {
  const all = [...tracks];
  const src = all.find((t) => t['packaging'] === 'x-fec-source'
    && parsePackagingMetadata(t['packagingMetadata'])['plainTrack'] === plainName);
  if (!src || typeof src['name'] !== 'string') return null;
  const m = parsePackagingMetadata(src['packagingMetadata']);
  if (m['scheme'] !== 'rs-cauchy-gf256') return null;
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : d;
  };
  const rungs = all
    .filter((t) => t['packaging'] === 'x-fec-repair' && typeof t['name'] === 'string'
      && parsePackagingMetadata(t['packagingMetadata'])['source'] === src['name'])
    .map((t) => ({ name: t['name'] as string, rung: num(parsePackagingMetadata(t['packagingMetadata'])['rung'], Infinity) }))
    .sort((a, b) => a.rung - b.rung)
    .map((r) => r.name);
  return {
    source: src['name'],
    symbolSize: num(m['symbolSize'], 1100),
    blockObjects: num(m['blockObjects'], 12),
    blocksPerGroup: Math.max(1, Math.floor(num(m['blocksPerGroup'], 1))),
    objectStride: num(m['objectStride'], 256),
    rungs,
  };
}

interface Block {
  readonly id: number;
  readonly layout: FecLayout;
  readonly k: number;
  readonly source: Map<number, Uint8Array>;
  readonly repair: Map<number, Uint8Array>;
  received: number;
  released: number;
  decoded: boolean;
  readonly firstMs: number;
}

/** One finished block, for the block log. */
export interface FecBlockRecord {
  readonly id: number;
  readonly k: number;
  readonly received: number;
  readonly repair: number;
  readonly outcome: 'whole' | 'recovered' | 'abandoned' | 'missing';
  /** Wall-clock ms when the block finished. */
  readonly atMs: number;
}

export interface FecStats {
  blocksSeen: number;
  blocksWhole: number;
  blocksRecovered: number;
  blocksAbandoned: number;
  blocksMissing: number;
  blocksSkipped: number;
  framesReleased: number;
  framesDropped: number;
  framesDroppedToKey: number;
  sourceSymbols: number;
  sourceLost: number;
  repairSymbols: number;
  repairBytes: Record<string, number>;
  endOfGroups: number;
  decodeCount: number;
  decodeMsTotal: number;
  decodeMsMax: number;
  /** Every decode as [wall-clock start ms, duration ms] (first 10,000). */
  decodeLog: Array<[number, number]>;
  decodeFailures: string[];
}

const LOG_CAP = 10_000;

export class FecStage {
  readonly info: FecInfo;
  readonly stats: FecStats = {
    blocksSeen: 0, blocksWhole: 0, blocksRecovered: 0, blocksAbandoned: 0, blocksMissing: 0,
    blocksSkipped: 0, framesReleased: 0, framesDropped: 0, framesDroppedToKey: 0,
    sourceSymbols: 0, sourceLost: 0, repairSymbols: 0, repairBytes: {}, endOfGroups: 0,
    decodeCount: 0, decodeMsTotal: 0, decodeMsMax: 0, decodeLog: [], decodeFailures: [],
  };
  readonly blockLog: FecBlockRecord[] = [];

  private readonly decoder: FecDecoder;
  private readonly deadlineMs: number;
  private readonly deliver: (obj: MoqtObject) => void;
  private readonly now: () => number;
  private readonly blocks = new Map<number, Block>();
  /** The block being released. */
  private next: number | null = null;
  /** Frames can't be decoded until the next group's key frame (at the start, and after a loss). */
  private toKeyFrame: boolean;
  /** The last group END_OF_GROUP was sent for. */
  private lastEndedGroup = -1;
  private template: MoqtObjectData | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cleanups: Array<() => void> = [];
  private _released = false;

  constructor(info: FecInfo, opts: {
    decoder: FecDecoder;
    deliver: (obj: MoqtObject) => void;
    deadlineMs?: number;
    now?: () => number;
    /** Tick period; 0 = no timer (the caller calls tick()). Default 50. */
    tickMs?: number;
  }) {
    this.info = info;
    this.decoder = opts.decoder;
    this.deliver = opts.deliver;
    this.deadlineMs = opts.deadlineMs ?? 600;
    this.now = opts.now ?? Date.now;
    this.toKeyFrame = info.blocksPerGroup > 1;
    const tickMs = opts.tickMs ?? 50;
    if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs);
  }

  get released(): boolean {
    return this._released;
  }

  /** Run on release (rung unsubscribes, routing removal). */
  onRelease(fn: () => void): void {
    if (this._released) fn();
    else this.cleanups.push(fn);
  }

  /** A source-symbol Object of the FEC track. */
  pushSource(obj: MoqtObjectData): void {
    if (this._released || !obj.payload.byteLength) return;
    this.template = obj;
    const parsed = this.parse(obj);
    if (!parsed) return;
    const [id, j] = this.locate(obj);
    const block = this.blockFor(id, parsed.sizes);
    if (!block) return;
    if (!block.source.has(j)) {
      block.source.set(j, parsed.symbol);
      block.received++;
      this.stats.sourceSymbols++;
    }
    this.pump();
  }

  /** A repair-symbol Object of rung `rung`. */
  pushRepair(rung: string, obj: MoqtObjectData): void {
    if (this._released || !obj.payload.byteLength) return;
    this.stats.repairSymbols++;
    this.stats.repairBytes[rung] = (this.stats.repairBytes[rung] ?? 0) + obj.payload.byteLength;
    const parsed = this.parse(obj);
    if (!parsed) return;
    const [id, j] = this.locate(obj);
    const block = this.blockFor(id, parsed.sizes);
    if (!block) return;
    const index = parsed.index ?? j;
    if (!block.repair.has(index)) block.repair.set(index, parsed.symbol);
    this.pump();
  }

  tick(): void {
    this.pump();
  }

  release(): void {
    if (this._released) return;
    this._released = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const fn of this.cleanups.splice(0)) {
      try { fn(); } catch { /* best effort */ }
    }
  }

  private parse(obj: MoqtObjectData): { sizes: number[]; index: number | null; symbol: Uint8Array } | null {
    try {
      return this.decoder.parseRepairObject(obj.payload);
    } catch (err) {
      this.noteFailure(`unparseable symbol g${obj.groupId} o${obj.objectId}: ${String(err)}`);
      return null;
    }
  }

  private locate(obj: MoqtObjectData): [number, number] {
    const group = Number(obj.groupId);
    const object = Number(obj.objectId);
    const { blocksPerGroup, objectStride } = this.info;
    if (blocksPerGroup === 1) return [group, object];
    return [group * blocksPerGroup + Math.floor(object / objectStride), object % objectStride];
  }

  private blockFor(id: number, sizes: number[]): Block | null {
    if (this.next !== null && id < this.next) return null;
    let block = this.blocks.get(id);
    if (!block) {
      const layout = this.decoder.layoutBlock(sizes, this.info.symbolSize);
      block = {
        id, layout, k: layout.k, source: new Map(), repair: new Map(),
        received: 0, released: 0, decoded: false, firstMs: this.now(),
      };
      this.blocks.set(id, block);
      this.stats.blocksSeen++;
      if (this.next === null) this.next = id;
    }
    return block;
  }

  /** Release what can be released, block by block in order. */
  private pump(): void {
    const bpg = this.info.blocksPerGroup;
    if (!this.template) return; // nothing of the source track yet: no alias to release frames on
    while (this.next !== null && !this._released) {
      if (this.next % bpg === 0) this.toKeyFrame = false;
      if (this.toKeyFrame) {
        // Without the key frame before them these frames can't be decoded: drop them, whether or
        // not they are here yet. (Joining mid-group isn't loss: count once frames have flowed.)
        const skipped = this.blocks.get(this.next);
        if (this.stats.framesReleased) {
          this.stats.blocksSkipped++;
          this.stats.framesDroppedToKey += skipped ? skipped.layout.sizes.length : this.info.blockObjects;
        }
        this.blocks.delete(this.next);
        this.advance(this.next + 1);
        continue;
      }
      const block = this.blocks.get(this.next);
      if (!block) {
        // Nothing of this block arrived. Skip it once a later one is late.
        if (!this.laterBlockIsLate(this.next)) return;
        this.stats.blocksMissing++;
        this.record({ id: this.next, k: 0, received: 0, repair: 0, outcome: 'missing', atMs: this.now() });
        this.giveUpGroup(this.next);
        this.advance(this.next + 1);
        continue;
      }
      this.releaseReady(block);
      if (block.released < block.layout.sizes.length && !block.decoded
          && block.source.size + block.repair.size >= block.k && block.source.size < block.k) {
        this.decode(block);
        this.releaseReady(block);
      }
      if (block.released >= block.layout.sizes.length) {
        if (block.decoded) this.stats.blocksRecovered++;
        else this.stats.blocksWhole++;
        this.finish(block, block.decoded ? 'recovered' : 'whole');
        continue;
      }
      if (this.now() - block.firstMs >= this.deadlineMs && this.blocks.size > 1) {
        this.stats.blocksAbandoned++;
        this.stats.framesDropped += block.layout.sizes.length - block.released;
        this.finish(block, 'abandoned');
        this.giveUpGroup(block.id);
        continue;
      }
      return;
    }
  }

  private laterBlockIsLate(id: number): boolean {
    for (const block of this.blocks.values()) {
      if (block.id > id && this.now() - block.firstMs >= this.deadlineMs) return true;
    }
    return false;
  }

  /** The rest of block id's group can't be decoded: end the group now and wait for a key frame. */
  private giveUpGroup(id: number): void {
    this.toKeyFrame = true;
    this.endGroup(Math.floor(id / this.info.blocksPerGroup));
  }

  private finish(block: Block, outcome: FecBlockRecord['outcome']): void {
    this.stats.sourceLost += Math.max(0, block.k - block.received);
    this.record({
      id: block.id, k: block.k, received: block.received, repair: block.repair.size, outcome, atMs: this.now(),
    });
    this.blocks.delete(block.id);
    this.advance(block.id + 1);
  }

  /** Move to block `id`; a group boundary passed ends the group before it. */
  private advance(id: number): void {
    this.next = id;
    if (id % this.info.blocksPerGroup === 0) this.endGroup(id / this.info.blocksPerGroup - 1);
  }

  private endGroup(group: number): void {
    if (group <= this.lastEndedGroup || !this.template) return;
    this.lastEndedGroup = group;
    this.stats.endOfGroups++;
    this.deliver({
      kind: 'gap',
      trackAlias: this.template.trackAlias,
      groupId: varint(BigInt(group)),
      subgroupId: varint(0n),
      objectId: varint(BigInt(this.info.blocksPerGroup * this.info.blockObjects)),
      status: ObjectStatus.END_OF_GROUP,
    } as MoqtObject);
  }

  private record(r: FecBlockRecord): void {
    if (this.blockLog.length < LOG_CAP) this.blockLog.push(r);
  }

  private noteFailure(reason: string): void {
    if (this.stats.decodeFailures.length < 100) this.stats.decodeFailures.push(reason);
  }

  private decode(block: Block): void {
    const startMs = this.now();
    const t0 = performance.now();
    const result = this.decoder.recoverSymbols(block.k, block.source, block.repair);
    const ms = performance.now() - t0;
    if (!result.ok) {
      this.noteFailure(`block ${block.id}: ${result.reason}`);
      return;
    }
    result.value.forEach((symbol, j) => block.source.set(j, symbol));
    block.decoded = true;
    this.stats.decodeCount++;
    this.stats.decodeMsTotal += ms;
    this.stats.decodeMsMax = Math.max(this.stats.decodeMsMax, ms);
    if (this.stats.decodeLog.length < LOG_CAP) {
      this.stats.decodeLog.push([startMs, Math.round(ms * 1000) / 1000]);
    }
  }

  /** Release every frame of the block, in order, whose symbols are all here. */
  private releaseReady(block: Block): void {
    const sizes = block.layout.sizes;
    while (block.released < sizes.length) {
      const i = block.released;
      const indices = this.decoder.symbolsForObject(block.layout, i);
      if (!indices.every((j) => block.source.has(j))) return;
      this.emit(block, i, indices);
      block.released++;
    }
  }

  private emit(block: Block, i: number, indices: number[]): void {
    const { layout } = block;
    const size = layout.sizes[i]!;
    const start = layout.starts[i]!;
    const s = this.info.symbolSize;
    const bytes = new Uint8Array(size);
    let written = 0;
    for (const j of indices) {
      const symbol = block.source.get(j)!;
      const from = Math.max(start, j * s) - j * s;
      const to = Math.min(start + size, (j + 1) * s) - j * s;
      bytes.set(symbol.subarray(from, to), written);
      written += to - from;
    }
    const propsLength = (bytes[0]! << 8) | bytes[1]!;
    const properties = propsLength ? bytes.subarray(2, 2 + propsLength) : undefined;
    const template = this.template!;
    const bpg = this.info.blocksPerGroup;
    this.stats.framesReleased++;
    this.deliver({
      kind: 'data',
      trackAlias: template.trackAlias,
      groupId: varint(BigInt(Math.floor(block.id / bpg))),
      subgroupId: varint(0n),
      objectId: varint(BigInt((block.id % bpg) * this.info.blockObjects + i)),
      publisherPriority: template.publisherPriority,
      properties,
      extensions: properties,
      payload: bytes.subarray(2 + propsLength),
    } as MoqtObject);
  }
}
