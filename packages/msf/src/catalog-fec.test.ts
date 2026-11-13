/**
 * fec-with-moq: the opt-in parse options (MsfParseOptions). A catalog as the FEC publisher writes
 * it: the source track as LOC video with an `x-fec` field, and repair rungs under the unregistered
 * packaging `x-fec-repair`.
 */
import { describe, it, expect } from 'vitest';
import { parseMsfCatalog } from './catalog-msf00.js';

const FEC = { scheme: 'rs-cauchy-gf256', codec: 2, symbolSize: 1100, blockObjects: 12, rungs: ['rep1', 'rep2'],
  blocksPerGroup: 10, objectStride: 256 };
const CATALOG = JSON.stringify({
  version: 'draft-01', generatedAt: 1, tracks: [
    { name: 'src', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, codec: 'av01.0.04M.08',
      width: 640, height: 360, framerate: 60, 'x-fec': FEC },
    { name: 'rep1', packaging: 'x-fec-repair', isLive: true, 'x-fec': { source: 'src', rung: 1 } },
    { name: 'rep2', packaging: 'x-fec-repair', isLive: true, 'x-fec': { source: 'src', rung: 2 } },
  ],
});
const OPTIONS = { skipPackaging: new Set(['x-fec-repair']), keepFields: ['x-fec'] };

describe('MSF parse options (fec-with-moq)', () => {
  it('without options, the unknown packaging is still rejected', () => {
    expect(() => parseMsfCatalog(CATALOG, 'ns')).toThrow(/packaging/);
  });

  it('with options, repair tracks are accepted and left out, and x-fec is kept', () => {
    const cat = parseMsfCatalog(CATALOG, 'ns', OPTIONS);
    expect(cat.tracks.map((t) => t.name)).toEqual(['src']);
    expect(cat.tracks[0]!.extra).toEqual({ 'x-fec': FEC });
    expect(cat.tracks[0]!.codec).toBe('av01.0.04M.08');
  });

  it('options change nothing on a catalog without those fields', () => {
    const plain = JSON.stringify({ version: 'draft-01', tracks: [
      { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.42001f' }] });
    expect(parseMsfCatalog(plain, 'ns', OPTIONS)).toEqual(parseMsfCatalog(plain, 'ns'));
  });

  it('other unknown packaging is still rejected with options', () => {
    const bad = JSON.stringify({ version: 'draft-01', tracks: [{ name: 'x', packaging: 'bogus', isLive: true }] });
    expect(() => parseMsfCatalog(bad, 'ns', OPTIONS)).toThrow(/packaging/);
  });
});
