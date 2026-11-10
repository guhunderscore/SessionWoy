// Bundles the MV3 extension with esbuild (PRD §7.1 allows "Vite or equivalent": content
// scripts must be single classic files, which esbuild produces directly). The popup and side
// panel are Svelte 5 components compiled by esbuild-svelte (ADR 0003).
//
//   node build.mjs          release build -> dist/      (__E2E__ = false, no debug API)
//   node build.mjs --e2e    test build    -> dist-e2e/  (__E2E__ = true, exposes globalThis.sessionwoy)
//   add --watch to rebuild on change
import { build, context } from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const e2e = process.argv.includes('--e2e');
const outdir = e2e ? 'dist-e2e' : 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('public', outdir, { recursive: true });
cpSync('src/ui/popup/popup.html', `${outdir}/popup.html`);
cpSync('src/ui/sidepanel/sidepanel.html', `${outdir}/sidepanel.html`);

const common = {
  bundle: true,
  target: 'chrome120',
  sourcemap: 'linked',
  logLevel: 'info',
  legalComments: 'none',
  define: { __E2E__: String(e2e) },
  // Removes `if (__E2E__) { … }` from the release build (keeps whitespace readable).
  minifySyntax: true,
};

const ui = {
  ...common,
  format: 'esm',
  outdir,
  minify: true,
  mainFields: ['svelte', 'browser', 'module', 'main'],
  // `production` selects Svelte's production runtime (esm-env) instead of the dev build.
  conditions: ['svelte', 'browser', 'production'],
  plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
};

const configs = [
  { ...common, entryPoints: { background: 'src/background/index.ts' }, format: 'esm', outdir },
  { ...common, entryPoints: { 'content-main': 'src/content/main.ts' }, format: 'iife', outdir },
  { ...common, entryPoints: { 'content-relay': 'src/content/relay.ts' }, format: 'iife', outdir },
  { ...ui, entryPoints: { popup: 'src/ui/popup/main.ts' } },
  { ...ui, entryPoints: { sidepanel: 'src/ui/sidepanel/main.ts' } },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
