import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const mainOutDir = resolve('out/main');
const eagerNodeSqliteImport = /^\s*import\s+(?:(?:[^'"\n]+)\s+from\s+)?['"]node:sqlite['"]\s*;?/m;

function javascriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

const offenders = javascriptFiles(mainOutDir).filter((path) => eagerNodeSqliteImport.test(readFileSync(path, 'utf8')));

if (offenders.length > 0) {
  console.error('[build] Eager node:sqlite import found in the main-process bundle:');
  for (const path of offenders) console.error(`  - ${relative(process.cwd(), path)}`);
  console.error('Keep optional SQLite consumers external or preserve their lazy import boundary.');
  process.exit(1);
}

console.info('[build] Verified main-process bundle has no eager node:sqlite import.');
