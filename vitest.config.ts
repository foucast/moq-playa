import { defineConfig, configDefaults } from 'vitest/config';
import { resolve } from 'path';
import { existsSync } from 'fs';

export default defineConfig({
  resolve: {
    // Unit and simulation suites must exercise WORKSPACE SOURCE, not the
    // published `dist`. Each package's `exports` map points at `dist/index.js`,
    // so without these aliases a local `pnpm test` silently tests stale
    // generated code — a real-class composition ran against a prebuilt bundle
    // and made a production fix look like a no-op. CI's build-before-test order
    // masked it rather than preventing it. The published export surface stays
    // covered separately by `smoke:exports`.
    // Mirrors the list in `examples/vite.config.ts`.
    alias: {
      '@openmoq/transport': resolve(__dirname, 'packages/transport/src/index.ts'),
      '@openmoq/webtransport': resolve(__dirname, 'packages/webtransport/src/index.ts'),
      '@openmoq/quic': resolve(__dirname, 'packages/quic/src/index.ts'),
      '@openmoq/msf': resolve(__dirname, 'packages/msf/src/index.ts'),
      '@openmoq/loc': resolve(__dirname, 'packages/loc/src/index.ts'),
      '@openmoq/locmaf': resolve(__dirname, 'packages/locmaf/src/index.ts'),
      '@openmoq/playback': resolve(__dirname, 'packages/playback/src/index.ts'),
      '@openmoq/player': resolve(__dirname, 'packages/player/src/index.ts'),
      '@openmoq/browser': resolve(__dirname, 'packages/browser/src/index.ts'),
      '@openmoq/playa': resolve(__dirname, 'packages/playa/src/index.ts'),
      // fec-with-moq: the FEC decoder for the FEC stage's tests, from a checkout of the fec-with-moq
      // repository: FEC_DECODER_SRC, otherwise the sibling checkout under the repository's name or
      // its old one (fecing-with-moq), the first with web/fec-decoder/src. Without one those tests
      // skip and say so (fec-stage.test.ts); every other suite runs.
      'fec-decoder': process.env.FEC_DECODER_SRC
        ?? (['fec-with-moq', 'fecing-with-moq']
          .map((d) => resolve(__dirname, '..', d, 'web/fec-decoder/src'))
          .find((p) => existsSync(p))
          ?? resolve(__dirname, '../fec-with-moq/web/fec-decoder/src')),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'conformance/media/runner/src/**/*.test.ts',
      'examples/node-relay/src/**/*.test.ts',
      'examples/node-publisher/src/**/*.test.ts',
      'examples/broadcast/**/*.test.ts',
      'examples/player/**/*.test.ts',
      'examples/shared/**/*.test.ts',
      'scripts/**/*.test.ts',
      '_migration/**/*.test.ts',
    ],
    // The external-probe differential lane (`*.diff.test.ts`) requires a built
    // LibMoQ probe via MOQ_MEDIA_PROBE_BIN; it is opt-in via `test:corpus:diff`
    // and must NEVER run in the default suite.
    exclude: [...configDefaults.exclude, '**/*.diff.test.ts'],
  },
});
