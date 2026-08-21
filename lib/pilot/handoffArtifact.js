import fs from 'node:fs';
import path from 'node:path';

// e3d-pilot's actual, current per-target-repo config contract
// (../e3d-pilot/config.schema.json) - not assumed. research_topics
// is a single free-text STRING (not an array, despite the prose in
// docs/build-e3d-pilot.md reading like a list of hints) - the sample config
// at ../e3d-pilot/examples/sample-config.json confirms the same
// shape: `"research_topics": "AI video generation, wallet-paid APIs"`.
const REQUIRED_CONFIG_FIELDS = [
  'verify',
  'protected_paths',
  'research_topics',
  'pr',
  'providers',
  'max_diff_files',
  'max_diff_lines'
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function loadTargetConfig(targetRepoPath) {
  const configPath = path.join(targetRepoPath, '.e3d-pilot', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No .e3d-pilot/config.json found under ${targetRepoPath}. e3d-corp only writes into an ` +
        "existing e3d-pilot target-repo config (its research_topics field) - it never authors one " +
        'from scratch, since the other fields (verify commands, protected_paths, diff ceilings, ' +
        "provider assignment) are operational decisions that belong to whoever set up e3d-pilot " +
        'for this repo. Run `e3d-pilot config validate <repo>` there, or create the config, then retry.'
    );
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
  }

  const missing = REQUIRED_CONFIG_FIELDS.filter((field) => config[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`${configPath} is missing required field(s): ${missing.join(', ')}`);
  }
  if (typeof config.research_topics !== 'string') {
    throw new Error(`${configPath}: research_topics must be a string per e3d-pilot's config.schema.json`);
  }

  return { configPath, config };
}

// Additive only, and idempotent against repeat handoffs for the same
// opportunity - never overwrites whatever research direction the target
// repo's config already had.
function appendResearchTopic(existingTopics, newTopic) {
  if (existingTopics.toLowerCase().includes(newTopic.toLowerCase())) {
    return existingTopics;
  }
  return existingTopics.trim() === '' ? newTopic : `${existingTopics}, ${newTopic}`;
}

function auditMarkdown({ opportunity, chain, reason }) {
  const lines = [
    `# e3d-corp pilot handoff: ${opportunity.title}`,
    '',
    `- Opportunity id: ${opportunity.id}`,
    `- Type: ${opportunity.type}`,
    `- Score: ${opportunity.score ? `${opportunity.score.value} (${opportunity.score.rationale})` : '-'}`,
    `- correlationId: ${opportunity.correlationId}`,
    `- Handoff reason: ${reason || '-'}`,
    '',
    '## Description',
    opportunity.description,
    '',
    '## Causal chain (evidence)',
    ...chain.map((event) => `- ${event.occurredAt} [${event.type}] id=${event.id} causation=${event.causationId ?? '-'}`)
  ];
  return `${lines.join('\n')}\n`;
}

// The real, usable "starting objective" surface e3d-pilot's discover stage
// reads is research_topics (a free-text hint feeding its web-research pass) -
// nothing else in e3d-pilot's documented pipeline (discover/ideate/draft)
// accepts an externally-chosen idea; ideate always generates its own 3-5
// candidates from findings.md, so this can bias discover's research, not
// force a specific candidate to be selected. The audit file under
// .e3d-pilot/e3d-corp-handoffs/ is for human/traceability purposes only -
// e3d-pilot's own stages never read it.
export function writeHandoffArtifact({ targetRepoPath, opportunity, chain, reason }) {
  if (!isNonEmptyString(targetRepoPath)) {
    throw new Error('writeHandoffArtifact requires a targetRepoPath');
  }
  if (!fs.existsSync(targetRepoPath) || !fs.statSync(targetRepoPath).isDirectory()) {
    throw new Error(`Target repo path does not exist or is not a directory: ${targetRepoPath}`);
  }

  const { configPath, config } = loadTargetConfig(targetRepoPath);

  const topic = `${opportunity.title} (e3d-corp opportunity ${opportunity.id}: ${opportunity.description})`.slice(0, 400);
  const updatedResearchTopics = appendResearchTopic(config.research_topics, topic);
  const researchTopicsUpdated = updatedResearchTopics !== config.research_topics;
  if (researchTopicsUpdated) {
    const updatedConfig = { ...config, research_topics: updatedResearchTopics };
    fs.writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf8');
  }

  const handoffDir = path.join(targetRepoPath, '.e3d-pilot', 'e3d-corp-handoffs');
  fs.mkdirSync(handoffDir, { recursive: true });
  const auditPath = path.join(handoffDir, `${opportunity.id}.md`);
  fs.writeFileSync(auditPath, auditMarkdown({ opportunity, chain, reason }), 'utf8');

  return { configPath, auditPath, researchTopicsUpdated };
}
