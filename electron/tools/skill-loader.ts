import { z } from 'zod';
import { readdirSync, existsSync, statSync, realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import { execPath } from 'process';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { AnyWorkflow } from '@mastra/core/workflows';
import { registerSkillWorkflow } from '../agent/mastra-instance.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { buildScopedToolName, findToolByName } from './naming.js';
import type { AppConfig } from '../config/schema.js';
import { runCommandWithStreaming, resolveProcessStreamingConfig } from './process-runner.js';
import { isCommandAllowed } from './shell.js';
import { runToolExecution } from './execution.js';
import { readContainedFileSync, SKILL_MANIFEST_MAX_BYTES } from './skill-fs.js';
import { withBrandUserAgent } from '../utils/user-agent.js';

/* ── Manifest types ── */

export type SkillExecutionType = 'shell' | 'script' | 'prompt' | 'http' | 'composite';

export type CompositeStep = {
  tool: string;
  args: Record<string, unknown>;
};

export type SkillExecution = {
  type: SkillExecutionType;
  command?: string;
  scriptFile?: string;
  promptTemplate?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  steps?: CompositeStep[];
};

export type SkillManifest = {
  name: string;
  description: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  execution: SkillExecution;
};

type WorkflowChain = {
  then: (step: unknown) => WorkflowChain;
  commit: () => AnyWorkflow;
};

export function getSkillToolName(skillName: string): string {
  return buildScopedToolName('skill', skillName);
}

/* ── Template interpolation ── */

export function interpolateTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{input\.([^}]+)\}\}/g, (_match, path: string) => {
    const keys = path.trim().split('.');
    let current: unknown = input;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return '';
      current = (current as Record<string, unknown>)[key];
    }
    return current == null ? '' : String(current);
  });
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Like interpolateTemplate, but each substituted value is single-quoted for the
 * shell so that interpolated input cannot break out of argument position.
 *
 * The regex also consumes an optional pair of single- or double-quotes that
 * directly surround the placeholder in the template, so that pre-existing
 * skill templates written as `./run.sh '{{input.name}}'` produce
 * `./run.sh 'value'` (safe) rather than `./run.sh ''value''` (which would
 * un-quote the value and re-introduce injection).
 */
export function interpolateTemplateShellSafe(template: string, input: Record<string, unknown>): string {
  return template.replace(/(['"]?)\{\{input\.([^}]+)\}\}\1/g, (_match, _quote: string, path: string) => {
    const keys = path.trim().split('.');
    let current: unknown = input;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return shellQuote('');
      current = (current as Record<string, unknown>)[key];
    }
    return shellQuote(current == null ? '' : String(current));
  });
}

/* ── JSON Schema → Zod conversion ── */

import { convertJsonSchemaToZod } from './json-schema-zod.js';

export { convertJsonSchemaToZod } from './json-schema-zod.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** HTTP-skill request timeout + response body cap. */
const HTTP_SKILL_TIMEOUT_MS = 30_000;
const HTTP_SKILL_MAX_BODY_BYTES = 10 * 1024 * 1024;

/* ── Skill loading from disk ── */

export function loadSkillsFromDisk(skillsDir: string): Array<{ manifest: SkillManifest; dir: string }> {
  if (!existsSync(skillsDir)) return [];

  const results: Array<{ manifest: SkillManifest; dir: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  let skillsRoot: string;
  try {
    skillsRoot = realpathSync(skillsDir);
  } catch {
    return [];
  }

  const seenNames = new Set<string>();

  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);
    // Reject a skill dir that isn't a real directory contained in the skills
    // root — a symlink could point outside it and load arbitrary code/manifests.
    let realSkillDir: string;
    try {
      if (!statSync(skillDir).isDirectory()) continue;
      realSkillDir = realpathSync(skillDir);
    } catch {
      continue;
    }
    if (realSkillDir !== skillsRoot && !realSkillDir.startsWith(skillsRoot + sep)) {
      console.warn(`[SkillLoader] Skipping skill "${entry}": resolves outside the skills directory`);
      continue;
    }

    const manifestPath = join(skillDir, 'skill.json');
    if (!existsSync(manifestPath)) continue;

    try {
      // Symlink-safe, size-capped read: skill.json must be a regular file inside
      // the skill dir — a symlinked manifest could expose an arbitrary local file.
      const manifestRaw = readContainedFileSync(skillDir, manifestPath, SKILL_MANIFEST_MAX_BYTES);
      if (manifestRaw == null) {
        console.warn(`[SkillLoader] Skipping skill "${entry}": manifest missing, too large, or not a regular file`);
        continue;
      }
      const raw = JSON.parse(manifestRaw);
      const name = raw.name ?? entry;
      // The manifest name is the tool's identity + the enablement key, so it
      // must be a valid slug AND match the directory name — otherwise a skill
      // could impersonate another (enabled) skill's name.
      if (!SKILL_NAME_RE.test(name)) {
        console.warn(`[SkillLoader] Skipping skill "${entry}": invalid manifest name "${name}"`);
        continue;
      }
      if (name !== entry) {
        console.warn(
          `[SkillLoader] Skipping skill in "${entry}": manifest name "${name}" does not match its directory`,
        );
        continue;
      }
      if (seenNames.has(name)) {
        console.warn(`[SkillLoader] Skipping duplicate skill name "${name}"`);
        continue;
      }
      seenNames.add(name);
      const manifest: SkillManifest = {
        name,
        description: raw.description ?? `Skill: ${entry}`,
        version: raw.version,
        inputSchema: raw.inputSchema,
        execution: raw.execution ?? { type: 'shell', command: './run.sh' },
      };
      results.push({ manifest, dir: skillDir });
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load skill ${entry}:`, err);
    }
  }

  return results;
}

/* ── Execution handler functions (used inside Mastra Steps) ── */

async function runShellExecution(
  manifest: SkillManifest,
  skillDir: string,
  input: Record<string, unknown>,
  getConfig: () => AppConfig,
): Promise<Record<string, unknown>> {
  const command = manifest.execution.command ?? './run.sh';

  // SECURITY: never interpolate agent-supplied input into the shell command.
  // Single-quoting is not enough — a placeholder that sits inside pre-existing
  // DOUBLE quotes in the template (e.g. `echo "x {{input.v}}"`) still allows
  // $(...) / backtick command substitution to execute. Input is passed to the
  // skill exclusively via the SKILL_INPUT env var (JSON). A command template
  // that still references {{input.…}} is rejected so the skill author migrates
  // to reading SKILL_INPUT instead of silently running an unsafe command.
  if (/\{\{\s*input\./.test(command)) {
    return {
      isError: true,
      error:
        'Skill shell commands may not interpolate {{input.*}} (shell-injection risk). ' +
        'Read the JSON input from the SKILL_INPUT environment variable instead.',
    };
  }
  const resolvedCommand = command;
  const config = getConfig();

  const check = isCommandAllowed(resolvedCommand, config);
  if (!check.allowed) {
    return { error: check.reason, isError: true };
  }

  const streaming = resolveProcessStreamingConfig(config);

  // Create a minimal execution context for process-runner (no progress/abort in workflow steps)
  const context: ToolExecutionContext = { toolCallId: `wf-${Date.now()}` };

  const result = await runCommandWithStreaming({
    command: resolvedCommand,
    cwd: skillDir,
    timeoutMs: config.tools.shell.timeout,
    env: { ...process.env, SKILL_INPUT: JSON.stringify(input) },
    context,
    streaming,
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { error: 'Skill timed out' } : {}),
    ...(result.cancelled ? { error: 'Skill cancelled' } : {}),
  };
}

async function runScriptExecution(
  manifest: SkillManifest,
  skillDir: string,
  input: Record<string, unknown>,
  getConfig: () => AppConfig,
): Promise<Record<string, unknown>> {
  const scriptFile = manifest.execution.scriptFile ?? 'index.mjs';
  const config = getConfig();
  const streaming = resolveProcessStreamingConfig(config);
  const context: ToolExecutionContext = { toolCallId: `wf-${Date.now()}` };

  // Resolve the script path and require it to stay inside the skill directory,
  // then run it with argv (shell:false). Passing it through a shell as
  // `node ${JSON.stringify(scriptFile)}` is injectable — JSON.stringify's double
  // quotes do NOT stop $(...) / backtick command substitution, so a crafted
  // manifest scriptFile could execute arbitrary shell.
  const skillRoot = realpathSync(skillDir);
  const scriptPath = resolve(skillRoot, scriptFile);
  let realScriptPath: string;
  try {
    realScriptPath = realpathSync(scriptPath);
  } catch {
    throw new Error(`Skill script not found: ${scriptFile}`);
  }
  if (realScriptPath !== skillRoot && !realScriptPath.startsWith(skillRoot + sep)) {
    throw new Error(`Skill script "${scriptFile}" escapes the skill directory`);
  }

  const result = await runCommandWithStreaming({
    command: `node ${JSON.stringify(scriptFile)}`,
    argv: [execPath, realScriptPath],
    cwd: skillDir,
    timeoutMs: config.tools.shell.timeout,
    env: { ...process.env, SKILL_INPUT: JSON.stringify(input) },
    context,
    streaming,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    parsed = undefined;
  }

  return {
    exitCode: result.exitCode,
    output: parsed ?? result.stdout,
    stderr: result.stderr || undefined,
    ...(result.timedOut ? { error: 'Skill timed out' } : {}),
    ...(result.cancelled ? { error: 'Skill cancelled' } : {}),
  };
}

function runPromptExecution(manifest: SkillManifest, input: Record<string, unknown>): Record<string, unknown> {
  const template = manifest.execution.promptTemplate ?? '';
  return { prompt: interpolateTemplate(template, input) };
}

async function runHttpExecution(
  manifest: SkillManifest,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const exec = manifest.execution;
  const url = interpolateTemplate(exec.url ?? '', input);
  const method = (exec.method ?? 'POST').toUpperCase();

  const headers = withBrandUserAgent({
    'Content-Type': 'application/json',
    ...(exec.headers ?? {}),
  });
  for (const [key, value] of Object.entries(headers)) {
    headers[key] = interpolateTemplate(value, input);
  }

  const fetchOptions: RequestInit = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    if (exec.bodyTemplate) {
      fetchOptions.body = interpolateTemplate(exec.bodyTemplate, input);
    } else {
      fetchOptions.body = JSON.stringify(input);
    }
  }

  // Bound the request: a slow/huge endpoint shouldn't hang the tool call or
  // buffer unbounded memory. Abort after HTTP_SKILL_TIMEOUT_MS and cap the body.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HTTP_SKILL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { ...fetchOptions, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }

  const contentType = resp.headers.get('content-type') ?? '';
  // Read the body stream with a byte cap instead of unbounded json()/text().
  const raw = await readCappedBody(resp, HTTP_SKILL_MAX_BODY_BYTES);
  let body: unknown;
  if (contentType.includes('json')) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  } else {
    body = raw;
  }

  return {
    status: resp.status,
    ok: resp.ok,
    body,
    ...(resp.ok ? {} : { error: `HTTP ${resp.status}` }),
  };
}

/** Read a response body up to `maxBytes`, aborting the stream once exceeded. */
async function readCappedBody(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return await resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          void reader.cancel();
          throw new Error(`HTTP skill response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/* ── Build a Mastra Workflow from a skill manifest ── */

const anySchema = z.record(z.string(), z.any());

export function skillToWorkflow(
  manifest: SkillManifest,
  skillDir: string,
  getConfig: () => AppConfig,
  allTools?: ToolDefinition[],
): AnyWorkflow {
  const inputSchema = manifest.inputSchema ? convertJsonSchemaToZod(manifest.inputSchema) : anySchema;
  const outputSchema = anySchema;

  if (manifest.execution.type === 'composite') {
    return buildCompositeWorkflow(manifest, inputSchema, outputSchema, getConfig, allTools ?? []);
  }

  // Single-step workflow for shell/script/prompt/http
  const executionStep = createStep({
    id: `${manifest.name}-execute`,
    description: manifest.description,
    inputSchema: anySchema,
    outputSchema: anySchema,
    execute: async ({ inputData }) => {
      const input = (inputData ?? {}) as Record<string, unknown>;
      switch (manifest.execution.type) {
        case 'shell':
          return runShellExecution(manifest, skillDir, input, getConfig);
        case 'script':
          return runScriptExecution(manifest, skillDir, input, getConfig);
        case 'prompt':
          return runPromptExecution(manifest, input);
        case 'http':
          return runHttpExecution(manifest, input);
        default:
          return { error: `Unknown execution type: ${manifest.execution.type}` };
      }
    },
  });

  const workflow = createWorkflow({
    id: getSkillToolName(manifest.name),
    description: manifest.description,
    inputSchema,
    outputSchema,
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .then(executionStep as any)
    .commit();

  registerSkillWorkflow(workflow);
  return workflow;
}

function buildCompositeWorkflow(
  manifest: SkillManifest,
  inputSchema: z.ZodTypeAny,
  outputSchema: z.ZodTypeAny,
  getConfig: () => AppConfig,
  allTools: ToolDefinition[],
): AnyWorkflow {
  const compositeSteps = manifest.execution.steps ?? [];
  if (compositeSteps.length === 0) {
    // Empty composite — create a no-op workflow
    const noOp = createStep({
      id: `${manifest.name}-noop`,
      inputSchema: anySchema,
      outputSchema: anySchema,
      execute: async () => ({ error: 'No steps defined in composite skill.' }),
    });
    const wf = createWorkflow({
      id: getSkillToolName(manifest.name),
      description: manifest.description,
      inputSchema,
      outputSchema,
    })
      .then(noOp as any)
      .commit();
    registerSkillWorkflow(wf);
    return wf;
  }

  // Create Mastra steps from each composite step definition
  const mastraSteps = compositeSteps.map((stepDef, i) => {
    return createStep({
      id: `${manifest.name}-step-${i}`,
      description: `Step ${i + 1}: ${stepDef.tool}`,
      inputSchema: anySchema,
      outputSchema: anySchema,
      execute: async ({ inputData }) => {
        const prevOutput = (inputData ?? {}) as Record<string, unknown>;
        const tool = findToolByName(allTools, stepDef.tool);
        if (!tool) {
          return { error: `Tool "${stepDef.tool}" not found.` };
        }

        // Merge step args with previous output
        const mergedInput: Record<string, unknown> = { ...prevOutput, ...stepDef.args };

        // Interpolate string values
        const interpolated: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(mergedInput)) {
          if (typeof value === 'string') {
            interpolated[key] = interpolateTemplate(value, prevOutput);
          } else {
            interpolated[key] = value;
          }
        }

        const context: ToolExecutionContext = { toolCallId: `wf-composite-${Date.now()}` };
        const result = await tool.execute(interpolated, context);
        // Ensure we return an object for the next step
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          return result as Record<string, unknown>;
        }
        return { value: result };
      },
    });
  });

  // Chain steps sequentially via .then()
  let wf = createWorkflow({
    id: getSkillToolName(manifest.name),
    description: manifest.description,
    inputSchema,
    outputSchema,
  }) as unknown as WorkflowChain;

  for (const step of mastraSteps) {
    wf = wf.then(step);
  }

  const committed = wf.commit();
  registerSkillWorkflow(committed);
  return committed;
}

/* ── Build a ToolDefinition wrapper around a workflow ── */

export function workflowToToolDefinition(manifest: SkillManifest, workflow: AnyWorkflow): ToolDefinition {
  const inputSchema = manifest.inputSchema ? convertJsonSchemaToZod(manifest.inputSchema) : z.object({}).passthrough();

  return {
    name: getSkillToolName(manifest.name),
    description: `[Workflow] ${manifest.description}`,
    inputSchema,
    source: 'skill',
    sourceId: manifest.name,
    originalName: manifest.name,
    aliases: [`skill:${manifest.name}`],
    execute: async (input, context) =>
      runToolExecution({
        context,
        run: async () => {
          const typedInput = (input ?? {}) as Record<string, unknown>;
          const run = await workflow.createRun();
          const result = await run.start({ inputData: typedInput });

          if (result.status === 'success') {
            return result.result ?? { status: 'success', steps: result.steps };
          }
          if (result.status === 'failed') {
            const workflowError =
              'error' in result &&
              result.error &&
              typeof result.error === 'object' &&
              'message' in result.error &&
              typeof result.error.message === 'string'
                ? result.error.message
                : 'Workflow failed';
            return {
              isError: true,
              error: workflowError,
              status: 'failed',
              steps: result.steps,
            };
          }
          return { status: result.status, steps: result.steps };
        },
      }),
  };
}

/* ── Load all enabled skills as Mastra Workflows ── */

export function loadSkillsAsWorkflows(
  skillsDir: string,
  enabledSkills: string[],
  getConfig: () => AppConfig,
  allTools?: ToolDefinition[],
): Map<string, AnyWorkflow> {
  const skills = loadSkillsFromDisk(skillsDir);
  const workflows = new Map<string, AnyWorkflow>();

  for (const { manifest, dir } of skills) {
    if (enabledSkills.length > 0 && !enabledSkills.includes(manifest.name)) continue;
    try {
      const wf = skillToWorkflow(manifest, dir, getConfig, allTools);
      workflows.set(manifest.name, wf);
    } catch (err) {
      console.warn(`[SkillLoader] Failed to create workflow for skill ${manifest.name}:`, err);
    }
  }

  console.info(`[SkillLoader] Loaded ${workflows.size} skill workflows from ${skillsDir}`);
  return workflows;
}

/* ── Load all enabled skills as tools (wrapping workflows) ── */

export function loadSkillsAsTools(
  skillsDir: string,
  enabledSkills: string[],
  getConfig: () => AppConfig,
  allTools?: ToolDefinition[],
): ToolDefinition[] {
  const skills = loadSkillsFromDisk(skillsDir);
  const tools: ToolDefinition[] = [];

  for (const { manifest, dir } of skills) {
    if (enabledSkills.length > 0 && !enabledSkills.includes(manifest.name)) continue;
    try {
      const workflow = skillToWorkflow(manifest, dir, getConfig, allTools);
      tools.push(workflowToToolDefinition(manifest, workflow));
    } catch (err) {
      console.warn(`[SkillLoader] Failed to create tool for skill ${manifest.name}:`, err);
    }
  }

  console.info(`[SkillLoader] Loaded ${tools.length} skill tools from ${skillsDir}`);
  return tools;
}
