import { readAllEventRecords } from '../events/store.js';
import { resolveProvider } from '../llm/registry.js';
import { createProposal } from '../proposals/create.js';

const ROLE_NAME = 'risk.assess';
const ASSESSMENT_KEYS = ['verdict', 'reasoning', 'riskFactors', 'evidenceEventIds'];
const VALID_VERDICTS = new Set(['HOLD', 'APPROVE', 'CHECK']);
const REQUEST_EVENT_TYPE = 'payment-request.received';

function stripMarkdownFence(rawText) {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function toOccurredAtTime(event) {
  return new Date(event?.occurredAt).getTime();
}

function normalizeAllowedEvidenceIds(allowedEvidenceIds) {
  if (!(allowedEvidenceIds instanceof Set) && !Array.isArray(allowedEvidenceIds)) {
    throw new Error(`${ROLE_NAME} requires allowedEvidenceIds to be an array or Set`);
  }

  const normalized = new Set();
  for (const value of allowedEvidenceIds) {
    if (typeof value !== 'string') {
      throw new Error(`${ROLE_NAME} allowedEvidenceIds must contain only strings`);
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new Error(`${ROLE_NAME} allowedEvidenceIds must not contain blank ids`);
    }
    normalized.add(trimmed);
  }
  return normalized;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function buildSystemPrompt(companyName) {
  return [
    `You are the ${ROLE_NAME} role inside e3d-corp for ${companyName}.`,
    'You assess one inbound payment request using only the event evidence supplied to you.',
    'You can recommend HOLD, APPROVE, or CHECK, but you cannot approve, reject, confirm, execute, or mutate anything.',
    'APPROVE is only a recommendation for a human reviewer inside a pending proposal.',
    'Use CHECK when the evidence is insufficient, missing, ambiguous, or contradictory.',
    'Never invent facts, never infer evidence you were not given, and never cite an evidenceEventId that is not in the allowed list.',
    'Respond with ONLY a single JSON object matching exactly this shape:',
    '{"verdict":"HOLD"|"APPROVE"|"CHECK","reasoning":string,"riskFactors":string[],"evidenceEventIds":string[]}',
    'Return no prose and no markdown code fences.'
  ].join('\n');
}

function summarizePromptEvent(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    source: event.source,
    subject: event.subject,
    payload: event.payload,
    causationId: event.causationId ?? null,
    correlationId: event.correlationId
  };
}

function normalizeProviderName(providerConfig) {
  if (isNonEmptyString(providerConfig)) {
    return providerConfig.trim();
  }

  if (Array.isArray(providerConfig)) {
    const [first] = providerConfig;
    if (isNonEmptyString(first)) {
      return first.trim();
    }
  }

  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
}

function normalizeRequestPayload(requestEvent) {
  if (!requestEvent || typeof requestEvent !== 'object') {
    throw new Error(`${ROLE_NAME} requires requestEvent`);
  }
  if (!isNonEmptyString(requestEvent.id)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.id`);
  }
  if (requestEvent.type !== REQUEST_EVENT_TYPE) {
    throw new Error(`${ROLE_NAME} requires requestEvent.type to be "${REQUEST_EVENT_TYPE}"`);
  }
  if (!isNonEmptyString(requestEvent.correlationId)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.correlationId`);
  }

  const request = requestEvent.payload;
  if (!isPlainObject(request)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload to be an object`);
  }

  if (!isNonEmptyString(request.requestId)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.requestId`);
  }
  const vendorId = normalizeVendorId(request.vendorId);
  if (!vendorId) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.vendorId to be a non-empty string`);
  }
  if (!isNonEmptyString(request.vendorName)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.vendorName to be a non-empty string`);
  }
  if (typeof request.amount !== 'number' || !Number.isFinite(request.amount) || request.amount <= 0) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.amount to be a finite number greater than zero`);
  }
  if (!isNonEmptyString(request.currency)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.currency to be a non-empty string`);
  }
  if (!isNonEmptyString(request.description)) {
    throw new Error(`${ROLE_NAME} requires requestEvent.payload.description to be a non-empty string`);
  }

  const normalized = {
    requestId: request.requestId.trim(),
    vendorId,
    vendorName: request.vendorName.trim(),
    amount: request.amount,
    currency: request.currency.trim().toUpperCase(),
    description: request.description.trim()
  };

  if (request.dueDate !== undefined) {
    if (!isNonEmptyString(request.dueDate)) {
      throw new Error(`${ROLE_NAME} requires requestEvent.payload.dueDate to be a non-empty string when present`);
    }
    normalized.dueDate = request.dueDate;
  }

  if (request.reference !== undefined) {
    if (!isNonEmptyString(request.reference)) {
      throw new Error(`${ROLE_NAME} requires requestEvent.payload.reference to be a non-empty string when present`);
    }
    normalized.reference = request.reference.trim();
  }

  return normalized;
}

function buildPrompt({ requestEvent, priorEvents, allowedEvidenceEventIds, instanceConfig }) {
  return {
    systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'),
    userPrompt: JSON.stringify(
      {
        requestEvent: summarizePromptEvent(requestEvent),
        priorVendorEvents: priorEvents.map(summarizePromptEvent),
        allowedEvidenceEventIds
      },
      null,
      2
    )
  };
}

export function normalizeVendorId(vendorId) {
  return typeof vendorId === 'string' ? vendorId.trim().toLowerCase() : null;
}

export function selectVendorHistory(events, requestEvent) {
  if (!Array.isArray(events)) {
    throw new Error(`${ROLE_NAME} selectVendorHistory requires events to be an array`);
  }
  if (!requestEvent || typeof requestEvent !== 'object') {
    throw new Error(`${ROLE_NAME} selectVendorHistory requires requestEvent`);
  }

  const requestVendorId = normalizeVendorId(requestEvent.payload?.vendorId);
  if (!requestVendorId) {
    throw new Error(`${ROLE_NAME} requestEvent.payload.vendorId must be a non-empty string`);
  }

  const requestIndex = events.findIndex((event) => event?.id === requestEvent.id);
  if (requestIndex === -1) {
    throw new Error(`${ROLE_NAME} selectVendorHistory requires requestEvent to be present in events`);
  }

  const requestTime = toOccurredAtTime(requestEvent);
  const matches = [];

  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return;
    if (event.id === requestEvent.id) return;

    const eventTime = toOccurredAtTime(event);
    const predatesRequest = eventTime < requestTime || (eventTime === requestTime && index < requestIndex);
    if (!predatesRequest) return;

    const subjectVendorId = normalizeVendorId(event.subject?.id);
    const payloadVendorId = typeof event.payload?.vendorId === 'string' ? normalizeVendorId(event.payload.vendorId) : null;
    if (subjectVendorId !== requestVendorId && payloadVendorId !== requestVendorId) return;

    matches.push({ event, index, eventTime });
  });

  matches.sort((left, right) => {
    if (left.eventTime !== right.eventTime) {
      return right.eventTime - left.eventTime;
    }
    return right.index - left.index;
  });

  return matches.slice(0, 20).map(({ event }) => event);
}

export function parseAssessmentJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error(`${ROLE_NAME} returned empty output`);
  }

  const stripped = stripMarkdownFence(rawText);
  if (stripped === '') {
    throw new Error(`${ROLE_NAME} returned empty output`);
  }

  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(`${ROLE_NAME} returned invalid JSON: ${error.message}`);
  }
}

export function normalizeAssessment(parsed, allowedEvidenceIds) {
  if (!isPlainObject(parsed)) {
    throw new Error(`${ROLE_NAME} assessment must be a plain object`);
  }

  const keys = Object.keys(parsed);
  const missingKeys = ASSESSMENT_KEYS.filter((key) => !Object.hasOwn(parsed, key));
  const extraKeys = keys.filter((key) => !ASSESSMENT_KEYS.includes(key));
  if (missingKeys.length > 0 || extraKeys.length > 0 || keys.length !== ASSESSMENT_KEYS.length) {
    throw new Error(
      `${ROLE_NAME} assessment must contain exactly these keys: ${ASSESSMENT_KEYS.join(', ')}`
    );
  }

  if (!VALID_VERDICTS.has(parsed.verdict)) {
    throw new Error(`${ROLE_NAME} assessment verdict must be one of HOLD, APPROVE, CHECK`);
  }

  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim() === '') {
    throw new Error(`${ROLE_NAME} assessment reasoning must be a non-empty string`);
  }
  const reasoning = parsed.reasoning.trim();

  if (!Array.isArray(parsed.riskFactors)) {
    throw new Error(`${ROLE_NAME} assessment riskFactors must be an array of non-empty strings`);
  }
  const riskFactors = parsed.riskFactors.map((factor) => {
    if (typeof factor !== 'string') {
      throw new Error(`${ROLE_NAME} assessment riskFactors must be an array of non-empty strings`);
    }
    const trimmed = factor.trim();
    if (trimmed === '') {
      throw new Error(`${ROLE_NAME} assessment riskFactors must not contain blank strings`);
    }
    return trimmed;
  });

  if (!Array.isArray(parsed.evidenceEventIds)) {
    throw new Error(`${ROLE_NAME} assessment evidenceEventIds must be an array`);
  }

  const allowedSet = normalizeAllowedEvidenceIds(allowedEvidenceIds);
  const seenEvidenceIds = new Set();
  const evidenceEventIds = parsed.evidenceEventIds.map((id) => {
    if (typeof id !== 'string') {
      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must contain only strings`);
    }
    const trimmed = id.trim();
    if (trimmed === '') {
      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must not contain blank ids`);
    }
    if (seenEvidenceIds.has(trimmed)) {
      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must not contain duplicates`);
    }
    if (!allowedSet.has(trimmed)) {
      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must only cite supplied event ids`);
    }
    seenEvidenceIds.add(trimmed);
    return trimmed;
  });

  return {
    verdict: parsed.verdict,
    reasoning,
    riskFactors,
    evidenceEventIds
  };
}

export async function runRiskAssess({ dataDir, instanceConfig, requestEvent, llmClient } = {}) {
  if (!dataDir) {
    throw new Error('runRiskAssess requires a dataDir');
  }

  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
  const { model, call } = resolveProvider(instanceConfig, provider);

  if (llmClient !== undefined && typeof llmClient !== 'function') {
    throw new Error('runRiskAssess requires llmClient to be a function when provided');
  }

  const normalizedRequest = normalizeRequestPayload(requestEvent);
  const events = readAllEventRecords(dataDir);
  const priorEvents = selectVendorHistory(events, requestEvent);
  const allowedEvidenceEventIds = [requestEvent.id, ...priorEvents.map((event) => event.id)];
  const { systemPrompt, userPrompt } = buildPrompt({
    requestEvent,
    priorEvents,
    allowedEvidenceEventIds,
    instanceConfig
  });

  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
  const assessment = normalizeAssessment(parseAssessmentJson(response?.text), allowedEvidenceEventIds);
  const created = createProposal(dataDir, {
    type: 'flag-payment-request',
    payload: {
      requestEventId: requestEvent.id,
      request: normalizedRequest,
      assessment
    },
    proposedBy: { role: ROLE_NAME, provider, model },
    causationId: requestEvent.id,
    correlationId: requestEvent.correlationId,
    instanceConfig
  });

  return {
    assessment,
    proposal: created.proposal,
    event: created.event
  };
}
