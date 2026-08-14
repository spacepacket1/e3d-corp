import { queryEvents } from '../events/store.js';
import { createLocalLlmClient } from '../llm/localClient.js';
import { normalizeOpportunityCandidate, OPPORTUNITY_TYPE_EXAMPLES } from '../opportunities/schema.js';

const SYSTEM_PROMPT = [
  'You are the opportunity.prospect role inside e3d-corp, a system that helps FutCo find real, ' +
    'evidence-backed business opportunities.',
  'You are given one triggering event (a lead, a manually-added signal, or a discovery-pass signal) ' +
    'and any evidence already gathered for it (FutCo knowledge-base results, web search results).',
  'Respond with ONLY a single JSON object — no prose, no markdown code fences — matching exactly this shape:',
  '{"type": string, "title": string, "description": string, "evidenceEventIds": string[], ' +
    '"confidence": number, "rationale": string}',
  `"type" should be a short kebab-case string. Common examples: ${OPPORTUNITY_TYPE_EXAMPLES.join(', ')}. ` +
    'Pick the closest fit, or invent a similarly-shaped one if none fit.',
  '"evidenceEventIds" must only contain ids taken from the evidence list you were given below — never invent one.',
  '"confidence" is your own confidence this is a real, worthwhile opportunity, from 0 to 1.',
  '"rationale" briefly explains why, citing the evidence.',
  "Never claim a FutCo capability that isn't supported by the evidence provided.",
  '"title" and "description" must name a SPECIFIC finding from the evidence below — a named company, ' +
    'product, article, technology, or event you can point to — never a generic restatement of the search ' +
    'query or trigger topic itself (e.g. "growing interest in X" / "a market trend toward X" is not acceptable ' +
    'unless X is a specific named thing you found, not the topic you searched for).',
  'If the evidence genuinely contains nothing specific and actionable, respond with the JSON shape above, ' +
    'using a low confidence value (below 0.3) and say plainly in the rationale that nothing specific was found ' +
    '— a low-confidence, honest "nothing here" is far better than a vague opportunity manufactured to fill ' +
    'the response.',
  'Never respond with free text instead of JSON, in any case.'
].join('\n');

function truncate(text, maxLength) {
  if (typeof text !== 'string') return text;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeResultItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    title: item.title,
    url: item.url,
    snippet: truncate(item.content ?? item.snippet ?? '', 400)
  };
}

function summarizeEvidenceEvent(event) {
  const result = event.payload?.result;
  const topResults = Array.isArray(result?.results) ? result.results.slice(0, 5).map(summarizeResultItem) : undefined;

  return {
    id: event.id,
    occurredAt: event.occurredAt,
    kind: event.payload?.kind,
    query: event.payload?.query,
    resultSummary: event.payload?.resultSummary,
    results: topResults,
    degraded: event.payload?.degraded ?? false
  };
}

export function buildPrompt({ triggerEvent, evidenceEvents }) {
  const userPrompt = JSON.stringify(
    {
      triggerEvent: {
        id: triggerEvent.id,
        type: triggerEvent.type,
        occurredAt: triggerEvent.occurredAt,
        source: triggerEvent.source,
        payload: triggerEvent.payload
      },
      evidence: evidenceEvents.map(summarizeEvidenceEvent)
    },
    null,
    2
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

// Local models sometimes wrap otherwise-correct JSON in a markdown fence despite
// instructions not to. Stripping that envelope is not "guessing" the semantic
// content — it's normalizing formatting before a strict JSON.parse, which still
// throws on anything that isn't valid JSON underneath.
function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseCandidateJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('opportunity.prospect returned empty output');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText));
  } catch (error) {
    throw new Error(`opportunity.prospect returned invalid JSON: ${error.message}`);
  }

  return parsed;
}

function deriveResearchQuery(triggerEvent) {
  const payload = triggerEvent.payload ?? {};
  return (
    payload.topic ||
    payload.workflowProblem ||
    payload.submission?.workflowProblem ||
    payload.note ||
    payload.title ||
    triggerEvent.subject?.id ||
    triggerEvent.type
  );
}

// Authority level 0/1: read-only research plus an internal write (the evidence
// event), fully autonomous. This does not itself create the Opportunity record —
// runOpportunityEngine does that, deterministically, from this function's output.
export async function runOpportunityProspect({
  instanceConfig,
  dataDir,
  triggerEvent,
  researchAdapter,
  researchQuery,
  llmClient
} = {}) {
  if (!triggerEvent || !triggerEvent.id || !triggerEvent.correlationId) {
    throw new Error('runOpportunityProspect requires a triggerEvent with an id and correlationId');
  }
  if (!dataDir) {
    throw new Error('runOpportunityProspect requires a dataDir');
  }

  let evidenceEvents = queryEvents(dataDir, {
    type: 'evidence.gathered',
    correlationId: triggerEvent.correlationId
  });

  if (researchAdapter && evidenceEvents.length === 0) {
    const query = researchQuery ?? deriveResearchQuery(triggerEvent);
    if (query) {
      await researchAdapter.searchKnowledgeBase(query, {
        causationId: triggerEvent.id,
        correlationId: triggerEvent.correlationId
      });
      evidenceEvents = queryEvents(dataDir, {
        type: 'evidence.gathered',
        correlationId: triggerEvent.correlationId
      });
    }
  }

  const { systemPrompt, userPrompt } = buildPrompt({ triggerEvent, evidenceEvents });
  const call = llmClient ?? createLocalLlmClient(instanceConfig);
  const rawText = await call({ systemPrompt, userPrompt });
  const candidate = normalizeOpportunityCandidate(parseCandidateJson(rawText));

  return {
    ...candidate,
    sourceEventIds: [triggerEvent.id, ...evidenceEvents.map((event) => event.id)],
    correlationId: triggerEvent.correlationId
  };
}
