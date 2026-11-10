import type { BridgePlugin, BridgeSnapshot } from '../shared/plugin-bridge';

export function bridgeSnapshotFixture(overrides: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    importsEnabled: false,
    sharingEnabled: false,
    remoteEnabled: false,
    publicUrl: '',
    hostHomes: { claude: '/fixture/claude', codex: '/fixture/codex' },
    plugins: [],
    sources: [],
    clients: [],
    activity: [],
    remoteProblems: [],
    credentialStorage: 'encrypted',
    compatibility: [
      {
        runtime: 'Codex SDK',
        mcp: true,
        skills: true,
        sessionHooks: true,
        toolHooks: 'kai-tools-only',
        notes: 'Native Codex tools bypass Kai pre-tool hooks. Kai-provided MCP tools remain gated.',
      },
    ],
    ...overrides,
  };
}

export function bridgePluginFixture(): BridgePlugin {
  return {
    id: 'codex:clanks@fixture',
    host: 'codex',
    name: 'Clanks fixture',
    version: '1.0.0',
    description: 'Local collaboration fixture',
    installation: 'clanks@fixture',
    packagePath: '/fixture/codex/plugins/cache/fixture/clanks/1.0.0',
    hostEnabled: true,
    ambiguous: false,
    selected: true,
    overlaps: [],
    diagnostics: [],
    components: (['skill', 'mcp', 'hooks'] as const).map((kind, index) => ({
      id: `codex:clanks@fixture/${kind}/fixture`,
      kind,
      name: `Fixture ${kind}`,
      description: `${kind} component`,
      access: ['Fixture access'],
      status: 'off',
      selected: false,
      diagnostics: [],
      revision: String(index + 1).repeat(64),
    })),
  };
}
