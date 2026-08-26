import { callGrokCli, DEFAULT_GROK_MODEL, findBinary, resolveGrokCliSettings } from './grokCliClient.js';
import { callLocalLlm, resolveLocalProviderSettings } from './localClient.js';
import { callOpenAiCompatibleLlm, resolveOpenAiCompatibleSettings } from './openaiCompatibleClient.js';

function requireProvider(instanceConfig, providerName) {
  const providerConfig = instanceConfig?.llm?.providers?.[providerName];
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" is not defined under llm.providers`);
  }
  return providerConfig;
}

function wrapResolutionError(providerName, error) {
  return new Error(`Provider "${providerName}" is not ready: ${error.message}`);
}

function resolveProviderStatus(providerName, providerConfig) {
  switch (providerConfig.kind) {
    case 'local':
      return {
        provider: providerName,
        kind: providerConfig.kind,
        ready: Boolean(process.env[providerConfig.baseUrlEnvVar] && process.env[providerConfig.modelEnvVar]),
        checks: [
          {
            type: 'env',
            name: providerConfig.baseUrlEnvVar,
            ready: Boolean(process.env[providerConfig.baseUrlEnvVar]),
            message: process.env[providerConfig.baseUrlEnvVar]
              ? `env var ${providerConfig.baseUrlEnvVar} is set`
              : `missing env var ${providerConfig.baseUrlEnvVar}`
          },
          {
            type: 'env',
            name: providerConfig.modelEnvVar,
            ready: Boolean(process.env[providerConfig.modelEnvVar]),
            message: process.env[providerConfig.modelEnvVar]
              ? `env var ${providerConfig.modelEnvVar} is set`
              : `missing env var ${providerConfig.modelEnvVar}`
          }
        ]
      };
    case 'openai-compatible':
      return {
        provider: providerName,
        kind: providerConfig.kind,
        ready: Boolean(
          process.env[providerConfig.baseUrlEnvVar] &&
            process.env[providerConfig.modelEnvVar] &&
            process.env[providerConfig.apiKeyEnvVar]
        ),
        checks: [
          {
            type: 'env',
            name: providerConfig.baseUrlEnvVar,
            ready: Boolean(process.env[providerConfig.baseUrlEnvVar]),
            message: process.env[providerConfig.baseUrlEnvVar]
              ? `env var ${providerConfig.baseUrlEnvVar} is set`
              : `missing env var ${providerConfig.baseUrlEnvVar}`
          },
          {
            type: 'env',
            name: providerConfig.modelEnvVar,
            ready: Boolean(process.env[providerConfig.modelEnvVar]),
            message: process.env[providerConfig.modelEnvVar]
              ? `env var ${providerConfig.modelEnvVar} is set`
              : `missing env var ${providerConfig.modelEnvVar}`
          },
          {
            type: 'env',
            name: providerConfig.apiKeyEnvVar,
            ready: Boolean(process.env[providerConfig.apiKeyEnvVar]),
            message: process.env[providerConfig.apiKeyEnvVar]
              ? `env var ${providerConfig.apiKeyEnvVar} is set`
              : `missing env var ${providerConfig.apiKeyEnvVar}`
          }
        ]
      };
    case 'grok-cli': {
      const binaryName = providerConfig.binEnvVar ? process.env[providerConfig.binEnvVar] : 'grok';
      const binaryReady = Boolean(binaryName && findBinary(binaryName));
      return {
        provider: providerName,
        kind: providerConfig.kind,
        ready: binaryReady,
        checks: providerConfig.binEnvVar
          ? [
              {
                type: 'env',
                name: providerConfig.binEnvVar,
                ready: Boolean(process.env[providerConfig.binEnvVar]),
                message: process.env[providerConfig.binEnvVar]
                  ? `env var ${providerConfig.binEnvVar} is set`
                  : `missing env var ${providerConfig.binEnvVar}`
              },
              {
                type: 'binary',
                name: binaryName ?? 'grok',
                ready: binaryReady,
                message: binaryReady ? `binary ${binaryName} found` : `missing binary ${binaryName ?? 'grok'}`
              }
            ]
          : [
              {
                type: 'binary',
                name: 'grok',
                ready: binaryReady,
                message: binaryReady ? 'binary grok found' : 'missing binary grok'
              }
            ]
      };
    }
    default:
      return {
        provider: providerName,
        kind: providerConfig.kind,
        ready: false,
        checks: [{ type: 'config', name: 'kind', ready: false, message: `unsupported kind ${providerConfig.kind}` }]
      };
  }
}

export function listProviderStatuses(instanceConfig) {
  return Object.entries(instanceConfig?.llm?.providers ?? {}).map(([providerName, providerConfig]) =>
    resolveProviderStatus(providerName, providerConfig)
  );
}

export function resolveProvider(instanceConfig, providerName) {
  const providerConfig = requireProvider(instanceConfig, providerName);

  try {
    switch (providerConfig.kind) {
      case 'local': {
        const { baseUrl, model, timeoutMs } = resolveLocalProviderSettings(providerConfig);
        return {
          model,
          call: ({ systemPrompt, userPrompt }) =>
            callLocalLlm({ baseUrl, model, systemPrompt, userPrompt, timeoutMs })
        };
      }
      case 'openai-compatible': {
        const { baseUrl, model, apiKey, timeoutMs } = resolveOpenAiCompatibleSettings(providerConfig);
        return {
          model,
          call: ({ systemPrompt, userPrompt }) =>
            callOpenAiCompatibleLlm({ baseUrl, model, apiKey, systemPrompt, userPrompt, timeoutMs })
        };
      }
      case 'grok-cli': {
        const { binaryPath, model, timeoutMs } = resolveGrokCliSettings(providerConfig);
        return {
          model: model ?? DEFAULT_GROK_MODEL,
          call: ({ systemPrompt, userPrompt }) => callGrokCli({ binaryPath, model, systemPrompt, userPrompt, timeoutMs })
        };
      }
      default:
        throw new Error(`unsupported kind "${providerConfig.kind}"`);
    }
  } catch (error) {
    throw wrapResolutionError(providerName, error);
  }
}
