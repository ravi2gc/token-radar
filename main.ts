// Token Launch Radar — entrypoint.
//
// Reads the sealed DefiLlama snapshot, builds the ranked board with the
// value model in lib/model.ts, and writes everything the dashboard needs
// into the output directory: board.json, the dashboard files, the
// screenshots, and dossier.json via the kit's buildDossier.
//
// Usage: node main.ts [--input <snapshot.json>]
//   Output directory: MAKEFUN_OUTPUT_DIR, or /output by default.
//   The snapshot path defaults to /input/snapshot.json.
// No network, no clock, no randomness: two runs write byte-identical bytes.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string } {
  let input = '/input/snapshot.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) {
      input = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node main.ts [--input <snapshot.json>]');
      process.exit(0);
    }
  }
  return { input };
}

function main(): void {
  const { input } = parseArgs(process.argv.slice(2));
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const snapshotPath = resolve(input);

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  const board = buildBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');

  const dashSrc = join(repoRoot, 'dashboard');
  const shotsSrc = join(repoRoot, 'screenshots');
  if (!existsSync(dashSrc)) throw new Error('dashboard/ is missing from the repository');
  if (!existsSync(shotsSrc)) throw new Error('screenshots/ is missing from the repository');
  cpSync(dashSrc, join(outDir, 'dashboard'), { recursive: true });
  cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  console.log(
    `token-radar: ${board.counts.total} protocols, ${board.counts.pre_token} pre-token, ` +
      `${board.counts.watchlist} watchlist; R2=${board.model.r2.toFixed(3)}, ` +
      `LOO median error=${board.model.loo_median_ape_pct.toFixed(1)}% -> ${outDir}`,
  );
}

main();
