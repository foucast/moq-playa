/**
 * fec-with-moq: the FEC stage on real publisher output. The vectors (six 12-frame blocks of a
 * 120-frame GOP: source-symbol and repair datagram payloads, and the LOC frames they carry) and the
 * Reed-Solomon decoder come from a checkout of the fec-with-moq repository: FEC_DECODER_SRC,
 * otherwise the sibling checkout under the repository's name or its old one (fecing-with-moq), the
 * first with web/fec-decoder/src. Without one these tests skip, with a warning naming FEC_DECODER_SRC.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MoqtObject, MoqtObjectData } from '@openmoq/transport';
import { ObjectStatus, varint } from '@openmoq/transport';
import { FecStage, parseFecInfo, type FecDecoder, type FecInfo } from './fec-stage.js';
import { SubscriptionManager } from './subscription-manager.js';

const SIBLINGS = ['fec-with-moq', 'fecing-with-moq']
  .map((d) => resolve(__dirname, '../../../..', d, 'web/fec-decoder/src'));
const SRC = process.env.FEC_DECODER_SRC ?? SIBLINGS.find((p) => existsSync(p)) ?? SIBLINGS[0];
const VECTORS = resolve(SRC, '../test/media-vectors-gop120.json');
const HAVE = existsSync(resolve(SRC, 'decoder.ts')) && existsSync(VECTORS);
if (!HAVE) {
  console.warn(`fec-stage.test.ts: FEC decoder tests skipped: no decoder at ${SRC}. `
    + 'Clone foucast/fec-with-moq beside this repository, or set FEC_DECODER_SRC to its web/fec-decoder/src.');
}

interface Block { block: number; k: number; m: number; sizes: number[]; objects: string[];
  source_objects: string[]; repair_objects: string[] }

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** As the publisher's catalog: a group is a 120-frame GOP, 10 blocks of 12 frames. */
const INFO: FecInfo = { symbolSize: 1100, blockObjects: 12, blocksPerGroup: 10, objectStride: 256, rungs: ['rep1', 'rep2'] };

function datagram(group: number, object: number, payload: Uint8Array): MoqtObjectData {
  return {
    kind: 'data', trackAlias: varint(7n), groupId: varint(BigInt(group)), subgroupId: varint(0n),
    objectId: varint(BigInt(object)), publisherPriority: undefined, payload,
  } as MoqtObjectData;
}

describe.skipIf(!HAVE)('FecStage (real publisher vectors)', () => {
  let decoder: FecDecoder;
  let blocks: Block[];

  beforeAll(async () => {
    const dec = await import('fec-decoder/decoder.ts');
    const lay = await import('fec-decoder/layout.ts');
    const wire = await import('fec-decoder/wire.ts');
    decoder = {
      parseRepairObject: wire.parseRepairObject, layoutBlock: lay.layoutBlock,
      symbolsForObject: lay.symbolsForObject, recoverSymbols: dec.recoverSymbols,
    } as FecDecoder;
    blocks = (JSON.parse(readFileSync(VECTORS, 'utf8')) as { blocks: Block[] }).blocks;
  });

  function setup(deadlineMs = 600) {
    let t = 1_000;
    const out: MoqtObject[] = [];
    const stage = new FecStage(INFO, { decoder, deliver: (o) => out.push(o), deadlineMs, now: () => t, tickMs: 0 });
    return { stage, out, advance: (ms: number) => { t += ms; }, };
  }

  /** Push block q of group g: source symbols except `lostSource`, and the given repair indices. */
  function push(stage: FecStage, g: number, q: number, b: Block, lostSource: number[] = [], repair: number[] = []) {
    b.source_objects.forEach((p, j) => {
      if (!lostSource.includes(j)) stage.pushSource(datagram(g, q * INFO.objectStride + j, b64(p)));
    });
    for (const j of repair) stage.pushRepair(j < 6 ? 'rep1' : 'rep2', datagram(g, q * INFO.objectStride + j, b64(b.repair_objects[j]!)));
  }

  const data = (out: MoqtObject[]) => out.filter((o): o is MoqtObjectData => o.kind === 'data');
  const ends = (out: MoqtObject[]) => out.filter((o) => o.kind === 'gap');

  it('releases whole blocks frame by frame, in order, as the original LOC objects', () => {
    const { stage, out } = setup();
    blocks.forEach((b, q) => push(stage, 0, q, b));
    const frames = data(out);
    expect(frames).toHaveLength(72);
    frames.forEach((f, n) => {
      const q = Math.floor(n / 12), i = n % 12;
      expect(f.groupId).toBe(0n);
      expect(f.objectId).toBe(BigInt(q * 12 + i));
      const want = b64(blocks[q]!.objects[i]!);
      const propsLen = (want[0]! << 8) | want[1]!;
      expect(Buffer.from(f.payload)).toEqual(Buffer.from(want.subarray(2 + propsLen)));
      expect(Buffer.from(f.extensions!)).toEqual(Buffer.from(want.subarray(2, 2 + propsLen)));
      expect(f.properties).toBe(f.extensions);
    });
    expect(stage.stats.blocksWhole).toBe(6);
    expect(stage.stats.decodeCount).toBe(0);
    expect(ends(out)).toHaveLength(0); // group 0 not finished (10 blocks)
  });

  it('decodes lost source symbols, including the key frame, and timestamps the decode', () => {
    const { stage, out } = setup();
    const b = blocks[0]!;
    push(stage, 0, 0, b, [0, 1, 2], [0, 1, 7]);
    const frames = data(out);
    expect(frames).toHaveLength(12);
    frames.forEach((f, i) => {
      const want = b64(b.objects[i]!);
      expect(Buffer.from(f.payload)).toEqual(Buffer.from(want.subarray(2 + ((want[0]! << 8) | want[1]!))));
    });
    expect(stage.stats.blocksRecovered).toBe(1);
    expect(stage.stats.decodeCount).toBe(1);
    expect(stage.stats.decodeLog[0]![0]).toBe(1_000);
    expect(stage.stats.repairBytes).toEqual({ rep1: 2 * 1126, rep2: 1126 });
    expect(stage.blockLog[0]).toMatchObject({ id: 0, outcome: 'recovered', k: 37, received: 34, repair: 3 });
  });

  it('ends a group with END_OF_GROUP after its last block', () => {
    const { stage, out } = setup();
    for (let q = 0; q < 10; q++) push(stage, 0, q, blocks[q % 6]!);
    const last = out[out.length - 1]!;
    expect(last.kind).toBe('gap');
    expect(last.groupId).toBe(0n);
    expect((last as { status: bigint }).status).toBe(ObjectStatus.END_OF_GROUP);
    expect(last.objectId).toBe(120n);
    expect(data(out)).toHaveLength(120);
  });

  it('gives a block up at the deadline once a later block arrives, ends its group, resumes at the next key frame', () => {
    const { stage, out, advance } = setup(600);
    push(stage, 0, 0, blocks[0]!);
    push(stage, 0, 1, blocks[1]!, [5, 6, 7], [0]); // 3 lost, 1 repair: can't decode
    push(stage, 0, 2, blocks[2]!);
    advance(599);
    stage.tick();
    expect(stage.stats.blocksAbandoned).toBe(0);
    advance(1);
    stage.tick();
    expect(stage.stats.blocksAbandoned).toBe(1);
    // Frames of block 1 before its first lost symbol were released; the rest are dropped.
    const g0 = data(out).filter((f) => f.groupId === 0n);
    expect(g0.length).toBeGreaterThanOrEqual(12);
    expect(g0.length).toBeLessThan(24);
    expect(ends(out).map((e) => e.groupId)).toEqual([0n]);
    // Blocks 2.. of group 0 are skipped; group 1 starts at Object 0.
    push(stage, 0, 3, blocks[3]!);
    push(stage, 1, 0, blocks[0]!);
    const g1 = data(out).filter((f) => f.groupId === 1n);
    expect(g1).toHaveLength(12);
    expect(g1[0]!.objectId).toBe(0n);
    expect(stage.stats.blocksSkipped).toBeGreaterThanOrEqual(2);
    expect(stage.stats.decodeFailures).toHaveLength(0);
  });

  it('waits for the next group when it joins mid-group', () => {
    const { stage, out } = setup();
    push(stage, 3, 4, blocks[4]!);
    push(stage, 3, 5, blocks[5]!);
    expect(data(out)).toHaveLength(0);
    push(stage, 4, 0, blocks[0]!);
    expect(data(out).map((f) => f.groupId)).toEqual(new Array(12).fill(4n));
    expect(stage.stats.blocksSkipped).toBe(0); // joining isn't loss
  });

  it('accepts repair before any source without releasing or throwing', () => {
    const { stage, out } = setup();
    const b = blocks[3]!;
    for (let j = 0; j < b.m; j++) stage.pushRepair('rep1', datagram(0, 3 * 256 + j, b64(b.repair_objects[j]!)));
    expect(out).toHaveLength(0);
    expect(stage.stats.repairSymbols).toBe(b.m);
  });

  it('withdraws on release', () => {
    const { stage } = setup();
    let released = 0;
    stage.onRelease(() => released++);
    stage.release();
    stage.release();
    expect(released).toBe(1);
    stage.pushSource(datagram(0, 0, b64(blocks[0]!.source_objects[0]!)));
    expect(stage.stats.sourceSymbols).toBe(0);
  });
});

describe('parseFecInfo', () => {
  it('reads the publisher catalog entry', () => {
    expect(parseFecInfo({
      scheme: 'rs-cauchy-gf256', codec: 2, symbolSize: 1100, blockObjects: 12, blockSeconds: 0.2,
      rungs: ['rep1', 'rep2', 'rep3'], rungFractions: [0.25, 0.25, 0.25], blocksPerGroup: 10, objectStride: 256,
    })).toEqual({ symbolSize: 1100, blockObjects: 12, blocksPerGroup: 10, objectStride: 256, rungs: ['rep1', 'rep2', 'rep3'] });
  });
  it('refuses anything else', () => {
    expect(parseFecInfo(undefined)).toBeNull();
    expect(parseFecInfo({ scheme: 'other' })).toBeNull();
    expect(parseFecInfo({ scheme: 'rs-cauchy-gf256', codec: 1 })).toBeNull(); // zfec: not this decoder
  });
});

describe('SubscriptionManager FEC routing', () => {
  const obj = (alias: bigint, object = 0n): MoqtObject => ({
    kind: 'data', trackAlias: varint(alias), groupId: varint(0n), subgroupId: varint(0n),
    objectId: varint(object), publisherPriority: undefined, payload: new Uint8Array([1, 2, 3]),
  } as MoqtObject);

  it('routes as upstream when nothing is registered', async () => {
    const sm = new SubscriptionManager();
    sm.registerTrack(1n, 'src', 'video', 'loc');
    const seen: string[] = [];
    sm.onObject = (_m, name) => seen.push(name);
    await sm.routeObject(0n, obj(1n));
    await sm.routeObject(0n, obj(2n));
    expect(seen).toEqual(['src']);
  });

  it('diverts the source track to the stage, and passes the stage\'s frames through', async () => {
    const sm = new SubscriptionManager();
    sm.registerTrack(1n, 'src', 'video', 'loc');
    const toStage: MoqtObject[] = [];
    const toPipeline: MoqtObject[] = [];
    sm.fecSources.set('src', (o) => toStage.push(o));
    sm.onObject = (_m, _n, o) => toPipeline.push(o);
    await sm.routeObject(0n, obj(1n));
    expect(toStage).toHaveLength(1);
    expect(toPipeline).toHaveLength(0);
    await sm.routeObject(0n, obj(1n, 5n), undefined, undefined, true);
    expect(toPipeline.map((o) => o.objectId)).toEqual([5n]);
  });

  it('sends repair aliases only to the stage: never to onObject (stats, bandwidth estimator)', async () => {
    const sm = new SubscriptionManager();
    sm.registerTrack(1n, 'src', 'video', 'loc');
    const repair: MoqtObject[] = [];
    let onObject = 0;
    sm.fecRepair.set(9n, (o) => repair.push(o));
    sm.onObject = () => { onObject++; };
    await sm.routeObject(0n, obj(9n));
    expect(repair).toHaveLength(1);
    expect(onObject).toBe(0);
  });
});
