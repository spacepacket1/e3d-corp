import crypto from 'node:crypto';
import { createProposal } from './create.js';

export const X_POST_TYPE = 'x-post';
export const LINKEDIN_POST_TYPE = 'linkedin-post';
export const X_MAX_CHARS = 280;
export const LINKEDIN_MAX_CHARS = 3000;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function proposer(proposedBy) {
  return proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' };
}

export function proposeXPost(dataDir, { text, replyToTweetId = null, mediaPath = null, citedFacts = [], draftId = null, proposedBy, causationId = null, correlationId, instanceConfig } = {}) {
  if (!isNonEmptyString(text)) throw new Error('proposeXPost requires non-empty text');
  if (text.length > X_MAX_CHARS) throw new Error(`proposeXPost: text is ${text.length} characters; X allows ${X_MAX_CHARS}`);
  return createProposal(dataDir, {
    type: X_POST_TYPE,
    payload: {
      text: text.trim(),
      replyToTweetId: isNonEmptyString(replyToTweetId) ? replyToTweetId.trim() : null,
      mediaPath: isNonEmptyString(mediaPath) ? mediaPath.trim() : null,
      citedFacts,
      draftId
    },
    proposedBy: proposer(proposedBy),
    causationId,
    correlationId: isNonEmptyString(correlationId) ? correlationId : crypto.randomUUID(),
    instanceConfig
  });
}

export function proposeLinkedinPost(dataDir, { text, citedFacts = [], draftId = null, proposedBy, causationId = null, correlationId, instanceConfig } = {}) {
  if (!isNonEmptyString(text)) throw new Error('proposeLinkedinPost requires non-empty text');
  if (text.length > LINKEDIN_MAX_CHARS) throw new Error(`proposeLinkedinPost: text is ${text.length} characters; limit is ${LINKEDIN_MAX_CHARS}`);
  return createProposal(dataDir, {
    type: LINKEDIN_POST_TYPE,
    payload: { text: text.trim(), citedFacts, draftId },
    proposedBy: proposer(proposedBy),
    causationId,
    correlationId: isNonEmptyString(correlationId) ? correlationId : crypto.randomUUID(),
    instanceConfig
  });
}
