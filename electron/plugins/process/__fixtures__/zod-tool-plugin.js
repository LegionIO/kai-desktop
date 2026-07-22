import { z } from 'zod';

export function activate(api) {
  api.tools.register([
    {
      name: 'zod_fixture',
      description: 'Registers a Zod-backed tool without synchronous host calls.',
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ value }),
    },
  ]);
}
