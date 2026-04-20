/**
 * Multi-tier project instructions loader.
 *
 * Discovers and merges instruction files from all major AI coding tool
 * conventions, since kai-desktop is a standalone Mastra-based agent that
 * no longer delegates to the Claude Code or Codex SDKs.
 *
 * Supported conventions (all discovered automatically):
 *
 *   Claude Code:
 *     - ~/.claude/CLAUDE.md                (user global)
 *     - ~/.claude/rules/*.md               (user rules, recursive)
 *     - CLAUDE.md                          (project, walked up from cwd)
 *     - .claude/CLAUDE.md                  (project, walked up from cwd)
 *     - .claude/rules/*.md                 (project rules, recursive)
 *     - CLAUDE.local.md                    (local override, cwd only)
 *
 *   OpenAI Codex / AGENTS.md:
 *     - AGENTS.md                          (project, walked up from cwd)
 *
 *   Cursor:
 *     - .cursorrules                       (project root)
 *     - .cursor/rules/*.md                 (project rules)
 *
 *   GitHub Copilot:
 *     - .github/copilot-instructions.md    (project root)
 *
 *   Windsurf:
 *     - .windsurfrules                     (project root)
 *
 *   Cline:
 *     - .clinerules                        (project root)
 *
 * Supports @include directive for composing instruction files.
 * Inspired by Claude Code's CLAUDE.md system (src/utils/claudemd.ts).
 */

import { readFile, stat, readdir } from 'fs/promises';
import { join, resolve, dirname, isAbsolute } from 'path';
import { homedir } from 'os';

export type InstructionSource = {
  path: string;
  tier: 'global' | 'project' | 'local';
  origin: string; // e.g. 'claude', 'codex'
  content: string;
};

const MAX_FILE_SIZE = 40 * 1024; // 40 KB per file
const MAX_TOTAL_SIZE = 200 * 1024; // 200 KB total
const MAX_INCLUDE_DEPTH = 5;

// Text file extensions allowed for @include (matches Claude Code's convention)
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.html', '.css', '.scss', '.less', '.sql', '.graphql',
  '.env', '.ini', '.cfg', '.conf', '.properties',
  '.r', '.R', '.jl', '.lua', '.pl', '.pm', '.ex', '.exs',
  '.zig', '.nim', '.v', '.dart', '.proto',
]);

// ─── Claude Code conventions ────────────────────────────────────────

/** Files searched at each directory level when walking upward. */
const CLAUDE_PROJECT_FILES = ['CLAUDE.md', '.claude/CLAUDE.md'];
const CLAUDE_RULES_DIR = '.claude/rules';
const CLAUDE_LOCAL_FILE = 'CLAUDE.local.md';
const CLAUDE_GLOBAL_FILE = join('.claude', 'CLAUDE.md');
const CLAUDE_GLOBAL_RULES = join('.claude', 'rules');

// ─── Codex convention ───────────────────────────────────────────────

const CODEX_PROJECT_FILES = ['AGENTS.md'];

/**
 * Load all instruction sources for a given working directory.
 * Returns sources in priority order (lowest priority first, highest last).
 */
export async function loadProjectInstructions(cwd: string): Promise<InstructionSource[]> {
  const sources: InstructionSource[] = [];
  const processedPaths = new Set<string>();

  // ── 1. Global (user-level) ──────────────────────────────────────

  const home = homedir();

  // ~/.claude/CLAUDE.md
  const globalClaudeMd = join(home, CLAUDE_GLOBAL_FILE);
  const globalContent = await safeReadWithIncludes(globalClaudeMd, processedPaths, 0);
  if (globalContent) {
    sources.push({ path: globalClaudeMd, tier: 'global', origin: 'claude', content: globalContent });
  }

  // ~/.claude/rules/*.md (recursive)
  const globalRulesDir = join(home, CLAUDE_GLOBAL_RULES);
  await collectRulesDir(globalRulesDir, 'global', 'claude', sources, processedPaths);

  // ── 2. Project (walk cwd → root) ───────────────────────────────

  const projectSources = await discoverProjectInstructions(cwd, processedPaths);
  for (const src of projectSources) {
    sources.push(src);
  }

  // ── 3. Local override (cwd only, highest priority) ─────────────

  const localPath = join(cwd, CLAUDE_LOCAL_FILE);
  const localContent = await safeReadWithIncludes(localPath, processedPaths, 0);
  if (localContent) {
    sources.push({ path: localPath, tier: 'local', origin: 'claude', content: localContent });
  }

  return sources;
}

/**
 * Build the full instructions string from all sources.
 */
export function buildInstructionsPrompt(sources: InstructionSource[]): string {
  if (sources.length === 0) return '';

  let totalSize = 0;
  const parts: string[] = [];

  for (const source of sources) {
    let content = source.content;

    // Enforce per-file size limit
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE);
      content += `\n\n[Truncated: ${source.path} exceeds ${MAX_FILE_SIZE / 1024}KB limit]`;
    }

    // Enforce total size limit
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (totalSize + contentSize > MAX_TOTAL_SIZE) {
      parts.push(`[Skipped: ${source.path} — total instruction size exceeds ${MAX_TOTAL_SIZE / 1024}KB limit]`);
      continue;
    }

    totalSize += contentSize;

    const tierLabel = source.tier === 'global' ? 'user instructions'
      : source.tier === 'local' ? 'local project instructions'
      : 'project instructions';

    parts.push(
      `Contents of ${source.path} (${tierLabel}):\n\n${content}`,
    );
  }

  if (parts.length === 0) return '';

  return [
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions.',
    '',
    ...parts,
  ].join('\n\n');
}

// ─── Directory traversal ────────────────────────────────────────────

/**
 * Walk from cwd upward to root, collecting project instruction files.
 * Returns sources ordered root-first (closest-to-cwd last = highest priority).
 */
async function discoverProjectInstructions(
  cwd: string,
  processedPaths: Set<string>,
): Promise<InstructionSource[]> {
  const sources: InstructionSource[] = [];
  const directories: string[] = [];

  let dir = resolve(cwd);
  const root = resolve('/');
  while (dir !== root) {
    directories.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Reverse so root-first, closest-to-cwd last (higher priority)
  directories.reverse();

  for (const directory of directories) {
    // Claude Code project files (CLAUDE.md, .claude/CLAUDE.md)
    for (const fileName of CLAUDE_PROJECT_FILES) {
      const filePath = join(directory, fileName);
      const content = await safeReadWithIncludes(filePath, processedPaths, 0);
      if (content) {
        sources.push({ path: filePath, tier: 'project', origin: 'claude', content });
      }
    }

    // .claude/rules/*.md (recursive)
    const rulesDir = join(directory, CLAUDE_RULES_DIR);
    await collectRulesDir(rulesDir, 'project', 'claude', sources, processedPaths);

    // AGENTS.md (Codex convention, also walked up)
    for (const fileName of CODEX_PROJECT_FILES) {
      const filePath = join(directory, fileName);
      const content = await safeReadPlain(filePath);
      if (content) {
        sources.push({ path: filePath, tier: 'project', origin: 'codex', content });
      }
    }
  }

  return sources;
}

/**
 * Recursively collect *.md files from a rules directory.
 */
async function collectRulesDir(
  rulesDir: string,
  tier: InstructionSource['tier'],
  origin: string,
  sources: InstructionSource[],
  processedPaths: Set<string>,
): Promise<void> {
  try {
    const entries = await readdir(rulesDir, { withFileTypes: true });
    const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      const entryPath = join(rulesDir, entry.name);
      if (entry.isDirectory()) {
        await collectRulesDir(entryPath, tier, origin, sources, processedPaths);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = await safeReadWithIncludes(entryPath, processedPaths, 0);
        if (content) {
          sources.push({ path: entryPath, tier, origin, content });
        }
      }
    }
  } catch {
    // Directory doesn't exist — fine
  }
}

// ─── File reading with @include ─────────────────────────────────────

/**
 * Read a file and process @include directives.
 * Returns null if the file doesn't exist.
 */
async function safeReadWithIncludes(
  filePath: string,
  processedPaths: Set<string>,
  depth: number,
): Promise<string | null> {
  if (depth > MAX_INCLUDE_DEPTH) return '[Max include depth exceeded]';

  const resolved = resolve(filePath);

  // Circular reference prevention
  if (processedPaths.has(resolved)) return null;

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return null;

    processedPaths.add(resolved);
    const raw = await readFile(resolved, 'utf-8');
    const stripped = stripHtmlComments(raw);
    return await processIncludes(stripped, dirname(resolved), processedPaths, depth);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    return null;
  }
}

/**
 * Read a plain file without @include processing (for companion tools).
 * Returns null if the file doesn't exist.
 */
async function safeReadPlain(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Process @include directives in content.
 * Syntax: @path, @./relative, @~/home, @/absolute
 * Skips lines inside fenced code blocks.
 */
async function processIncludes(
  content: string,
  baseDir: string,
  processedPaths: Set<string>,
  depth: number,
): Promise<string> {
  const lines = content.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track fenced code blocks to avoid processing @includes inside them
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Match @path lines (but not @mentions like @user or email-like patterns)
    if (/^@[.\/~]/.test(trimmed) || (trimmed.startsWith('@') && trimmed.length > 1 && !trimmed.includes(' ') && !trimmed.includes('@', 1))) {
      let includePath = trimmed.slice(1);

      // Strip fragment identifiers (@file.md#section → @file.md)
      const hashIdx = includePath.indexOf('#');
      if (hashIdx > 0) includePath = includePath.slice(0, hashIdx);

      let resolved: string;
      if (includePath.startsWith('~/')) {
        resolved = join(homedir(), includePath.slice(2));
      } else if (isAbsolute(includePath)) {
        resolved = includePath;
      } else {
        resolved = join(baseDir, includePath);
      }

      // Only include text files
      const ext = getExtension(resolved);
      if (!TEXT_EXTENSIONS.has(ext) && ext !== '') {
        result.push(line);
        continue;
      }

      const included = await safeReadWithIncludes(resolved, processedPaths, depth + 1);
      if (included !== null) {
        result.push(included);
      }
      // Silently skip non-existent includes (matches Claude Code behavior)
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * Strip block-level HTML comments from markdown content.
 * Leaves inline comments and unclosed comments intact.
 */
function stripHtmlComments(content: string): string {
  // Only strip comments that occupy their own block (entire line(s))
  return content.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, '');
}

function getExtension(filePath: string): string {
  const base = filePath.split('/').pop() ?? '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return base.slice(dotIdx).toLowerCase();
}
