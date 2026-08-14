import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { getRepoInfo, listRepos, searchKnowledgeBase } from './futcoMcp.js';
import { webSearch } from './webSearch.js';

function summaryForResearchResult(result) {
  if (!result || typeof result !== 'object') {
    return 'No result returned.';
  }

  if (result.status === 'unavailable') {
    return result.summary || result.reason || 'Research provider unavailable.';
  }

  if (typeof result.summary === 'string' && result.summary.trim() !== '') {
    return result.summary;
  }

  if (Array.isArray(result.results)) {
    return `${result.results.length} results`;
  }

  return 'Result received.';
}

function evidenceEventSource(kind) {
  return kind === 'web-search' ? 'research.webSearch' : 'research.futcoMcp';
}

function buildEvidencePayload({ kind, query, result }) {
  return {
    kind,
    query,
    resultSummary: summaryForResearchResult(result),
    result,
    degraded: result?.status === 'unavailable'
  };
}

function appendEvidenceEvent(dataDir, { kind, query, result, causationId, correlationId }) {
  return appendEvent(dataDir, {
    type: 'evidence.gathered',
    source: evidenceEventSource(kind),
    subject: {
      type: 'research',
      id: crypto.randomUUID()
    },
    payload: buildEvidencePayload({ kind, query, result }),
    causationId: causationId ?? null,
    correlationId: correlationId ?? crypto.randomUUID()
  });
}

export function createResearchAdapter(instanceConfig, { dataDir } = {}) {
  if (!dataDir) {
    throw new Error('createResearchAdapter requires a dataDir');
  }

  const futcoMcpUrl = instanceConfig?.research?.futcoMcpUrl;
  const webSearchProvider = instanceConfig?.research?.webSearchProvider;
  const webSearchApiKeyEnvVar = instanceConfig?.research?.webSearchApiKeyEnvVar;
  const webSearchApiKey = webSearchApiKeyEnvVar ? process.env[webSearchApiKeyEnvVar] : undefined;

  return {
    async searchKnowledgeBase(query, options = {}) {
      const result = await searchKnowledgeBase(query, {
        futcoMcpUrl,
        limit: options.limit
      });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'knowledge-base-search',
        query,
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    },

    async getRepoInfo(name, options = {}) {
      const result = await getRepoInfo(name, { futcoMcpUrl });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'repo-info',
        query: name,
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    },

    async listRepos(options = {}) {
      const result = await listRepos({ futcoMcpUrl, status: options.status });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'list-repos',
        query: options.status ?? 'all',
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    },

    async webSearch(query, options = {}) {
      const result = await webSearch(query, {
        provider: options.provider ?? webSearchProvider,
        apiKey: options.apiKey ?? webSearchApiKey
      });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'web-search',
        query,
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    }
  };
}

export { appendEvidenceEvent, summaryForResearchResult };
