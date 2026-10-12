const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 60_000;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 1024;

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  if (![promptTokens, completionTokens].every((value) => Number.isFinite(value))) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
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

// Model is deliberately not a required env var like the other providers'
// baseUrl/model pairs - there's no per-deployment endpoint to configure here,
// just a model choice, so a sane default (providerConfig.modelEnvVar can
// still override it) keeps setup to one credential instead of two.
export function resolveAnthropicSettings(providerConfig) {
  const apiKeyEnvVar = providerConfig?.apiKeyEnvVar;
  if (!apiKeyEnvVar) {
    throw new Error('Anthropic provider config is missing apiKeyEnvVar');
  }
  const apiKey = process.env[apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(`LLM API key env var "${apiKeyEnvVar}" is not set`);
  }

  const envModel = providerConfig.modelEnvVar ? process.env[providerConfig.modelEnvVar] : undefined;
  const model = envModel || DEFAULT_ANTHROPIC_MODEL;

  return {
    apiKey,
    model,
    timeoutMs: providerConfig.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS,
    maxTokens: providerConfig.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS
  };
}

export async function callAnthropicLlm({
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  timeoutMs = DEFAULT_ANTHROPIC_TIMEOUT_MS,
  maxTokens = DEFAULT_ANTHROPIC_MAX_TOKENS,
  fetchImpl = fetch
}) {
  const timeout = createTimeoutController(timeoutMs);

  // No `temperature` here deliberately: the current Claude 5 model family
  // rejects it outright ("temperature is deprecated for this model",
  // confirmed live) rather than silently ignoring it, unlike the
  // local/openai-compatible providers' models.
  let response;
  try {
    response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: timeout.signal
    });
  } catch (error) {
    throw normalizeTimeoutError(error, timeoutMs);
  } finally {
    timeout.clear();
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic API returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const body = await response.json();
  const content = Array.isArray(body?.content) ? body.content.find((block) => block.type === 'text')?.text : null;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Anthropic response did not include text content');
  }

  return {
    text: content,
    usage: normalizeUsage(body?.usage),
    costUsd: null
  };
}

export { DEFAULT_ANTHROPIC_MODEL };
