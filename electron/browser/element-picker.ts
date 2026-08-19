import { MAX_BROWSER_SELECTOR_CHARS } from './input-validation.js';

export function validatePickedElementSelector(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BROWSER_SELECTOR_CHARS) {
    throw new Error(`Browser element selectors are limited to ${MAX_BROWSER_SELECTOR_CHARS} characters.`);
  }
  return value;
}
