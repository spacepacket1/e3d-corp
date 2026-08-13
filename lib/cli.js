import path from 'node:path';
import { loadInstanceConfig, resolvePath } from './config.js';

const COMMANDS = [
  ['config validate <instance-config-path>', 'Validate an instance config file'],
  ['event add', 'Phase 2 stub: add a Company Event'],
  ['event log', 'Phase 2 stub: render the event log'],
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

  lines.push('', 'Phase 1 implements only `config validate`; the other commands are documented stubs.');
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

    const commandPath = [group, subcommand].filter(Boolean).join(' ');
    const hasKnownStub =
      group === 'event' ||
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
