'use strict';

const { randomBytes } = require('node:crypto');
const { mkdirSync, rmSync, unlinkSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { getAsset, isSea } = require('node:sea');

if (!isSea()) {
  process.stderr.write('kai-plugin-host must run from its signed SEA executable\n');
  process.exit(64);
}
if (process.argv.slice(2).length > 0) {
  process.stderr.write('kai-plugin-host does not accept command-line arguments\n');
  process.exit(64);
}

process.umask(0o077);
const extractionDir = join(tmpdir(), `kai-plugin-runtime-${process.pid}-${randomBytes(12).toString('hex')}`);
const runtimePath = join(extractionDir, 'runtime.cjs');
const zodCodecPath = join(extractionDir, 'zod-wire-codec.js');

try {
  mkdirSync(extractionDir, { recursive: false, mode: 0o700 });
  writeFileSync(runtimePath, Buffer.from(getAsset('runtime.cjs')), { flag: 'wx', mode: 0o400 });
  writeFileSync(zodCodecPath, Buffer.from(getAsset('zod-wire-codec.js')), { flag: 'wx', mode: 0o400 });
  process.once('exit', () => rmSync(extractionDir, { recursive: true, force: true }));
  const requireFromDisk = createRequire(runtimePath);
  const runtime = requireFromDisk(runtimePath);
  const startup = runtime.startSeaPluginHost({
    syncWorkerSource: getAsset('sync-worker.cjs', 'utf8'),
  });
  // The runtime bundle is resident after require(). Keep only the lazy Zod
  // codec on disk; schema-free plugins never parse or initialize it.
  unlinkSync(runtimePath);
  Promise.resolve(startup).catch((error) => {
    process.stderr.write(`${error && (error.stack || error.message) ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
} catch (error) {
  rmSync(extractionDir, { recursive: true, force: true });
  process.stderr.write(`${error && (error.stack || error.message) ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
}
