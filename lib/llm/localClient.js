// Local OpenAI-chat-completions-compatible endpoint, matching the
// LLM_BASE_URL / LLM_MODEL env var convention shared with e3d-maps/e3d-trade
// (Qwen2.5 via MLX on mini@10.0.0.42). `instanceConfig.llm.baseUrlEnvVar`/
// `modelEnvVar` name which env vars to read, so instances can point at
// different endpoints without code changes.

export function resolveLlmSettings(instanceConfig) {
  const baseUrlEnvVar = instanceConfig?.llm?.baseUrlEnvVar;
  const modelEnvVar = instanceConfig?.llm?.modelEnvVar;

  if (!baseUrlEnvVar || !modelEnvVar) {
    throw new Error('Instance config is missing llm.baseUrlEnvVar/llm.modelEnvVar');
  }

  const baseUrl = process.env[baseUrlEnvVar];
  const model = process.env[modelEnvVar];

  if (!baseUrl) {
    throw new Error(`LLM base URL env var "${baseUrlEnvVar}" is not set`);
  }
  if (!model) {
    throw new Error(`LLM model env var "${modelEnvVar}" is not set`);
  }

  return { baseUrl, model };
}

export async function callLocalLlm({ baseUrl, model, systemPrompt, userPrompt, temperature = 0.2 }) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`LLM endpoint returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('LLM response did not include message content');
  }

  return content;
}

export function createLocalLlmClient(instanceConfig) {
  const { baseUrl, model } = resolveLlmSettings(instanceConfig);
  return ({ systemPrompt, userPrompt }) => callLocalLlm({ baseUrl, model, systemPrompt, userPrompt });
}
