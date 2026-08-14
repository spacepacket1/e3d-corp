import { appendEvent, queryEvents } from '../events/store.js';
import { getOpportunity } from '../opportunities/store.js';

const STOPWORDS = new Set([
  'their', 'which', 'about', 'opportunity', 'company', 'business', 'market', 'customer',
  'customers', 'these', 'those', 'there', 'would', 'could', 'should', 'other'
]);

function significantWords(text) {
  return [
    ...new Set(
      (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 5 && !STOPWORDS.has(word))
    )
  ];
}

function findMatchingRepo(repos, opportunity) {
  const keywords = significantWords(`${opportunity.title} ${opportunity.description}`);
  if (keywords.length === 0) return null;

  for (const repo of repos) {
    const haystack = `${repo.name ?? ''} ${repo.one_liner ?? ''}`.toLowerCase();
    const matchedKeyword = keywords.find((keyword) => haystack.includes(keyword));
    if (matchedKeyword) {
      return { repo, matchedKeyword };
    }
  }
  return null;
}

function latestPilotHandoffEvent(dataDir, opportunityId) {
  const events = queryEvents(dataDir, { type: 'pilot-handoff.created' }).filter(
    (event) => event.payload?.opportunityId === opportunityId
  );
  return events[events.length - 1] ?? null;
}

// Deterministic keyword-overlap matching against futco-mcp's real repo
// listing, not an LLM judgment call - "AI suggests, code decides" has no AI
// role to suggest here at all, since a keyword match is auditable and
// reproducible in a way a model's verdict wouldn't be. Human-triggered, not
// automated polling, per the spec.
export async function checkCapabilityShipped({ dataDir, opportunityId, listRepos } = {}) {
  if (!dataDir) {
    throw new Error('checkCapabilityShipped requires a dataDir');
  }
  if (typeof listRepos !== 'function') {
    throw new Error('checkCapabilityShipped requires a listRepos function');
  }

  const opportunity = getOpportunity(dataDir, opportunityId);
  if (!opportunity) {
    throw new Error(`Opportunity not found: ${opportunityId}`);
  }

  const handoffEvent = latestPilotHandoffEvent(dataDir, opportunityId);
  if (!handoffEvent) {
    throw new Error(`Opportunity ${opportunityId} has no pilot-handoff.created event yet; nothing to check`);
  }

  const result = await listRepos();
  if (result.status !== 'ok') {
    throw new Error(`futco-mcp list_repos unavailable: ${result.reason ?? result.summary ?? 'unknown error'}`);
  }
  const repos = Array.isArray(result.repos) ? result.repos : [];

  const match = findMatchingRepo(repos, opportunity);
  if (!match) {
    return { matched: false, checkedRepoCount: repos.length };
  }

  const event = appendEvent(dataDir, {
    type: 'capability.shipped',
    source: 'opportunities.check-shipped',
    subject: { type: 'opportunity', id: opportunityId },
    payload: {
      opportunityId,
      repoName: match.repo.name,
      repoOneLiner: match.repo.one_liner ?? '',
      matchedKeyword: match.matchedKeyword,
      checkedAt: new Date().toISOString()
    },
    causationId: handoffEvent.id,
    correlationId: opportunity.correlationId
  });

  return { matched: true, repo: match.repo, matchedKeyword: match.matchedKeyword, event };
}
