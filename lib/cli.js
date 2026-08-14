import crypto from 'node:crypto';
import path from 'node:path';
import { loadInstance, loadInstanceConfig, resolvePath } from './config.js';
import { appendEvent, queryEvents } from './events/store.js';
import { reconstructChain } from './events/chain.js';
import { createResearchAdapter } from './research/adapter.js';
import { runDiscoveryPass } from './opportunities/engine.js';
import { listOpportunities, getOpportunity } from './opportunities/store.js';
import { listProposals, getProposal } from './proposals/store.js';
import { decideOpportunity, decideProposal } from './decisions/decide.js';
import { startWebServer } from './web/server.js';
import { runOpportunityCommunicator } from './roles/communicator.js';
import { registerActionExecutor } from './actions/registry.js';
import { sendOutreach } from './actions/sendOutreach.js';

// The one place a real action-execution function is wired up to the type it
// fires for - every CLI invocation and the web server both import this
// module, so registering here covers both surfaces from a single call site.
registerActionExecutor('send-outreach', sendOutreach);

const COMMANDS = [
  ['config validate <instance-config-path>', 'Validate an instance config file'],
  ['event add --type <type> --source <source> --payload <json>', 'Add a Company Event'],
  ['event log [--correlation <id>] [--since <date>]', 'Render a human-readable, ordered event log'],
  ['run [--instance <name>]', 'Run the scheduled discovery pass (instance config researchTopics) through opportunity.prospect'],
  ['pursue [--instance <name>]', 'Run opportunity.communicator over "pursuing" opportunities that have no send-outreach proposal yet'],
  ['opportunities list [--status <status>] [--min-score <n>]', 'List opportunities, ranked by score (dev/debug CLI)'],
  ['opportunities show <id>', 'Show an opportunity and its causal chain (dev/debug CLI)'],
  ['opportunities decide <id> --status <status> --reason <reason>', 'Decide what to do with an opportunity (reviewed|pursuing|no-value)'],
  ['opportunities check-shipped <id>', 'Phase 8 stub: check whether a related capability shipped'],
  ['proposals list [--status <status>] [--type <type>]', 'List proposals (dev/debug CLI)'],
  ['proposals show <id>', 'Show a proposal (dev/debug CLI)'],
  ['proposals approve <id> --reason <reason>', 'Approve a proposal (level-2 fires its action immediately)'],
  ['proposals reject <id> --reason <reason>', 'Reject a proposal'],
  ['web [--instance <name>] [--port <n>]', 'Start the web UI (basic auth required; refuses to start without it)'],
  ['outcomes record', 'Phase 9 stub: record an outcome'],
  ['experience show <correlationId>', 'Phase 9 stub: show an assembled experience record'],
  ['evaluate report', 'Phase 10 stub: render evaluation metrics']
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
    'Implemented so far: `config validate`, `event add`, `event log`, `run`, `pursue`, `opportunities list`, ' +
      '`opportunities show`, `opportunities decide`, `proposals list`, `proposals show`, `proposals approve`, ' +
      '`proposals reject`, `web`. The remaining commands are documented stubs for later phases.'
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

  const instanceName = flags.instance ?? 'futco';
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

function eventLogCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance ?? 'futco';
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
  const instanceName = flags.instance ?? 'futco';
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
    const { opportunity } = result;
    process.stdout.write(
      `[${result.topic}] -> ${opportunity.id} "${opportunity.title}" (type=${opportunity.type}, score=${opportunity.score.value})\n`
    );
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
  const instanceName = flags.instance ?? 'futco';
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
      const { proposal } = await runOpportunityCommunicator({
        instanceConfig: config,
        dataDir,
        opportunity,
        researchAdapter
      });
      process.stdout.write(`[${opportunity.id}] -> proposal ${proposal.id} drafted to ${proposal.payload.to}\n`);
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
  const instanceName = flags.instance ?? 'futco';
  const { dataDir } = loadInstance(instanceName);

  let minScore;
  if (flags['min-score'] !== undefined) {
    minScore = Number(flags['min-score']);
    if (Number.isNaN(minScore)) {
      process.stderr.write('--min-score must be a number\n');
      return 1;
    }
  }

  const opportunities = listOpportunities(dataDir, { status: flags.status, minScore });

  if (opportunities.length === 0) {
    process.stdout.write('No opportunities found.\n');
    return 0;
  }

  for (const opportunity of opportunities) {
    const score = opportunity.score ? opportunity.score.value : '-';
    process.stdout.write(
      `${opportunity.id}  [${opportunity.status}]  score=${score}  type=${opportunity.type}  "${opportunity.title}"\n`
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
  const instanceName = flags.instance ?? 'futco';
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
  process.stdout.write(`  score:       ${opportunity.score ? opportunity.score.value : '-'}\n`);
  if (opportunity.score) {
    process.stdout.write(`  rationale:   ${opportunity.score.rationale}\n`);
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

  const instanceName = flags.instance ?? 'futco';
  const { dataDir } = loadInstance(instanceName);

  const { decision, event } = decideOpportunity(dataDir, id, status, reason, resolveDecidedBy(flags), 'cli');
  process.stdout.write(`Decided opportunity ${id}: ${decision.decision} (event ${event.id})\n`);
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

  const instanceName = flags.instance ?? 'futco';
  const { config, dataDir } = loadInstance(instanceName);

  const result = await decideProposal(dataDir, id, decisionValue, reason, resolveDecidedBy(flags), 'cli', config);
  const executedNote = result.executed ? ' (action executed immediately)' : '';
  process.stdout.write(`Proposal ${id}: ${result.decision.decision}${executedNote}\n`);
  return 0;
}

function proposalsListCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const flags = parseFlags(args);
  const instanceName = flags.instance ?? 'futco';
  const { dataDir } = loadInstance(instanceName);

  const proposals = listProposals(dataDir, { status: flags.status, type: flags.type });

  if (proposals.length === 0) {
    process.stdout.write('No proposals found.\n');
    return 0;
  }

  for (const proposal of proposals) {
    process.stdout.write(
      `${proposal.id}  [${proposal.status}]  level=${proposal.authorityLevel}  type=${proposal.type}\n`
    );
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
  const instanceName = flags.instance ?? 'futco';
  const { dataDir } = loadInstance(instanceName);

  const proposal = getProposal(dataDir, id);
  if (!proposal) {
    process.stderr.write(`Proposal not found: ${id}\n`);
    return 1;
  }

  const chain = reconstructChain(dataDir, proposal.correlationId);

  process.stdout.write(`Proposal ${proposal.id}\n`);
  process.stdout.write(`  type:         ${proposal.type}\n`);
  process.stdout.write(`  status:       ${proposal.status}\n`);
  process.stdout.write(`  authorityLevel: ${proposal.authorityLevel}\n`);
  process.stdout.write(`  proposedBy:   ${JSON.stringify(proposal.proposedBy)}\n`);
  process.stdout.write(`  payload:      ${JSON.stringify(proposal.payload)}\n`);
  process.stdout.write(`  correlation:  ${proposal.correlationId}\n`);
  process.stdout.write(`  createdAt:    ${proposal.createdAt}\n`);
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
  const instanceName = flags.instance ?? 'futco';
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

    if (group === 'event' && subcommand === 'add') {
      return eventAddCommand(rest);
    }

    if (group === 'event' && subcommand === 'log') {
      return eventLogCommand(rest);
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

    if (group === 'web') {
      return webCommand(argv.slice(1));
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
