import type { ActiveWindowInfo, UiNode } from '../electron/platform/types.js';

export type AppShotMeta = {
  capturedAt: string;
  platform: NodeJS.Platform;
  adapter: 'native' | 'fallback';
  app: ActiveWindowInfo | null;
  display?: { id: string; bounds: { x: number; y: number; width: number; height: number }; scale: number };
  selectedText?: string | null;
  uiTree?: UiNode | null;
};

export type AppShotPayload = {
  refId: string;
  imageDataUrl: string;
  imageBytes: number;
  meta: AppShotMeta;
  metaJson: string;
  suggestedName: string;
};

export const APP_SHOT_REF_PREFIX = 'kai-appshot:';

export function parseAppShotRef(text: string): string | null {
  const match = text.match(/\[kai-appshot:([A-Za-z0-9_-]{6,64})\]/);
  return match ? match[1] : null;
}

export function formatAppShotRef(refId: string): string {
  return `[${APP_SHOT_REF_PREFIX}${refId}]`;
}
