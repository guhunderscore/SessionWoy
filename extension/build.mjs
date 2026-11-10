// Bundles the MV3 extension into dist/ with esbuild (PRD §7.1 allows "Vite or equivalent":
// content scripts must be single classic files, which esbuild produces directly).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('public', outdir, { recursive: true });
cpSync('src/popup/popup.html', `${outdir}/popup.html`);

const common = { bundle: true, target: 'chrome120', sourcemap: 'linked', logLevel: 'info', legalComments: 'none' };

const configs = [
  { ...common, entryPoints: { background: 'src/background/index.ts' }, format: 'esm', outdir },
  { ...common, entryPoints: { popup: 'src/popup/popup.ts' }, format: 'esm', outdir },
  { ...common, entryPoints: { 'content-main': 'src/content/main.ts' }, format: 'iife', outdir },
  { ...common, entryPoints: { 'content-relay': 'src/content/relay.ts' }, format: 'iife', outdir },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
