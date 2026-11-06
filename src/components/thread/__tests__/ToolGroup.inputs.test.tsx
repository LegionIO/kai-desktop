import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render as renderComponent, screen, waitFor } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';
import { mcpToolCallFixture } from '../../../../test-utils/mcp-ui';
import { ToolCallDisplay } from '../ToolGroup';

afterEach(cleanup);
const render = (ui: ReactElement) => renderComponent(ui, { wrapper: TooltipProvider });

it.each([
  'MCP repeat test verified',
  { value: 'MCP repeat test verified', _diffTracking: {} },
  { output: 'MCP repeat test verified' },
  { content: 'MCP repeat test verified', path: '/fixture/result.txt' },
])('preserves all MCP inputs when results match a specialized output shape: %j', async (result) => {
  render(<ToolCallDisplay part={mcpToolCallFixture(result)} />);
  fireEvent.click(screen.getByRole('button', { name: /Mcp Secplat/ }));
  expect(screen.getByText('Input')).toBeInTheDocument();
  await waitFor(() => expect(document.body.textContent).toContain('Verify the MCP request'));
  expect(document.body.textContent).toContain('nonprod');
  expect(document.body.textContent).toContain('MCP repeat test verified');
});

it('keeps inputs available while running, on failure, and for streamed arguments', () => {
  const part = mcpToolCallFixture();
  const { rerender } = render(<ToolCallDisplay part={{ ...part, result: undefined }} />);
  fireEvent.click(screen.getByRole('button', { name: /Mcp Secplat/ }));
  expect(screen.getByText('Input')).toBeInTheDocument();
  rerender(<ToolCallDisplay part={{ ...part, isError: true, result: 'Request rejected' }} />);
  expect(screen.getByText('Input')).toBeInTheDocument();
  rerender(<ToolCallDisplay part={{ ...part, args: {}, argsText: '{"message":"streaming' }} />);
  expect(screen.getByText('Input')).toBeInTheDocument();
});

it('preserves the command view for actual shell tools', async () => {
  render(<ToolCallDisplay part={{ ...mcpToolCallFixture(), toolName: 'sh', args: { command: 'echo verified' } }} />);
  fireEvent.click(screen.getByRole('button', { name: /Run/ }));
  expect(screen.queryByText('Input')).not.toBeInTheDocument();
  await waitFor(() => expect(document.body.textContent).toContain('echo verified'));
});
