import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { normalizeOpportunityCandidate } from './schema.js';
import { scoreOpportunity } from './scoring.js';
import { buildVideoSeries, YOUTUBE_EVENTS } from '../youtube/series.js';
import { analyzeVideo } from '../youtube/metrics.js';
import { resolveYoutubeConfig } from '../research/youtubeConfig.js';

export const YOUTUBE_SIGNAL_EVENT_TYPE = 'youtube.signal.detected';
export const YOUTUBE_OPPORTUNITY_TYPES = Object.freeze({
  stall: 'youtube-underperforming-video',
  breakout: 'youtube-breakout-video',
  comments: 'youtube-comments-awaiting-reply'
});

const PROPOSED_BY = Object.freeze({ role: 'youtube.scan', provider: 'deterministic', model: 'n/a' });
const DAY_MS = 86_400_000;

const fmt = (n, digits = 1) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(digits)).toString() : 'n/a');
const clampConfidence = (value, cap) => Math.round(Math.min(value, cap) * 100) / 100;

// One signal per (video, kind) per signal window, so a persistent problem raises one Opportunity per window, not one
// per scan, yet resurfaces next window instead of being silenced forever (same idea as adPerformanceSignal).
function signalId(videoId, kind, signalWindowDays, now) {
  return `${videoId}:${kind}:${Math.floor(now.getTime() / (signalWindowDays * DAY_MS))}`;
}

// A signal only counts as handled once it produced an Opportunity; a crash between the signal and the
// opportunity leaves it retryable, exactly like lib/event-sources/adPerformanceSignal.js.
function alreadyHandledSignalIds(dataDir) {
  const handledCausation = new Set(queryEvents(dataDir, { type: 'opportunity.created' }).map((e) => e.causationId).filter(Boolean));
  const handled = new Set();
  for (const signal of queryEvents(dataDir, { type: YOUTUBE_SIGNAL_EVENT_TYPE })) {
    if (handledCausation.has(signal.id) && signal.subject?.id) handled.add(signal.subject.id);
  }
  return handled;
}

function describe(kind, video, analysis) {
  const title = video.title ?? video.videoId;
  const age = fmt(analysis.ageDays, 1);
  if (kind === 'stall') {
    const s = analysis.stall;
    return {
      title: `"${title}" has stalled: ${fmt(s.viewsInWindow, 0)} views in the last ${fmt(s.windowHours, 0)}h`,
      description:
        `"${title}" (published ${age} days ago) gained ${fmt(s.viewsInWindow, 0)} views in the last ${fmt(s.windowHours, 0)} hours and averages ` +
        `${fmt(s.viewsPerDay)} views/day, which is ${fmt(s.relativeToMedian * 100, 0)}% of the channel median of ${fmt(s.medianViewsPerDay)} views/day ` +
        `across ${s.baselineVideoCount} other videos. Small numbers are noisy: this is a prompt for a human look, not a verdict.`,
      rationale: `lifetime ${fmt(s.viewsPerDay)}/day vs channel median ${fmt(s.medianViewsPerDay)}/day (${s.baselineVideoCount} videos); ${fmt(s.viewsInWindow, 0)} views in ${fmt(s.windowHours, 0)}h`
    };
  }
  if (kind === 'breakout') {
    const b = analysis.breakout;
    return {
      title: `"${title}" is breaking out: ${fmt(b.multipleOfMedian)}x the channel median`,
      description:
        `"${title}" gained ${fmt(b.viewsInWindow, 0)} views in the last ${fmt(b.windowHours, 0)} hours (${fmt(b.viewsPerDayInWindow)} views/day), ` +
        `${fmt(b.multipleOfMedian)}x the channel median of ${fmt(b.medianViewsPerDay)} views/day across ${b.baselineVideoCount} other videos. ` +
        'Worth amplifying while it is moving, and worth learning what drove it. A burst can also be a bot or a single share.',
      rationale: `${fmt(b.viewsPerDayInWindow)}/day in the last ${fmt(b.windowHours, 0)}h = ${fmt(b.multipleOfMedian)}x median ${fmt(b.medianViewsPerDay)}/day`
    };
  }
  const c = analysis.comments;
  return {
    title: `${fmt(c.newComments, 0)} new comments on "${title}" may deserve a reply`,
    description: `"${title}" gained ${fmt(c.newComments, 0)} comments in the last ${fmt(c.windowHours, 0)} hours. Replying early tends to keep a conversation going; drafts are queued for you to post by hand.`,
    rationale: `commentCount rose by ${fmt(c.newComments, 0)} in ${fmt(c.windowHours, 0)}h`
  };
}

function confidenceFor(kind, analysis, t, video) {
  if (kind === 'stall') {
    const s = analysis.stall;
    return clampConfidence(0.55 + (s.relativeToMedian < t.stallMaxRelativeToMedian / 2 ? 0.15 : 0) + (s.baselineVideoCount >= 4 ? 0.1 : 0), 0.85);
  }
  if (kind === 'breakout') {
    const b = analysis.breakout;
    return clampConfidence(0.6 + (b.multipleOfMedian >= t.breakoutMultiple * 2 ? 0.15 : 0) + (b.viewsInWindow >= t.breakoutMinViews * 3 ? 0.1 : 0), 0.9);
  }
  const c = analysis.comments;
  return clampConfidence(0.5 + (c.newComments >= t.commentMinNew * 2 ? 0.1 : 0) + (video.comments.length >= c.newComments ? 0.1 : 0), 0.8);
}

function sampleEventIdsFor(kind, analysis) {
  const source = kind === 'stall' ? analysis.stall : kind === 'breakout' ? analysis.breakout : analysis.comments;
  return (source.sampleEventIds ?? []).filter(Boolean);
}

function detectedKinds(analysis) {
  const kinds = [];
  if (analysis.stall.stalled === true) kinds.push('stall');
  if (analysis.breakout.breakout === true) kinds.push('breakout');
  if (analysis.comments.spike === true) kinds.push('comments');
  return kinds;
}

// Level 0/1: reads the sampled events, writes an internal evidence + signal + Opportunity. No model, no network.
export function scanYoutubeSignals({ dataDir, instanceConfig, now = new Date() } = {}) {
  if (!dataDir) throw new Error('scanYoutubeSignals requires a dataDir');
  const { thresholds, typeWeights } = resolveYoutubeConfig(instanceConfig);
  const videos = buildVideoSeries(dataDir).filter((video) => video.samples.length > 0 && video.privacyStatus !== 'private');
  const handled = alreadyHandledSignalIds(dataDir);

  const result = { created: [], alreadySignaled: [], insufficientData: [], videosAnalyzed: videos.length };

  for (const video of videos) {
    const analysis = analyzeVideo(video, videos, now, thresholds);
    for (const flag of [analysis.stall, analysis.breakout, analysis.comments]) {
      if (flag.insufficientData) result.insufficientData.push({ videoId: video.videoId, reason: flag.reason });
    }

    for (const kind of detectedKinds(analysis)) {
      const id = signalId(video.videoId, kind, thresholds.signalWindowDays, now);
      if (handled.has(id)) {
        result.alreadySignaled.push(id);
        continue;
      }

      const { title, description, rationale } = describe(kind, video, analysis);
      const sampleEventIds = sampleEventIdsFor(kind, analysis);
      const recentComments = kind === 'comments' ? video.comments.slice(0, Math.max(analysis.comments.newComments, 1)) : [];
      const correlationId = crypto.randomUUID();
      const metricResult = { status: 'ok', videoId: video.videoId, videoTitle: video.title, kind, sampleEventIds, commentEventIds: recentComments.map((c) => c.eventId), metrics: analysis[kind === 'stall' ? 'stall' : kind === 'breakout' ? 'breakout' : 'comments'] };

      const evidenceEvent = appendEvent(dataDir, {
        type: 'evidence.gathered',
        source: 'research.youtube',
        subject: { type: 'research', id: crypto.randomUUID() },
        payload: { kind: 'youtube-video-metrics', query: { videoId: video.videoId, signal: kind, signalWindowDays: thresholds.signalWindowDays }, resultSummary: rationale, result: metricResult, degraded: false },
        causationId: null,
        correlationId,
        occurredAt: now.toISOString()
      });

      const signalEvent = appendEvent(dataDir, {
        type: YOUTUBE_SIGNAL_EVENT_TYPE,
        source: 'youtube.scan',
        subject: { type: 'youtube-signal', id },
        payload: { signalId: id, kind, videoId: video.videoId, videoTitle: video.title, rationale },
        causationId: evidenceEvent.id,
        correlationId,
        occurredAt: now.toISOString()
      });

      const evidenceEventIds = [evidenceEvent.id, ...sampleEventIds, ...recentComments.map((c) => c.eventId)];
      const candidate = normalizeOpportunityCandidate({
        type: YOUTUBE_OPPORTUNITY_TYPES[kind],
        title,
        description,
        rationale,
        confidence: confidenceFor(kind, analysis, thresholds, video),
        evidenceEventIds,
        counterparty: { kind: 'none', name: null, contactHint: null }
      });

      const opportunityId = crypto.randomUUID();
      const record = {
        id: opportunityId,
        type: candidate.type,
        title: candidate.title,
        description: candidate.description,
        evidence: candidate.evidenceEventIds,
        score: null,
        status: 'candidate',
        counterparty: candidate.counterparty,
        pursuable: false,
        sourceEventIds: [signalEvent.id, ...candidate.evidenceEventIds],
        correlationId,
        proposedBy: PROPOSED_BY,
        signal: { kind, videoId: video.videoId, signalId: id },
        createdAt: now.toISOString()
      };

      const createdEvent = appendEvent(dataDir, {
        type: 'opportunity.created',
        source: 'youtube.scan',
        subject: { type: 'opportunity', id: opportunityId },
        payload: { ...record, roleConfidence: candidate.confidence, roleRationale: candidate.rationale },
        causationId: signalEvent.id,
        correlationId,
        occurredAt: now.toISOString()
      });

      const score = scoreOpportunity({
        confidence: candidate.confidence,
        evidenceCount: candidate.evidenceEventIds.length,
        triggerOccurredAt: signalEvent.occurredAt,
        type: candidate.type,
        typeWeights,
        now: now.getTime()
      });
      appendEvent(dataDir, {
        type: 'opportunity.scored',
        source: 'opportunity.engine',
        subject: { type: 'opportunity', id: opportunityId },
        payload: { id: opportunityId, score, status: 'scored' },
        causationId: createdEvent.id,
        correlationId,
        occurredAt: now.toISOString()
      });

      handled.add(id);
      result.created.push({ ...record, score, status: 'scored' });
    }
  }

  return result;
}

export { YOUTUBE_EVENTS };
