import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The fec-with-moq decoder sources: FEC_DECODER_SRC if set, otherwise the sibling checkout, under the
 * repository's name (fec-with-moq) or its old one (fecing-with-moq), whichever has web/fec-decoder/src.
 * The fec-with-moq page imports it, so the build stops here, with a message, when there is none.
 */
function fecDecoderSrc(): string {
  const env = process.env.FEC_DECODER_SRC;
  if (env !== undefined) return env;
  const tried = ['fec-with-moq', 'fecing-with-moq'].map((d) => resolve(__dirname, '../..', d, 'web/fec-decoder/src'));
  const found = tried.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(`fec-decoder: no fec-with-moq checkout found (tried ${tried.join(', ')}). `
      + 'Clone foucast/fec-with-moq beside this repository, or set FEC_DECODER_SRC to its web/fec-decoder/src.');
  }
  return found;
}

/** Build identity for diagnostics: a run's logs must name the build that produced them. */
function buildId(): string {
  let version = 'unknown';
  try {
    version = (JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch { /* keep 'unknown' */ }
  let sha = 'nogit';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8' }).trim().length > 0;
    if (dirty) sha += '-dirty';
  } catch { /* keep 'nogit' */ }
  return `${version}+${sha}`;
}

/**
 * Vite config for MoQ examples.
 *
 * resolve.alias maps @openmoq/* imports directly to TypeScript source files,
 * bypassing dist/. No `pnpm build` needed during development — edit library
 * source, save, Vite hot-reloads via esbuild.
 */
export default defineConfig({
  define: {
    __PLAYA_BUILD__: JSON.stringify(buildId()),
  },
  server: {
    // Default: localhost only. For mobile/device testing:
    //   VITE_HOST=0.0.0.0 npm run dev
    // or: npx vite --host
    ...(process.env.VITE_HOST ? { host: process.env.VITE_HOST } : {}),
  },
  resolve: {
    alias: {
      '@openmoq/transport': resolve(__dirname, '../packages/transport/src/index.ts'),
      '@openmoq/webtransport': resolve(__dirname, '../packages/webtransport/src/index.ts'),
      '@openmoq/msf': resolve(__dirname, '../packages/msf/src/index.ts'),
      '@openmoq/loc': resolve(__dirname, '../packages/loc/src/index.ts'),
      '@openmoq/locmaf': resolve(__dirname, '../packages/locmaf/src/index.ts'),
      '@openmoq/playback': resolve(__dirname, '../packages/playback/src/index.ts'),
      '@openmoq/player': resolve(__dirname, '../packages/player/src/index.ts'),
      '@openmoq/browser': resolve(__dirname, '../packages/browser/src/index.ts'),
      '@openmoq/playa': resolve(__dirname, '../packages/playa/src/index.ts'),
      // fec-with-moq harness: the FEC decoder, consumed from a checkout of the fec-with-moq
      // repository (web/fec-decoder/src), not copied here. FEC_DECODER_SRC overrides the default
      // sibling checkout (see fecDecoderSrc).
      'fec-decoder': fecDecoderSrc(),
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        catalog: resolve(__dirname, 'catalog/index.html'),
        connect: resolve(__dirname, 'connect/index.html'),
        player: resolve(__dirname, 'player/index.html'),
        simple: resolve(__dirname, 'simple/index.html'),
        broadcast: resolve(__dirname, 'broadcast/index.html'),
        'fec-with-moq': resolve(__dirname, 'fec-with-moq/index.html'),
        'fec-with-moq-demo': resolve(__dirname, 'fec-with-moq/demo.html'),
      },
    },
  },
});
