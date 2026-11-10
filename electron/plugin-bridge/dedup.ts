import type { NativeBridgeSource, PluginPlan } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { mcpComponentIdentity } from './identity.js';

/** Native plugins keep their existing identity and behavior. Configured native
 * MCP endpoints provide additional verifiable evidence, without connecting or
 * exposing account credentials. OAuth sources remain possible overlaps only. */
export function nativeMcpSources(
  config: Pick<AppConfig, 'mcpServers'>,
  hasAuthentication: (name: string) => boolean = () => true,
): NativeBridgeSource[] {
  return config.mcpServers.map((server) => {
    let componentIdentities: string[] = [];
    try {
      if (server.url && !server.command && !server.oauth && !hasAuthentication(server.name))
        componentIdentities = [
          mcpComponentIdentity(
            {
              url: server.url,
              args: [],
              env: server.env ?? {},
              headers: {},
              transport: 'http',
              origin: [],
            },
            true,
          ),
        ];
    } catch {
      /* A malformed native endpoint is not evidence of equivalence. */
    }
    return {
      id: `mcp:${server.name}`,
      name: server.name,
      componentIdentities,
    };
  });
}

/** Names are hints only. Matching account/endpoint/command definitions or
 * byte-identical skills are proof; a shared package name is not. */
export function findOverlaps(plans: PluginPlan[], native: NativeBridgeSource[]): void {
  for (const plan of plans) {
    plan.public.overlaps = [];
    for (const source of native) {
      const componentIds = plan.components
        .filter((c) => c.identity && source.componentIdentities?.includes(c.identity))
        .map((c) => c.public.id);
      const matchedContent = componentIds.length > 0;
      const matchedPackage = !!plan.packageIdentity && plan.packageIdentity === source.packageIdentity;
      if (matchedContent || matchedPackage || source.name.toLowerCase() === plan.public.name.toLowerCase()) {
        plan.public.overlaps.push({
          sourceId: source.id,
          name: source.name,
          native: true,
          confidence: matchedContent ? 'verified' : 'possible',
          componentIds,
          reason: matchedContent
            ? 'Matching component content or configuration'
            : matchedPackage
              ? 'Same published package; account and execution configuration have not been verified'
              : 'Similar name; equivalence has not been established',
        });
      }
    }
    for (const other of plans) {
      if (other === plan || other.public.id === plan.public.id) continue;
      const componentIds = plan.components
        .filter((c) => c.identity && other.components.some((o) => o.identity === c.identity))
        .map((c) => c.public.id);
      const exact = componentIds.length > 0;
      if (
        exact ||
        (plan.packageIdentity && plan.packageIdentity === other.packageIdentity) ||
        other.public.name.toLowerCase() === plan.public.name.toLowerCase()
      ) {
        plan.public.overlaps.push({
          sourceId: other.public.id,
          name: `${other.public.name} (${other.public.host})`,
          native: false,
          confidence: exact ? 'verified' : 'possible',
          componentIds,
          reason: exact
            ? 'Matching component content or execution configuration'
            : 'Similar name; accounts and configuration may differ',
        });
      }
    }
  }
}
