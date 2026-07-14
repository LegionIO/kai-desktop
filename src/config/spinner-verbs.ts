// Spinner verbs moved to shared/ so both the renderer (GUI thinking spinner)
// and the electron `kai` CLI can use the same list. Re-exported here to keep
// existing `@/config/spinner-verbs` imports working unchanged.
export { SPINNER_VERBS } from '../../shared/spinner-verbs';
