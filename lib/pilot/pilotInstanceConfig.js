// The Pilot (pilot.e3d.ai) transition of an instance config, as pure data +
// a pure function. Used by ops/migrate-instance-to-pilot.js and the example config.
const clone = (value) => JSON.parse(JSON.stringify(value));

export const PILOT_RESEARCH_TOPICS = Object.freeze([
  'multi-model LLM comparison: tools, workflows and demand for getting answers from several frontier AI models and seeing where they disagree',
  'getting a second opinion from multiple AI models before a decision (developers, founders, managers, analysts)',
  'agent builders who need a check on an agent\'s decision: MCP servers and tools that let an agent call a multi-model debate',
  'MCP server directories and registries: listings, discovery and distribution opportunities for Pilot',
  'ChatGPT apps and the ChatGPT app directory: distribution, review process and integration opportunities',
  'AI decision-making and decision-record tooling: audit trails, transcripts and recorded disagreement between models',
  'competitor and adjacent products: LLM council, model-debate and multi-model answer tools, pricing and positioning',
  'product feedback and marketing channels where developers who use several AI models gather (communities, newsletters, directories)'
]);

export const PILOT_DISCOVERY_TOPICS = PILOT_RESEARCH_TOPICS;

export const PILOT_X_SEARCH_QUERIES = Object.freeze([
  '("multiple LLMs" OR "multiple AI models" OR "several AI models") ("second opinion" OR compare) -is:retweet lang:en',
  '(ChatGPT OR Claude OR Gemini) "which model" (disagree OR compare OR "different answers") -is:retweet lang:en',
  '("LLM council" OR "model council" OR "AI debate" OR "multi-model") -is:retweet lang:en',
  '("MCP server" OR "MCP servers") (agent OR agents) -is:retweet lang:en',
  '("ChatGPT apps" OR "ChatGPT app directory" OR "apps in ChatGPT") -is:retweet lang:en',
  '("AI decision making" OR "decision with AI" OR "AI second opinion") -is:retweet lang:en'
]);

export const PILOT_X_TOPICS = Object.freeze([
  'comparing answers from several AI models, or asking which model to trust',
  'wanting a second opinion from multiple AI models before a decision',
  'agent builders and MCP servers: giving an agent a check on its own decisions',
  'ChatGPT apps / app directory and MCP directory distribution',
  'AI-assisted decision making, recorded reasoning and audit trails'
]);

export const PILOT_TYPE_WEIGHTS = Object.freeze({
  distribution: 1.3,
  marketing: 1.25,
  'product-feedback': 1.25,
  'integration-opportunity': 1.15,
  'competitor-development': 1.1,
  partnership: 1.05
});

export const PILOT_OWN_DOMAINS = Object.freeze(['pilot.e3d.ai']);

export const PILOT_GROWTH_DEFAULTS = Object.freeze({
  dryRun: false,
  draftsPerWeek: 4,
  adMonthlyCeilingUsd: 300,
  factsFile: '.e3d-corp/instance/futco/pilot-facts.json'
});

export const PILOT_ROLE_PROVIDERS = Object.freeze({
  'pilot.contentDraft': { provider: 'claude' },
  'pilot.adCopy': { provider: 'claude' },
  'pilot.competitorBrief': { provider: 'claude' }
});

const unique = (list) => [...new Set(list)];

// Returns a NEW config; the input is never mutated. Old crypto/oppscan/consulting
// settings are preserved under `archived`, not deleted. Idempotent.
export function migrateConfigToPilot(input) {
  const config = clone(input);
  const archived = config.archived && typeof config.archived === 'object' ? config.archived : {};

  if (Array.isArray(config.researchTopics) && !archived.researchTopics) {
    archived.researchTopics = config.researchTopics.filter((topic) => !PILOT_RESEARCH_TOPICS.includes(topic));
  }
  config.researchTopics = [...PILOT_RESEARCH_TOPICS];
  // Discovery (e3d-corp run) reads researchTopics; there is no separate key, so the list above is the discovery topic list.

  if (config.research?.x) {
    const x = config.research.x;
    archived.x = archived.x ?? { searchQueries: (x.searchQueries ?? []).filter((q) => !PILOT_X_SEARCH_QUERIES.includes(q)), topics: (x.topics ?? []).filter((t) => !PILOT_X_TOPICS.includes(t)) };
    x.searchQueries = [...PILOT_X_SEARCH_QUERIES];
    x.topics = [...PILOT_X_TOPICS];
    x.grounding = 'pilot';
  }

  if (config.scoring) {
    if (!archived.typeWeights) archived.typeWeights = clone(config.scoring.typeWeights ?? {});
    config.scoring.typeWeights = { ...PILOT_TYPE_WEIGHTS };
  } else {
    config.scoring = { typeWeights: { ...PILOT_TYPE_WEIGHTS } };
  }

  config.ownDomains = unique([...(config.ownDomains ?? []), ...PILOT_OWN_DOMAINS]);

  config.roles = { ...(config.roles ?? {}) };
  for (const [name, role] of Object.entries(PILOT_ROLE_PROVIDERS)) {
    config.roles[name] = config.roles[name] ?? { ...role };
  }
  config.pilotGrowth = { ...PILOT_GROWTH_DEFAULTS, ...(config.pilotGrowth ?? {}) };
  config.archived = archived;
  return config;
}
