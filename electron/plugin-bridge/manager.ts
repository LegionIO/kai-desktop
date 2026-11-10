import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import type { BridgeCompatibility, BridgePlugin } from '../../shared/plugin-bridge.js';
import { hostHomes, discoverInstallations } from './discovery.js';
import { loadPluginPlan } from './manifest.js';
import { findOverlaps } from './dedup.js';
import { hash, nativeBridgeSessionId, packageFile, readBoundedFile } from './files.js';
import { ImportedMcpPool, mcpExecutionRevision } from './mcp-import.js';
import type { BridgeStateStore } from './state.js';
import type { ComponentPlan, PluginPlan, NativeBridgeSource } from './types.js';
import { componentPluginId } from './identity.js';

export const BRIDGE_COMPATIBILITY: BridgeCompatibility[] = [
  {
    runtime: 'OpenCode',
    mcp: true,
    skills: true,
    sessionHooks: true,
    toolHooks: 'kai-tools-only',
    notes:
      'Kai-provided tools support enforcing hooks. Native OpenCode tools and approvals remain controlled by that runtime; no idle wake.',
  },
  {
    runtime: 'Mastra',
    mcp: true,
    skills: true,
    sessionHooks: true,
    toolHooks: 'all-kai-tools',
    notes: 'Kai tool boundaries enforce pre-tool denial. One bounded stop continuation; no idle wake.',
  },
  {
    runtime: 'Claude Agent SDK',
    mcp: true,
    skills: true,
    sessionHooks: true,
    toolHooks: 'kai-tools-only',
    notes:
      'Hooks enforce Kai-provided tools. Native SDK tool coverage is partial; a post-execution observation is not a pre-tool gate.',
  },
  {
    runtime: 'Codex SDK',
    mcp: true,
    skills: true,
    sessionHooks: true,
    toolHooks: 'kai-tools-only',
    notes:
      'Native Codex tools bypass Kai pre-tool hooks. Kai-provided MCP tools remain gated. The host CLI must support the selected model and its MCP approval flow; non-interactive CLIs may cancel calls requiring a human approval.',
  },
  {
    runtime: 'Pi',
    mcp: true,
    skills: true,
    sessionHooks: true,
    toolHooks: 'kai-tools-only',
    notes:
      'Native Pi tool interception and headless approvals are unavailable. Kai-provided tools retain their own gates.',
  },
];
export function bridgeToolName(componentId: string, name: string): string {
  return `bridge_${hash(componentId).slice(0, 10)}_${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)}_${hash(name).slice(0, 5)}`;
}

export class PluginBridgeManager {
  private plans: PluginPlan[] = [];
  private active = new Map<string, { plan: PluginPlan; component: ComponentPlan }>();
  private tools: ToolDefinition[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private refreshScheduled = false;
  private generation = 0;
  readonly pool: ImportedMcpPool;
  onRevoked: (allowed: Set<string>) => void = () => {};
  constructor(
    readonly appHome: string,
    readonly store: BridgeStateStore,
    private readonly getConfig: () => AppConfig,
    private readonly nativeSources: () => NativeBridgeSource[],
    private readonly publish: (tools: ToolDefinition[]) => void,
  ) {
    this.pool = new ImportedMcpPool(store.get().instanceId);
    this.pool.onCatalogChanged = () => this.scheduleRefresh();
  }

  enabled(): boolean {
    return this.store.get().importsEnabled && this.getConfig().pluginBridge?.enabled === true;
  }
  inventory(): BridgePlugin[] {
    return structuredClone(this.plans.map((p) => p.public));
  }
  homes() {
    return hostHomes(this.getConfig().pluginBridge);
  }
  configuration(): AppConfig {
    return this.getConfig();
  }
  activeComponents(): Array<{ plan: PluginPlan; component: ComponentPlan }> {
    return [...this.active.values()];
  }
  isAllowed(componentId: string): boolean {
    return this.enabled() && this.active.has(componentId);
  }
  assertAllowed(componentId: string): void {
    if (!this.isAllowed(componentId)) throw new Error('This imported component is disabled or requires review.');
  }
  /** Re-read installation metadata and detected access at the execution boundary.
   * This is synchronous until the gate is decided; no stale grant starts code. */
  revalidate(componentId: string): { plan: PluginPlan; component: ComponentPlan } {
    this.assertAllowed(componentId);
    this.scan();
    const approved = new Map(
      this.plans.flatMap((plan) =>
        plan.components
          .filter((component) => component.public.status === 'approved')
          .map((component) => [component.public.id, { plan, component }] as const),
      ),
    );
    let changed = false;
    for (const [id, old] of this.active) {
      const current = approved.get(id);
      if (!current || current.component.public.revision !== old.component.public.revision) changed = true;
      if (current) this.active.set(id, current);
      else this.active.delete(id);
    }
    this.pool.reconcile(
      new Map([...this.active].map(([id, value]) => [id, mcpExecutionRevision(value.plan, value.component)])),
    );
    this.onRevoked(new Set(this.active.keys()));
    if (changed) this.scheduleRefresh();
    this.assertAllowed(componentId);
    return this.active.get(componentId)!;
  }
  getTools(): ToolDefinition[] {
    return this.enabled() ? [...this.tools] : [];
  }
  private scheduleRefresh(): void {
    if (this.refreshScheduled || !this.enabled()) return;
    this.refreshScheduled = true;
    void this.refresh()
      .catch(() => this.store.record('error', 'Plugin update could not be activated.'))
      .finally(() => {
        this.refreshScheduled = false;
      });
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
  refresh(): Promise<void> {
    const generation = this.generation;
    return this.serialized(async () => {
      if (generation !== this.generation) return;
      this.scan();
      await this.activate(generation);
    });
  }
  private scan(): void {
    if (!this.enabled()) {
      this.plans = [];
      return;
    }
    const { installations, diagnostics } = discoverInstallations(this.homes());
    const previous = this.plans;
    const plans: PluginPlan[] = [];
    for (const installation of installations) {
      try {
        plans.push(loadPluginPlan(installation, this.appHome));
      } catch {
        plans.push({
          root: installation.root,
          dataDir: '',
          components: [],
          public: {
            id: `${installation.host}:${installation.installation}`,
            host: installation.host,
            name: installation.installation,
            description: '',
            packagePath: installation.root,
            version: installation.version,
            installation: installation.installation,
            hostEnabled: installation.hostEnabled,
            ambiguous: installation.ambiguous,
            selected: false,
            components: [],
            overlaps: [],
            diagnostics: ['The installed manifest is missing, malformed, or unsupported.'],
          },
        });
        this.store.record(
          'error',
          `Could not read the installed ${installation.host} plugin manifest.`,
          installation.installation,
        );
      }
    }
    diagnostics.forEach((message) => this.store.record('discovery', message));
    const state = this.store.get();
    // Preserve an explicit diagnostic for granted components that disappear.
    for (const id of Object.keys(state.grants)) {
      const pluginId = state.grants[id].pluginId ?? componentPluginId(id);
      let matches = plans.filter((p) => p.public.id === pluginId);
      if (!matches.length) {
        const old = previous.find((p) => p.public.id === pluginId);
        const host = pluginId.startsWith('claude:') ? 'claude' : 'codex';
        const installation = pluginId.slice(host.length + 1);
        const root = state.installations[pluginId] ?? old?.root ?? '';
        const missing: PluginPlan = {
          root,
          dataDir: '',
          components: [],
          public: {
            id: pluginId,
            host,
            installation,
            name: old?.public.name ?? installation,
            description: '',
            packagePath: root,
            version: old?.public.version ?? 'missing',
            hostEnabled: null,
            ambiguous: false,
            selected: false,
            components: [],
            overlaps: [],
            diagnostics: ['The approved user installation is no longer available. No alternate source was activated.'],
          },
        };
        plans.push(missing);
        matches = [missing];
      }
      for (const plan of matches) {
        if (plan.components.some((c) => c.public.id === id)) continue;
        const old = previous.flatMap((p) => p.components).find((c) => c.public.id === id);
        const component: ComponentPlan = {
          identity: '',
          scope: [],
          public: {
            id,
            name: old?.public.name ?? id.slice(pluginId.length + 1),
            kind: old?.public.kind ?? 'unsupported',
            description: '',
            access: [],
            selected: true,
            status: 'error',
            diagnostics: ['This approved component is missing from the installed package. Its selection was retained.'],
            revision: hash([id, 'missing']),
          },
        };
        plan.components.push(component);
        plan.public.components.push(component.public);
      }
    }
    findOverlaps(plans, this.nativeSources());
    for (const plan of plans) {
      plan.public.selected = !plan.public.ambiguous || state.installations[plan.public.id] === plan.root;
      for (const component of plan.components) {
        const grant = state.grants[component.public.id];
        component.public.selected = !!grant;
        if (['error', 'unsupported'].includes(component.public.status)) continue;
        if (!grant) continue;
        const expanded = component.scope.some((access) => !grant.access.includes(access));
        const nativeDuplicate = plan.public.overlaps.some(
          (o) => o.native && o.confidence === 'verified' && o.componentIds.includes(component.public.id),
        );
        component.public.status =
          expanded || !plan.public.selected || (nativeDuplicate && !grant.allowOverlap)
            ? 'review-required'
            : 'approved';
        if (expanded) component.public.diagnostics.push('Detected access changed. Review this component again.');
        if (nativeDuplicate && !grant.allowOverlap)
          component.public.diagnostics.push(
            'A native Kai equivalent is preferred. Explicitly approve overlap to use this source.',
          );
      }
    }
    this.plans = plans;
  }
  approve(
    pluginId: string,
    revisions: Record<string, string>,
    allowOverlap: boolean,
    packagePath?: string,
  ): Promise<void> {
    return this.serialized(async () => {
      if (!this.enabled()) throw new Error('Enable Plugin Bridge before approving components.');
      this.scan();
      const entries = Object.entries(revisions);
      const candidates = this.plans.filter(
        (p) =>
          p.public.id === pluginId &&
          (!packagePath || p.root === packagePath) &&
          entries.every(([id, revision]) =>
            p.components.some((c) => c.public.id === id && c.public.revision === revision),
          ),
      );
      const plan = candidates.length === 1 ? candidates[0] : candidates.find((p) => p.public.selected);
      if (!plan || (entries.length > 0 && candidates.length !== 1))
        throw new Error('The installation changed or its version is ambiguous. Refresh and review it again.');
      const selected = plan.components.filter((c) => Object.hasOwn(revisions, c.public.id));
      if (
        selected.some(
          (c) => ['error', 'unsupported'].includes(c.public.status) && !this.store.get().grants[c.public.id],
        )
      )
        throw new Error('Unsupported or malformed components cannot be approved.');
      const conflicts = plan.public.overlaps.filter(
        (o) => o.confidence === 'verified' && selected.some((c) => o.componentIds.includes(c.public.id)),
      );
      if (
        !allowOverlap &&
        conflicts.some(
          (o) =>
            o.native ||
            this.plans.some(
              (p) =>
                p.public.id === o.sourceId &&
                p.components.some(
                  (other) =>
                    other.public.status === 'approved' &&
                    selected.some((c) => !!c.identity && c.identity === other.identity),
                ),
            ),
        )
      ) {
        throw new Error('Review the verified overlap and explicitly choose this additional source.');
      }
      this.store.update((state) => {
        const previousGrants = { ...state.grants };
        state.installations[pluginId] = plan.root;
        for (const id of Object.keys(state.grants)) if (id.startsWith(`${pluginId}/`)) delete state.grants[id];
        for (const component of selected)
          state.grants[component.public.id] = ['error', 'unsupported'].includes(component.public.status)
            ? previousGrants[component.public.id]
            : {
                pluginId,
                access: component.scope,
                approvedAt: new Date().toISOString(),
                allowOverlap,
              };
      });
      this.store.record('approval', `Approved ${selected.length} components from ${plan.public.name}.`, pluginId);
      this.scan();
      await this.activate();
    });
  }
  private async activate(generation = this.generation): Promise<void> {
    const previous = this.active;
    this.active = new Map(
      this.enabled()
        ? this.plans.flatMap((plan) =>
            plan.components
              .filter((component) => component.public.status === 'approved')
              .map((component) => [component.public.id, { plan, component }] as const),
          )
        : [],
    );
    const allowed = new Set(this.active.keys());
    this.onRevoked(allowed);
    this.pool.reconcile(
      new Map([...this.active].map(([id, value]) => [id, mcpExecutionRevision(value.plan, value.component)])),
    );
    await this.pool.revoke(allowed);
    const tools: ToolDefinition[] = [];
    for (const { plan, component } of this.active.values()) {
      if (generation !== this.generation) return;
      const old = previous.get(component.public.id);
      if (old && old.component.public.revision !== component.public.revision)
        this.store.record('update', 'Adopted an update within the approved detected access.', component.public.id);
      const provenance = {
        instanceId: this.store.get().instanceId,
        pluginId: plan.public.id,
        componentId: component.public.id,
        origin: [this.store.get().instanceId],
      };
      if (component.skill) {
        tools.push({
          name: bridgeToolName(component.public.id, 'read_skill'),
          source: 'bridge',
          sourceId: component.public.id,
          description: `${plan.public.name}: ${component.public.description} Read SKILL.md when this skill is relevant. Supporting files resolve relative to the skill directory and must stay inside the installed plugin.`,
          inputSchema: z.object({ file: z.string().default('SKILL.md') }),
          bridge: provenance,
          execute: async (input) => {
            const current = this.revalidate(component.public.id);
            if (!current.component.skill) throw new Error('The selected skill is unavailable.');
            const file = packageFile(
              current.plan.root,
              resolve(current.component.skill.directory, (input as { file: string }).file),
            );
            return {
              file: relative(current.plan.root, file),
              instructions: readBoundedFile(file, 256 * 1024).replace(
                /\$\{(?:(?:CLAUDE|CODEX)_)?PLUGIN_(ROOT|DATA)\}/g,
                (_match, kind: string) => (kind === 'ROOT' ? current.plan.root : current.plan.dataDir),
              ),
              packageRoot: current.plan.root,
            };
          },
        });
      }
      if (component.mcp) {
        try {
          const connection = await this.pool.connect(plan, component, { sessionId: 'catalog', cwd: homedir() });
          await this.pool.refreshTools(connection);
          this.assertAllowed(component.public.id);
          // Validate the complete catalog before publishing any tools from it.
          const catalog = connection.tools.map((tool) => ({
            tool,
            schema: z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
          }));
          for (const { tool, schema } of catalog) {
            tools.push({
              name: bridgeToolName(component.public.id, tool.name),
              description: `${plan.public.name}: ${tool.description ?? tool.name}${connection.instructions ? `\nMCP server instructions:\n${connection.instructions}` : ''}`,
              source: 'bridge',
              sourceId: component.public.id,
              originalName: tool.name,
              inputSchema: schema,
              jsonInputSchema: tool.inputSchema,
              jsonOutputSchema: tool.outputSchema,
              mcpDescriptor: { title: tool.title, annotations: tool.annotations, _meta: tool._meta, icons: tool.icons },
              bridge: provenance,
              execute: async (input: unknown, context: ToolExecutionContext) => {
                const current = this.revalidate(component.public.id);
                const sessionId = context.bridgeSessionId ?? context.conversationId;
                if (!sessionId) throw new Error('This imported MCP requires a Kai chat or connector session.');
                const conn = await this.pool.connect(current.plan, current.component, {
                  sessionId: nativeBridgeSessionId(this.store.get().instanceId, sessionId),
                  cwd: context.cwd ?? homedir(),
                  lifecycleHooks: !context.connectorClientId,
                });
                this.assertAllowed(component.public.id);
                if (!conn.tools.some((candidate) => candidate.name === tool.name))
                  throw new Error('The imported tool is no longer available. Refresh the plugin.');
                return this.pool.call(conn, tool.name, input, context);
              },
            });
          }
        } catch {
          component.public.status = 'error';
          component.public.diagnostics = [
            'MCP could not start. Check the installed program, environment, or plugin sign-in, then refresh.',
          ];
          this.store.record('error', 'An approved MCP could not start.', component.public.id);
        }
      }
    }
    if (generation !== this.generation) return;
    this.tools = tools;
    this.publish(tools);
  }
  async stop(): Promise<void> {
    this.generation++;
    this.active.clear();
    this.tools = [];
    this.publish([]);
    this.onRevoked(new Set());
    await this.pool.revoke();
  }
}
