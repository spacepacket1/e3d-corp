// Thin client for TypeSafe's System One API ("Jev"): typed Choice/Score/Noul
// judgments over structured state, not chat completion. Mirrors
// e3d-pilot's lib/providers/jev.sh / lib/ideas/jev_dedup.sh - same vendor,
// same Choice-over-the-existing-ledger pattern, ported to this instance's
// Opportunity ledger instead of e3d-pilot's idea ledger (the two never
// shared an implementation; this is the opportunity-side counterpart).
//
// That sibling stays advisory-only (attaches a note, never blocks) because
// a false-positive dedup skip on an idea could silently lose a genuinely
// new one forever. The harm is asymmetric the other way here: an
// Opportunity skipped by mistake is still sitting in the backlog from
// whenever Jev thinks it duplicates - nothing is lost, discovery just
// didn't mint a second near-identical record today. So this one actually
// skips creation on a match, logging why (opportunity.dedup_skipped in
// lib/opportunities/engine.js), rather than just annotating it.

const JEV_API_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
// Choice supports at most 255 options; stay well short so "none" and
// whatever's added mid-list never risk the API's own ceiling.
const MAX_CRITERIA = 200;

export function jevAvailable() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

async function callJev({ state, questions }) {
  const response = await fetch(JEV_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ state, model: JEV_MODEL, questions })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jev request failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

function buildCriteria(existingOpportunities) {
  const criteria = {
    none: 'This candidate does not duplicate any opportunity listed above - it describes a genuinely different gap, lead, or finding.'
  };
  for (const opportunity of existingOpportunities.slice(0, MAX_CRITERIA)) {
    criteria[opportunity.id] = `title: ${opportunity.title} -- description: ${opportunity.description ?? ''}`;
  }
  return criteria;
}

// Best-effort: any failure (no key, nothing to compare against, network
// error, malformed response) returns isDuplicate:false - the caller treats
// that identically to "proceed as if this check didn't exist," same
// opt-in-by-credential convention as the ideas-ledger sibling.
export async function checkOpportunityDuplicate({ candidateTitle, candidateDescription, existingOpportunities }) {
  if (!jevAvailable()) {
    return { checked: false, isDuplicate: false, reason: 'TYPESAFE_API_KEY not set' };
  }
  if (!Array.isArray(existingOpportunities) || existingOpportunities.length === 0) {
    return { checked: false, isDuplicate: false, reason: 'no existing opportunities to compare against' };
  }

  const state = { candidate_title: candidateTitle ?? '', candidate_description: candidateDescription ?? '' };
  const questions = {
    duplicate_match: {
      type: 'choice',
      instructions:
        'The state is a newly proposed business Opportunity (candidate_title, candidate_description). Which existing opportunity below, if any, describes the same underlying lead, gap, or finding, even if worded differently? Pick "none" if the candidate is genuinely distinct from all of them.',
      criteria: buildCriteria(existingOpportunities)
    }
  };

  try {
    const response = await callJev({ state, questions });
    const match = response?.answers?.duplicate_match?.choice ?? 'none';
    if (!match || match === 'none') {
      return { checked: true, isDuplicate: false };
    }
    const confidence = response?.answers?.duplicate_match?.confidence ?? 'unknown';
    return { checked: true, isDuplicate: true, matchedOpportunityId: match, confidence };
  } catch (error) {
    return { checked: false, isDuplicate: false, reason: `Jev call failed: ${error.message}` };
  }
}
