import { describe, it, expect } from 'vitest';
import { isBundledUpdateProtected } from '../plugin-bootstrap.js';

// R28P1: a bundled-plugin update must be DEFERRED (not replace the installed
// generation) while that plugin owes un-reconciled post-update cleanup, so the
// reconciler can run its post-update hook against matching code. The pure
// predicate below encodes that decision.
describe('isBundledUpdateProtected (R28P1)', () => {
  it('is not protected when no protection is supplied', () => {
    expect(isBundledUpdateProtected('privileges')).toBe(false);
    expect(isBundledUpdateProtected('privileges', undefined)).toBe(false);
    expect(isBundledUpdateProtected('privileges', {})).toBe(false);
  });

  it('protects a plugin named in the owed set, and only that one', () => {
    const protection = { names: new Set(['privileges']) };
    expect(isBundledUpdateProtected('privileges', protection)).toBe(true);
    expect(isBundledUpdateProtected('other', protection)).toBe(false);
  });

  it('protects EVERY plugin when the owed set is unknown (all:true)', () => {
    // Corrupt ledger / legacy marker → owed set unknown → protect all.
    const protection = { all: true, names: new Set<string>() };
    expect(isBundledUpdateProtected('privileges', protection)).toBe(true);
    expect(isBundledUpdateProtected('anything-else', protection)).toBe(true);
  });

  it('an empty owed set protects nothing (all:false, no names match)', () => {
    const protection = { all: false, names: new Set<string>() };
    expect(isBundledUpdateProtected('privileges', protection)).toBe(false);
  });
});
