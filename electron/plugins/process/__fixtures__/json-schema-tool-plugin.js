export function activate(api) {
  api.tools.register([
    {
      name: 'json_schema_fixture',
      description: 'Registers a JSON Schema tool without synchronous host calls.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execute: async ({ value }) => ({ value }),
    },
  ]);
}
