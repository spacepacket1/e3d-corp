import crypto from 'node:crypto';
import { createProposal } from './create.js';

export const PILOT_AD_CAMPAIGN_TYPE = 'pilot-ad-campaign';
export const DEFAULT_MONTHLY_CEILING_USD = 300;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Validates a pilot-ad-campaign payload: budget ceiling, per-day cap and an
// explicit kill rule are mandatory. Returns { valid, errors }.
export function validatePilotAdCampaign(payload, { monthlyCeilingUsd = DEFAULT_MONTHLY_CEILING_USD } = {}) {
  const errors = [];
  const budget = payload?.budget;
  if (!budget || typeof budget !== 'object') {
    errors.push('budget: required');
  } else {
    if (!isPositiveNumber(budget.monthlyCeilingUsd)) errors.push('budget.monthlyCeilingUsd: must be a positive number');
    else if (budget.monthlyCeilingUsd > monthlyCeilingUsd) errors.push(`budget.monthlyCeilingUsd: ${budget.monthlyCeilingUsd} exceeds the allowed ceiling ${monthlyCeilingUsd}`);
    if (!isPositiveNumber(budget.dailyCapUsd)) errors.push('budget.dailyCapUsd: must be a positive number');
    else if (isPositiveNumber(budget.monthlyCeilingUsd) && budget.dailyCapUsd * 20 > budget.monthlyCeilingUsd) {
      errors.push('budget.dailyCapUsd: more than monthlyCeilingUsd / 20 (a full month at this rate would breach the ceiling)');
    }
  }
  const kill = payload?.killRule;
  if (!kill || typeof kill !== 'object') {
    errors.push('killRule: required');
  } else {
    if (!isPositiveNumber(kill.pauseIfCpaUsdAbove)) errors.push('killRule.pauseIfCpaUsdAbove: must be a positive number');
    if (!isPositiveNumber(kill.pauseIfZeroSignupsAfterSpendUsd)) errors.push('killRule.pauseIfZeroSignupsAfterSpendUsd: must be a positive number');
    else if (isPositiveNumber(budget?.monthlyCeilingUsd) && kill.pauseIfZeroSignupsAfterSpendUsd > budget.monthlyCeilingUsd / 2) {
      errors.push('killRule.pauseIfZeroSignupsAfterSpendUsd: more than half the monthly ceiling');
    }
  }
  if (!Array.isArray(payload?.variants) || payload.variants.length === 0) errors.push('variants: at least one copy variant required');
  if (!payload?.audience || typeof payload.audience !== 'object') errors.push('audience: required');
  return { valid: errors.length === 0, errors };
}

export function proposePilotAdCampaign(dataDir, { variants, audience, budget, killRule, rationale = '', notes = '', proposedBy, causationId = null, correlationId, instanceConfig } = {}) {
  const maxCeiling = instanceConfig?.pilotGrowth?.adMonthlyCeilingUsd ?? DEFAULT_MONTHLY_CEILING_USD;
  const payload = {
    channel: 'meta',
    product: 'pilot.e3d.ai',
    variants,
    audience,
    budget,
    killRule,
    rationale: isNonEmptyString(rationale) ? rationale.trim() : '',
    notes: isNonEmptyString(notes) ? notes.trim() : '',
    launch: 'manual: approving this records the decision only; nothing is spent or launched automatically'
  };
  const { valid, errors } = validatePilotAdCampaign(payload, { monthlyCeilingUsd: maxCeiling });
  if (!valid) throw new Error(`Invalid pilot-ad-campaign:\n- ${errors.join('\n- ')}`);
  return createProposal(dataDir, {
    type: PILOT_AD_CAMPAIGN_TYPE,
    payload,
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId,
    correlationId: isNonEmptyString(correlationId) ? correlationId : crypto.randomUUID(),
    instanceConfig
  });
}
