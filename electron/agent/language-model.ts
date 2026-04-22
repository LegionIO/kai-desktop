import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { LanguageModel } from 'ai';
import type { LLMModelConfig } from './model-catalog.js';
import { withBrandUserAgent } from '../utils/user-agent.js';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function isAzureOpenAIHost(hostname: string): boolean {
  const n = hostname.trim().toLowerCase();
  return n === 'openai.azure.com' || n.endsWith('.openai.azure.com');
}

function hasOpenAIV1Path(pathname: string): boolean {
  const p = stripTrailingSlashes(pathname.toLowerCase());
  return p === '/openai/v1' || p.startsWith('/openai/v1/');
}

function normalizeOpenAIBaseUrl(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim() ? stripTrailingSlashes(endpoint.trim()) : '';
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (hasOpenAIV1Path(parsed.pathname)) return trimmed;
  if (!isAzureOpenAIHost(parsed.hostname)) return trimmed;
  const basePath = stripTrailingSlashes(parsed.pathname);
  parsed.pathname = `${basePath}/openai/v1`;
  return stripTrailingSlashes(parsed.toString());
}

export function shouldUseOpenAIResponsesApi(
  modelConfig: Pick<LLMModelConfig, 'provider' | 'useResponsesApi'>,
): boolean {
  if (modelConfig.provider !== 'openai-compatible') return false;
  return modelConfig.useResponsesApi === true;
}

/**
 * Fetch wrapper for OpenAI-compatible endpoints that patches Responses API
 * requests to ensure every function_call has a matching function_call_output.
 *
 * Some gateways translate the Responses API to Anthropic Messages API format
 * but fail when the input array has function_call items without matching
 * function_call_output items during multi-step agentic turns.
 */
function createResponsesApiPatchingFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (!url.endsWith('/responses') || typeof init?.body !== 'string') {
      return fetch(input, init);
    }

    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      const inputItems = parsed.input;
      if (!Array.isArray(inputItems)) {
        return fetch(input, init);
      }

      // Collect all function_call call_ids and all function_call_output call_ids
      const callIds = new Set<string>();
      const outputIds = new Set<string>();
      for (const item of inputItems) {
        if (item && typeof item === 'object') {
          if (item.type === 'function_call' && item.call_id) callIds.add(item.call_id as string);
          if (item.type === 'function_call_output' && item.call_id) outputIds.add(item.call_id as string);
        }
      }

      // Find function_calls without matching outputs
      const orphanedIds = [...callIds].filter(id => !outputIds.has(id));

      let patched = [...inputItems];
      let patchApplied = false;

      // Inject synthetic function_call_output for each orphaned call
      if (orphanedIds.length > 0) {
        patchApplied = true;
        for (const callId of orphanedIds) {
          const callIndex = patched.findIndex(
            (item) => item && typeof item === 'object' && item.type === 'function_call' && item.call_id === callId,
          );
          const insertAt = callIndex >= 0 ? callIndex + 1 : patched.length;
          patched.splice(insertAt, 0, {
            type: 'function_call_output',
            call_id: callId,
            output: 'Tool execution did not return a result.',
          });
        }
      }

      // Remove trailing assistant messages — Mastra's MessageMerger can produce
      // duplicate/redundant assistant items for each agentic loop step.  The
      // gateway rejects these because Anthropic requires the conversation to end
      // with a user (or tool-result) turn, not an assistant turn.
      while (patched.length > 0) {
        const last = patched[patched.length - 1] as Record<string, unknown>;
        if (last.role === 'assistant') {
          patched.pop();
          patchApplied = true;
        } else {
          break;
        }
      }

      if (!patchApplied) {
        return fetch(input, init);
      }

      return fetch(input, {
        ...init,
        body: JSON.stringify({ ...parsed, input: patched }),
      });
    } catch {
      return fetch(input, init);
    }
  };
}

function createTemperatureOmissionFetch(): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(withBrandUserAgent(init?.headers));
    if (headers.get('x-skynet-omit-temperature') !== '1') {
      return fetch(input, {
        ...init,
        headers,
      });
    }

    headers.delete('x-skynet-omit-temperature');

    if (typeof init?.body !== 'string') {
      return fetch(input, {
        ...init,
        headers,
      });
    }

    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'temperature' in parsed) {
        delete parsed.temperature;
      }
      return fetch(input, {
        ...init,
        headers,
        body: JSON.stringify(parsed),
      });
    } catch {
      return fetch(input, {
        ...init,
        headers,
      });
    }
  };
}

function createAwsCredentialProvider(profile?: string) {
  const provider = defaultProvider({
    ...(profile ? { profile } : {}),
  });
  return async () => {
    const creds = await provider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    };
  };
}

async function createBedrockModel(modelConfig: LLMModelConfig) {
  const configuredHeaders = { ...(modelConfig.extraHeaders ?? {}) };

  // Region: use config, fall back to env, default to us-east-1 when using a gateway endpoint
  const region = modelConfig.region
    || process.env.AWS_REGION
    || process.env.AWS_DEFAULT_REGION
    || (modelConfig.endpoint ? 'us-east-1' : '');

  // Build a credential provider when Bedrock is using the default AWS chain
  const hasExplicitKeys = Boolean(modelConfig.accessKeyId && modelConfig.secretAccessKey);
  const needsCredentialProvider = !modelConfig.apiKey && !hasExplicitKeys;

  // If an AWS profile is configured, set it in env for the default provider chain
  if (modelConfig.awsProfile) {
    process.env.AWS_PROFILE = modelConfig.awsProfile;
  }

  const credentialProviderFn = needsCredentialProvider
    ? createAwsCredentialProvider(modelConfig.awsProfile)
    : undefined;

  const bedrock = createAmazonBedrock({
    ...(region ? { region } : {}),
    ...(modelConfig.endpoint ? { baseURL: modelConfig.endpoint } : {}),
    ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
    ...(hasExplicitKeys ? { accessKeyId: modelConfig.accessKeyId! } : {}),
    ...(hasExplicitKeys ? { secretAccessKey: modelConfig.secretAccessKey! } : {}),
    ...(modelConfig.sessionToken ? { sessionToken: modelConfig.sessionToken } : {}),
    ...(credentialProviderFn ? { credentialProvider: credentialProviderFn } : {}),
    ...(Object.keys(configuredHeaders).length > 0 ? { headers: withBrandUserAgent(configuredHeaders) } : { headers: withBrandUserAgent() }),
  });

  return bedrock(modelConfig.modelName);
}

export async function createLanguageModelFromConfig(modelConfig: LLMModelConfig): Promise<LanguageModel> {
  if (modelConfig.provider === 'google') {
    throw new Error('Gemini models are not supported by ' + __BRAND_PRODUCT_NAME + ' runtime yet.');
  }

  // console.info(
  //   `[LLM] Creating model: provider=${modelConfig.provider} model=${modelConfig.modelName} baseURL=${modelConfig.endpoint ?? 'default'} useResponsesApi=${modelConfig.useResponsesApi ?? 'default'}`,
  // );

  if (modelConfig.provider === 'anthropic') {
    const anthropic = createAnthropic({
      baseURL: stripTrailingSlashes(modelConfig.endpoint),
      ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
      headers: withBrandUserAgent(modelConfig.extraHeaders ?? {}),
      fetch: createTemperatureOmissionFetch(),
    });
    return anthropic(modelConfig.modelName);
  }

  if (modelConfig.provider === 'amazon-bedrock') {
    return await createBedrockModel(modelConfig);
  }

  const normalizedBaseUrl = normalizeOpenAIBaseUrl(modelConfig.endpoint);
  const openai = createOpenAI({
    ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
    apiKey: modelConfig.apiKey || 'dummy',
    headers: withBrandUserAgent({
      ...(modelConfig.apiVersion ? { 'api-version': modelConfig.apiVersion } : {}),
      ...(modelConfig.extraHeaders ?? {}),
    }),
    fetch: createResponsesApiPatchingFetch(),
  });

  const modelId = modelConfig.deploymentName || modelConfig.modelName;
  if (shouldUseOpenAIResponsesApi(modelConfig)) {
    return openai(modelId);
  }
  return openai.chat(modelId);
}
