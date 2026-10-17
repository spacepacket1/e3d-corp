import { createYoutubeClientFromConfig } from './research/youtubeConfig.js';
import { sampleChannel } from './event-sources/youtubeChannelSignal.js';
import { scanYoutubeSignals } from './opportunities/youtubeOpportunities.js';
import { runYoutubePoll } from './youtube/poll.js';
import { renderYoutubeReport } from './youtube/report.js';
import { proposeFromOpportunity } from './youtube/propose.js';
import { measureAppliedChanges } from './youtube/measure.js';
import { proposeYoutubeRollback } from './proposals/youtubeMetadataChange.js';
import { applyYoutubeMetadataChange } from './actions/youtubeMetadataChange.js';
import { getProposal } from './proposals/store.js';
import { appendEvent } from './events/store.js';
import { queryEvents } from './events/store.js';

function summarizeSample(s) {
  if (s.skipped === 'interval') return `Skipped: sampled recently (next sample allowed after ${s.nextSampleAt}). Use --force to sample anyway.`;
  const lines = [`Sampled ${s.sampled} video(s); ${s.discovered} newly discovered; ${s.comments} new comment(s); about ${s.quotaUnitsUsed} quota units used.`];
  if (s.degraded) lines.push(`DEGRADED: ${s.errors.map((e) => e.message ?? e).join('; ')}. Nothing was recorded as numbers for the failed step.`);
  return lines.join('\n');
}

function summarizeScan(r) {
  const lines = [`Scan: ${r.created.length} new opportunit${r.created.length === 1 ? 'y' : 'ies'}, ${r.alreadySignaled.length} already handled, ${r.insufficientData.length} video(s) without enough data.`];
  for (const o of r.created) lines.push(`  ${o.id}  [${o.type}]  ${o.title}`);
  return lines.join('\n');
}

function summarizeMeasure(m) {
  const lines = [`Measure: ${m.recorded.length} outcome(s) recorded, ${m.skipped.length} window(s) not ready or not measurable.`];
  for (const r of m.recorded) lines.push(`  ${r.outcome.payload.videoId} ${r.outcome.payload.horizon}: ${r.outcome.payload.verdict}`);
  for (const s of m.skipped) lines.push(`  skipped ${s.videoId} ${s.horizon}: ${s.reason}`);
  return lines.join('\n');
}

// `youtube <sample|scan|poll|report|propose|apply|rollback|measure>`. `deps` supplies the CLI's own flag parser and
// instance loader so this file does not import lib/cli.js.
export async function youtubeCommand(subcommand, args, { parseFlags, loadInstance, out = process.stdout, err = process.stderr, env = process.env }) {
  const positional = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const flags = parseFlags(positional ? args.slice(1) : args);
  if (!flags.instance) { err.write('Missing required --instance <name>\n'); return 1; }
  const { config, dataDir } = loadInstance(flags.instance);
  const now = flags.now ? new Date(flags.now) : new Date();
  const client = () => createYoutubeClientFromConfig(config, { env });
  const say = (text) => out.write(`${text}\n`);

  switch (subcommand) {
    case 'sample': {
      say(summarizeSample(await sampleChannel({ dataDir, instanceConfig: config, client: client(), now, force: flags.force === true })));
      return 0;
    }
    case 'scan': {
      say(summarizeScan(scanYoutubeSignals({ dataDir, instanceConfig: config, now })));
      return 0;
    }
    case 'poll': {
      const r = await runYoutubePoll({ dataDir, instanceConfig: config, client: client(), now, force: flags.force === true });
      say([summarizeSample(r.sample), summarizeScan(r.scan), summarizeMeasure(r.measure)].join('\n'));
      return r.sample.degraded ? 2 : 0;
    }
    case 'report': {
      say(renderYoutubeReport({ dataDir, instanceConfig: config, now }));
      return 0;
    }
    case 'measure': {
      say(summarizeMeasure(measureAppliedChanges(dataDir, { instanceConfig: config, now })));
      return 0;
    }
    case 'propose': {
      if (!positional) { err.write('youtube propose requires an <opportunity-id>\n'); return 1; }
      const r = await proposeFromOpportunity(dataDir, positional, { instanceConfig: config, now });
      if (r.alreadyDrafted) { say(`Opportunity ${positional} was already drafted (event ${r.event.id}); nothing was done.`); return 0; }
      if (r.failed) { err.write(`Drafting failed: ${r.reason}. Nothing was recorded as a draft; you can retry.\n`); return 1; }
      say(`Drafted for ${positional}: ${r.drafts.length} draft(s) queued for a human to post, ${r.proposal ? `1 metadata proposal ${r.proposal.id} (pending; review with \`proposals show ${r.proposal.id}\`, then \`proposals approve ${r.proposal.id} --reason ...\`)` : 'no metadata change proposed'}.`);
      for (const d of r.dropped) say(`  dropped ${d.kind}: ${d.reason}`);
      if (r.notes) say(`  model notes: ${r.notes}`);
      return 0;
    }
    case 'apply': {
      if (!positional) { err.write('youtube apply requires a <proposalId>\n'); return 1; }
      const proposal = getProposal(dataDir, positional);
      if (!proposal) { err.write(`Proposal not found: ${positional}\n`); return 1; }
      const approval = queryEvents(dataDir, { type: 'proposal.approved', subject: { type: 'proposal', id: positional } }).pop();
      const result = await applyYoutubeMetadataChange(proposal, {
        dataDir, instanceConfig: config, causationId: approval?.id ?? null, correlationId: proposal.correlationId,
        appendEvent: (event) => appendEvent(dataDir, event)
      });
      if (result.alreadyApplied) { say(`Proposal ${positional} was already applied; nothing was changed.`); return 0; }
      if (!result.applied) { err.write(`NOT applied: ${result.reason}\n`); return 1; }
      say(`Applied proposal ${positional}. Roll back with: youtube rollback ${positional} (creates a pending proposal).`);
      return 0;
    }
    case 'rollback': {
      if (!positional) { err.write('youtube rollback requires a <proposalId>\n'); return 1; }
      const { proposal } = proposeYoutubeRollback(dataDir, positional, { instanceConfig: config });
      say(`Rollback proposal ${proposal.id} created (pending). Approve it to restore the previous values: proposals approve ${proposal.id} --reason ...`);
      return 0;
    }
    default:
      err.write(`Unknown youtube command: ${subcommand ?? ''}\n`);
      return 1;
  }
}
