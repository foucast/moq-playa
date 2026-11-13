// Types for the fec-with-moq FEC decoder (web/fec-decoder/src in that repository), which Vite
// resolves through the `fec-decoder` alias (vite.config.ts). Only what the harness imports.
declare module 'fec-decoder/decoder.ts' {
  export function recoverSymbols(
    k: number, source: Map<number, Uint8Array>, repair: Map<number, Uint8Array>,
  ): { ok: true; value: Uint8Array[] } | { ok: false; reason: string };
}
declare module 'fec-decoder/layout.ts' {
  export interface Layout { symbolSize: number; sizes: number[]; starts: number[]; k: number }
  export function layoutBlock(sizes: number[], symbolSize?: number): Layout;
  export function symbolsForObject(lay: Layout, i: number): number[];
}
declare module 'fec-decoder/wire.ts' {
  export function parseRepairObject(p: Uint8Array): {
    codec: number; indexed: boolean; sizes: number[]; index: number | null; symbol: Uint8Array;
  };
}
