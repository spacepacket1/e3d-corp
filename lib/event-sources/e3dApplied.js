import crypto from 'node:crypto';
import { appendEvent } from '../events/store.js';

export function recordLeadReceived(
  dataDir,
  submission,
  { causationId = null, correlationId = crypto.randomUUID() } = {}
) {
  if (submission === null || typeof submission !== 'object' || Array.isArray(submission)) {
    throw new Error('Lead submission must be an object');
  }

  const leadId =
    typeof submission.email === 'string' && submission.email.trim() !== ''
      ? submission.email.trim().toLowerCase()
      : crypto.randomUUID();

  return appendEvent(dataDir, {
    type: 'lead.received',
    source: 'e3d-applied.contact-delivery',
    subject: {
      type: 'lead',
      id: leadId
    },
    payload: {
      source: 'e3d-applied',
      mechanism: 'contact-form-delivery',
      submission: {
        name: submission.name ?? '',
        email: submission.email ?? '',
        company: submission.company ?? '',
        role: submission.role ?? '',
        companySize: submission.companySize ?? '',
        workflowProblem: submission.workflowProblem ?? '',
        triedAi: submission.triedAi ?? '',
        preferredNextStep: submission.preferredNextStep ?? '',
        phone: submission.phone ?? '',
        referralSource: submission.referralSource ?? '',
        consent: Boolean(submission.consent),
        submittedAt: submission.submittedAt ?? new Date().toISOString()
      }
    },
    causationId,
    correlationId
  });
}
