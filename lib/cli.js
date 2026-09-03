import crypto from 'node:crypto';
import path from 'node:path';
import { loadInstance, loadInstanceConfig, resolvePath } from './config.js';
import { appendEvent, queryEvents, verifyEventChain } from './events/store.js';
import { reconstructChain } from './events/chain.js';
import { createResearchAdapter } from './research/adapter.js';
import { runDiscoveryPass } from './opportunities/engine.js';
import { listOpportunities, getOpportunity } from './opportunities/store.js';
import { groupProposals, listProposals, getProposal, listSiblingProposals } from './proposals/store.js';
import { decideOpportunity, decideProposal, confirmAndExecute } from './decisions/decide.js';
import { startWebServer } from './web/server.js';
import { runOpportunityCommunicator } from './roles/communicator.js';
import { registerActionExecutor } from './actions/registry.js';
import { sendOutreach } from './actions/sendOutreach.js';
import { proposePilotHandoff } from './proposals/pilotHandoff.js';
import { pilotHandoff } from './actions/pilotHandoff.js';
import { submitCapitalMandate } from './actions/capitalMandate.js';
import { publishStressChange } from './actions/publishStressChange.js';
import { createE3dClient } from './e3d/client.js';
import { checkCapabilityShipped } from './pilot/checkShipped.js';
import { recordOutcome } from './outcomes/record.js';
import { OUTCOME_TYPES } from './outcomes/schema.js';
import { assembleExperience } from './experience/assemble.js';
import { computeMetrics, formatMetricsReport } from './evaluation/metrics.js';
import { publishAnchor, verifyAgainstAnchors, verifyExternalAnchor } from './anchor/anchor.js';
import { createEmailAnchorTransport } from './anchor/emailTransport.js';
import { computeBudgetStatus, listBudgetProviders } from './llm/budget.js';
import { listProviderStatuses } from './llm/registry.js';

// The one place a real action-execution function is wired up to the type it
// fires for - every CLI invocation and the web server both import this
// module, so registering here covers both surfaces from a single call site.
registerActionExecutor('send-outreach', sendOutreach);
registerActionExecutor('pilot-handoff', pilotHandoff);
registerActionExecutor('capital_mandate', submitCapitalMandate);
registerActionExecutor('publish-stress-change', publishStressChange);

const COMMANDS = [
  ['config validate <instance-config-path>', 'Validate an instance config file'],
  ['providers status --instance <name>', 'Report configured provider readiness without making a completion call'],
  ['budget status --instance <name>', 'Report current per-provider token budget status for configured limits'],
  ['event add --instance <name> --type <type> --source <source> --payload <json>', 'Add a Company Event'],
  ['event log --instance <name> [--correlation <id>] [--since <date>]', 'Render a human-readable, ordered event log'],
  ['event verify --instance <name> [--head <hash> --count <n>]', 'Verify the hash chain, published anchors, and optionally an emailed anchor'],
  ['anchor publish --instance <name>', 'Publish the current chain head to an external anchor (email)'],
  ['run --instance <name>', 'Run the scheduled discovery pass (instance config researchTopics) through opportunity.prospect'],
  ['pursue --instance <name>', 'Run opportunity.communicator over "pursuing" opportunities that have no send-outreach proposal yet'],
  ['opportunities list --instance <name> [--status <status>] [--min-score <n>] [--pursuable-only]', 'List opportunities, pursuable first, then ranked by score (dev/debug CLI)'],
  ['opportunities show <id> --instance <name>', 'Show an opportunity and its causal chain (dev/debug CLI)'],
  ['opportunities decide <id> --instance <name> --status <status> --reason <reason>', 'Decide what to do with an opportunity (reviewed|pursuing|no-value)'],
  ['opportunities propose-handoff <id> --instance <name> --repo <path> --reason <reason>', 'Propose an e3d-pilot handoff for a "pursuing" opportunity'],
  ['opportunities check-shipped <id> --instance <name>', 'Re-query the knowledge base for evidence a related capability now exists'],
  ['proposals list --instance <name> [--status <status>] [--type <type>]', 'List proposals (dev/debug CLI)'],
  ['proposals show <id> --instance <name>', 'Show a proposal (dev/debug CLI)'],
  ['proposals approve <id> --instance <name> --reason <reason>', 'Approve a proposal (level-2 fires its action immediately)'],
  ['proposals reject <id> --instance <name> --reason <reason>', 'Reject a proposal'],
  ['proposals confirm <id> --instance <name>', 'Confirm and fire an approved level-3/4 proposal (the required second step)'],
  ['web --instance <name> [--port <n>]', 'Start the web UI (basic auth required; refuses to start without it)'],
  ['outcomes record --instance <name> --correlation <id> --type <type> --payload <json> [--occurred-at <iso>]', 'Record a real-world Outcome for a chain'],
  ['experience show <correlationId> --instance <name>', 'Render one fully assembled Experience record for a chain'],
  ['evaluate report --instance <name> [--since <date>]', 'Render evaluation metrics computed over real events/experience data']
];

export function formatHelp() {
  const lines = [
    'Usage:',
    '  e3d-corp <command> [options]',
    '',
    'Commands:'
  ];

  for (const [command, description] of COMMANDS) {
    lines.push(`  ${command.padEnd(40)} ${description}`);
  }

  lines.push(
    '',
    'Implemented so far: `config validate`, `providers status`, `event add`, `event log`, `event verify`, `anchor publish`, `run`, `pursue`, `opportunities list`, ' +
      '`opportunities show`, `opportunities decide`, `opportunities propose-handoff`, `opportunities check-shipped`, ' +
      '`proposals list`, `proposals show`, `proposals approve`, `proposals reject`, `proposals confirm`, `web`, `outcomes record`, ' +
      '`experience show`, `evaluate report`, `budget status`. The remaining commands are documented stubs for later phases.'
  );
  return lines.join('\n');
}

function printHelp(stream = process.stdout) {
  stream.write(`${formatHelp()}\n`);
}

function printNotImplemented(commandPath) {
  process.stderr.write(`Not yet implemented: ${commandPath}\n`);
  process.exitCode = 1;
}

function normalizeHelpFlag(args) {
  return args.length === 0 || args.includes('--help') || args.includes('-h');
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function formatPursuableMarker(opportunity) {
  return opportunity?.pursuable === true ? '[pursuable]' : '[intel-only]';
}

function formatCounterpartySummary(counterparty) {
  if (!counterparty) {
    return 'unknown (predates this field)';
  }
  if (counterparty.kind === 'none') {
    return 'none';
  }

  const parts = [counterparty.name ?? 'unknown', `kind=${counterparty.kind}`];
  if (counterparty.contactHint) {
    parts.push(`contactHint=${counterparty.contactHint}`);
  }
  return parts.join(', ');
}

function eventAddCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const { type, source, payload: payloadRaw, correlation, causation } = flags;

  if (!type || !source || payloadRaw === undefined) {
    process.stderr.write('event add requires --type, --source, and --payload\n');
    return 1;
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    process.stderr.write(`Invalid JSON for --payload: ${error.message}\n`);
    return 1;
  }

  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const record = appendEvent(dataDir, {
    type,
    source,
    payload,
    correlationId: correlation ?? crypto.randomUUID(),
    causationId: causation ?? null,
    subject: {
      type: flags['subject-type'] ?? type,
      id: flags['subject-id'] ?? crypto.randomUUID()
    }
  });

  process.stdout.write(`Added event ${record.id} (type=${record.type}, correlationId=${record.correlationId})\n`);
  return 0;
}

// A hash chain nobody checks is decoration. This is the check: it exits
// non-zero on a broken chain so a scheduled run can alert on it, and names
// the first bad record rather than just reporting a boolean.
function eventVerifyCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const result = verifyEventChain(dataDir);
  const unchainedNote =
    result.unchained > 0
      ? ` (${result.unchained} written before chaining, sealed by the first chained record)`
      : '';

  if (!result.valid) {
    process.stderr.write(`Event chain BROKEN at record ${result.brokenAt}: ${result.reason}\n`);
    return 1;
  }

  process.stdout.write(
    `Event chain intact: ${result.chained} of ${result.total} records verified${unchainedNote}\n`
  );

  // An anchor read off an email is the strongest check available: its
  // reference value never lived in the file being checked, so it is the only
  // one that can catch a truncated tail or a rewrite that also deleted the
  // in-log anchors.
  if (flags.head || flags.count) {
    if (!flags.head || !flags.count) {
      process.stderr.write('event verify requires both --head and --count when checking an emailed anchor\n');
      return 1;
    }
    const external = verifyExternalAnchor(dataDir, { head: flags.head, count: Number(flags.count) });
    if (!external.valid) {
      process.stderr.write(`Emailed anchor FAILS: ${external.reason}\n`);
      return 1;
    }
    process.stdout.write(
      `Emailed anchor verified: the first ${external.count} of ${external.currentCount} records are unchanged since it was published\n`
    );
    return 0;
  }

  // The chain proves no partial edit. In-log anchors additionally prove no
  // full rewrite. Neither can prove the tail was not cut - that needs the
  // emailed copy above, so a pass here is reported for exactly what it covers.
  const anchors = verifyAgainstAnchors(dataDir);

  if (anchors.anchorCount === 0) {
    process.stdout.write(
      'No anchors published yet — a full rewrite would not be detectable.\n' +
        'Publish one with: e3d-corp anchor publish\n'
    );
    return 0;
  }

  if (!anchors.valid) {
    for (const anchor of anchors.results.filter((entry) => !entry.valid)) {
      process.stderr.write(`Anchor published ${anchor.publishedAt} FAILS: ${anchor.reason}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `Anchors verified: ${anchors.anchorCount}, pinning the first ${anchors.pinnedThrough} records against a rewrite\n` +
      'Tail truncation is only detectable against an emailed anchor: e3d-corp event verify --head <hash> --count <n>\n'
  );
  return 0;
}

async function anchorPublishCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  const transport = createEmailAnchorTransport(config);
  const { head, count, delivery } = await publishAnchor(dataDir, { instanceConfig: config, transport });

  process.stdout.write(
    `Anchored ${count} records at ${head.slice(0, 16)}… → ${transport.destination} (messageId=${delivery.messageId})\n`
  );
  return 0;
}

function eventLogCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const events = queryEvents(dataDir, {
    correlationId: flags.correlation,
    since: flags.since
  });

  if (events.length === 0) {
    process.stdout.write('No events found.\n');
    return 0;
  }

  for (const event of events) {
    const causation = event.causationId ?? '-';
    process.stdout.write(
      `${event.occurredAt}  [${event.type}]  id=${event.id}  correlation=${event.correlationId}  causation=${causation}  source=${event.source}  subject=${event.subject.type}:${event.subject.id}\n`
    );
    process.stdout.write(`    payload: ${JSON.stringify(event.payload)}\n`);
  }

  return 0;
}

async function runCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);
  const researchAdapter = createResearchAdapter(config, { dataDir });

  const results = await runDiscoveryPass({ instanceConfig: config, dataDir, researchAdapter });

  if (results.length === 0) {
    process.stdout.write('No research topics configured; nothing to discover.\n');
    return 0;
  }

  let hadError = false;
  for (const result of results) {
    if (result.error) {
      hadError = true;
      process.stdout.write(`[${result.topic}] failed: ${result.error}\n`);
      continue;
    }
    for (const opportunity of result.opportunities) {
      process.stdout.write(
        `[${result.topic}] -> ${opportunity.id} "${opportunity.title}" (type=${opportunity.type}, score=${opportunity.score.value})\n`
      );
    }
  }

  return hadError ? 1 : 0;
}

// Idempotent by design: a "pursuing" opportunity that already has a
// send-outreach proposal (pending, approved, or rejected) is skipped rather
// than drafted again, so re-running `pursue` after a human has already
// decided never produces a duplicate outreach draft.
async function pursueCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);
  const researchAdapter = createResearchAdapter(config, { dataDir });

  const pursuing = listOpportunities(dataDir, { status: 'pursuing' });
  if (pursuing.length === 0) {
    process.stdout.write('No pursuing opportunities found.\n');
    return 0;
  }

  const existingOutreach = listProposals(dataDir, { type: 'send-outreach' });

  let hadError = false;
  for (const opportunity of pursuing) {
    const already = existingOutreach.find((proposal) => proposal.correlationId === opportunity.correlationId);
    if (already) {
      process.stdout.write(`[${opportunity.id}] already has a send-outreach proposal (${already.id}); skipping\n`);
      continue;
    }

    try {
      const result = await runOpportunityCommunicator({
        instanceConfig: config,
        dataDir,
        opportunity,
        researchAdapter
      });
      for (const proposal of result.proposals ?? [result.proposal]) {
        process.stdout.write(`[${opportunity.id}] -> proposal ${proposal.id} drafted to ${proposal.payload.to}\n`);
      }
    } catch (error) {
      hadError = true;
      process.stdout.write(`[${opportunity.id}] failed: ${error.message}\n`);
    }
  }

  return hadError ? 1 : 0;
}

function opportunitiesListCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  let minScore;
  if (flags['min-score'] !== undefined) {
    minScore = Number(flags['min-score']);
    if (Number.isNaN(minScore)) {
      process.stderr.write('--min-score must be a number\n');
      return 1;
    }
  }

  const opportunities = listOpportunities(dataDir, {
    status: flags.status,
    minScore,
    pursuableOnly: flags['pursuable-only'] === true
  });

  if (opportunities.length === 0) {
    process.stdout.write('No opportunities found.\n');
    return 0;
  }

  for (const opportunity of opportunities) {
    const score = opportunity.score ? opportunity.score.value : '-';
    process.stdout.write(
      `${opportunity.id}  [${opportunity.status}]  ${formatPursuableMarker(opportunity)}  score=${score}  type=${opportunity.type}  counterparty=${formatCounterpartySummary(opportunity.counterparty)}  "${opportunity.title}"\n`
    );
  }

  return 0;
}

function opportunitiesShowCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('opportunities show requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    process.stderr.write(`Opportunity not found: ${id}\n`);
    return 1;
  }

  const chain = reconstructChain(dataDir, opportunity.correlationId);

  process.stdout.write(`Opportunity ${opportunity.id}\n`);
  process.stdout.write(`  type:        ${opportunity.type}\n`);
  process.stdout.write(`  title:       ${opportunity.title}\n`);
  process.stdout.write(`  status:      ${opportunity.status}\n`);
  process.stdout.write(`  pursuable:   ${opportunity.pursuable === true ? 'true' : 'false'}\n`);
  process.stdout.write(`  score:       ${opportunity.score ? opportunity.score.value : '-'}\n`);
  if (opportunity.score) {
    process.stdout.write(`  rationale:   ${opportunity.score.rationale}\n`);
  }
  if (!opportunity.counterparty) {
    process.stdout.write('  counterparty:\n');
    process.stdout.write('    unknown (predates this field)\n');
  } else {
    process.stdout.write('  counterparty:\n');
    process.stdout.write(`    kind:        ${opportunity.counterparty.kind}\n`);
    process.stdout.write(`    name:        ${opportunity.counterparty.name ?? 'null'}\n`);
    process.stdout.write(`    contactHint: ${opportunity.counterparty.contactHint ?? 'null'}\n`);
  }
  process.stdout.write(`  description: ${opportunity.description}\n`);
  process.stdout.write(`  evidence:    ${(opportunity.evidence ?? []).join(', ') || '-'}\n`);
  process.stdout.write(`  correlation: ${opportunity.correlationId}\n`);
  process.stdout.write(`  createdAt:   ${opportunity.createdAt}\n`);
  process.stdout.write('  causal chain:\n');
  for (const event of chain) {
    process.stdout.write(
      `    ${event.occurredAt}  [${event.type}]  id=${event.id}  causation=${event.causationId ?? '-'}\n`
    );
  }

  return 0;
}

function resolveDecidedBy(flags) {
  return flags['decided-by'] ?? process.env.E3D_CORP_USER ?? process.env.USER ?? 'cli';
}

function opportunitiesDecideCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('opportunities decide requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const { status, reason } = flags;
  if (!status || !reason) {
    process.stderr.write('opportunities decide requires --status and --reason\n');
    return 1;
  }

  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const { decision, event } = decideOpportunity(dataDir, id, status, reason, resolveDecidedBy(flags), 'cli');
  process.stdout.write(`Decided opportunity ${id}: ${decision.decision} (event ${event.id})\n`);
  return 0;
}

function opportunitiesProposeHandoffCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('opportunities propose-handoff requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const { repo, reason } = flags;
  if (!repo || !reason) {
    process.stderr.write('opportunities propose-handoff requires --repo and --reason\n');
    return 1;
  }

  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    process.stderr.write(`Opportunity not found: ${id}\n`);
    return 1;
  }

  const { proposal } = proposePilotHandoff(dataDir, {
    opportunity,
    targetRepo: repo,
    reason,
    instanceConfig: config
  });
  process.stdout.write(`Proposed pilot-handoff ${proposal.id} for opportunity ${id} -> ${repo}\n`);
  return 0;
}

async function opportunitiesCheckShippedCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('opportunities check-shipped requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    process.stderr.write(`Opportunity not found: ${id}\n`);
    return 1;
  }

  const researchAdapter = createResearchAdapter(config, { dataDir });

  const result = await checkCapabilityShipped({
    dataDir,
    opportunityId: id,
    listRepos: () => researchAdapter.listRepos({ correlationId: opportunity.correlationId })
  });

  if (result.matched) {
    process.stdout.write(
      `Capability shipped: ${result.repo.name} (matched "${result.matchedKeyword}") - ${result.repo.one_liner ?? ''}\n`
    );
  } else {
    process.stdout.write(`No shipped capability found yet (checked ${result.checkedRepoCount} repos).\n`);
  }
  return 0;
}

async function proposalsDecideCommand(args, decisionValue) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  const label = decisionValue === 'approved' ? 'approve' : 'reject';
  if (!id) {
    process.stderr.write(`proposals ${label} requires an <id>\n`);
    return 1;
  }

  const flags = parseFlags(rest);
  const { reason } = flags;
  if (!reason) {
    process.stderr.write(`proposals ${label} requires --reason\n`);
    return 1;
  }

  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  const proposal = getProposal(dataDir, id);
  const result = await decideProposal(dataDir, id, decisionValue, reason, resolveDecidedBy(flags), 'cli', config);
  if (decisionValue === 'rejected' && proposal?.type === 'publish-stress-change') {
    await createE3dClient(config.e3d ?? {}).rejectFinancialStressChange({
      run_id: proposal.payload?.run_id,
      reason
    });
  }
  const executedNote = result.executed ? ' (action executed immediately)' : '';
  process.stdout.write(`Proposal ${id}: ${result.decision.decision}${executedNote}\n`);
  return 0;
}

// The distinct, explicit second step a level-3/4 proposal requires before
// its action fires. A separate command invocation is exactly what the web
// UI's confirm button is - same two-step shape, same single implementation.
// Deliberately takes no --reason, matching confirmAndExecute: the
// deliberation already happened at approval; this is "yes, actually do it
// now". Every refusal (not approved, wrong authority level, no registered
// executor) is enforced inside confirmAndExecute, not re-checked here.
async function proposalsConfirmCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('proposals confirm requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  await confirmAndExecute(dataDir, id, resolveDecidedBy(flags), 'cli', config);
  process.stdout.write(`Proposal ${id}: confirmed, action executed\n`);
  return 0;
}

function proposalsListCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const proposals = listProposals(dataDir, { status: flags.status, type: flags.type });

  if (proposals.length === 0) {
    process.stdout.write('No proposals found.\n');
    return 0;
  }

  for (const group of groupProposals(proposals)) {
    if (group.proposals.length > 1) {
      process.stdout.write(`${group.label} (${group.proposals.length} drafts, correlation ${group.correlationId})\n`);
    }
    for (const proposal of group.proposals) {
      process.stdout.write(
        `${proposal.id}  [${proposal.status}]  level=${proposal.authorityLevel}  type=${proposal.type}\n`
      );
    }
  }

  return 0;
}

function proposalsShowCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write('proposals show requires an <id>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const proposal = getProposal(dataDir, id);
  if (!proposal) {
    process.stderr.write(`Proposal not found: ${id}\n`);
    return 1;
  }

  const chain = reconstructChain(dataDir, proposal.correlationId);
  const siblings = listSiblingProposals(dataDir, proposal);

  process.stdout.write(`Proposal ${proposal.id}\n`);
  process.stdout.write(`  type:         ${proposal.type}\n`);
  process.stdout.write(`  status:       ${proposal.status}\n`);
  process.stdout.write(`  authorityLevel: ${proposal.authorityLevel}\n`);
  process.stdout.write(`  proposedBy:   ${JSON.stringify(proposal.proposedBy)}\n`);
  process.stdout.write(`  payload:      ${JSON.stringify(proposal.payload)}\n`);
  process.stdout.write(`  correlation:  ${proposal.correlationId}\n`);
  process.stdout.write(`  createdAt:    ${proposal.createdAt}\n`);
  if (siblings.length > 1) {
    process.stdout.write(`  sibling drafts (${siblings.length} total):\n`);
    for (const sibling of siblings) {
      process.stdout.write(
        `    ${sibling.id}  [${sibling.status}]  provider=${sibling.proposedBy?.provider ?? '-'}  subject=${JSON.stringify(sibling.payload?.subject ?? '')}\n`
      );
    }
  }
  process.stdout.write('  causal chain:\n');
  for (const event of chain) {
    process.stdout.write(
      `    ${event.occurredAt}  [${event.type}]  id=${event.id}  causation=${event.causationId ?? '-'}\n`
    );
  }

  return 0;
}

function webCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);
  const port = flags.port ? Number(flags.port) : config.web?.port ?? 3000;
  if (Number.isNaN(port)) {
    process.stderr.write('--port must be a number\n');
    return 1;
  }

  startWebServer({ config, dataDir, port });
  process.stdout.write(`e3d-corp web UI listening on http://localhost:${port} (instance: ${instanceName})\n`);
  // Deliberately does not resolve early: the listening HTTP server keeps the
  // event loop alive, which is what makes `e3d-corp web` a long-running
  // process rather than a one-shot command.
  return 0;
}

function outcomesRecordCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const { correlation, type, payload: payloadRaw, 'occurred-at': occurredAt } = flags;
  if (!correlation || !type || payloadRaw === undefined) {
    process.stderr.write('outcomes record requires --correlation, --type, and --payload\n');
    return 1;
  }
  if (!OUTCOME_TYPES.includes(type)) {
    process.stderr.write(`Unknown outcome type "${type}"; expected one of ${OUTCOME_TYPES.join(', ')}\n`);
    return 1;
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    process.stderr.write(`Invalid JSON for --payload: ${error.message}\n`);
    return 1;
  }

  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const { outcome, event } = recordOutcome(dataDir, {
    correlationId: correlation,
    type,
    payload,
    occurredAt: typeof occurredAt === 'string' ? occurredAt : undefined
  });
  process.stdout.write(`Recorded outcome ${outcome.id} (type=${outcome.type}, event ${event.id})\n`);
  return 0;
}

function experienceShowCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const [correlationId, ...rest] = args;
  if (!correlationId) {
    process.stderr.write('experience show requires a <correlationId>\n');
    return 1;
  }

  const flags = parseFlags(rest);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { dataDir } = loadInstance(instanceName);

  const experience = assembleExperience(dataDir, correlationId);
  process.stdout.write(`Experience for correlationId ${experience.correlationId}\n`);
  process.stdout.write(`  context:       ${experience.context}\n`);
  process.stdout.write(`  role:          ${experience.role ?? '-'}\n`);
  process.stdout.write(`  model:         ${experience.model ?? '-'}\n`);
  process.stdout.write(`  originatingEvent: [${experience.originatingEvent.type}] ${experience.originatingEvent.id}\n`);
  process.stdout.write(`  evidence:      ${experience.evidence.length} item(s)\n`);
  process.stdout.write(`  proposal:      ${experience.proposal ? experience.proposal.type : '-'}\n`);
  process.stdout.write(`  decision:      ${experience.decision ? experience.decision.decision ?? experience.decision.status : '-'}\n`);
  process.stdout.write(`  action:        ${experience.action ? experience.action.type : '-'}\n`);
  process.stdout.write(`  outcome:       ${experience.outcome ? experience.outcome.type : '-'}\n`);
  process.stdout.write(`  latencyMs:     ${experience.latencyMs ?? '-'}\n`);
  process.stdout.write(`  costEstimate:  ${experience.costEstimate ?? '-'}\n`);
  return 0;
}

function evaluateReportCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }
  const { config, dataDir } = loadInstance(instanceName);

  const metrics = computeMetrics(dataDir, {
    since: typeof flags.since === 'string' ? flags.since : undefined,
    instanceConfig: config
  });
  process.stdout.write(`${formatMetricsReport(metrics)}\n`);
  return 0;
}

function budgetStatusCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }

  const { config, dataDir } = loadInstance(instanceName);
  const providers = listBudgetProviders(config);
  if (providers.length === 0) {
    process.stdout.write('No provider budgets configured.\n');
    return 0;
  }

  for (const providerName of providers) {
    const status = computeBudgetStatus(dataDir, config, providerName);
    if (status.unlimited) {
      process.stdout.write(`${status.provider}: unlimited\n`);
      continue;
    }
    process.stdout.write(
      `${status.provider}: spent=${status.settled} allocated=${status.limit} outstanding=${status.outstanding} remaining=${status.remaining}\n`
    );
    process.stdout.write(`  - period: ${status.periodStart} to ${status.periodEnd}\n`);
  }

  return 0;
}

function validateConfigCommand(args) {
  const target = args[0];
  if (!target || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const filePath = resolvePath(target);
  loadInstanceConfig(filePath);
  process.stdout.write(`${path.relative(process.cwd(), filePath) || filePath}: valid\n`);
  return 0;
}

function providersStatusCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance;
  if (!instanceName) {
    process.stderr.write('Missing required --instance <name>\n');
    return 1;
  }

  const { config } = loadInstance(instanceName);
  const statuses = listProviderStatuses(config);
  let allReady = true;

  for (const status of statuses) {
    const label = status.ready ? 'ready' : 'not-ready';
    if (!status.ready) {
      allReady = false;
    }
    process.stdout.write(`${status.provider} (${status.kind}): ${label}\n`);
    for (const check of status.checks) {
      process.stdout.write(`  - ${check.message}\n`);
    }
  }

  return allReady ? 0 : 1;
}

export async function run(argv = process.argv.slice(2)) {
  try {
    if (normalizeHelpFlag(argv)) {
      printHelp();
      return 0;
    }

    const [group, subcommand, ...rest] = argv;

    if (group === 'config' && subcommand === 'validate') {
      return validateConfigCommand(rest);
    }

    if (group === 'config') {
      printHelp();
      process.stderr.write(`Unknown config command: ${subcommand ?? ''}\n`);
      return 1;
    }

    if (group === 'providers' && subcommand === 'status') {
      return providersStatusCommand(rest);
    }

    if (group === 'providers') {
      printHelp();
      process.stderr.write(`Unknown providers command: ${subcommand ?? ''}\n`);
      return 1;
    }

    if (group === 'budget' && subcommand === 'status') {
      return budgetStatusCommand(rest);
    }

    if (group === 'budget') {
      printHelp();
      process.stderr.write(`Unknown budget command: ${subcommand ?? ''}\n`);
      return 1;
    }

    if (group === 'event' && subcommand === 'add') {
      return eventAddCommand(rest);
    }

    if (group === 'event' && subcommand === 'log') {
      return eventLogCommand(rest);
    }

    if (group === 'event' && subcommand === 'verify') {
      return eventVerifyCommand(rest);
    }

    if (group === 'anchor' && subcommand === 'publish') {
      return await anchorPublishCommand(rest);
    }

    if (group === 'anchor') {
      printHelp();
      process.stderr.write(`Unknown anchor command: ${subcommand ?? ''}\n`);
      return 1;
    }

    if (group === 'event') {
      printHelp();
      process.stderr.write(`Unknown event command: ${subcommand ?? ''}\n`);
      return 1;
    }

    if (group === 'run') {
      return await runCommand(argv.slice(1));
    }

    if (group === 'pursue') {
      return await pursueCommand(argv.slice(1));
    }

    if (group === 'opportunities' && subcommand === 'list') {
      return opportunitiesListCommand(rest);
    }

    if (group === 'opportunities' && subcommand === 'show') {
      return opportunitiesShowCommand(rest);
    }

    if (group === 'opportunities' && subcommand === 'decide') {
      return opportunitiesDecideCommand(rest);
    }

    if (group === 'opportunities' && subcommand === 'propose-handoff') {
      return opportunitiesProposeHandoffCommand(rest);
    }

    if (group === 'opportunities' && subcommand === 'check-shipped') {
      return await opportunitiesCheckShippedCommand(rest);
    }

    if (group === 'proposals' && subcommand === 'list') {
      return proposalsListCommand(rest);
    }

    if (group === 'proposals' && subcommand === 'show') {
      return proposalsShowCommand(rest);
    }

    if (group === 'proposals' && subcommand === 'approve') {
      return await proposalsDecideCommand(rest, 'approved');
    }

    if (group === 'proposals' && subcommand === 'reject') {
      return await proposalsDecideCommand(rest, 'rejected');
    }

    if (group === 'proposals' && subcommand === 'confirm') {
      return await proposalsConfirmCommand(rest);
    }

    if (group === 'web') {
      return webCommand(argv.slice(1));
    }

    if (group === 'outcomes' && subcommand === 'record') {
      return outcomesRecordCommand(rest);
    }

    if (group === 'experience' && subcommand === 'show') {
      return experienceShowCommand(rest);
    }

    if (group === 'evaluate' && subcommand === 'report') {
      return evaluateReportCommand(rest);
    }

    const commandPath = [group, subcommand].filter(Boolean).join(' ');
    const hasKnownStub =
      group === 'opportunities' ||
      group === 'proposals' ||
      group === 'outcomes' ||
      group === 'experience' ||
      group === 'evaluate';

    if (hasKnownStub) {
      printNotImplemented(commandPath || group);
      return 1;
    }

    printHelp();
    process.stderr.write(`Unknown command: ${argv.join(' ')}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}
