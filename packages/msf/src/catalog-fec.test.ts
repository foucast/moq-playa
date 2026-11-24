/**
 * fec-with-moq: the opt-in parse options (MsfParseOptions). A catalog as the FEC publisher writes
 * it (three kinds of track): a plain LOC video track for every player, the FEC source track
 * (`x-fec-source`, datagrams) and repair rungs (`x-fec-repair`), the FEC parameters in
 * packagingMetadata (MSF-02 §5.2.5), version draft-02.
 */
import { describe, it, expect } from 'vitest';
import { parseMsfCatalog } from './catalog-msf00.js';
import { isTrackPackagingSupported } from './selection.js';

const SRC = { name: 'src', packaging: 'x-fec-source', isLive: true,
  packagingMetadata: 'scheme=rs-cauchy-gf256;symbolSize=1100;blockObjects=12;blockSeconds=0.2;'
    + 'blocksPerGroup=10;objectStride=256;rungs=2;plainTrack=video' };
const REP = [1, 2].map((r) => ({ name: `rep${r}`, packaging: 'x-fec-repair', isLive: true,
  packagingMetadata: `source=src;rung=${r};fraction=0.15` }));
const VIDEO = { name: 'video', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1,
  codec: 'av01.0.04M.08', width: 640, height: 360, framerate: 60, bitrate: 1_000_000 };
const CATALOG = JSON.stringify({ version: 'draft-02', generatedAt: 1, tracks: [VIDEO, SRC, ...REP] });

function options(skipped: Array<Record<string, unknown>>) {
  return { skipPackaging: new Set(['x-fec-source', 'x-fec-repair']),
    onSkipped: (t: Readonly<Record<string, unknown>>) => { skipped.push({ ...t }); } };
}

describe('MSF parse options (fec-with-moq)', () => {
  it('without options, the FEC tracks parse but lose their packagingMetadata and are not selectable', () => {
    const cat = parseMsfCatalog(CATALOG, 'ns');
    expect(cat.tracks.map((t) => t.name)).toEqual(['video', 'src', 'rep1', 'rep2']);
    const src = cat.tracks.find((t) => t.name === 'src')!;
    expect(src.packagingMetadata).toEqual({});
    expect(isTrackPackagingSupported(src, { msfDraft: 'draft-02' })).toBe(false);
    expect(isTrackPackagingSupported(cat.tracks[0]!, { msfDraft: 'draft-02' })).toBe(true);
  });

  it('with options, only the plain track is a catalog track; the FEC tracks are handed over raw', () => {
    const skipped: Array<Record<string, unknown>> = [];
    const cat = parseMsfCatalog(CATALOG, 'ns', options(skipped));
    expect(cat.tracks.map((t) => t.name)).toEqual(['video']);
    expect(cat.tracks[0]!.codec).toBe('av01.0.04M.08');
    expect(skipped).toEqual([SRC, ...REP]);
  });

  it('options change nothing on a catalog without FEC tracks', () => {
    const plain = JSON.stringify({ version: 'draft-02', tracks: [VIDEO] });
    expect(parseMsfCatalog(plain, 'ns', options([]))).toEqual(parseMsfCatalog(plain, 'ns'));
  });

  it('a draft-01 catalog with an FEC track is still rejected without options', () => {
    const old = JSON.stringify({ version: 'draft-01', tracks: [VIDEO, ...REP] });
    expect(() => parseMsfCatalog(old, 'ns')).toThrow(/packaging is required/);
  });
});
