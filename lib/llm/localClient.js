const DEFAULT_LOCAL_TIMEOUT_MS = 60_000;

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
  const timer = setTimeout(() => controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    }
  };
}

function normalizeTimeoutError(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.message === `LLM request timed out after ${timeoutMs}ms`) {
    return new Error(`LLM request timed out after ${timeoutMs}ms`);
  }
  return error;
}

export function resolveLocalProviderSettings(providerConfig) {
  const baseUrlEnvVar = providerConfig?.baseUrlEnvVar;
  const modelEnvVar = providerConfig?.modelEnvVar;

  if (!baseUrlEnvVar || !modelEnvVar) {
    throw new Error('Local provider config is missing baseUrlEnvVar/modelEnvVar');
  }

  const baseUrl = process.env[baseUrlEnvVar];
  const model = process.env[modelEnvVar];

  if (!baseUrl) {
    throw new Error(`LLM base URL env var "${baseUrlEnvVar}" is not set`);
  }
  if (!model) {
    throw new Error(`LLM model env var "${modelEnvVar}" is not set`);
  }

  return {
    baseUrl,
    model,
    timeoutMs: providerConfig.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS
  };
}

export async function callLocalLlm({
  baseUrl,
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.2,
  timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeout = createTimeoutController(timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

export function createLocalLlmClient(instanceConfig) {
  const providerConfig = instanceConfig?.llm?.providers?.local;
  if (!providerConfig) {
    throw new Error('Instance config is missing llm.providers.local');
  }
  const { baseUrl, model, timeoutMs } = resolveLocalProviderSettings(providerConfig);
  return ({ systemPrompt, userPrompt }) => callLocalLlm({ baseUrl, model, systemPrompt, userPrompt, timeoutMs });
}
