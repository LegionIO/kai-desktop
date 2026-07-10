import type { IpcMain } from 'electron';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, resolve, sep } from 'path';
import type { AppConfig } from '../config/schema.js';
import { loadSkillsFromDisk } from '../tools/skill-loader.js';
import { readContainedFileSync, SKILL_MANIFEST_MAX_BYTES, SKILL_FILE_MAX_BYTES } from '../tools/skill-fs.js';
import { readEffectiveConfig, writeDesktopConfig } from './config.js';

function readConfig(appHome: string): AppConfig {
  return readEffectiveConfig(appHome);
}

/**
 * Validate a skill name and resolve it to a directory strictly inside skillsDir.
 * Returns null if the name contains path separators, traversal segments, or
 * resolves outside skillsDir.
 */
function safeSkillDir(skillsDir: string, name: string): string | null {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return null;
  }
  const skillDir = join(skillsDir, name);
  const resolved = resolve(skillDir);
  if (!resolved.startsWith(resolve(skillsDir) + sep)) {
    return null;
  }
  return skillDir;
}

export function registerSkillsHandlers(ipcMain: IpcMain, appHome: string): void {
  ipcMain.handle('skills:list', async () => {
    const config = readConfig(appHome);
    const skillsDir = config.skills?.directory || join(appHome, 'skills');
    const skills = loadSkillsFromDisk(skillsDir);
    const enabled = config.skills?.enabled ?? [];

    return skills.map(({ manifest, dir }) => ({
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      type: manifest.execution.type,
      enabled: enabled.length === 0 || enabled.includes(manifest.name),
      dir,
    }));
  });

  ipcMain.handle('skills:get', async (_event, name: string) => {
    const config = readConfig(appHome);
    const skillsDir = config.skills?.directory || join(appHome, 'skills');
    const skillDir = safeSkillDir(skillsDir, name);
    if (!skillDir) return { error: 'Invalid skill name' };
    const manifestPath = join(skillDir, 'skill.json');

    if (!existsSync(manifestPath)) return { error: `Skill "${name}" not found.` };

    const manifestRaw = readContainedFileSync(skillDir, manifestPath, SKILL_MANIFEST_MAX_BYTES);
    if (manifestRaw == null) return { error: `Skill "${name}" manifest is missing, too large, or not a regular file.` };
    const manifest = JSON.parse(manifestRaw);
    const files: Record<string, string> = {};

    try {
      const entries = readdirSync(skillDir);
      for (const entry of entries) {
        if (entry === 'skill.json') continue;
        // Symlink-safe + size-capped: a symlinked file inside a skill dir must
        // not expose an arbitrary local file through the get IPC.
        const contents = readContainedFileSync(skillDir, join(skillDir, entry), SKILL_FILE_MAX_BYTES);
        if (contents != null) files[entry] = contents;
      }
    } catch {
      /* ignore */
    }

    return { manifest, files, dir: skillDir };
  });

  ipcMain.handle('skills:delete', async (_event, name: string) => {
    const config = readConfig(appHome);
    const skillsDir = config.skills?.directory || join(appHome, 'skills');
    const skillDir = safeSkillDir(skillsDir, name);
    if (!skillDir) return { error: 'Invalid skill name' };

    if (!existsSync(skillDir)) return { error: `Skill "${name}" not found.` };

    rmSync(skillDir, { recursive: true, force: true });

    // Remove from enabled list
    const enabled = (config.skills?.enabled ?? []).filter((s: string) => s !== name);
    config.skills = { ...config.skills, enabled, directory: config.skills?.directory ?? join(appHome, 'skills') };
    writeDesktopConfig(appHome, config);

    return { success: true };
  });

  ipcMain.handle('skills:toggle', async (_event, name: string, enable: boolean) => {
    const config = readConfig(appHome);
    let enabled = [...(config.skills?.enabled ?? [])];

    if (enable && !enabled.includes(name)) {
      enabled.push(name);
    } else if (!enable) {
      enabled = enabled.filter((s: string) => s !== name);
    }

    config.skills = { ...config.skills, enabled, directory: config.skills?.directory ?? join(appHome, 'skills') };
    writeDesktopConfig(appHome, config);

    return { success: true, enabled: enable };
  });
}
