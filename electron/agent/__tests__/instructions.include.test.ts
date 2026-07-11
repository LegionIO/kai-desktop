import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProjectInstructions, buildInstructionsPrompt } from '../instructions.js';

/**
 * Security regression: an @include directive in a project instruction file
 * (which may come from an untrusted/cloned repo) must NOT be able to splice
 * arbitrary local files outside the project tree into the model system prompt.
 */
describe('loadProjectInstructions @include containment', () => {
  let projectDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'kai-instr-proj-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'kai-instr-secret-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses an absolute @include that escapes the project tree', async () => {
    const secret = join(outsideDir, 'secret.md');
    await writeFile(secret, 'TOP_SECRET_ABSOLUTE_TOKEN', 'utf-8');
    await writeFile(join(projectDir, 'CLAUDE.md'), `Project rules.\n@${secret}\n`, 'utf-8');

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).not.toContain('TOP_SECRET_ABSOLUTE_TOKEN');
  });

  it('refuses a relative traversal @include that escapes the project tree', async () => {
    const secret = join(outsideDir, 'creds.md');
    await writeFile(secret, 'TOP_SECRET_TRAVERSAL_TOKEN', 'utf-8');
    // ../<secretDirName>/creds.md relative to the project dir
    const rel = join('..', outsideDir.split('/').pop() as string, 'creds.md');
    await writeFile(join(projectDir, 'CLAUDE.md'), `Rules.\n@${rel}\n`, 'utf-8');

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).not.toContain('TOP_SECRET_TRAVERSAL_TOKEN');
  });

  it('refuses an extensionless @include (secrets like id_rsa are extensionless)', async () => {
    const secret = join(outsideDir, 'id_rsa');
    await writeFile(secret, 'PRIVATE_KEY_MATERIAL', 'utf-8');
    await writeFile(join(projectDir, 'CLAUDE.md'), `Rules.\n@${secret}\n`, 'utf-8');

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).not.toContain('PRIVATE_KEY_MATERIAL');
  });

  it('still splices a legitimate in-tree relative @include', async () => {
    await mkdir(join(projectDir, 'docs'), { recursive: true });
    await writeFile(join(projectDir, 'docs', 'extra.md'), 'IN_TREE_INCLUDED_CONTENT', 'utf-8');
    await writeFile(join(projectDir, 'CLAUDE.md'), `Rules.\n@./docs/extra.md\n`, 'utf-8');

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).toContain('IN_TREE_INCLUDED_CONTENT');
  });
});
