import { queryEvents } from '../events/store.js';
import { listOpportunities } from '../opportunities/store.js';
import { listProposals } from '../proposals/store.js';
import { listOutcomes } from '../outcomes/store.js';
import { buildVideoSeries } from './series.js';
import { analyzeVideo, channelBaseline } from './metrics.js';
import { resolveThresholds } from './thresholds.js';
import { OUTCOME_TYPE } from './measure.js';

const DAY = 86_400_000;
const fmt = (n, digits = 0) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'n/a');
const signed = (n) => (typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n}` : 'n/a');
const OPEN_STATUSES = new Set(['scored', 'reviewed', 'pursuing']);

function ago(iso, now) {
  const h = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
  return h < 48 ? `${fmt(h, 1)}h ago` : `${fmt(h / 24, 1)}d ago`;
}

// Plain-text weekly report, a pure read of the event log. It states what the numbers are and are not: views are a weak
// signal, small numbers are noisy, and "n/a" means we do not have the data (never zero).
export function renderYoutubeReport({ dataDir, instanceConfig, now = new Date() } = {}) {
  const thresholds = resolveThresholds(instanceConfig?.research?.youtube?.thresholds);
  const series = buildVideoSeries(dataDir).filter((v) => v.privacyStatus !== 'private' && v.samples.length > 0);
  const lines = [];
  const channelId = instanceConfig?.research?.youtube?.channelId ?? 'unknown';
  lines.push(`YouTube channel report - ${channelId}`);
  lines.push(`Generated ${now.toISOString()}`);

  const lastSample = series.flatMap((v) => v.samples).map((s) => new Date(s.sampledAt).getTime()).sort((a, b) => b - a)[0];
  if (!lastSample) {
    lines.push('', 'No samples yet. Run `youtube sample` (needs a YouTube Data API key; see docs/youtube-monitor.md).');
    return lines.join('\n');
  }
  lines.push(`Last sample: ${ago(new Date(lastSample).toISOString(), now)}`);
  const degraded = queryEvents(dataDir, { type: 'evidence.gathered' }).filter((e) => e.payload?.kind === 'youtube-channel-sample' && e.payload.degraded);
  const lastDegraded = degraded[degraded.length - 1];
  if (lastDegraded && new Date(lastDegraded.occurredAt).getTime() > lastSample) {
    lines.push(`WARNING: the most recent sampling attempt failed (${lastDegraded.payload.result.reason}): ${lastDegraded.payload.result.summary}. Numbers below may be stale.`);
  }

  const baseline = channelBaseline(series, { minAgeDays: thresholds.baselineMinAgeDays });
  lines.push(baseline
    ? `Channel baseline: median ${fmt(baseline.medianViewsPerDay, 1)} views/day across ${baseline.videoCount} videos older than ${thresholds.baselineMinAgeDays} days`
    : 'Channel baseline: not enough older videos yet to compute one');

  lines.push('', 'Videos (newest first)');
  const sorted = [...series].sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0));
  for (const video of sorted) {
    const a = analyzeVideo(video, series, now, thresholds);
    const vpd = a.viewsPerDay;
    const vsMedian = vpd && baseline?.medianViewsPerDay ? `${fmt(vpd.value / baseline.medianViewsPerDay, 2)}x median` : 'n/a vs median';
    lines.push(`- ${video.title ?? video.videoId} [${video.videoId}]`);
    lines.push(`    ${fmt(a.ageDays, 1)}d old | ${a.latest?.viewCount ?? 'n/a'} views | ${vpd ? fmt(vpd.value, 1) : 'n/a'} views/day (${vsMedian}) | trend: ${a.trend?.label ?? 'n/a'}`);
    lines.push(`    last 24h: ${a.views24h.insufficientData ? `n/a (${a.views24h.reason})` : signed(a.views24h.delta)} | last 7d: ${a.views7d.insufficientData ? `n/a (${a.views7d.reason})` : signed(a.views7d.delta)} | comments: ${a.latest?.commentCount ?? 'n/a'}`);
  }

  const open = listOpportunities(dataDir).filter((o) => String(o.type).startsWith('youtube-') && OPEN_STATUSES.has(o.status));
  lines.push('', `Open opportunities (${open.length})`);
  for (const o of open) lines.push(`- ${o.id} [${o.type}] ${o.title} (score ${fmt(o.score?.value, 2)}, ${ago(o.createdAt, now)})`);
  if (open.length === 0) lines.push('- none');

  const pending = listProposals(dataDir, { status: 'pending', type: 'youtube-metadata-change' });
  lines.push('', `Pending metadata proposals (${pending.length})`);
  for (const p of pending) lines.push(`- ${p.id} ${p.payload.videoTitle ?? p.payload.videoId}: change ${Object.keys(p.payload.changes).join(', ')} - ${p.payload.reason}`);
  if (pending.length === 0) lines.push('- none');

  const drafts = queryEvents(dataDir, { type: 'youtube.draftQueued' });
  lines.push('', `Queued drafts for a human to post: ${drafts.length}`);
  for (const d of drafts.slice(-5)) lines.push(`- [${d.payload.kind}${d.payload.platform ? `/${d.payload.platform}` : ''}] ${d.payload.text.slice(0, 140)}`);

  const measured = listOutcomes(dataDir).filter((o) => o.type === OUTCOME_TYPE);
  lines.push('', `Measured changes (${measured.length})`);
  for (const o of measured.slice(0, 5)) {
    const p = o.payload;
    lines.push(`- ${p.videoId} ${p.horizon}: ${p.verdict} (views/day ${fmt(p.beforeViewsPerDay, 1)} -> ${fmt(p.afterViewsPerDay, 1)}, relative to channel ${fmt(p.relativeLift, 2)}x). Caveat: correlation, not causation.`);
  }
  if (measured.length === 0) lines.push('- none yet');

  lines.push('', 'Reading this: views are a weak signal of quality and small numbers are noisy; "n/a" means missing data, not zero.');
  return lines.join('\n');
}
