import { samplePilotMetrics } from './event-sources/pilotMetrics.js';
import { scanPilotSignals } from './opportunities/pilotOpportunities.js';
import { runPilotPoll } from './pilot/poll.js';
import { buildPilotSummary, formatPilotSummaryText } from './pilot/summary.js';
import { proposeRetentionNudge } from './pilot/nudge.js';

function summarizeSample(s) {
  if (s.skipped === 'interval') return `Skipped: sampled recently (next sample allowed after ${s.nextSampleAt}). Use --force to sample anyway.`;
  if (s.degraded) return `DEGRADED: ${s.error.message}. Nothing was recorded as numbers.`;
  return `Sampled Pilot metrics (event ${s.event.id}).`;
}

function summarizeScan(r) {
  if (!r.sampled) return 'Scan: no Pilot sample recorded yet.';
  if (r.stale) return 'Scan: the latest sample is more than 6h old; not judging stale numbers.';
  const lines = [`Scan: ${r.created.length} new opportunit${r.created.length === 1 ? 'y' : 'ies'}, ${r.alreadySignaled.length} already handled${r.noBaseline ? ' (no week-old sample yet: week-on-week signals skipped)' : ''}.`];
  for (const o of r.created) lines.push(`  ${o.id}  [${o.type}]  ${o.title}`);
  return lines.join('\n');
}

// `pilot <sample|scan|poll|summary|nudge>`. `deps` supplies the CLI's own flag parser and instance loader.
export async function pilotCommand(subcommand, args, { parseFlags, loadInstance, out = process.stdout, err = process.stderr, transport } = {}) {
  const positional = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const flags = parseFlags(positional ? args.slice(1) : args);
  if (!flags.instance) { err.write('Missing required --instance <name>\n'); return 1; }
  const { config, dataDir } = loadInstance(flags.instance);
  const now = flags.now ? new Date(flags.now) : new Date();
  const say = (text) => out.write(`${text}\n`);

  switch (subcommand) {
    case 'sample':
      say(summarizeSample(await samplePilotMetrics({ dataDir, instanceConfig: config, transport, now, force: flags.force === true })));
      return 0;
    case 'scan':
      say(summarizeScan(scanPilotSignals({ dataDir, instanceConfig: config, now })));
      return 0;
    case 'poll': {
      const r = await runPilotPoll({ dataDir, instanceConfig: config, transport, now, force: flags.force === true });
      say([summarizeSample(r.sample), summarizeScan(r.scan), r.revenue.recorded ? 'Revenue outcome recorded.' : `Revenue outcome: ${r.revenue.reason ?? 'already recorded'}`].join('\n'));
      return r.sample.degraded ? 2 : 0;
    }
    case 'summary':
      say(formatPilotSummaryText(buildPilotSummary(dataDir, { now })).join('\n'));
      return 0;
    case 'nudge': {
      if (!positional) { err.write('Usage: pilot nudge <opportunity-id> --instance <name>\n'); return 1; }
      const r = await proposeRetentionNudge(dataDir, positional, { instanceConfig: config, now });
      if (r.failed) { err.write(`Could not draft a nudge: ${r.reason}\n`); return 1; }
      say(r.alreadyProposed ? `Already proposed: ${r.proposal.id}` : `Created pending proposal ${r.proposal.id} (pilot-retention-nudge, level ${r.proposal.authorityLevel}). Review with: proposals show ${r.proposal.id}`);
      return 0;
    }
    default:
      err.write(`Unknown pilot subcommand: ${subcommand ?? '(none)'}. Expected sample|scan|poll|summary|nudge\n`);
      return 1;
  }
}
