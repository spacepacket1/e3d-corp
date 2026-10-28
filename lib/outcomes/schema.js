// Non-exhaustive per the spec ("covering (non-exhaustively): ..."), but this
// is the documented starter list. Each type IS the raw event `type` an
// Outcome is appended under - matching how Decisions use their own event
// types (`opportunity.reviewed`, `proposal.approved`) rather than a generic
// wrapper, and matching capability.shipped, which Phase 8 already emits
// exactly this way.
//
// One deliberate deviation from the spec's literal string list: the spec
// names an Outcome type "proposal.rejected" (an external party rejecting our
// proposal/quote), which is a literal event-type collision with Phase 5's
// Decision event type of the same name (e3d-corp/a human rejecting a
// Proposal object internally) - two genuinely different real-world facts
// that would become indistinguishable under `queryEvents({type:
// 'proposal.rejected'})`, directly undermining the spec's own "Decision vs
// Outcome are separate objects, evaluation metrics must not conflate them"
// requirement. Renamed to `outcome.proposal.rejected` to keep them
// distinguishable; every other listed type has no such collision and keeps
// its literal spec name.
export const OUTCOME_TYPES = [
  'prospect.replied',
  'meeting.booked',
  'proposal.accepted',
  'outcome.proposal.rejected',
  'deal.won',
  'deal.lost',
  'invoice.paid',
  'capability.shipped',
  'customer.adopted',
  'opportunity.no-value',
  'trade.executed',
  'trade.realized',
  // YouTube monitor: a measured before/after of a metadata change we applied. Neutral on purpose - it is a
  // measurement with caveats, not a business result, so it is NOT in evaluation/metrics POSITIVE_OUTCOME_TYPES.
  'youtube.metadata_change.measured',
  // Pilot growth: a post we published (x-post / linkedin-post). Neutral: a publication fact, not a business result.
  'social.post.published'
];
