// Publishes an anchor by emailing it. The mailbox and the mail provider's
// own logs are both outside this machine's reach, so an anchor sent last
// week survives any later rewrite of events.jsonl - which is the whole
// property being bought. Reuses Phase 7's SES transport rather than opening
// a second path to the same provider.

import { sendEmailViaSes } from '../outreach/sesTransport.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function resolveAnchorRecipient(instanceConfig) {
  const anchor = instanceConfig?.anchor;
  if (!anchor || anchor.provider !== 'email') {
    throw new Error('Instance config has no anchor.provider "email" configured; refusing to publish an anchor');
  }
  if (!isNonEmptyString(anchor.toEmailEnvVar)) {
    throw new Error('Instance config is missing anchor.toEmailEnvVar');
  }
  const to = process.env[anchor.toEmailEnvVar];
  if (!isNonEmptyString(to)) {
    throw new Error(`Env var "${anchor.toEmailEnvVar}" (anchor.toEmailEnvVar) is not set`);
  }
  return to;
}

// Deliberately plain text and self-describing: the value of an anchor is that
// someone can act on it years later, possibly without this repository in
// front of them, so the mail states what the numbers mean and how to check
// them rather than assuming context.
export function buildAnchorBody({ instanceName, head, count, publishedAt }) {
  return [
    `e3d-corp event log anchor — instance "${instanceName}"`,
    '',
    `  chain head : ${head}`,
    `  records    : ${count}`,
    `  published  : ${publishedAt}`,
    '',
    'Keep this message. It is a fixed point for the append-only event log:',
    `the hash above commits to the first ${count} records of that log,`,
    'and nothing in it identifies a client, a deal, or an amount.',
    '',
    'To check the log against this anchor later:',
    '',
    `  node bin/e3d-corp event verify --instance ${instanceName} \\`,
    `    --head ${head} --count ${count}`,
    '',
    `That recomputes the head over the first ${count} records and compares it to`,
    'the value above. A mismatch means history at or before that point was',
    `rewritten; a log now shorter than ${count} records means the end was cut off.`,
    '',
    'Run it from this message rather than from the anchors stored in the log.',
    'Anything that rewrote the log could have rewritten those too, and cutting',
    'the tail removes them outright — this copy is the one that survives, which',
    'is the entire reason it was sent.'
  ].join('\n');
}

export function createEmailAnchorTransport(instanceConfig) {
  const to = resolveAnchorRecipient(instanceConfig);

  return {
    name: 'email',
    destination: to,
    async send({ head, count, publishedAt }) {
      const instanceName = instanceConfig?.name ?? 'unknown';
      const result = await sendEmailViaSes({
        instanceConfig,
        to,
        subject: `e3d-corp anchor — ${instanceName} — ${count} records — ${head.slice(0, 12)}`,
        body: buildAnchorBody({ instanceName, head, count, publishedAt })
      });
      return { transport: 'email', to, messageId: result.messageId };
    }
  };
}
