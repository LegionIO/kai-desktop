'use strict';

/**
 * Node SEA entrypoints intentionally cannot import modules from the file
 * system. This tiny trampoline is embedded as a SEA asset, materialized into a
 * private temporary directory, and loaded as a regular CommonJS module. Its
 * dynamic import therefore uses Node's normal filesystem ESM loader.
 */
exports.loadExternalModule = (specifier) => import(specifier);
