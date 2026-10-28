export const PILOT_NUDGE_PROPOSAL_TYPE = 'pilot-retention-nudge';
export const NUDGE_COHORTS = Object.freeze(['outOfCredits', 'nearAllowance', 'paymentFailed', 'starterExpiringSoon']);
export const NUDGE_LIMITS = Object.freeze({ subject: 100, body: 1500 });

const isString = (v) => typeof v === 'string';
// A retention nudge is a head-count and words. Nothing that identifies a person may ride along in a payload.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const ALLOWED_URL_HOSTS = new Set(['pilot.e3d.ai']);

export function addressProblem(text) {
  if (!isString(text)) return null;
  if (EMAIL.test(text)) return 'contains an email address';
  for (const url of text.match(/https?:\/\/[^\s)>\]]+/g) ?? []) {
    let host = null;
    try { host = new URL(url).hostname; } catch { /* a malformed URL is refused below */ }
    if (!ALLOWED_URL_HOSTS.has(host)) return `contains a link outside ${[...ALLOWED_URL_HOSTS].join(', ')}`;
  }
  return null;
}

// Validates and normalizes a pilot-retention-nudge payload: cohort name, count and drafted copy only. Throws listing
// every problem. Unknown fields are refused so an address (or anything else) cannot be smuggled in beside the copy.
export function normalizePilotNudgePayload(payload) {
  const errors = [];
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const allowed = ['cohort', 'count', 'copy', 'opportunityId', 'sampleEventId', 'rationale'];
  const unknown = Object.keys(p).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unsupported field(s): ${unknown.join(', ')} (a nudge carries a cohort, count and copy only)`);
  if (!NUDGE_COHORTS.includes(p.cohort)) errors.push(`cohort: must be one of ${NUDGE_COHORTS.join(', ')}`);
  if (!Number.isInteger(p.count) || p.count < 1) errors.push('count: must be an integer >= 1');
  const copy = p.copy;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) errors.push('copy: required object { subject, body }');
  else {
    const extra = Object.keys(copy).filter((k) => !['subject', 'body'].includes(k));
    if (extra.length) errors.push(`copy: unsupported field(s) ${extra.join(', ')}`);
    if (!isString(copy.subject) || copy.subject.trim() === '') errors.push('copy.subject: required');
    else if (copy.subject.length > NUDGE_LIMITS.subject) errors.push(`copy.subject: over ${NUDGE_LIMITS.subject} characters`);
    if (!isString(copy.body) || copy.body.trim() === '') errors.push('copy.body: required');
    else if (copy.body.length > NUDGE_LIMITS.body) errors.push(`copy.body: over ${NUDGE_LIMITS.body} characters`);
    for (const key of ['subject', 'body']) {
      const problem = addressProblem(copy[key]);
      if (problem) errors.push(`copy.${key}: ${problem}`);
    }
  }
  for (const key of ['opportunityId', 'sampleEventId', 'rationale']) {
    if (p[key] !== undefined && p[key] !== null && !isString(p[key])) errors.push(`${key}: must be a string or null`);
    else if (addressProblem(p[key])) errors.push(`${key}: ${addressProblem(p[key])}`);
  }
  if (errors.length) throw new Error(`Invalid pilot-retention-nudge payload:\n- ${errors.join('\n- ')}`);
  return {
    cohort: p.cohort,
    count: p.count,
    copy: { subject: copy.subject.trim(), body: copy.body.trim() },
    opportunityId: p.opportunityId ?? null,
    sampleEventId: p.sampleEventId ?? null,
    rationale: p.rationale ?? null
  };
}
