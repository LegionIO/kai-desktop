import { fromJSONSchema, toJSONSchema, type ZodType } from 'zod';
import type { ZodWireCodec } from './wire.js';

/**
 * Heavy, optional Zod bridge. Keeping this in its own module lets Rollup emit a
 * lazy chunk for utility processes whose plugins never transport schemas.
 */
export const zodWireCodec: ZodWireCodec = {
  toJSONSchema: (schema) =>
    toJSONSchema(schema as ZodType, {
      io: 'input',
      unrepresentable: 'any',
    }),
  fromJSONSchema: (schema) => fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]),
};
