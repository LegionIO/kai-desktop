import { z } from 'zod';
import type { BrowserActionRequest, BrowserScreenshotRequest } from '../../shared/browser.js';
import { MAX_BROWSER_URL_CHARS } from './metadata.js';

export const MAX_BROWSER_SELECTOR_CHARS = 8 * 1024;
export const MAX_BROWSER_SEMANTIC_TARGET_CHARS = 4 * 1024;
export const MAX_BROWSER_ROLE_CHARS = 128;
export const MAX_BROWSER_TYPED_VALUE_CHARS = 100_000;
export const MAX_BROWSER_KEY_CHARS = 64;
export const MAX_BROWSER_KEYS = 16;
export const MAX_BROWSER_INPUT_COORDINATE = 100_000;
const BROWSER_MODIFIER_KEYS = new Set(['shift', 'control', 'ctrl', 'alt', 'meta', 'command']);

const tabId = z.string().uuid().optional();
const boundedCoordinate = z.number().finite().min(-MAX_BROWSER_INPUT_COORDINATE).max(MAX_BROWSER_INPUT_COORDINATE);
const boundedViewportCoordinate = boundedCoordinate.min(0);

export const browserActionRequestSchema = z
  .object({
    tabId,
    kind: z.enum([
      'navigate',
      'back',
      'forward',
      'reload',
      'stop',
      'click',
      'doubleClick',
      'hover',
      'focus',
      'type',
      'press',
      'scroll',
      'drag',
      'wait',
      'bookmark',
      'unbookmark',
    ]),
    url: z.string().max(MAX_BROWSER_URL_CHARS).optional(),
    selector: z.string().max(MAX_BROWSER_SELECTOR_CHARS).optional(),
    role: z.string().max(MAX_BROWSER_ROLE_CHARS).optional(),
    name: z.string().max(MAX_BROWSER_SEMANTIC_TARGET_CHARS).optional(),
    // `text` is normally a semantic target. Navigate and legacy type/press
    // forms also use it as their value, so the kind-specific cap below is wider.
    text: z.string().max(MAX_BROWSER_TYPED_VALUE_CHARS).optional(),
    value: z.string().max(MAX_BROWSER_TYPED_VALUE_CHARS).optional(),
    keys: z.array(z.string().min(1).max(MAX_BROWSER_KEY_CHARS)).max(MAX_BROWSER_KEYS).optional(),
    x: boundedViewportCoordinate.optional(),
    y: boundedViewportCoordinate.optional(),
    endX: boundedCoordinate.optional(),
    endY: boundedCoordinate.optional(),
    deltaX: boundedCoordinate.optional(),
    deltaY: boundedCoordinate.optional(),
    waitMs: z.number().int().min(0).max(30_000).optional(),
  })
  .superRefine((request, context) => {
    if (request.kind === 'press' && request.keys && request.keys.length > 1) {
      const invalidModifierIndex = request.keys
        .slice(0, -1)
        .findIndex((key) => !BROWSER_MODIFIER_KEYS.has(key.toLowerCase()));
      if (invalidModifierIndex >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keys', invalidModifierIndex],
          message: 'Browser press keys must contain only modifiers before the final key.',
        });
      }
    }
    if (request.text === undefined) return;
    const maximum =
      request.kind === 'navigate'
        ? MAX_BROWSER_URL_CHARS
        : request.kind === 'type'
          ? MAX_BROWSER_TYPED_VALUE_CHARS
          : request.kind === 'press'
            ? MAX_BROWSER_KEY_CHARS
            : MAX_BROWSER_SEMANTIC_TARGET_CHARS;
    if (request.text.length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `Browser ${request.kind} text is limited to ${maximum} characters.`,
      });
    }
  });

export const browserScreenshotRequestSchema = z.object({
  tabId,
  mode: z.enum(['viewport', 'full-page', 'element']).default('viewport'),
  selector: z.string().max(MAX_BROWSER_SELECTOR_CHARS).optional(),
  documentToken: z.string().max(256).optional(),
  saveToFile: z.boolean().default(false),
  exportToFile: z.boolean().default(false),
});

export const browserScreenshotToolInputSchema = browserScreenshotRequestSchema.omit({
  documentToken: true,
  exportToFile: true,
});

export const browserPermissionDecisionSchema = z.enum(['allow-once', 'allow', 'deny']);

export function parseBrowserActionRequest(input: unknown): BrowserActionRequest {
  return browserActionRequestSchema.parse(input) as BrowserActionRequest;
}

export function parseBrowserScreenshotRequest(input: unknown): BrowserScreenshotRequest {
  return browserScreenshotRequestSchema.parse(input) as BrowserScreenshotRequest;
}

export function parseBrowserPermissionDecision(input: unknown): 'allow-once' | 'allow' | 'deny' {
  const result = browserPermissionDecisionSchema.safeParse(input);
  if (!result.success) {
    throw new Error('Browser permission decision must be allow-once, allow, or deny.');
  }
  return result.data;
}
