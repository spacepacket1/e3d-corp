import { queryEvents } from '../events/store.js';
import { listOpportunities } from '../opportunities/store.js';
import { runCreativeBrief } from './creativeBrief.js';

function alreadyDraftedOpportunityIds(dataDir) {
  const drafted = queryEvents(dataDir, { type: 'creative-brief.drafted' });
  return new Set(drafted.map((event) => event.payload?.opportunityId).filter(Boolean));
}

// Closes the trigger gap upstream of everything else in
// docs/futco-ad-mandate-spec.md's Phase 2: lib/roles/creativeBrief.js's
// runCreativeBrief is itself fully autonomous (authority level 0/1, never a
// Proposal), but until this scan existed, nothing ever called it except a
// human running `opportunities draft-creative-brief <id>` one opportunity at
// a time. Mirrors pursueCommand's existing shape in lib/cli.js (lib/cli.js's
// `pursue`): scan every "pursuing" opportunity, skip ones already handled,
// and keep going past a single opportunity's failure (a provider hiccup, an
// opportunity with no chain yet) rather than aborting the whole pass -
// exactly the resilience discipline pursueCommand already established for
// the outreach-drafting side of this same loop.
export async function autoDraftCreativeBriefs(dataDir, { instanceConfig, llmClient } = {}) {
  const pursuing = listOpportunities(dataDir, { status: 'pursuing' });
  const alreadyDrafted = alreadyDraftedOpportunityIds(dataDir);

  const results = [];
  for (const opportunity of pursuing) {
    if (alreadyDrafted.has(opportunity.id)) {
      results.push({ opportunityId: opportunity.id, status: 'already-drafted' });
      continue;
    }
    try {
      const { event } = await runCreativeBrief({ instanceConfig, dataDir, opportunity, llmClient });
      results.push({ opportunityId: opportunity.id, status: 'drafted', eventId: event.id });
    } catch (error) {
      results.push({ opportunityId: opportunity.id, status: 'error', reason: error.message });
    }
  }
  return results;
}
