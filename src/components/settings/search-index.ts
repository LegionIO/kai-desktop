import type { SettingsSection } from './SettingsPanel';

export type SettingsSearchEntry = {
  /** DOM anchor — rendered as `data-setting-id` on the field wrapper. Use the config dot-path where one exists. */
  id: string;
  label: string;
  section: SettingsSection;
  /** Inner tab key (e.g. 'runtimes' under Models). Omit for non-tabbed sections. */
  tab?: string;
  /** Extra match terms (synonyms, config path fragments). */
  keywords?: string[];
  /** Always-mounted anchor to highlight when `id` isn't in the DOM (e.g. field is behind a disabled toggle or collapsed section). */
  fallbackId?: string;
};

export const SECTION_LABELS: Record<SettingsSection, string> = {
  models: 'Models',
  usage: 'Usage',
  tools: 'Tools',
  automations: 'Automations',
  general: 'Application',
  audio: 'Audio',
  voice: 'Voice',
  'computer-use': 'Autopilot',
  'media-generation': 'Media Generation',
  'web-server': 'Web UI',
};

export const TAB_LABELS: Record<string, string> = {
  // Models
  profiles: 'Profiles',
  runtimes: 'Runtimes',
  providers: 'Providers',
  catalog: 'Catalog',
  prompts: 'Prompts',
  advanced: 'Advanced',
  // Tools
  'built-in': 'System',
  cli: 'CLI',
  mcp: 'MCP',
  skills: 'Skills',
  // Application
  general: 'General',
  'app-shots': 'App Shots',
  appshots: 'Appshots',
  // Voice
  realtime: 'Voice Chat',
  dictation: 'Dictation',
  // Media Generation
  image: 'Image',
  video: 'Video',
};

export const SETTINGS_INDEX: SettingsSearchEntry[] = [
  // ─── Models › Advanced (global defaults; profiles override) ───
  {
    id: 'advanced.maxSteps',
    label: 'Max steps per task (global default)',
    section: 'models',
    tab: 'advanced',
    keywords: ['turns', 'limit', 'iterations', 'tool calls'],
  },
  {
    id: 'advanced.temperature',
    label: 'Temperature (global default)',
    section: 'models',
    tab: 'advanced',
    keywords: ['sampling', 'creativity', 'randomness'],
  },
  {
    id: 'advanced.maxRetries',
    label: 'Max retries on transient errors',
    section: 'models',
    tab: 'advanced',
    keywords: ['retry', 'error handling', 'rate limit'],
  },
  {
    id: 'advanced.useResponsesApi',
    label: 'Use Responses API (global default)',
    section: 'models',
    tab: 'advanced',
    keywords: ['openai'],
  },
  {
    id: 'ui.showPluginDockIcons',
    label: 'Show plugin icons in dock',
    section: 'models',
    tab: 'advanced',
    keywords: ['sidebar'],
  },
  {
    id: 'ui.dockBadgeStyle',
    label: 'Dock badge style',
    section: 'models',
    tab: 'advanced',
    keywords: ['notification', 'pill'],
  },

  // ─── Models › Runtimes ───
  {
    id: 'agent.runtime',
    label: 'Agent runtime',
    section: 'models',
    tab: 'runtimes',
    keywords: ['claude', 'codex', 'mastra', 'sdk'],
  },
  {
    id: 'agent.maxTurns',
    label: 'Max turns',
    section: 'models',
    tab: 'runtimes',
    keywords: ['steps', 'limit', 'iterations', 'tool calls', 'maxSteps'],
  },
  {
    id: 'agent.autoContinueOnMaxTurns',
    label: 'Auto-continue when max turns reached',
    section: 'models',
    tab: 'runtimes',
    keywords: ['limit', 'resume'],
  },
  {
    id: 'agent.confinement.enabled',
    label: 'Enable confinement enforcement',
    section: 'models',
    tab: 'runtimes',
    keywords: ['confinement', 'sandbox', 'blast radius', 'scrub', 'credentials', 'workspace', 'isolation', 'security'],
  },
  {
    id: 'agent.confinement.envAllowlist',
    label: 'Environment allowlist',
    section: 'models',
    tab: 'runtimes',
    fallbackId: 'agent.confinement.enabled',
    keywords: ['confinement', 'env', 'environment', 'passthrough', 'allowlist', 'variables'],
  },
  {
    id: 'mastra.advanced',
    label: 'Memory & compaction (Mastra)',
    section: 'models',
    tab: 'runtimes',
    keywords: ['working memory', 'semantic recall', 'context', 'compaction', 'summarize'],
  },

  // ─── Models › Profiles ───
  {
    id: 'profiles',
    label: 'Model profiles',
    section: 'models',
    tab: 'profiles',
    keywords: ['default profile', 'temperature', 'responses api', 'reasoning effort', 'system prompt'],
  },
  {
    id: 'profile.maxSteps',
    label: 'Max steps (per profile)',
    section: 'models',
    tab: 'profiles',
    keywords: ['turns', 'limit', 'iterations'],
  },

  // ─── Models › Providers / Catalog / Prompts ───
  {
    id: 'models.providers',
    label: 'API providers',
    section: 'models',
    tab: 'providers',
    keywords: ['openai', 'anthropic', 'bedrock', 'google', 'endpoint', 'api key'],
  },
  {
    id: 'models.catalog',
    label: 'Model catalog',
    section: 'models',
    tab: 'catalog',
    keywords: ['add model', 'deployment', 'vision'],
  },
  {
    id: 'systemPrompts',
    label: 'System prompts',
    section: 'models',
    tab: 'prompts',
    keywords: ['chat prompt', 'plan prompt', 'instructions'],
  },

  // ─── Usage ───
  { id: 'usage', label: 'Token usage dashboard', section: 'usage', keywords: ['tokens', 'cost', 'spend', 'billing'] },

  // ─── Tools › System ───
  {
    id: 'tools.shell.enabled',
    label: 'Shell tool',
    section: 'tools',
    tab: 'built-in',
    keywords: ['bash', 'command', 'terminal'],
  },
  { id: 'tools.shell.timeout', label: 'Shell timeout', section: 'tools', tab: 'built-in', keywords: ['bash'] },
  {
    id: 'tools.shell.allowPatterns',
    label: 'Shell allow patterns',
    section: 'tools',
    tab: 'built-in',
    keywords: ['whitelist', 'permission'],
  },
  {
    id: 'tools.shell.denyPatterns',
    label: 'Shell deny patterns',
    section: 'tools',
    tab: 'built-in',
    keywords: ['blacklist', 'block'],
  },
  {
    id: 'tools.fileAccess.enabled',
    label: 'File access tool',
    section: 'tools',
    tab: 'built-in',
    keywords: ['read file', 'write file', 'filesystem'],
  },
  {
    id: 'tools.fileAccess.allowPaths',
    label: 'File access allow paths',
    section: 'tools',
    tab: 'built-in',
    keywords: ['whitelist', 'workspace'],
  },
  {
    id: 'tools.fileAccess.denyPaths',
    label: 'File access deny paths',
    section: 'tools',
    tab: 'built-in',
    keywords: ['blacklist'],
  },
  {
    id: 'tools.webFetch.enabled',
    label: 'Web fetch tool',
    section: 'tools',
    tab: 'built-in',
    keywords: ['http', 'url', 'download'],
  },
  {
    id: 'tools.webSearch.enabled',
    label: 'Web search tool',
    section: 'tools',
    tab: 'built-in',
    keywords: ['google', 'bing', 'internet'],
  },
  {
    id: 'tools.processStreaming.enabled',
    label: 'Process streaming',
    section: 'tools',
    tab: 'built-in',
    keywords: ['long running', 'output'],
  },
  {
    id: 'tools.processStreaming.maxOutputBytes',
    label: 'Max output bytes',
    section: 'tools',
    tab: 'built-in',
    keywords: ['truncate', 'streaming'],
  },
  {
    id: 'tools.processStreaming.observer.enabled',
    label: 'Tool observer',
    section: 'tools',
    tab: 'built-in',
    keywords: ['watch', 'monitor'],
  },
  {
    id: 'tools.subAgents.enabled',
    label: 'Sub-agents',
    section: 'tools',
    tab: 'built-in',
    keywords: ['task', 'delegate', 'parallel'],
  },
  {
    id: 'tools.subAgents.maxDepth',
    label: 'Sub-agent max depth',
    section: 'tools',
    tab: 'built-in',
    keywords: ['recursion', 'nesting'],
  },
  {
    id: 'tools.subAgents.maxConcurrent',
    label: 'Sub-agent max concurrent',
    section: 'tools',
    tab: 'built-in',
    keywords: ['parallel'],
  },

  // ─── Tools › CLI / MCP / Skills ───
  {
    id: 'cliTools',
    label: 'CLI tool integrations',
    section: 'tools',
    tab: 'cli',
    keywords: ['command line', 'binary'],
  },
  {
    id: 'mcpServers',
    label: 'MCP servers',
    section: 'tools',
    tab: 'mcp',
    keywords: ['model context protocol', 'stdio', 'sse'],
  },
  { id: 'skills', label: 'Installed skills', section: 'tools', tab: 'skills', keywords: ['slash command'] },

  // ─── Automations ───
  {
    id: 'automations.enabled',
    label: 'Automations enabled',
    section: 'automations',
    keywords: ['rules', 'triggers', 'events'],
  },
  {
    id: 'automations.rules',
    label: 'Automation rules',
    section: 'automations',
    keywords: ['trigger', 'action', 'when'],
  },

  // ─── Application › General ───
  {
    id: 'cli.install',
    label: 'Install the kai terminal command',
    section: 'general',
    tab: 'general',
    keywords: ['cli', 'command line', 'terminal', 'kai command', 'path', 'shell', 'install kai', 'code command'],
  },
  {
    id: 'launchAtLogin',
    label: 'Launch at login',
    section: 'general',
    tab: 'general',
    keywords: ['startup', 'autostart'],
  },
  {
    id: 'ui.theme',
    label: 'Color scheme',
    section: 'general',
    tab: 'general',
    keywords: ['theme', 'dark mode', 'light mode', 'appearance'],
  },
  {
    id: 'ui.splashBackground',
    label: 'Splash background',
    section: 'general',
    tab: 'general',
    keywords: ['wallpaper', 'appearance'],
  },
  {
    id: 'ui.fullWidthContent',
    label: 'Full width content',
    section: 'general',
    tab: 'general',
    keywords: ['layout', 'wide'],
  },
  {
    id: 'titleGeneration.enabled',
    label: 'Auto-generate chat titles',
    section: 'general',
    tab: 'general',
    keywords: ['rename', 'conversation'],
  },
  {
    id: 'ui.composer.showModelProfileSelector',
    label: 'Show model & profile selector in composer',
    section: 'general',
    tab: 'general',
    keywords: ['dropdown', 'toolbar'],
  },
  {
    id: 'partitions',
    label: 'Browser partitions',
    section: 'general',
    tab: 'general',
    keywords: ['cookies', 'cache', 'storage', 'clear', 'delete'],
  },

  // ─── Application › App Shots ───
  {
    id: 'appShots.enabled',
    label: 'Enable App Shots',
    section: 'general',
    tab: 'app-shots',
    keywords: ['screenshot', 'capture', 'window'],
  },
  {
    id: 'appShots.hotkey',
    label: 'App Shots global shortcut',
    section: 'general',
    tab: 'app-shots',
    keywords: ['keybinding', 'hotkey', 'capture'],
  },
  { id: 'appShots.autoAttach', label: 'Auto-attach App Shot to active chat', section: 'general', tab: 'app-shots' },
  {
    id: 'appShots.includeUiTree',
    label: 'Include UI element tree',
    section: 'general',
    tab: 'app-shots',
    keywords: ['accessibility'],
  },

  // ─── Application › Appshots (persisted gallery) ───
  {
    id: 'appshots.enabled',
    label: 'Enable appshots',
    section: 'general',
    tab: 'appshots',
    keywords: ['appshot', 'screenshot', 'gallery', 'persisted', 'snapshot'],
  },
  {
    id: 'appshots.autoCapture',
    label: 'Auto-capture frames during computer use',
    section: 'general',
    tab: 'appshots',
    keywords: ['appshot', 'screenshot', 'automatic', 'computer use', 'capture'],
  },
  {
    id: 'appshots.captureVisibleText',
    label: 'Store visible text metadata',
    section: 'general',
    tab: 'appshots',
    keywords: ['appshot', 'ocr', 'visible text', 'metadata', 'privacy'],
  },
  {
    id: 'appshots.retention.maxCount',
    label: 'Max appshots',
    section: 'general',
    tab: 'appshots',
    keywords: ['appshot', 'retention', 'limit', 'count', 'cleanup'],
  },
  {
    id: 'appshots.retention.maxAgeDays',
    label: 'Appshot max age (days)',
    section: 'general',
    tab: 'appshots',
    keywords: ['appshot', 'retention', 'age', 'expiry', 'cleanup'],
  },

  // ─── Audio ───
  { id: 'audio.provider', label: 'Speech provider', section: 'audio', keywords: ['azure', 'native', 'tts', 'stt'] },
  {
    id: 'audio.tts.enabled',
    label: 'Enable text-to-speech',
    section: 'audio',
    keywords: ['tts', 'voice', 'read aloud'],
  },
  {
    id: 'audio.tts.voice',
    label: 'TTS voice',
    section: 'audio',
    keywords: ['speech'],
    fallbackId: 'audio.tts.enabled',
  },
  {
    id: 'audio.tts.rate',
    label: 'TTS speed',
    section: 'audio',
    keywords: ['rate', 'speech'],
    fallbackId: 'audio.tts.enabled',
  },
  {
    id: 'audio.recording.enabled',
    label: 'Enable voice recording',
    section: 'audio',
    keywords: ['microphone', 'mic', 'stt'],
  },
  {
    id: 'audio.recording.inputDeviceId',
    label: 'Input device',
    section: 'audio',
    keywords: ['microphone', 'mic'],
    fallbackId: 'audio.recording.enabled',
  },
  {
    id: 'audio.azure.subscriptionKey',
    label: 'Azure Speech subscription key',
    section: 'audio',
    keywords: ['api key', 'cognitive'],
    fallbackId: 'audio.provider',
  },
  { id: 'audio.azure.region', label: 'Azure Speech region', section: 'audio', fallbackId: 'audio.provider' },

  // ─── Voice › Voice Chat ───
  {
    id: 'realtime.enabled',
    label: 'Enable realtime audio',
    section: 'voice',
    tab: 'realtime',
    keywords: ['voice chat', 'call', 'live'],
  },
  {
    id: 'realtime.provider',
    label: 'Realtime provider',
    section: 'voice',
    tab: 'realtime',
    keywords: ['openai', 'azure'],
  },
  { id: 'realtime.model', label: 'Realtime model', section: 'voice', tab: 'realtime' },
  { id: 'realtime.voice', label: 'Realtime voice', section: 'voice', tab: 'realtime' },
  {
    id: 'realtime.memoryContext.enabled',
    label: 'Include chat memory in call context',
    section: 'voice',
    tab: 'realtime',
    keywords: ['history'],
  },
  {
    id: 'realtime.turnDetection.type',
    label: 'Turn detection',
    section: 'voice',
    tab: 'realtime',
    keywords: ['vad', 'silence'],
  },
  {
    id: 'realtime.autoEndCall.enabled',
    label: 'Automatically end call on silence',
    section: 'voice',
    tab: 'realtime',
    keywords: ['hangup', 'timeout'],
  },

  // ─── Voice › Dictation ───
  {
    id: 'dictation.enabled',
    label: 'Enable Dictation Anywhere',
    section: 'voice',
    tab: 'dictation',
    keywords: ['stt', 'speech to text', 'transcribe'],
  },
  {
    id: 'dictation.hotkey',
    label: 'Dictation hotkey',
    section: 'voice',
    tab: 'dictation',
    keywords: ['shortcut', 'keybinding'],
  },
  {
    id: 'dictation.provider',
    label: 'Dictation provider',
    section: 'voice',
    tab: 'dictation',
    keywords: ['whisper', 'openai'],
  },
  {
    id: 'dictation.mode',
    label: 'Dictation mode',
    section: 'voice',
    tab: 'dictation',
    keywords: ['push to talk', 'hold', 'toggle'],
  },
  {
    id: 'dictation.finalCleanupEnabled',
    label: 'Clean up final transcript',
    section: 'voice',
    tab: 'dictation',
    keywords: ['punctuation', 'format'],
  },
  {
    id: 'dictation.vadSilenceDurationMs',
    label: 'VAD silence threshold',
    section: 'voice',
    tab: 'dictation',
    keywords: ['voice activity'],
  },

  // ─── Autopilot ───
  {
    id: 'computerUse.enabled',
    label: 'Autopilot enabled',
    section: 'computer-use',
    keywords: ['computer use', 'browser', 'automation'],
  },
  {
    id: 'computerUse.defaultTarget',
    label: 'Default target',
    section: 'computer-use',
    keywords: ['isolated browser', 'local mac'],
  },
  {
    id: 'computerUse.approvalModeDefault',
    label: 'Approval mode',
    section: 'computer-use',
    keywords: ['step', 'goal', 'autonomous'],
  },
  { id: 'computerUse.idleTimeoutSec', label: 'Idle timeout', section: 'computer-use', keywords: ['seconds'] },
  {
    id: 'computerUse.maxSessionDurationMin',
    label: 'Max session duration',
    section: 'computer-use',
    keywords: ['minutes', 'limit'],
  },
  {
    id: 'computerUse.models',
    label: 'Autopilot model assignments',
    section: 'computer-use',
    keywords: ['planner', 'driver', 'verifier', 'recovery'],
  },
  {
    id: 'computerUse.safety.pauseOnTerminal',
    label: 'Pause on Terminal actions',
    section: 'computer-use',
    keywords: ['safety'],
  },
  {
    id: 'computerUse.localMacos.allowedDisplays',
    label: 'Allowed displays',
    section: 'computer-use',
    keywords: ['monitor', 'screen'],
  },
  {
    id: 'computerUse.localMacos.captureExcludedApps',
    label: 'Capture excluded apps',
    section: 'computer-use',
    keywords: ['hide', 'privacy'],
  },
  { id: 'computerUse.overlay.enabled', label: 'Overlay status bar', section: 'computer-use' },
  {
    id: 'computerUse.capture.maxDimension',
    label: 'Screenshot max dimension',
    section: 'computer-use',
    keywords: ['resolution', 'capture'],
    fallbackId: 'computerUse.capture',
  },

  // ─── Media Generation ───
  {
    id: 'imageGeneration.enabled',
    label: 'Image generation',
    section: 'media-generation',
    tab: 'image',
    keywords: ['dall-e', 'sora', 'picture'],
  },
  {
    id: 'imageGeneration.size',
    label: 'Image size',
    section: 'media-generation',
    tab: 'image',
    keywords: ['resolution', 'dimensions'],
  },
  { id: 'imageGeneration.quality', label: 'Image quality', section: 'media-generation', tab: 'image' },
  {
    id: 'videoGeneration.enabled',
    label: 'Video generation',
    section: 'media-generation',
    tab: 'video',
    keywords: ['sora'],
  },
  {
    id: 'videoGeneration.duration',
    label: 'Video duration',
    section: 'media-generation',
    tab: 'video',
    keywords: ['seconds', 'length'],
  },

  // ─── Web UI ───
  {
    id: 'webServer.enabled',
    label: 'Enable Web UI server',
    section: 'web-server',
    keywords: ['http', 'remote', 'browser', 'network'],
  },
  { id: 'webServer.port', label: 'Web UI port', section: 'web-server', fallbackId: 'webServer.enabled' },
  {
    id: 'webServer.bindAddress',
    label: 'Bind address',
    section: 'web-server',
    keywords: ['host', 'ip', 'interface'],
    fallbackId: 'webServer.enabled',
  },
  {
    id: 'webServer.tls.enabled',
    label: 'Enable HTTPS',
    section: 'web-server',
    keywords: ['tls', 'ssl', 'certificate'],
    fallbackId: 'webServer.enabled',
  },
  {
    id: 'webServer.tls.mode',
    label: 'Certificate mode',
    section: 'web-server',
    keywords: ['self-signed', 'custom cert'],
    fallbackId: 'webServer.enabled',
  },
  {
    id: 'webServer.auth.mode',
    label: 'Web UI access mode',
    section: 'web-server',
    keywords: ['authentication', 'anonymous', 'password', 'login'],
    fallbackId: 'webServer.enabled',
  },
  {
    id: 'webServer.auth.password',
    label: 'Web UI password',
    section: 'web-server',
    keywords: ['login', 'credential'],
    fallbackId: 'webServer.enabled',
  },
];

export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.keywords?.some((k) => k.toLowerCase().includes(q)),
  ).slice(0, 30);
}

export function breadcrumb(entry: SettingsSearchEntry): string {
  const section = SECTION_LABELS[entry.section];
  return entry.tab ? `${section} › ${TAB_LABELS[entry.tab] ?? entry.tab}` : section;
}
