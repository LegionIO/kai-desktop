#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '24.14.0';
const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const PROTOCOL_VERSION = packageMetadata.pluginProcessProtocolVersion;
if (!Number.isInteger(PROTOCOL_VERSION) || PROTOCOL_VERSION < 1) {
  throw new Error('package.json pluginProcessProtocolVersion must be a positive integer');
}
const bootstrapPath = join(root, 'scripts', 'sea-plugin-host', 'production-bootstrap.cjs');
const outputRoot = join(root, 'resources', 'plugin-host');
const cacheRoot = join(root, '.cache', 'kai-sea-node', NODE_VERSION);
const workRoot = join(root, 'out', 'plugin-sea-build');
const runtimeBundle = join(workRoot, 'runtime.cjs');
const workerBundle = join(workRoot, 'sync-worker.cjs');
const zodBundle = join(workRoot, 'zod-wire-codec.js');
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js');

const archives = {
  'darwin-arm64': {
    name: `node-v${NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: '448f01d4dfa5a21d280cfbacf00abc22b51aad52f38db0f4886e0e5d00df541d',
  },
  'darwin-x64': {
    name: `node-v${NODE_VERSION}-darwin-x64.tar.xz`,
    sha256: 'c17b234c4db75eeb03c3a86664428ec25ee849e1ebbe8cb05c4a70f282187866',
  },
  'linux-arm64': {
    name: `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: 'e7adfca03d9173276114a6f2219df1a7d25e1bfd6bbd771d3f839118a2053094',
  },
  'linux-x64': {
    name: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df',
  },
  'win32-arm64': {
    name: `node-v${NODE_VERSION}-win-arm64.zip`,
    sha256: '88d36e8109736a2fa9bdc596f2cf507a3c52c69cdf96e54f8acd473ec14be853',
  },
  'win32-x64': {
    name: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66',
  },
};

function parseTargets() {
  const index = process.argv.indexOf('--targets');
  const raw = index >= 0 ? process.argv[index + 1] : process.env.KAI_SEA_TARGETS;
  return (raw || `${process.platform}-${process.arch}`)
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function downloadPinnedArchive(target) {
  const descriptor = archives[target];
  if (!descriptor) throw new Error(`No pinned Node SEA input for ${target}`);
  mkdirSync(cacheRoot, { recursive: true });
  const archivePath = join(cacheRoot, descriptor.name);
  if (existsSync(archivePath) && sha256(archivePath) === descriptor.sha256) return archivePath;
  rmSync(archivePath, { force: true });

  const configured = process.env.KAI_SEA_NODE_MIRROR?.replace(/\/$/, '');
  const mirrors = configured ? [configured] : ['https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node'];
  const mirrorUser = process.env.KAI_SEA_NODE_MIRROR_USER;
  const mirrorToken = process.env.KAI_SEA_NODE_MIRROR_TOKEN;
  if ((mirrorUser && !mirrorToken) || (!mirrorUser && mirrorToken)) {
    throw new Error('KAI_SEA_NODE_MIRROR_USER and KAI_SEA_NODE_MIRROR_TOKEN must be set together');
  }
  const authHeaders =
    mirrorUser && mirrorToken
      ? { Authorization: `Basic ${Buffer.from(`${mirrorUser}:${mirrorToken}`).toString('base64')}` }
      : undefined;
  let lastError;
  for (const mirror of mirrors) {
    const url = `${mirror}/v${NODE_VERSION}/${descriptor.name}`;
    try {
      // Keep credentials out of the URL (failure logs print it). Corporate/on-
      // prem builds pass the JFrog OIDC subject + access-token via env and we
      // authenticate with a Basic header. Every response is still verified
      // against the pinned upstream SHA-256 below.
      const response = await fetch(url, { redirect: 'follow', headers: authHeaders });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      const actual = sha256(archivePath);
      if (actual !== descriptor.sha256) {
        throw new Error(`checksum mismatch (expected ${descriptor.sha256}, received ${actual})`);
      }
      return archivePath;
    } catch (error) {
      rmSync(archivePath, { force: true });
      lastError = error;
      console.warn(`[plugin-sea] Could not fetch ${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(`Could not obtain checksum-pinned Node ${NODE_VERSION} for ${target}`, { cause: lastError });
}

function envBinary(target) {
  const key = `KAI_SEA_NODE_BINARY_${target.replaceAll('-', '_').toUpperCase()}`;
  return process.env[key] || (target === `${process.platform}-${process.arch}` ? process.env.KAI_SEA_NODE_BINARY : '');
}

function spawnForTarget(path, target, args, options) {
  const targetArch = target.split('-')[1];
  if (process.platform === 'darwin' && target.startsWith('darwin-') && targetArch !== process.arch) {
    return spawnSync('/usr/bin/arch', [`-${targetArch === 'x64' ? 'x86_64' : targetArch}`, path, ...args], options);
  }
  return spawnSync(path, args, options);
}

function validateNodeBinary(path, target) {
  const probe = spawnForTarget(
    path,
    target,
    ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],
    {
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (probe.status !== 0) throw new Error(`Could not execute SEA input ${path}: ${probe.stderr || probe.error}`);
  const result = JSON.parse(probe.stdout);
  const [platform, arch] = target.split('-');
  if (result.version !== NODE_VERSION || result.platform !== platform || result.arch !== arch) {
    throw new Error(
      `SEA input mismatch for ${target}: received Node ${result.version} ${result.platform}-${result.arch}`,
    );
  }
}

async function resolveNodeBinary(target) {
  const explicit = envBinary(target);
  if (explicit) {
    const path = resolve(explicit);
    validateNodeBinary(path, target);
    return { path, archiveSha256: null, source: 'explicit' };
  }
  if (
    target === `${process.platform}-${process.arch}` &&
    process.versions.node === NODE_VERSION &&
    process.env.KAI_SEA_FORCE_PINNED_DOWNLOAD !== '1'
  ) {
    validateNodeBinary(process.execPath, target);
    return { path: process.execPath, archiveSha256: null, source: 'build runtime' };
  }

  const descriptor = archives[target];
  const archivePath = await downloadPinnedArchive(target);
  const extractDir = join(cacheRoot, target);
  const marker = join(extractDir, '.complete');
  if (!existsSync(marker)) {
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    if (descriptor.name.endsWith('.zip')) {
      if (process.platform !== 'win32') throw new Error(`Extracting ${descriptor.name} requires a Windows builder`);
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
    } else {
      execFileSync('tar', ['-xf', archivePath, '-C', extractDir]);
    }
    writeFileSync(marker, `${descriptor.sha256}\n`);
  }
  const platform = target.split('-')[0];
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  const path = join(
    extractDir,
    `node-v${NODE_VERSION}-${target.replace('win32-', 'win-')}`,
    platform === 'win32' ? '' : 'bin',
    executable,
  );
  validateNodeBinary(path, target);
  return { path, archiveSha256: descriptor.sha256, source: descriptor.name };
}

async function bundleRuntime() {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  await Promise.all([
    build({
      entryPoints: [join(root, 'electron', 'plugins', 'process', 'sea-runtime-entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: runtimeBundle,
      sourcemap: false,
      legalComments: 'none',
      external: ['./zod-wire-codec.js'],
    }),
    build({
      entryPoints: [join(root, 'electron', 'plugins', 'process', 'sync-rpc-worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: workerBundle,
      sourcemap: false,
      legalComments: 'none',
    }),
    build({
      entryPoints: [join(root, 'electron', 'plugins', 'process', 'zod-wire-codec.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: zodBundle,
      sourcemap: false,
      legalComments: 'none',
    }),
  ]);
}

function buildTarget(target, nodeInput) {
  if (!existsSync(postjectCli)) throw new Error(`postject is unavailable at ${postjectCli}`);
  const targetDir = join(outputRoot, target);
  mkdirSync(targetDir, { recursive: true });
  const output = join(targetDir, target.startsWith('win32-') ? 'kai-plugin-host.exe' : 'kai-plugin-host');
  const blob = join(workRoot, `${target}.blob`);
  const config = join(workRoot, `${target}.json`);
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        main: bootstrapPath,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgv: ['--no-warnings', '--max-old-space-size=256'],
        execArgvExtension: 'none',
        assets: {
          'runtime.cjs': runtimeBundle,
          'sync-worker.cjs': workerBundle,
          'zod-wire-codec.js': zodBundle,
        },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(nodeInput.path, ['--experimental-sea-config', config], { stdio: 'inherit' });
  copyFileSync(nodeInput.path, output);
  if (target.startsWith('darwin-')) {
    spawnSync('codesign', ['--remove-signature', output], { stdio: 'ignore' });
    if (process.env.KAI_SEA_STRIP !== '0') spawnSync('strip', ['-S', output], { stdio: 'inherit' });
  }
  const postjectArgs = [
    postjectCli,
    output,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (target.startsWith('darwin-')) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.execPath, postjectArgs, { stdio: 'inherit' });
  if (target.startsWith('darwin-')) {
    execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
  }
  chmodSync(output, 0o755);
  const smoke = spawnForTarget(output, target, [], { input: '{}\n', encoding: 'utf8', timeout: 60_000 });
  if (smoke.status === null || smoke.signal) {
    throw new Error(`Generated SEA host for ${target} did not execute: ${smoke.error || smoke.signal}`);
  }
  if (smoke.status === 0 || !smoke.stderr?.includes('Invalid plugin host initialization payload')) {
    throw new Error(`Generated SEA host for ${target} did not run the embedded Kai runtime`);
  }
  return {
    target,
    path: relative(outputRoot, output),
    preSigningSha256: sha256(output),
    preSigningSize: readFileSync(output).byteLength,
    nodeVersion: NODE_VERSION,
    nodeInput: nodeInput.source,
    nodeArchiveSha256: nodeInput.archiveSha256,
  };
}

async function main() {
  const targets = parseTargets();
  for (const target of targets) {
    if (!archives[target]) throw new Error(`Unsupported SEA target: ${target}`);
  }
  await bundleRuntime();
  const records = [];
  for (const target of targets) {
    const nodeInput = await resolveNodeBinary(target);
    records.push(buildTarget(target, nodeInput));
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(
    join(outputRoot, 'manifest.json'),
    `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, nodeVersion: NODE_VERSION, hosts: records }, null, 2)}\n`,
  );
  console.info(`[plugin-sea] Built ${records.map((record) => record.target).join(', ')}`);
}

main().catch((error) => {
  console.error(`[plugin-sea] ${error instanceof Error ? error.stack || error.message : error}`);
  process.exitCode = 1;
});
