import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseShell } from 'shell-quote';
import type { BridgeComponent } from '../../shared/plugin-bridge.js';
import { hash, object, packageFile, readBoundedFile, safeLabel, strings } from './files.js';
import type { ComponentPlan, HookCommand, InstalledPlugin, McpPlan, PluginPlan } from './types.js';
import { mcpComponentIdentity, packageContentIdentity, skillComponentIdentity } from './identity.js';

export const SUPPORTED_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
  'Interrupt',
]);

function readJson(root: string, file: string): Record<string, unknown> {
  return object(JSON.parse(readBoundedFile(packageFile(root, file))));
}
function reference(root: string, value: unknown, expand: (text: string) => string): Record<string, unknown> {
  return typeof value === 'string' ? readJson(root, expand(value)) : object(value);
}
function defaultFile(root: string, paths: string[]): string | undefined {
  return paths.find((path) => existsSync(join(root, path)));
}
function normalized(value: unknown, root: string, dataDir: string): unknown {
  if (typeof value === 'string') return value.split(root).join('${PLUGIN_ROOT}').split(dataDir).join('${PLUGIN_DATA}');
  if (Array.isArray(value)) return value.map((v) => normalized(v, root, dataDir));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalized(v, root, dataDir)]));
  return value;
}
export function expandPluginVariables(value: string, root: string, dataDir: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    if (['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT'].includes(name)) return root;
    if (['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA', 'CODEX_PLUGIN_DATA'].includes(name)) return dataDir;
    if (env[name] !== undefined) return env[name]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`Required environment variable ${name} is not configured.`);
  });
}
function stringMap(value: unknown, expand: (text: string) => string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, v]) => {
      if (typeof v !== 'string') throw new Error('Environment and header values must be strings.');
      return [key, expand(v)];
    }),
  );
}
/** Commands are shown without argument values. The complete command is bound
 * into the opaque access fingerprint; credentials never enter public inventory. */
function commandAccess(command: string): string {
  const first = parseShell(command)[0];
  return typeof first === 'string' && /^[\w./\\ -]+$/.test(first) ? basename(first) : 'shell command';
}
export function normalizePackageIdentity(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : object(value).url;
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw.replace(/^git\+/, ''));
    if (!['https:', 'http:'].includes(url.protocol)) return undefined;
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return undefined;
  }
}

export function loadPluginPlan(
  installed: InstalledPlugin,
  appHome: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginPlan {
  const root = installed.root;
  const manifestPath = defaultFile(root, [
    'plugin.json',
    `.${installed.host}-plugin/plugin.json`,
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ]);
  if (!manifestPath) throw new Error('No supported plugin manifest was found.');
  const portable = readJson(root, manifestPath);
  const extensions = object(portable.extensions);
  let overlay = object(extensions['com.openai']);
  if (manifestPath === 'plugin.json' && !Object.hasOwn(extensions, 'com.openai')) {
    // A portable identity may carry its host-specific components in the
    // compatibility manifest. Do not silently drop those components.
    const compatibility = defaultFile(root, [`.${installed.host}-plugin/plugin.json`]);
    if (compatibility) overlay = readJson(root, compatibility);
  }
  const manifest =
    manifestPath === 'plugin.json'
      ? { ...portable, ...overlay, name: portable.name, version: portable.version ?? overlay.version }
      : portable;
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('Plugin manifest has no name.');
  const id = `${installed.host}:${installed.installation}`;
  const dataDir = join(appHome, 'plugin-bridge', 'data', hash(id).slice(0, 24));
  const expand = (value: string) => expandPluginVariables(value, root, dataDir, env);
  const components: ComponentPlan[] = [];
  const diagnostics: string[] = [];
  const add = (
    name: string,
    kind: BridgeComponent['kind'],
    access: string[],
    definition: Omit<ComponentPlan, 'public' | 'scope' | 'identity'>,
    raw: unknown,
    description = '',
  ) => {
    const normalizedRaw = normalized(raw, root, dataDir);
    const scope = [...access, `definition:${hash(normalizedRaw)}`].sort();
    components.push({
      ...definition,
      scope,
      identity: definition.mcp ? mcpComponentIdentity(definition.mcp) : hash({ kind, definition: raw }),
      public: {
        id: `${id}/${kind}/${name}`,
        name,
        kind,
        description,
        access,
        selected: false,
        status: kind === 'unsupported' ? 'unsupported' : 'off',
        diagnostics: [],
        revision: hash({ installed, name, raw: normalizedRaw }),
      },
    });
  };
  const unsupported = (name: string, reason: string) => add(name, 'unsupported', [], {}, reason, reason);
  const failed = (name: string, kind: BridgeComponent['kind'], reason: string) => {
    add(name, kind, [], {}, reason);
    const component = components.at(-1)!;
    component.public.status = 'error';
    component.public.diagnostics.push(reason);
  };

  try {
    const mcpRef = manifest.mcpServers ?? manifest.mcp ?? defaultFile(root, ['.mcp.json', 'mcp.json']);
    const servers: Record<string, unknown> = {};
    for (const ref of Array.isArray(mcpRef) ? mcpRef : [mcpRef]) {
      const configs = reference(root, ref, expand);
      for (const [name, config] of Object.entries(object(configs.mcpServers ?? configs))) {
        if (name.startsWith('$')) continue;
        if (Object.hasOwn(servers, name))
          throw new Error('Duplicate MCP server identity in referenced configurations.');
        servers[name] = config;
      }
    }
    for (const [name, raw] of Object.entries(servers)) {
      if (name.startsWith('$')) continue;
      try {
        const config = object(raw);
        const url = typeof config.url === 'string' ? expand(config.url) : undefined;
        let command = typeof config.command === 'string' ? expand(config.command) : undefined;
        if (command?.startsWith('./') || command?.startsWith('../'))
          command = packageFile(root, resolve(root, command));
        if ((!url && !command) || (url && command)) throw new Error('MCP requires exactly one URL or command.');
        if (url && !['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Unsupported MCP URL scheme.');
        if (url && (new URL(url).username || new URL(url).password))
          throw new Error('MCP URL credentials must use declared headers or environment variables.');
        if (config.type && !['stdio', 'sse', 'http', 'streamable-http'].includes(String(config.type)))
          throw new Error('Unsupported MCP transport.');
        const mcp: McpPlan = {
          command,
          url,
          args: strings(config.args)
            .map(expand)
            .map((arg) => (arg.startsWith('./') || arg.startsWith('../') ? packageFile(root, arg) : arg)),
          env: stringMap(config.env, expand),
          headers: stringMap(config.headers ?? config.http_headers, expand),
          transport: command ? 'stdio' : config.type === 'sse' ? 'sse' : 'http',
          origin: strings(object(config._meta)['kai.origin']),
        };
        if (/^kai(?:-mcp)?$/i.test(basename(command ?? '').replace(/\.(exe|cmd)$/, '')) && mcp.args.includes('serve')) {
          throw new Error('Kai connectors cannot be imported into Kai.');
        }
        if (name === 'kai-mcp' || mcp.origin.length) throw new Error('A Kai forwarding connector cannot be imported.');
        const access = [
          command ? `Run local program: ${commandAccess(command)}` : `Connect to ${new URL(url!).origin}`,
          ...Object.keys(mcp.env).map((key) => `Environment variable: ${key}`),
          ...Object.keys(mcp.headers).map((key) => `HTTP header: ${key}`),
          ...(command ? ['Read and write as your local user', 'Use the chat working directory'] : []),
        ];
        add(name, 'mcp', access, { mcp }, mcp, 'MCP tools supplied by this installed plugin.');
      } catch (error) {
        failed(name, 'mcp', error instanceof Error ? error.message : 'Invalid MCP component.');
      }
    }
  } catch {
    diagnostics.push('The referenced MCP configuration could not be read.');
  }

  const skillRefs = strings(manifest.skills ?? (existsSync(join(root, 'skills')) ? './skills' : []));
  let contentIdentity: string | undefined;
  for (const ref of skillRefs) {
    try {
      const base = packageFile(root, expand(ref));
      const files = statSync(base).isFile()
        ? [base]
        : existsSync(join(base, 'SKILL.md'))
          ? [join(base, 'SKILL.md')]
          : readdirSync(base, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .slice(0, 200)
              .map((entry) => join(base, entry.name, 'SKILL.md'))
              .filter(existsSync);
      for (const candidate of files) {
        const file = packageFile(root, candidate);
        const text = readBoundedFile(file, 256 * 1024);
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        const metadata = frontmatter ? object(parseYaml(frontmatter[1], { maxAliasCount: 20 })) : {};
        const name = relative(root, dirname(file)).replaceAll('\\', '/');
        const description = safeLabel(metadata.description, 'Instructions and supporting files from this plugin.');
        // Instruction edits are compatible updates. Permission declarations and
        // package-file access remain bound to the human's reviewed scope.
        add(
          name,
          'skill',
          [
            'Read skill instructions and supporting package files',
            ...strings(metadata['allowed-tools']).map((t) => `Declared tool: ${t}`),
          ],
          { skill: { directory: dirname(file), instructionsPath: file } },
          { path: name, allowedTools: metadata['allowed-tools'] ?? [] },
          description,
        );
        contentIdentity ??= packageContentIdentity(root);
        components.at(-1)!.identity = skillComponentIdentity(root, dirname(file), contentIdentity);
        components.at(-1)!.public.revision = hash({ installation: installed.root, name, text });
      }
    } catch {
      failed(ref, 'skill', 'Skill files are missing, malformed, or outside the installed package.');
    }
  }
  try {
    const hookRef = manifest.hooks ?? defaultFile(root, ['hooks/hooks.json']);
    const hookConfigs = (Array.isArray(hookRef) ? hookRef : [hookRef]).map((ref) => reference(root, ref, expand));
    const mergedHooks: Record<string, unknown[]> = {};
    for (const config of hookConfigs)
      for (const [event, raw] of Object.entries(object(config.hooks ?? config))) {
        mergedHooks[event] = [...(mergedHooks[event] ?? []), ...(Array.isArray(raw) ? raw : [raw])];
      }
    for (const [event, raw] of Object.entries(mergedHooks)) {
      if (!SUPPORTED_HOOK_EVENTS.has(event)) {
        unsupported(`hooks:${event}`, 'This lifecycle event is not supported.');
        continue;
      }
      const commands: HookCommand[] = [];
      for (const [groupIndex, groupValue] of (Array.isArray(raw) ? raw : [raw]).entries()) {
        const group = object(groupValue);
        if (typeof group.matcher === 'string') {
          if (group.matcher.length > 256 || /[(){}]/.test(group.matcher)) {
            failed(
              `${event}:group-${groupIndex}`,
              'hooks',
              'This hook matcher uses unsupported grouping or repetition. Simple regular expressions and alternatives are supported.',
            );
            continue;
          }
          try {
            new RegExp(group.matcher === '*' ? '.*' : group.matcher);
          } catch {
            failed(`${event}:group-${groupIndex}`, 'hooks', 'Invalid hook matcher.');
            continue;
          }
        }
        for (const [hookIndex, value] of (Array.isArray(group.hooks) ? group.hooks : [group]).entries()) {
          const hook = object(value);
          if (hook.type !== 'command' || typeof hook.command !== 'string') {
            unsupported(`hooks:${event}:${groupIndex}:${hookIndex}`, 'Only command hooks are supported.');
            continue;
          }
          commands.push({
            command: expand(hook.command),
            async: hook.async === true,
            timeoutMs: Math.min(60_000, Math.max(100, typeof hook.timeout === 'number' ? hook.timeout * 1000 : 10_000)),
            matcher: typeof group.matcher === 'string' ? group.matcher : undefined,
          });
        }
      }
      if (commands.length > 32) throw new Error('Too many commands in a hook group.');
      if (commands.length)
        add(
          event,
          'hooks',
          [
            `Observe ${event} payloads`,
            'Run local code as your user',
            'Write plugin data',
            ...commands.map((c) => `Run ${commandAccess(c.command)}${c.async ? ' (bounded watcher)' : ''}`),
            ...(['PreToolUse', 'UserPromptSubmit', 'Stop'].includes(event)
              ? ['May deny or request context at supported Kai boundaries']
              : []),
          ],
          { hooks: { event, commands } },
          { event, commands },
        );
    }
  } catch {
    diagnostics.push('The referenced hooks configuration could not be read.');
  }
  for (const kind of ['commands', 'agents', 'lspServers', 'apps'] as const) {
    if (manifest[kind] || existsSync(join(root, kind === 'lspServers' ? '.lsp.json' : kind)))
      unsupported(kind, `${kind} are not imported in V1.`);
  }
  if (components.length > 1000) throw new Error('Plugin component limit exceeded.');
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.public.id)) throw new Error('Duplicate plugin component identity.');
    ids.add(component.public.id);
  }
  return {
    root,
    dataDir,
    packageIdentity: normalizePackageIdentity(manifest.repository ?? manifest.homepage),
    components,
    public: {
      id,
      host: installed.host,
      name: safeLabel(object(manifest.interface).displayName ?? manifest.name, installed.installation),
      description: safeLabel(manifest.description, ''),
      packagePath: root,
      version: installed.version,
      installation: installed.installation,
      hostEnabled: installed.hostEnabled,
      ambiguous: installed.ambiguous,
      selected: false,
      components: components.map((c) => c.public),
      overlaps: [],
      diagnostics,
    },
  };
}
