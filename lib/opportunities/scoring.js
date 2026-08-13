// Deterministic scoring — not a second LLM call. Combines the role's own
// confidence with configurable weights into one sortable score.value.
//
// score.value = (confidenceWeight * confidence
//              + evidenceWeight   * min(evidenceCount / evidenceSaturation, 1)
//              + recencyWeight    * recencyFactor(occurredAt))
//              * typeMultiplier
//
// recencyFactor decays linearly from 1.0 (right now) to 0.0 at recencyHorizonDays,
// so a fresher trigger event scores higher than a stale one, all else equal.
// typeMultiplier comes from instance config's `scoring.typeWeights[type]` (default 1),
// letting an instance emphasize/de-emphasize whole opportunity types without
// touching this function.

const DEFAULT_WEIGHTS = {
  confidence: 0.6,
  evidenceCount: 0.25,
  recency: 0.15
};

const EVIDENCE_SATURATION_COUNT = 5;
const RECENCY_HORIZON_DAYS = 30;

function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function recencyFactor(occurredAt, now = Date.now()) {
  const occurredAtMs = new Date(occurredAt).getTime();
  if (Number.isNaN(occurredAtMs)) return 0;

  const ageDays = Math.max(0, (now - occurredAtMs) / (1000 * 60 * 60 * 24));
  return clamp01(1 - ageDays / RECENCY_HORIZON_DAYS);
}

export function scoreOpportunity({
  confidence,
  evidenceCount,
  triggerOccurredAt,
  type,
  weights = {},
  typeWeights = {},
  now = Date.now()
}) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
    throw new Error('scoreOpportunity requires a numeric confidence');
  }

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const confidenceScore = clamp01(confidence);
  const evidenceScore = clamp01((evidenceCount ?? 0) / EVIDENCE_SATURATION_COUNT);
  const recency = recencyFactor(triggerOccurredAt, now);
  const typeMultiplier = typeWeights[type] ?? 1;

  const weighted =
    w.confidence * confidenceScore + w.evidenceCount * evidenceScore + w.recency * recency;
  const value = Math.round(weighted * typeMultiplier * 1000) / 1000;

  const rationale =
    `confidence=${confidenceScore.toFixed(2)} (w=${w.confidence}) + ` +
    `evidence=${evidenceCount ?? 0} items→${evidenceScore.toFixed(2)} (w=${w.evidenceCount}) + ` +
    `recency=${recency.toFixed(2)} (w=${w.recency}), type "${type}" multiplier=${typeMultiplier}`;

  return { value, rationale };
}

export { DEFAULT_WEIGHTS, EVIDENCE_SATURATION_COUNT, RECENCY_HORIZON_DAYS };
