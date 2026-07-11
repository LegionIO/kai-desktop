import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { resolveMediaGenEndpoint, saveMediaToFile, filePathToUrl, MAX_MEDIA_BYTES } from './media-gen-utils.js';
import { withBrandUserAgent } from '../utils/user-agent.js';
import { safeFetch, readCappedArrayBuffer } from '../utils/ssrf-guard.js';
import { recordUsageEvent } from '../ipc/usage.js';

export function createImageGenTool(getConfig: () => AppConfig, appHome: string): ToolDefinition {
  return {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using an AI image generation model (e.g. gpt-image-2). ' +
      'Returns a local file URL that can be embedded in markdown. ' +
      'The image is saved to disk automatically.',
    inputSchema: z.object({
      prompt: z.string().describe('A detailed description of the image to generate.'),
      size: z
        .string()
        .optional()
        .describe('Image dimensions, e.g. "1024x1024", "1536x1024", "1024x1536". Defaults to config or "1024x1024".'),
      quality: z.string().optional().describe('Image quality: "low", "medium", "high". Defaults to config or "high".'),
      n: z.number().optional().default(1).describe('Number of images to generate. Defaults to 1.'),
    }),
    execute: async (input) => {
      const { prompt, size, quality, n } = input as {
        prompt: string;
        size?: string;
        quality?: string;
        n?: number;
      };

      const config = getConfig().imageGeneration;
      if (!config?.enabled) {
        return { error: 'Image generation is not enabled. Enable it in Settings > Media Generation > Image.' };
      }

      try {
        const { url, headers } = resolveMediaGenEndpoint(config, '/images/generations');

        const outputFormat = config.outputFormat || 'png';
        const body: Record<string, unknown> = {
          model: config.model || 'gpt-image-2',
          prompt,
          size: size || config.size || '1024x1024',
          quality: quality || config.quality || 'high',
          output_format: outputFormat,
          output_compression: 100,
          n: n ?? 1,
        };

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeout || 300000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          return {
            error: `Image generation failed: HTTP ${response.status} ${response.statusText}`,
            details: errorText,
          };
        }

        const result = (await response.json()) as {
          data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
        };

        if (!result.data || result.data.length === 0) {
          return { error: 'No images returned from the API.', rawResponse: result };
        }

        const ext = outputFormat;
        const images: Array<{ filePath: string; url: string; revisedPrompt?: string }> = [];

        for (const item of result.data) {
          if (item.b64_json) {
            // Reject BEFORE decoding: Buffer.from(...,'base64') would
            // materialize the whole (attacker-controlled) blob in memory first,
            // so a post-decode cap can't prevent an OOM. base64 encodes 3 bytes
            // per 4 chars, so an encoded length over ceil(MAX/3)*4 can't fit
            // under MAX_MEDIA_BYTES. (+3 slack for '=' padding.)
            if (item.b64_json.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 3) {
              return { error: 'Generated image exceeds the size limit.' };
            }
            const buffer = Buffer.from(item.b64_json, 'base64');
            // Belt-and-suspenders: verify the actual decoded size too.
            if (buffer.byteLength > MAX_MEDIA_BYTES) {
              return { error: 'Generated image exceeds the size limit.' };
            }
            const filePath = saveMediaToFile(buffer, 'images', ext, appHome);
            images.push({
              filePath,
              url: filePathToUrl(filePath),
              revisedPrompt: item.revised_prompt,
            });
          } else if (item.url) {
            // If the API returns a URL instead of base64, download and save it.
            // Route through the SSRF guard + a size cap: `item.url` comes from the
            // (user-configured, but potentially compromised) provider, so a
            // returned metadata-IP/localhost URL or a giant body must not reach a
            // raw fetch. On failure we DO NOT fall back to returning the raw
            // provider URL — the renderer would then load an arbitrary remote URL
            // (re-introducing SSRF / tracking / remote-content risk).
            try {
              const imgResponse = await safeFetch(item.url, {
                headers: withBrandUserAgent(),
                timeoutMs: 30000,
              });
              if (imgResponse.ok) {
                const buffer = await readCappedArrayBuffer(imgResponse, MAX_MEDIA_BYTES);
                const filePath = saveMediaToFile(buffer, 'images', ext, appHome);
                images.push({
                  filePath,
                  url: filePathToUrl(filePath),
                  revisedPrompt: item.revised_prompt,
                });
              }
            } catch {
              // Download failed (network / blocked-by-SSRF-guard / too large):
              // skip this item rather than surfacing the raw provider URL.
            }
          }
        }

        if (images.length === 0) {
          return { error: 'Failed to process any images from the response.' };
        }

        recordUsageEvent({
          modality: 'image-gen',
          imageCount: images.length,
          size: (size || config.size || '1024x1024') as string,
          quality: (quality || config.quality || 'high') as string,
          modelKey: config.model || 'gpt-image-2',
        });

        const markdownPreview = images
          .map((img, i) => `![Generated Image ${images.length > 1 ? i + 1 : ''}](${img.url})`)
          .join('\n');

        return {
          type: 'image_generation_result',
          images,
          markdownPreview,
          prompt,
          model: config.model || 'gpt-image-2',
        };
      } catch (err) {
        return {
          error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
