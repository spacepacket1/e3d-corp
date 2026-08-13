import crypto from 'node:crypto';
import path from 'node:path';
import { loadInstance, loadInstanceConfig, resolvePath } from './config.js';
import { appendEvent, queryEvents } from './events/store.js';

const COMMANDS = [
  ['config validate <instance-config-path>', 'Validate an instance config file'],
  ['event add --type <type> --source <source> --payload <json>', 'Add a Company Event'],
  ['event log [--correlation <id>] [--since <date>]', 'Render a human-readable, ordered event log'],
  ['run', 'Phase 4 stub: run the scheduled discovery loop for an instance'],
  ['opportunities list', 'Phase 4 stub: list opportunities'],
  ['opportunities show <id>', 'Phase 4 stub: show an opportunity and causal chain'],
  ['opportunities decide <id>', 'Phase 5 stub: decide an opportunity'],
  ['opportunities check-shipped <id>', 'Phase 8 stub: check whether a related capability shipped'],
  ['proposals approve <id>', 'Phase 5 stub: approve a proposal'],
  ['proposals reject <id>', 'Phase 5 stub: reject a proposal'],
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
    'Implemented so far: `config validate`, `event add`, `event log`. The remaining commands are documented stubs for later phases.'
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

export function run(argv = process.argv.slice(2)) {
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

    const commandPath = [group, subcommand].filter(Boolean).join(' ');
    const hasKnownStub =
      group === 'run' ||
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
