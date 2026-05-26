/**
 * Verifies that the committed JSONL fixtures under
 * `electron/__tests__/__fixtures__/` match the sha256 manifest stored at
 * `electron/__tests__/__fixtures__/.checksum`.
 *
 * Used as the `pnpm test:fixtures:verify` step in CI: if a fixture was
 * hand-edited without re-running `pnpm fixtures:gen`, this script exits
 * non-zero and the build fails.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = dirname(__dirname);
const FIXTURES_DIR = join(REPO_ROOT, 'electron', '__tests__', '__fixtures__');
const MANIFEST = join(FIXTURES_DIR, '.checksum');

function listFixtureFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFixtureFiles(full));
    } else if (name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out.sort();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function main(): void {
  if (!existsSync(MANIFEST)) {
    console.error(`[fixtures] manifest missing: ${MANIFEST}. Run \`pnpm fixtures:gen\` first.`);
    process.exit(1);
  }
  const manifest = readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [hash, ...rest] = l.split('  ');
      return { hash, file: rest.join('  ') };
    });

  const expected = new Map(manifest.map((m) => [m.file, m.hash]));
  const actualFiles = listFixtureFiles(FIXTURES_DIR).map((f) => relative(FIXTURES_DIR, f));

  let failed = false;

  for (const file of actualFiles) {
    const wantHash = expected.get(file);
    const haveHash = sha256(join(FIXTURES_DIR, file));
    if (!wantHash) {
      console.error(`[fixtures] new file not in manifest: ${file} (sha256 ${haveHash})`);
      failed = true;
      continue;
    }
    if (wantHash !== haveHash) {
      console.error(`[fixtures] checksum mismatch for ${file}: expected ${wantHash}, got ${haveHash}`);
      failed = true;
    }
    expected.delete(file);
  }

  for (const stale of expected.keys()) {
    console.error(`[fixtures] manifest references missing file: ${stale}`);
    failed = true;
  }

  if (failed) {
    console.error(`[fixtures] verification failed. Run \`pnpm fixtures:gen\` to regenerate.`);
    process.exit(1);
  }

  console.info(`[fixtures] verified ${actualFiles.length} files OK`);
}

main();
