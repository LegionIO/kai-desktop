/**
 * Tests for two renderer pure helpers (component-gated via 178f07b):
 *  - appShotPayloadToAttachments: turns a captured App Shot (screenshot + meta)
 *    into the two composer attachments (image + JSON sidecar). The MIME→ext
 *    mapping + base64 sidecar encoding are the regression-prone bits.
 *  - headTailLabel: the compaction head/tail-ratio slider label.
 */
import { describe, it, expect } from 'vitest';
import { appShotPayloadToAttachments } from '../useAppShots';
import { headTailLabel } from '@/components/settings/shared';
import type { AppShotPayload } from '../../../shared/app-shots';

const payload = (over: Partial<AppShotPayload> = {}): AppShotPayload =>
  ({
    refId: 'abc123',
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    imageBytes: 1234,
    meta: {} as AppShotPayload['meta'],
    metaJson: '{"app":"Safari"}',
    suggestedName: 'appshot-1',
    ...over,
  }) as AppShotPayload;

describe('appShotPayloadToAttachments', () => {
  it('produces an image attachment + a JSON sidecar', () => {
    const [img, json] = appShotPayloadToAttachments(payload());
    expect(img).toMatchObject({
      name: 'appshot-1.png',
      mime: 'image/png',
      isImage: true,
      size: 1234,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(json).toMatchObject({
      name: 'appshot-1.appshot.json',
      mime: 'application/json',
      isImage: false,
      text: '{"app":"Safari"}',
    });
  });

  it('base64-encodes the metaJson into the sidecar dataUrl', () => {
    const [, json] = appShotPayloadToAttachments(payload({ metaJson: '{"x":1}' }));
    expect(json.dataUrl).toBe(`data:application/json;base64,${btoa('{"x":1}')}`);
    // sidecar size is the UTF-8 byte length of the metaJson
    expect(json.size).toBe(new TextEncoder().encode('{"x":1}').length);
  });

  it('maps known image MIME types to their extension', () => {
    expect(appShotPayloadToAttachments(payload({ imageDataUrl: 'data:image/jpeg;base64,x' }))[0].name).toBe(
      'appshot-1.jpg',
    );
    expect(appShotPayloadToAttachments(payload({ imageDataUrl: 'data:image/webp;base64,x' }))[0].name).toBe(
      'appshot-1.webp',
    );
  });

  it('falls back to a sanitized subtype for an unknown MIME', () => {
    const [img] = appShotPayloadToAttachments(payload({ imageDataUrl: 'data:image/avif;base64,x' }));
    expect(img.mime).toBe('image/avif');
    expect(img.name).toBe('appshot-1.avif');
  });

  it('defaults to png when the data URL has an empty MIME segment', () => {
    // ';' at index 5 → slice(5,5) is '' → `|| 'image/png'` fallback engages.
    const [img] = appShotPayloadToAttachments(payload({ imageDataUrl: 'data:;base64,x' }));
    expect(img.mime).toBe('image/png');
    expect(img.name).toBe('appshot-1.png');
  });
});

describe('headTailLabel', () => {
  it('labels a head/tail split', () => {
    expect(headTailLabel('Truncate', 0.3)).toBe('Truncate: 30% head, 70% tail');
  });
  it('collapses to 100% head / 100% tail at the extremes', () => {
    expect(headTailLabel('T', 1)).toBe('T: 100% head');
    expect(headTailLabel('T', 0)).toBe('T: 100% tail');
  });
  it('rounds the ratio to whole percent', () => {
    expect(headTailLabel('T', 0.256)).toBe('T: 26% head, 74% tail');
  });
});
