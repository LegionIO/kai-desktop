import { createHash, randomBytes } from 'node:crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const experimentDir = join(root, 'scripts', 'sea-plugin-host');
const bootstrapPath = join(experimentDir, 'bootstrap.cjs');
const loaderPath = join(experimentDir, 'disk-loader.cjs');
const fixturePath = join(experimentDir, 'fixture-plugin.mjs');
const optionalSmokePlugin = process.env.KAI_SEA_SMOKE_PLUGIN ? resolve(process.env.KAI_SEA_SMOKE_PLUGIN) : null;
const seaNodePath = resolve(process.env.KAI_SEA_NODE_BINARY || process.execPath);
const postjectPath = process.env.KAI_SEA_POSTJECT ? resolve(process.env.KAI_SEA_POSTJECT) : null;
const tempRoot = join(tmpdir(), `kai-sea-proof-${process.pid}-${randomBytes(6).toString('hex')}`);
const executablePath = join(tempRoot, process.platform === 'win32' ? 'kai-plugin-host.exe' : 'kai-plugin-host');
const configPath = join(tempRoot, 'sea-config.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function onceExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class Peer {
  #buffered = '';
  #messages = [];
  #waiters = [];
  #sequence = 0;

  constructor(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#consume(chunk));
  }

  #consume(chunk) {
    this.#buffered += chunk;
    for (;;) {
      const newline = this.#buffered.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffered.slice(0, newline);
      this.#buffered = this.#buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      this.#messages.push(message);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(message)) continue;
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate, label) {
    const existing = this.#messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return withTimeout(
      new Promise((resolveWait) => this.#waiters.push({ predicate, resolve: resolveWait })),
      5_000,
      label,
    );
  }

  async control(command, extra = {}) {
    const requestId = ++this.#sequence;
    this.send({ type: 'control', requestId, command, ...extra });
    const result = await this.waitFor(
      (message) => message?.type === 'control-result' && message.requestId === requestId,
      `control ${command}`,
    );
    if (!result.ok) throw new Error(result.error || `Control ${command} failed`);
    return result.value;
  }
}

function buildSea() {
  const seaVersion = execFileSync(seaNodePath, ['--version'], { encoding: 'utf8' }).trim();
  const [major = 0, minor = 0] = seaVersion
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const help = spawnSync(seaNodePath, ['--help'], { encoding: 'utf8' });
  const helpText = `${help.stdout}\n${help.stderr}`;
  const canBuildDirectly = helpText.includes('--build-sea');
  const canBuildBlob = helpText.includes('--experimental-sea-config');
  if (!canBuildDirectly && (!canBuildBlob || !postjectPath)) {
    throw new Error(
      `${seaNodePath} cannot complete a SEA build. Use an official Node >=25.5 binary, or set ` +
        'KAI_SEA_POSTJECT when using the preparation-blob flow from Node 20-24.',
    );
  }

  const baseConfig = {
    main: bootstrapPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // Node documents that import() is unavailable when code cache is on.
    useCodeCache: false,
    assets: { 'disk-loader.cjs': loaderPath },
  };
  const directConfig = {
    ...baseConfig,
    mainFormat: 'commonjs',
    executable: seaNodePath,
    output: executablePath,
    execArgv: ['--no-warnings', '--max-old-space-size=128'],
    // Critical hardening in Node 24.14+/25.5+: ignore NODE_OPTIONS and do not
    // expose a CLI extension point for additional Node/V8 arguments.
    execArgvExtension: 'none',
  };
  const supportsExecArgvExtension = major > 24 || (major === 24 && minor >= 14);
  const blobPath = join(tempRoot, 'sea-prep.blob');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      canBuildDirectly
        ? directConfig
        : {
            ...baseConfig,
            output: blobPath,
            ...(supportsExecArgvExtension
              ? {
                  execArgv: ['--no-warnings', '--max-old-space-size=128'],
                  execArgvExtension: 'none',
                }
              : {}),
          },
      null,
      2,
    )}\n`,
  );
  try {
    if (canBuildDirectly) {
      execFileSync(seaNodePath, ['--build-sea', configPath], { stdio: 'inherit' });
    } else {
      execFileSync(seaNodePath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
      execFileSync('cp', [seaNodePath, executablePath]);
      if (process.platform === 'darwin') {
        spawnSync('codesign', ['--remove-signature', executablePath], { stdio: 'ignore' });
      }
      const postjectArgs = [
        executablePath,
        'NODE_SEA_BLOB',
        blobPath,
        '--sentinel-fuse',
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      ];
      if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
      execFileSync(postjectPath, postjectArgs, { stdio: 'inherit' });
    }
  } catch (error) {
    throw new Error(
      `Could not build a SEA with ${seaNodePath}. Some package-manager Node builds expose --build-sea but ` +
        'compile SEA out; set KAI_SEA_NODE_BINARY to a pinned official Node binary.',
      { cause: error },
    );
  }
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', executablePath], { stdio: 'inherit' });
  }
  return { canBuildDirectly, hardensNodeOptions: canBuildDirectly || supportsExecArgvExtension, seaVersion };
}

async function macMemory(pid) {
  if (process.platform !== 'darwin') return {};
  const [{ stdout: ps }, { stdout: vmmap }] = await Promise.all([
    execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]),
    execFileAsync('vmmap', ['-summary', String(pid)], { maxBuffer: 4 * 1024 * 1024 }),
  ]);
  const footprint = /Physical footprint:\s+([0-9.]+)([KMG])/.exec(vmmap);
  return {
    rssKiB: Number.parseInt(ps.trim(), 10),
    physicalFootprint: footprint ? `${footprint[1]}${footprint[2]}` : null,
  };
}

async function main() {
  rmSync(tempRoot, { recursive: true, force: true });
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(tempRoot, { recursive: true }));
  const build = buildSea();

  // NODE_OPTIONS must be ignored and -e must be treated as an application
  // argument, not as a generic Node interpreter command.
  const hostileNodeOptions = '--require=/definitely/not-present/kai-sea-proof.cjs';
  const refused = spawnSync(executablePath, ['-e', 'process.exit(0)'], {
    encoding: 'utf8',
    // Node 25.5+ applies execArgvExtension:none in the direct-build config.
    // The legacy Node 20-24 blob format varies by minor version, so the proof
    // does not claim NODE_OPTIONS isolation there unless release CI uses a
    // pinned version known to support that field (Node 24.14 does).
    env: { ...process.env, NODE_OPTIONS: build.hardensNodeOptions ? hostileNodeOptions : '' },
    timeout: 5_000,
  });
  assert(refused.status === 64, `SEA generic-CLI refusal exited ${refused.status}: ${refused.stderr}`);
  assert(refused.stderr.includes('does not accept command-line arguments'), 'SEA did not explain its CLI refusal');

  const tokenRecords = new Map();
  const server = createServer((socket) => {
    const peer = new Peer(socket);
    void peer
      .waitFor((message) => message?.type === 'hello', 'broker hello')
      .then((hello) => {
        const record = tokenRecords.get(hello.token);
        if (!record || hello.pluginName !== record.pluginName || hello.sea !== true) {
          socket.destroy(new Error('SEA host authentication failed'));
          return;
        }
        tokenRecords.delete(hello.token);
        record.resolve({ peer, hello });
        peer.send({ type: 'ready', pluginData: { seed: record.seed }, config: { ui: { theme: 'dark' } } });
      })
      .catch((error) => socket.destroy(error));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Broker did not expose a TCP address');
  const children = new Set();

  const launch = async (pluginName, seed, pluginPath = fixturePath) => {
    const token = randomBytes(32).toString('hex');
    const pluginHash = createHash('sha256').update(readFileSync(pluginPath)).digest('hex');
    const connection = new Promise((resolveConnection) => {
      tokenRecords.set(token, { pluginName, seed, resolve: resolveConnection });
    });
    const child = spawn(executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: build.hardensNodeOptions ? hostileNodeOptions : '' },
    });
    children.add(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(
      `${JSON.stringify({
        host: '127.0.0.1',
        port: address.port,
        token,
        pluginName,
        pluginPath,
        expectedHash: pluginHash,
      })}\n`,
    );
    const { peer, hello } = await withTimeout(connection, 5_000, `${pluginName} connection`);
    await peer.waitFor((message) => message?.type === 'activated', `${pluginName} activation`);
    assert(hello.pid === child.pid, `${pluginName} reported the wrong PID`);
    return { child, peer, stderr: () => stderr, exit: onceExit(child) };
  };

  let first;
  let second;
  let existingPlugin;
  try {
    [first, second] = await Promise.all([launch('sea-proof-a', 7), launch('sea-proof-b', 11)]);
    const [firstMemory, secondMemory] = await Promise.all([macMemory(first.child.pid), macMemory(second.child.pid)]);

    const firstState = await first.peer.waitFor(
      (message) =>
        message?.type === 'operation' &&
        message.namespace === 'state' &&
        message.method === 'set' &&
        message.args?.[0] === 'answer',
      'first state publication',
    );
    const secondState = await second.peer.waitFor(
      (message) =>
        message?.type === 'operation' &&
        message.namespace === 'state' &&
        message.method === 'set' &&
        message.args?.[0] === 'answer',
      'second state publication',
    );
    assert(firstState.args[1] === 42, 'First SEA plugin did not receive its mirrored plugin data');
    assert(secondState.args[1] === 66, 'Second SEA plugin did not receive its mirrored plugin data');

    first.child.kill('SIGKILL');
    const firstExit = await withTimeout(first.exit, 5_000, 'first forced exit');
    assert(firstExit.signal || firstExit.code !== 0, 'First SEA host did not terminate independently');

    assert((await second.peer.control('ping')) === 'pong', 'Second SEA host stopped after its sibling was killed');
    const action = await second.peer.control('invoke-action', {
      targetId: 'sea-proof',
      action: 'calculate',
      payload: { value: 4 },
    });
    assert(action.value === 15, 'Callback invocation did not round-trip through the SEA host');
    assert(action.pluginName === 'sea-proof-b', 'Callback ran in the wrong SEA process');
    await second.peer.control('deactivate');
    const secondExit = await withTimeout(second.exit, 5_000, 'second graceful exit');
    assert(secondExit.code === 0, `Second SEA host exited ${secondExit.code}: ${second.stderr()}`);

    if (optionalSmokePlugin) {
      existingPlugin = await launch('sea-proof-existing', 0, optionalSmokePlugin);
      await existingPlugin.peer.waitFor(
        (message) =>
          message?.type === 'operation' && message.namespace === 'ui' && message.method === 'registerSettingsView',
        'existing plugin UI registration',
      );
      await existingPlugin.peer.waitFor(
        (message) => message?.type === 'operation' && message.namespace === 'actions' && message.method === 'register',
        'existing plugin action registration',
      );
      await existingPlugin.peer.control('deactivate');
      const existingExit = await withTimeout(existingPlugin.exit, 5_000, 'existing plugin graceful exit');
      assert(existingExit.code === 0, `Existing plugin exited ${existingExit.code}: ${existingPlugin.stderr()}`);
    }

    console.info('Node SEA plugin-host proof passed.');
    console.info(
      JSON.stringify(
        {
          buildNode: build.seaVersion,
          executableBytes: statSync(executablePath).size,
          first: { pid: first.child.pid, ...firstMemory, forcedExit: firstExit },
          second: { pid: second.child.pid, ...secondMemory, gracefulExit: secondExit },
          verified: [
            'SEA bootstrap execution',
            ...(build.canBuildDirectly ? [] : ['legacy preparation-blob + postject build']),
            ...(build.hardensNodeOptions ? ['NODE_OPTIONS ignored'] : []),
            'generic Node CLI refused',
            'authenticated loopback IPC',
            'hashed external ESM with top-level await',
            'mirrored synchronous plugin data',
            'async callback round-trip',
            'independent kill/crash containment',
            'graceful deactivation',
            ...(optionalSmokePlugin ? ['existing plugin backend loaded without changes'] : []),
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(tempRoot, { recursive: true, force: true }));
