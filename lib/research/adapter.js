import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';
import { getRepoInfo, listRepos, searchKnowledgeBase } from './knowledgeBaseMcp.js';
import { webSearch } from './webSearch.js';
import { fetchOppscanFeed } from './oppscanFeed.js';
import { fetchGa4Report } from './ga4.js';
import { fetchMetaInsights } from './metaInsights.js';

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
  if (kind === 'web-search') return 'research.webSearch';
  if (kind === 'oppscan-feed') return 'research.oppscanFeed';
  if (kind === 'ga4-report') return 'research.ga4';
  if (kind === 'meta-insights') return 'research.metaInsights';
  return 'research.knowledgeBase';
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

  const knowledgeBaseMcpUrl = instanceConfig?.research?.knowledgeBaseMcpUrl;
  const knowledgeBaseMcpServerPath = instanceConfig?.research?.knowledgeBaseMcpServerPath;
  const webSearchProvider = instanceConfig?.research?.webSearchProvider;
  const webSearchApiKeyEnvVar = instanceConfig?.research?.webSearchApiKeyEnvVar;
  const webSearchApiKey = webSearchApiKeyEnvVar ? process.env[webSearchApiKeyEnvVar] : undefined;

  return {
    async searchKnowledgeBase(query, options = {}) {
      const result = await searchKnowledgeBase(query, {
        knowledgeBaseMcpUrl,
        knowledgeBaseMcpServerPath,
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
      const result = await getRepoInfo(name, { knowledgeBaseMcpUrl, knowledgeBaseMcpServerPath });
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
      const result = await listRepos({ knowledgeBaseMcpUrl, knowledgeBaseMcpServerPath, status: options.status });
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
    },

    // Pull-only: lands each batch as evidence.gathered (endpoint + cursor as
    // provenance, inside result). Never contacts a lead or mutates anything
    // at the feed - it's a GET with a bearer token, same trust level as the
    // other research providers above.
    async pullOppscanFeed(options = {}) {
      const result = await fetchOppscanFeed({
        feedUrl: options.feedUrl,
        token: options.token,
        cursor: options.cursor,
        limit: options.limit
      });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'oppscan-feed',
        query: result.query ?? { cursor: options.cursor ?? null, limit: options.limit ?? null },
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    },

    // A GA4 report is a rolling N-day window, not a cursor-paged feed - each
    // pull intentionally overlaps the previous one's date range (GA4 data
    // itself gets revised for a few days after it happens), so this lands a
    // fresh evidence.gathered snapshot every run rather than trying to dedup
    // or resume from a stored position.
    async pullGa4Report(options = {}) {
      const result = await fetchGa4Report({
        credentialsKeyFile: options.credentialsKeyFile,
        propertyId: options.propertyId,
        label: options.label,
        dimensions: options.dimensions,
        metrics: options.metrics,
        startDate: options.startDate,
        endDate: options.endDate,
        limit: options.limit
      });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'ga4-report',
        query: result.query ?? { propertyId: options.propertyId, label: options.label ?? null },
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    },

    // Read-only (ads_read-scoped token, per the handoff) - this never writes
    // to Meta. A rolling window like pullGa4Report, same reason: insights get
    // revised for a short window after the fact, so there is nothing stable
    // to resume a cursor from.
    async pullMetaInsights(options = {}) {
      const result = await fetchMetaInsights({
        token: options.token,
        adAccountId: options.adAccountId,
        campaignIds: options.campaignIds,
        fields: options.fields,
        lookbackDays: options.lookbackDays,
        limit: options.limit
      });
      const event = appendEvidenceEvent(dataDir, {
        kind: 'meta-insights',
        query: result.query ?? { adAccountId: options.adAccountId, campaignIds: options.campaignIds ?? [] },
        result,
        causationId: options.causationId,
        correlationId: options.correlationId
      });
      return { ...result, evidenceEventId: event.id };
    }
  };
}

export { appendEvidenceEvent, summaryForResearchResult };
