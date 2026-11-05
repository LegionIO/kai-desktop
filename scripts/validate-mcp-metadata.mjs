import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const expected = JSON.parse(await readFile(new URL('../site/oauth/client-metadata.json', import.meta.url), 'utf8'));
assert.equal(expected.client_id, 'https://legionio.github.io/kai-desktop/oauth/client-metadata.json');
assert.equal(expected.application_type, 'native');
assert.equal(expected.token_endpoint_auth_method, 'none');
assert.deepEqual(expected.grant_types, ['authorization_code', 'refresh_token']);
assert.deepEqual(expected.response_types, ['code']);
assert.deepEqual(expected.redirect_uris, ['http://127.0.0.1/callback', 'http://localhost/callback']);
assert.equal(expected.client_name, 'Kai');
assert.equal(expected.client_uri, 'https://github.com/LegionIO/kai-desktop');
assert.equal(Object.keys(expected).length, 8, 'Only public client metadata belongs in the Pages artifact');

if (process.argv.includes('--live')) {
  const response = await fetch(expected.client_id, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i);
  assert.deepEqual(await response.json(), expected);
}
console.info('MCP client metadata verified');
