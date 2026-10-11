// The full authority level enum (Shared Constraints in docs/build-e3d-corp.md).
// Levels 0-1 are autonomous and never generate a Proposal/Decision (Phase 4
// already implements this for Opportunity creation/scoring). Levels 2-4 always
// require an explicit, logged human Decision - no exceptions, no override.
export const AUTHORITY_LEVELS = Object.freeze({
  OBSERVE: 0,
  INTERNAL_WRITE: 1,
  EXTERNAL_ACTION: 2,
  FINANCIAL_ACTION: 3,
  IRREVERSIBLE_ACTION: 4
});

export const AUTHORITY_LEVEL_DESCRIPTIONS = Object.freeze({
  0: 'observe - read-only research/ingestion; fully autonomous',
  1: 'internal/reversible write - create/update an Opportunity, draft a Proposal, add an internal note; fully autonomous',
  2: 'external/reversible action - send outreach, hand off to e3d-pilot; approval and execution are the same call',
  3: 'financial/contractual action - issue an invoice, record a payment, sign anything; approval only, execution requires confirmAndExecute',
  4: 'irreversible/high-value action - mark a deal closed-won/closed-lost, public announcement; approval only, execution requires confirmAndExecute'
});

export const ACTION_POLICY_VERSION = 6;

// Versioned policy table: action `type` -> minimum required authority level.
// Every action-execution function (Phase 7 onward) must call
// assertProposalAuthorized against this table before doing anything with a
// side effect - this is the single source of truth for "how much authority
// does this action need," read at the call site itself, not just by the CLI
// or web UI. Only levels 2-4 appear here: levels 0-1 are autonomous writes
// that never go through a Proposal at all.
export const ACTION_POLICY = Object.freeze({
  'send-outreach': AUTHORITY_LEVELS.EXTERNAL_ACTION,
  'pilot-handoff': AUTHORITY_LEVELS.EXTERNAL_ACTION,
  capital_mandate: AUTHORITY_LEVELS.FINANCIAL_ACTION,
  'issue-invoice': AUTHORITY_LEVELS.FINANCIAL_ACTION,
  'flag-payment-request': AUTHORITY_LEVELS.FINANCIAL_ACTION,
  'mark-deal-closed': AUTHORITY_LEVELS.IRREVERSIBLE_ACTION,
  // Changes recurring ad spend/budget commitments - same level as
  // capital_mandate/issue-invoice. v4 adds this ahead of any executor:
  // today it only backs a retroactive ledger record (ops/backfill/), and
  // later a real Meta-write executor will sit behind this exact gate with
  // its own narrowly-scoped write token (lib/research/ga4.js and
  // lib/research/oppscanFeed.js are read-only evidence, not this).
  'meta-campaign-change': AUTHORITY_LEVELS.FINANCIAL_ACTION,
  // v5 adds this for the FutCo ad-outcome loop (docs/futco-ad-outcome-loop-manifesto.md
  // in e3d-pilot): commissioning a creative direction from e3d-creative directly,
  // skipping a Pilot handoff, for a routine variant of an existing campaign. Same
  // level as pilot-handoff - approval and execution are the same call - because
  // invoking another repo's engine is an external action, even though no money
  // moves and nothing is published yet. Launching the resulting creative as a real
  // ad/budget change is a separate, later action at meta-campaign-change's level.
  'commission-creative': AUTHORITY_LEVELS.EXTERNAL_ACTION,
  // v6 adds this for docs/futco-ad-mandate-spec.md (e3d-pilot): proposing and
  // activating an ad_mandate (spend ceilings, allowed products, pause
  // conditions) is itself a financial-adjacent decision, same level as
  // capital_mandate, even though activation in this phase only transitions
  // internal state and never spends anything (paper_only_creative is
  // hard-required true by the schema). Autonomous decisions *under* an
  // already-active mandate are a separate code path (autoDecideUnderMandate,
  // not yet built) that never re-uses this authority level directly - they
  // check the mandate's own state instead.
  ad_mandate: AUTHORITY_LEVELS.FINANCIAL_ACTION
});

export function getRequiredAuthorityLevel(actionType) {
  if (typeof actionType !== 'string' || actionType.trim() === '') {
    throw new Error('getRequiredAuthorityLevel requires a non-empty action type');
  }
  const level = ACTION_POLICY[actionType];
  if (level === undefined) {
    throw new Error(
      `No authority policy defined for action type "${actionType}" (policy v${ACTION_POLICY_VERSION}); refusing to treat it as autonomous`
    );
  }
  return level;
}

// The guard every action-execution function calls at its own call site, every
// time, with no override. Fails closed: unknown type, type/level mismatch, or
// a proposal that isn't `approved` all refuse to let the action proceed.
export function assertProposalAuthorized(proposal, actionType) {
  const requiredLevel = getRequiredAuthorityLevel(actionType);

  if (requiredLevel < AUTHORITY_LEVELS.EXTERNAL_ACTION) {
    throw new Error(
      `Action type "${actionType}" is authority level ${requiredLevel}; it does not require a Proposal/Decision and should never be gated here`
    );
  }

  if (!proposal || typeof proposal !== 'object') {
    throw new Error(`Action refused: no proposal provided for action type "${actionType}"`);
  }
  if (proposal.type !== actionType) {
    throw new Error(`Action refused: proposal ${proposal.id} is type "${proposal.type}", expected "${actionType}"`);
  }
  if (proposal.authorityLevel !== requiredLevel) {
    throw new Error(
      `Action refused: proposal ${proposal.id} has authorityLevel ${proposal.authorityLevel}, policy v${ACTION_POLICY_VERSION} requires ${requiredLevel} for "${actionType}"`
    );
  }
  if (proposal.status !== 'approved') {
    throw new Error(`Action refused: proposal ${proposal.id} is not approved (status: ${proposal.status})`);
  }

  return true;
}
