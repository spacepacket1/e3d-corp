const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (![promptTokens, completionTokens, totalTokens].every((value) => Number.isFinite(value))) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

function normalizeTimeoutError(error, timeoutMs) {
  if (error?.name === 'AbortError') {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }
  return error;
}

export function resolveOpenAiCompatibleSettings(providerConfig) {
  const baseUrlEnvVar = providerConfig?.baseUrlEnvVar;
  const modelEnvVar = providerConfig?.modelEnvVar;
  const apiKeyEnvVar = providerConfig?.apiKeyEnvVar;

  if (!baseUrlEnvVar || !modelEnvVar || !apiKeyEnvVar) {
    throw new Error('Hosted provider config is missing baseUrlEnvVar/modelEnvVar/apiKeyEnvVar');
  }

  const baseUrl = process.env[baseUrlEnvVar];
  const model = process.env[modelEnvVar];
  const apiKey = process.env[apiKeyEnvVar];

  if (!baseUrl) {
    throw new Error(`LLM base URL env var "${baseUrlEnvVar}" is not set`);
  }
  if (!model) {
    throw new Error(`LLM model env var "${modelEnvVar}" is not set`);
  }
  if (!apiKey) {
    throw new Error(`LLM API key env var "${apiKeyEnvVar}" is not set`);
  }

  return {
    baseUrl,
    model,
    apiKey,
    timeoutMs: providerConfig.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  };
}

export async function callOpenAiCompatibleLlm({
  baseUrl,
  model,
  apiKey,
  systemPrompt,
  userPrompt,
  temperature = 0.2,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeout = createTimeoutController(timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: timeout.signal
    });
  } catch (error) {
    throw normalizeTimeoutError(error, timeoutMs);
  } finally {
    timeout.clear();
  }

  if (!response.ok) {
    throw new Error(`LLM endpoint returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('LLM response did not include message content');
  }

  return {
    text: content,
    usage: normalizeUsage(body?.usage),
    costUsd: null
  };
}
