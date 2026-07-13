import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadProjectInstructions, buildInstructionsPrompt } from '../instructions.js';

/**
 * Security regression: a DISCOVERY instruction file (CLAUDE.md / AGENTS.md) that
 * is itself a SYMLINK to an out-of-tree file must NOT read that file into the
 * system prompt. A hostile cloned repo could ship `CLAUDE.md → ~/.ssh/id_rsa` (or
 * AGENTS.md → /etc/passwd); the depth-0 read must realpath the file and reject a
 * target that escapes the directory it was discovered in. This complements the
 * @include-containment tests (which cover untrusted file *content*); here the
 * untrusted vector is the discovery file *path* being a symlink.
 */
describe('loadProjectInstructions depth-0 symlink containment', () => {
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

  it('refuses a CLAUDE.md that is a symlink to an out-of-tree secret', async () => {
    const secret = join(outsideDir, 'secret.txt');
    await writeFile(secret, 'CLAUDE_SYMLINK_SECRET_TOKEN', 'utf-8');
    // The discovered CLAUDE.md IS a symlink pointing outside the project tree.
    await symlink(secret, join(projectDir, 'CLAUDE.md'));

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).not.toContain('CLAUDE_SYMLINK_SECRET_TOKEN');
  });

  it('refuses an AGENTS.md that is a symlink to an out-of-tree secret', async () => {
    const secret = join(outsideDir, 'id_rsa');
    await writeFile(secret, 'AGENTS_SYMLINK_PRIVATE_KEY', 'utf-8');
    await symlink(secret, join(projectDir, 'AGENTS.md'));

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).not.toContain('AGENTS_SYMLINK_PRIVATE_KEY');
  });

  it('still reads a plain (non-symlink) in-tree CLAUDE.md', async () => {
    await writeFile(join(projectDir, 'CLAUDE.md'), 'PLAIN_IN_TREE_RULES', 'utf-8');
    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).toContain('PLAIN_IN_TREE_RULES');
  });

  it('still reads a plain (non-symlink) in-tree AGENTS.md', async () => {
    await writeFile(join(projectDir, 'AGENTS.md'), 'PLAIN_IN_TREE_AGENTS', 'utf-8');
    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).toContain('PLAIN_IN_TREE_AGENTS');
  });

  it('still reads a CLAUDE.md symlinked to another IN-TREE file (containment allows in-tree targets)', async () => {
    const realTarget = join(projectDir, 'real-rules.md');
    await writeFile(realTarget, 'IN_TREE_SYMLINK_TARGET', 'utf-8');
    await symlink(realTarget, join(projectDir, 'CLAUDE.md'));

    const sources = await loadProjectInstructions(projectDir);
    const prompt = buildInstructionsPrompt(sources);
    expect(prompt).toContain('IN_TREE_SYMLINK_TARGET');
  });
});
