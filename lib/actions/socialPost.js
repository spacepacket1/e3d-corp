import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import crypto from 'node:crypto';
import { postToX } from '../social/xPost.js';
import { postToLinkedIn } from '../social/linkedinPost.js';
import { X_POST_TYPE, LINKEDIN_POST_TYPE, X_MAX_CHARS, LINKEDIN_MAX_CHARS } from '../proposals/socialPost.js';

const PLATFORMS = {
  [X_POST_TYPE]: { eventType: 'x.posted', source: 'action:x-post', platform: 'x', max: X_MAX_CHARS, defaultTransport: postToX },
  [LINKEDIN_POST_TYPE]: { eventType: 'linkedin.posted', source: 'action:linkedin-post', platform: 'linkedin', max: LINKEDIN_MAX_CHARS, defaultTransport: postToLinkedIn }
};

function isDryRun(ctx) {
  return ctx.dryRun === true || ctx.instanceConfig?.pilotGrowth?.dryRun === true;
}

async function executeSocialPost(proposal, ctx, actionType) {
  // First line of every real-world action: the authority guard.
  assertProposalAuthorized(proposal, actionType);
  const spec = PLATFORMS[actionType];

  const { dataDir, causationId = null, correlationId } = ctx;
  if (!dataDir) throw new Error(`${actionType} executor requires a dataDir`);

  const prior = queryEvents(dataDir, { type: spec.eventType }).find((event) => event.payload?.proposalId === proposal.id);
  if (prior) return { posted: false, idempotent: true, event: prior, url: prior.payload.url };

  const { text, replyToTweetId = null, mediaPath = null } = proposal.payload ?? {};
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`Proposal ${proposal.id} has no text; refusing to post`);
  }
  if (text.length > spec.max) {
    throw new Error(`Proposal ${proposal.id} text is ${text.length} characters; ${spec.platform} allows ${spec.max}`);
  }

  if (isDryRun(ctx)) {
    return { posted: false, dryRun: true, preview: { platform: spec.platform, text, replyToTweetId, mediaPath } };
  }

  const transport = ctx.transport ?? spec.defaultTransport;
  const result = await transport({ text, replyToTweetId, mediaPath });

  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const resolvedCorrelation = correlationId ?? proposal.correlationId;
  const event = append({
    type: spec.eventType,
    source: spec.source,
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      platform: spec.platform,
      text,
      replyToTweetId,
      postId: result.postId,
      url: result.url,
      auth: result.auth ?? null,
      postedAt: new Date().toISOString()
    },
    causationId,
    correlationId: resolvedCorrelation
  });

  // Outcome event carrying the post URL, in the exact shape lib/outcomes/record.js writes
  // (event type = outcome type, subject outcome, payload {id, correlationId, type, ...}). Appended through
  // the same `append` as the action event because this executor can run inside decide.js's events lock,
  // where recordOutcome (which takes the lock itself) would deadlock. The Experience snapshot is a pure
  // recompute from the log and is refreshed the next time an Outcome is recorded the normal way.
  const outcomeId = crypto.randomUUID();
  const outcome = append({
    type: 'social.post.published',
    source: spec.source,
    subject: { type: 'outcome', id: outcomeId },
    payload: { id: outcomeId, correlationId: resolvedCorrelation, type: 'social.post.published', platform: spec.platform, url: result.url, postId: result.postId, proposalId: proposal.id },
    causationId: event.id,
    correlationId: resolvedCorrelation
  });

  return { posted: true, idempotent: false, url: result.url, event, outcome };
}

export const postXProposal = (proposal, ctx = {}) => executeSocialPost(proposal, ctx, X_POST_TYPE);
export const postLinkedinProposal = (proposal, ctx = {}) => executeSocialPost(proposal, ctx, LINKEDIN_POST_TYPE);
