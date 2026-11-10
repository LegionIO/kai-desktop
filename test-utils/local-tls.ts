import forge from 'node-forge';
import { createServer, request, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

let fixtureKeys: { cert: string; key: string } | undefined;
/** Ephemeral test-only TLS keys. Never read or write the user's Kai certs. */
export function localTlsKeys(): { cert: string; key: string } {
  if (fixtureKeys) return fixtureKeys;
  const keys = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2025-01-01');
  cert.validity.notAfter = new Date('2040-01-01');
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fixtureKeys = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
  return fixtureKeys;
}
export async function localHttpsFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(localTlsKeys(), handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    server,
    request: (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      localHttpsRequest(origin, path, options),
    close: () => closeServer(server),
  };
}
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
export function localHttpsRequest(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const url = new URL(path, origin);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    throw new Error('TLS test fixture allows loopback only.');
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
