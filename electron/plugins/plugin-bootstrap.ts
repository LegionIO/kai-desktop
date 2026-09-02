import { cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getPluginIntegrity, hashPluginDirectory, isTransientFsError } from './plugin-integrity.js';
import type { PluginIntegrity } from './plugin-integrity.js';

/**
 * Resolve the path to the bundled-plugins directory.
 *
 * In development (`electron-vite dev`) the source tree is used directly.
 * In packaged builds, `extraResources` places the folder alongside the asar.
 */
function getBundledPluginsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bundled-plugins');
  }
  // Dev mode — bundled-plugins/ lives at the project root
  return join(import.meta.dirname, '../../bundled-plugins');
}

/**
 * Copy brand-required plugins from the bundled resources into the user's
 * plugins directory (`~/.{appSlug}/plugins/`).
 *
 * Skips any plugin whose target directory already exists (idempotent).
 * This runs synchronously during startup, before plugin discovery.
 *
 * When marketplace URLs are configured, this function is a no-op — the
 * marketplace service handles required plugin installation instead.
 *
 * `protectedUpdates` (optional) marks plugins that owe un-reconciled
 * post-update cleanup per the post-update ledger. Their INSTALLED generation
 * must NOT be replaced before the reconciler runs their post-update hook: the
 * hook may need to run against the same code that performed the pre-update
 * setup (e.g. to revoke it). We leave the old generation in place this launch;
 * once reconciliation clears the debt, a later launch's bootstrap replaces it
 * (R28P1). `all:true` protects EVERY bundled plugin — used when the owed set is
 * UNKNOWN (a corrupt/unreadable ledger, or a legacy marker meaning "all
 * active"), so we never strand cleanup we can't enumerate. A missing arg means
 * "replace normally".
 */
export type BundledUpdateProtection = { names?: ReadonlySet<string>; all?: boolean };

/**
 * Pure predicate: is replacing this bundled plugin's installed generation
 * deferred because it owes un-reconciled post-update cleanup (R28P1)? `all`
 * protects everything (unknown owed set); otherwise only named plugins are
 * protected. Extracted so the decision is unit-testable without a filesystem or
 * the compile-time brand `define`s.
 */
export function isBundledUpdateProtected(entry: string, protection?: BundledUpdateProtection): boolean {
  if (!protection) return false;
  return protection.all === true || protection.names?.has(entry) === true;
}

/** Result of a bundled-plugin bootstrap pass. `incompleteBootstrap` is true when a
 *  bundled plugin could NOT be confirmed/installed this launch due to a transient
 *  filesystem failure (unconfirmable destination, or an unreadable bundled dir) — the
 *  caller must then block app installs for the session, else an absent/old required
 *  plugin could let an update bypass its pre-update veto (R46P1#structured). */
export type BundledBootstrapResult = { incompleteBootstrap: boolean };

export function bootstrapBundledPlugins(
  pluginsDir: string,
  protectedUpdates?: BundledUpdateProtection,
): BundledBootstrapResult {
  // Skip bundled-plugin copy when marketplace is configured
  try {
    if (Array.isArray(__BRAND_MARKETPLACE_URLS) && __BRAND_MARKETPLACE_URLS.length > 0) {
      return { incompleteBootstrap: false };
    }
  } catch {
    // __BRAND_MARKETPLACE_URLS not defined — continue with bundled bootstrap
  }

  const bundledDir = getBundledPluginsDir();
  // Stat the bundled dir directly (errno in hand). ENOENT = no bundled plugins ship
  // with this build (legitimate → not incomplete). A TRANSIENT error (EIO/EACCES/…) is
  // unconfirmable → incomplete so installs block + retry. A DETERMINISTIC defect
  // (ENOTDIR/ELOOP — a corrupt package) recurs EVERY launch, so flagging it incomplete
  // would PERMANENTLY block the updater, including the update that would repair the
  // bundle (R49P2) — surface it (warn) but do NOT wedge updates.
  try {
    statSync(bundledDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { incompleteBootstrap: false };
    const transient = isTransientFsError(err);
    console.warn(
      `[PluginBootstrap] Bundled-plugins dir unreadable (${transient ? 'transient' : 'deterministic'}) at ${bundledDir}:`,
      err,
    );
    return { incompleteBootstrap: transient };
  }

  let entries: string[];
  try {
    entries = readdirSync(bundledDir);
  } catch (err) {
    // Couldn't list the bundled dir. Transient → incomplete (retry next launch);
    // deterministic → surface but don't permanently wedge updates (R49P2).
    const transient = isTransientFsError(err);
    console.warn(
      `[PluginBootstrap] Could not read bundled-plugins dir (${transient ? 'transient' : 'deterministic'}):`,
      err,
    );
    return { incompleteBootstrap: transient };
  }

  let incompleteBootstrap = false;
  for (const entry of entries) {
    if (entry === '.gitkeep') continue;

    const srcDir = join(bundledDir, entry);
    const destDir = join(pluginsDir, entry);

    // Tracks whether we've begun MUTATING the destination for this entry (rm/cp).
    // Once mutation starts, ANY failure — even a "deterministic" ENOSPC/EDQUOT/EROFS
    // not in the transient errno set — leaves the plugin MISSING or PARTIAL, so the
    // session must block installs regardless of errno classification (R47P1). Before
    // any mutation, only a transient failure (which a retry can clear) blocks.
    let destMutationBegan = false;

    try {
      let action = 'Installed';
      const sourceHash = hashPluginDirectory(srcDir);
      // Classify the destination rather than a bare existsSync (R40P1): a transient
      // EIO/EACCES must NOT be read as "absent" — if the owed OLD generation is
      // actually present, treating it as missing would skip the protection check
      // Stat the destination directly (errno in hand). 'present' → compare/replace.
      // ENOENT → not installed yet → fall through to the fresh cpSync. Any OTHER error
      // means we can't confirm the destination: SKIP (never risk overwriting an owed
      // generation), but only mark the session-wide install block for a TRANSIENT
      // failure — a DETERMINISTIC dest defect (ENOTDIR/ELOOP) recurs every launch and
      // must not permanently wedge the updater (R49P2), consistent with the source-dir
      // handling above.
      let destPresent = false;
      try {
        statSync(destDir);
        destPresent = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          const transient = isTransientFsError(err);
          console.warn(
            `[PluginBootstrap] Skipping bundled plugin "${entry}" — destination unconfirmable (${transient ? 'transient' : 'deterministic'}); won't risk overwriting an owed generation:`,
            err,
          );
          if (transient) incompleteBootstrap = true;
          continue;
        }
      }
      if (destPresent) {
        const installedHash = hashPluginDirectory(destDir);
        if (installedHash === sourceHash) continue;
        // Owed post-update cleanup for this plugin (or an unknown owed set) —
        // DON'T replace its generation before the reconciler runs its
        // post-update hook against matching code (R28P1). It updates on a later
        // launch once the debt clears.
        if (isBundledUpdateProtected(entry, protectedUpdates)) {
          console.info(`[PluginBootstrap] Deferring bundled-plugin update for "${entry}" — owes post-update cleanup.`);
          continue;
        }
        destMutationBegan = true; // rmSync below deletes the working generation
        rmSync(destDir, { recursive: true, force: true });
        action = 'Updated';
      }

      destMutationBegan = true; // cpSync creates/replaces the destination
      cpSync(srcDir, destDir, { recursive: true });
      console.info(`[PluginBootstrap] ${action} bundled plugin "${entry}"`);
    } catch (err) {
      console.warn(`[PluginBootstrap] Failed to install bundled plugin "${entry}":`, err);
      // If destination mutation had begun, the plugin is now missing/partial (e.g.
      // rmSync succeeded then cpSync hit ENOSPC/EDQUOT/EROFS) → block installs so an
      // update can't proceed without its pre-update veto, regardless of errno (R47P1).
      // Before any mutation, only a TRANSIENT failure (retryable) blocks; a
      // deterministic pre-mutation failure (bad source) won't clear on retry.
      if (destMutationBegan || isTransientFsError(err)) incompleteBootstrap = true;
    }
  }
  return { incompleteBootstrap };
}

/**
 * Returns integrity metadata for a bundled plugin when the current brand ships
 * one. Used as a trusted source for required-plugin load checks in builds that
 * do not use a marketplace.
 *
 * Returns `null` ONLY for a genuine ABSENCE (ENOENT) or a DETERMINISTIC defect (bad
 * content) — a retry won't change those, so the caller's integrity check deterministically
 * rejects and the plugin stays inactive (surfaced as an error row). A TRANSIENT
 * filesystem failure (EIO/EACCES/EMFILE/…) is NOT collapsed to `null` (R46P1): that
 * would make the required plugin silently inactive with NO ledger debt, so an app
 * update could proceed WITHOUT its pre-update veto. Instead THROW — the failure
 * propagates through isRequiredPluginIntegrityTrusted → ensurePluginApproved → up to
 * loadPlugin's catch, which on the faithful startup pass marks discovery incomplete
 * and blocks installs for the session (R43P1), retrying next launch.
 */
export function getBundledPluginIntegrity(pluginName: string): PluginIntegrity | null {
  const pluginDir = join(getBundledPluginsDir(), pluginName);
  // Stat directly (not via pathAvailability) so a transient failure keeps its ORIGINAL
  // errno/cause — a bare replacement Error would carry no `code`, so loadPlugin's
  // isTransientFsError() wouldn't recognize it and discovery wouldn't be marked
  // incomplete (R46P1#structured). ENOENT → genuine absence → null.
  try {
    statSync(pluginDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err; // transient/permission — propagate WITH its errno so faithful startup blocks
  }

  try {
    return getPluginIntegrity(pluginDir, pluginName);
  } catch (err) {
    // Transient read/hash failure → propagate so faithful startup blocks updates;
    // a deterministic content defect → null (deterministic integrity rejection).
    if (isTransientFsError(err)) throw err;
    return null;
  }
}

/**
 * Returns the set of plugin names that the current brand mandates.
 */
export function getBrandRequiredPluginNames(): string[] {
  try {
    return [...__BRAND_REQUIRED_PLUGINS];
  } catch {
    return [];
  }
}

/**
 * Returns the marketplace catalog URLs configured for the current brand.
 */
export function getBrandMarketplaceUrls(): string[] {
  try {
    return [...__BRAND_MARKETPLACE_URLS];
  } catch {
    return [];
  }
}
