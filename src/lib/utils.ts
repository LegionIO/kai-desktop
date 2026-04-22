import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Re-focus the chat composer after an interaction that steals focus
 * (tool approvals, native dialogs, etc.).
 */
export function refocusComposer() {
  window.focus();
  setTimeout(() => {
    // Target the composer's contenteditable inside <main>, not the
    // sidebar search box (which is also contenteditable).
    document.querySelector<HTMLElement>('main [contenteditable]')?.focus();
  }, 50);
}

/** Generate a UUID, with fallback for non-secure contexts (HTTP web UI). */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
