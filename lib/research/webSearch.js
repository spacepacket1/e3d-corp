function unavailableResult(query, provider, reason) {
  return {
    status: 'unavailable',
    provider: 'web-search',
    query,
    searchProvider: provider,
    reason,
    summary: reason
  };
}

function normalizeResults(data) {
  if (!data || typeof data !== 'object') {
    return { results: [], summary: '' };
  }

  if (Array.isArray(data.results)) {
    return {
      results: data.results,
      summary: data.summary || data.answer || `${data.results.length} results`
    };
  }

  if (Array.isArray(data.items)) {
    return {
      results: data.items,
      summary: data.summary || `${data.items.length} results`
    };
  }

  return {
    results: [],
    summary: typeof data.summary === 'string' ? data.summary : ''
  };
}

async function fetchJsonProvider(providerUrl, query, apiKey) {
  const body = apiKey ? { query, api_key: apiKey } : { query };
  const headers = { 'content-type': 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(providerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`provider returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { summary: text, results: [] };
  }
}

export async function webSearch(query, options = {}) {
  const provider = options.provider ?? '';
  if (!provider) {
    return unavailableResult(query, provider, 'web search provider is not configured');
  }

  if (provider === 'disabled' || provider === 'unavailable' || provider === 'example-search') {
    return unavailableResult(query, provider, `web search provider "${provider}" is unavailable`);
  }

  if (!/^https?:\/\//i.test(provider)) {
    return unavailableResult(query, provider, `web search provider "${provider}" is unavailable`);
  }

  try {
    const raw = await fetchJsonProvider(provider, query, options.apiKey);
    const normalized = normalizeResults(raw);
    return {
      status: 'ok',
      provider: 'web-search',
      searchProvider: provider,
      query,
      results: normalized.results,
      summary: normalized.summary || `${normalized.results.length} results`,
      raw
    };
  } catch (error) {
    return unavailableResult(query, provider, `web search unavailable: ${error.message}`);
  }
}

export { unavailableResult as unavailableWebSearchResult };
