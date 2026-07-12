/**
 * Tests for mcp-manage.ts secret-redaction helpers (via __internal). MCP server
 * specs carry credentials in env values, args (--token X), and URL
 * userinfo/query/path — these helpers keep all of that out of the list/edit/
 * delete responses and the approval prompt shown to (and logged by) the model.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../mcp-manage.js';
import type { AppConfig } from '../../config/schema.js';

const { redactServer, redactUrl, describeServerForApproval } = __internal;
type McpServer = AppConfig['mcpServers'][number];
const srv = (o: Partial<McpServer>): McpServer => ({ name: 'srv', enabled: true, ...o }) as McpServer;

describe('redactUrl', () => {
  it('keeps a bare origin (+ root path) when there are no secret-bearing parts', () => {
    expect(redactUrl('https://mcp.example.com')).toBe('https://mcp.example.com/');
    expect(redactUrl('https://mcp.example.com/')).toBe('https://mcp.example.com/');
  });

  it('redacts the path when there is a non-root path (may carry a token)', () => {
    expect(redactUrl('https://mcp.example.com/hooks/abc123')).toBe('https://mcp.example.com/[redacted-path]');
  });

  it('redacts when userinfo / query / fragment are present', () => {
    expect(redactUrl('https://user:pw@mcp.example.com')).toBe('https://mcp.example.com/[redacted-path]');
    expect(redactUrl('https://mcp.example.com?token=abc')).toBe('https://mcp.example.com/[redacted-path]');
    expect(redactUrl('https://mcp.example.com#frag')).toBe('https://mcp.example.com/[redacted-path]');
  });

  it('falls back to [redacted-url] on an unparseable URL', () => {
    expect(redactUrl('not a url')).toBe('[redacted-url]');
  });
});

describe('redactServer', () => {
  it('masks env VALUES (keeps key names), redacts arg COUNT, and redacts the url', () => {
    const out = redactServer(
      srv({
        command: 'node',
        args: ['--token', 'sk-secret', '--header', 'Authorization: Bearer x'],
        url: 'https://mcp.example.com/hooks/abc',
        env: { API_KEY: 'sk-live-123', REGION: 'us' },
      }),
    );
    expect(out.command).toBe('node');
    expect(out.args).toBe('[4 arg(s) redacted]');
    expect(out.url).toBe('https://mcp.example.com/[redacted-path]');
    expect(out.env).toEqual({ API_KEY: '[redacted]', REGION: '[redacted]' });
    // no raw secret leaks anywhere in the serialized output
    expect(JSON.stringify(out)).not.toContain('sk-live-123');
    expect(JSON.stringify(out)).not.toContain('sk-secret');
  });

  it('omits absent fields and reflects enabled default', () => {
    const out = redactServer(srv({ name: 'x', enabled: undefined }));
    expect(out.name).toBe('x');
    expect(out.enabled).toBe(true); // enabled !== false → true
    expect('args' in out).toBe(false);
    expect('url' in out).toBe(false);
    expect('env' in out).toBe(false);
  });

  it('treats enabled:false as disabled', () => {
    expect(redactServer(srv({ enabled: false })).enabled).toBe(false);
  });
});

describe('describeServerForApproval', () => {
  it('discloses command + arg count + redacted url + env KEY names only', () => {
    const desc = describeServerForApproval({
      command: 'node',
      args: ['--token', 'x'],
      url: 'https://mcp.example.com/hooks/abc',
      env: { API_KEY: 'sk-live', REGION: 'us' },
    });
    expect(desc).toContain('command: node (+2 arg(s))');
    expect(desc).toContain('url: https://mcp.example.com/[redacted-path]');
    expect(desc).toContain('env: API_KEY, REGION');
    expect(desc).not.toContain('sk-live'); // values never disclosed
    expect(desc).not.toContain('--token');
  });

  it('handles a spec with no launch fields', () => {
    expect(describeServerForApproval({})).toBe('(no launch spec)');
  });
});
