import { queryEvents } from '../events/store.js';
import { listOpportunities } from '../opportunities/store.js';
import { listLatestExperience } from '../experience/store.js';
import { computeBudgetStatus, listBudgetProviders } from '../llm/budget.js';

// Outcome types that count as "the chain produced something worth having"
// for cost-per-useful-opportunity - a documented judgment call, not
// specified verbatim by the spec. Excludes the negative/neutral outcomes
// (outcome.proposal.rejected, deal.lost, opportunity.no-value).
export const POSITIVE_OUTCOME_TYPES = [
  'meeting.booked',
  'proposal.accepted',
  'deal.won',
  'invoice.paid',
  'customer.adopted',
  'capability.shipped'
];

function afterSince(occurredAt, since) {
  if (!since || !occurredAt) return true;
  return new Date(occurredAt).getTime() >= new Date(since).getTime();
}

// Discovery/acceptance/rejection counts are computed directly from
// events.jsonl (via the same fold functions Opportunities/Proposals already
// use), not from experience.jsonl. The spec's prose reads as if every metric
// here comes "from experience.jsonl," but experience.jsonl only holds
// *meaningfully-completed* chains (Phase 9's own definition - one that
// reached a Decision or Outcome) - gating raw discovery/acceptance counts
// behind that would silently undercount every opportunity that hasn't
// reached an outcome yet, which is most of them at this stage. experience.
// jsonl is used below specifically where "per completed chain" is the
// correct unit (cost/latency by role+model, cost-per-useful-opportunity) -
// exactly the metrics that need a fully assembled chain, not just counts.
function computeOpportunitiesDiscovered(dataDir, since) {
  const opportunities = listOpportunities(dataDir).filter((o) => afterSince(o.createdAt, since));
  const byType = {};
  for (const opportunity of opportunities) {
    byType[opportunity.type] = (byType[opportunity.type] ?? 0) + 1;
  }
  return { total: opportunities.length, byType };
}

function computeOpportunityAcceptance(dataDir, since) {
  const reviewed = queryEvents(dataDir, { type: 'opportunity.reviewed' }).filter((event) => afterSince(event.occurredAt, since));
  const pursuing = reviewed.filter((event) => event.payload?.decision === 'pursuing').length;
  const noValue = reviewed.filter((event) => event.payload?.decision === 'no-value').length;
  const denominator = pursuing + noValue;
  return { pursuing, noValue, rate: denominator > 0 ? pursuing / denominator : null };
}

// "human override/rejection rate": among Proposal Decisions (Phase 5), how
// often a human rejected rather than approved.
function computeProposalRejection(dataDir, since) {
  const approved = queryEvents(dataDir, { type: 'proposal.approved' }).filter((event) => afterSince(event.occurredAt, since)).length;
  const rejected = queryEvents(dataDir, { type: 'proposal.rejected' }).filter((event) => afterSince(event.occurredAt, since)).length;
  const denominator = approved + rejected;
  return { approved, rejected, rate: denominator > 0 ? rejected / denominator : null };
}

function correlationIdsWithOutcome(dataDir, type, since) {
  return new Set(
    queryEvents(dataDir, { type })
      .filter((event) => afterSince(event.occurredAt, since))
      .map((event) => event.correlationId)
  );
}

// A funnel over every real outreach.sent action (Phase 7), not experience.
// jsonl, for the same "don't undercount chains without an outcome yet"
// reason as discovery/acceptance above.
function computeOutreachFunnel(dataDir, since) {
  const sentCorrelationIds = [
    ...new Set(
      queryEvents(dataDir, { type: 'outreach.sent' })
        .filter((event) => afterSince(event.occurredAt, since))
        .map((event) => event.correlationId)
    )
  ];
  const repliedIds = correlationIdsWithOutcome(dataDir, 'prospect.replied', since);
  const meetingIds = correlationIdsWithOutcome(dataDir, 'meeting.booked', since);
  const wonIds = correlationIdsWithOutcome(dataDir, 'deal.won', since);

  const sent = sentCorrelationIds.length;
  const replied = sentCorrelationIds.filter((id) => repliedIds.has(id)).length;
  const meetingsBooked = sentCorrelationIds.filter((id) => meetingIds.has(id)).length;
  const dealsWon = sentCorrelationIds.filter((id) => wonIds.has(id)).length;

  return {
    sent,
    replied,
    responseRate: sent > 0 ? replied / sent : null,
    meetingsBooked,
    meetingBookedRate: sent > 0 ? meetingsBooked / sent : null,
    dealsWon,
    dealWinRate: sent > 0 ? dealsWon / sent : null
  };
}

function computeRevenueAttributable(dataDir, since) {
  const paidEvents = queryEvents(dataDir, { type: 'invoice.paid' }).filter((event) => afterSince(event.occurredAt, since));
  let total = 0;
  for (const event of paidEvents) {
    const amount = event.payload?.amount;
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      total += amount;
    }
  }
  return total;
}

// costEstimate is always null today (Phase 9: no LLM call in this codebase
// records token usage/cost yet), so this is honestly null until that
// instrumentation exists - never a fabricated number.
function computeCostPerUsefulOpportunity(experiences) {
  const useful = experiences.filter((experience) => experience.outcome && POSITIVE_OUTCOME_TYPES.includes(experience.outcome.type));
  const costs = useful.map((experience) => experience.costEstimate).filter((cost) => typeof cost === 'number');
  return {
    usefulOpportunityCount: useful.length,
    costPerUsefulOpportunity: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / useful.length : null
  };
}

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeProviderSpendByCorrelationId(dataDir, since) {
  const events = [
    ...queryEvents(dataDir, { type: 'role.provider.completed' }),
    ...queryEvents(dataDir, { type: 'role.provider.failed' })
  ].filter((event) => afterSince(event.occurredAt, since));

  const totals = {};
  for (const event of events) {
    if (!event.correlationId) {
      continue;
    }
    const costUsd = event.payload?.costUsd;
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) {
      continue;
    }
    totals[event.correlationId] = (totals[event.correlationId] ?? 0) + costUsd;
  }
  return totals;
}

function computeLatencyAndCostByRoleModel(dataDir, since) {
  const events = [
    ...queryEvents(dataDir, { type: 'role.provider.completed' }),
    ...queryEvents(dataDir, { type: 'role.provider.failed' })
  ].filter((event) => afterSince(event.occurredAt, since));

  const latencyBuckets = {};
  const costBuckets = {};
  for (const event of events) {
    const key = `${event.payload?.role ?? 'unknown'}:${event.payload?.provider ?? 'unknown'}:${event.payload?.model ?? 'unknown'}`;
    if (typeof event.payload?.latencyMs === 'number') {
      (latencyBuckets[key] ??= []).push(event.payload.latencyMs);
    }
    if (typeof event.payload?.costUsd === 'number') {
      (costBuckets[key] ??= []).push(event.payload.costUsd);
    }
  }
  return {
    latencyByRoleModel: Object.fromEntries(Object.entries(latencyBuckets).map(([key, values]) => [key, average(values)])),
    costByRoleModel: Object.fromEntries(Object.entries(costBuckets).map(([key, values]) => [key, average(values)]))
  };
}

// Explicitly does not compute or expose any "training readiness" signal -
// out of scope for this phase (spec Non-Goals), left for the future
// fine-tuning ticket once there is real Experience data to justify it.
export function computeMetrics(dataDir, { since, instanceConfig } = {}) {
  const experiences = listLatestExperience(dataDir).filter((experience) => afterSince(experience.originatingEvent?.occurredAt, since));
  const costByCorrelationId = computeProviderSpendByCorrelationId(dataDir, since);
  const useful = experiences.filter((experience) => experience.outcome && POSITIVE_OUTCOME_TYPES.includes(experience.outcome.type));
  const usefulCosts = useful
    .map((experience) => costByCorrelationId[experience.correlationId])
    .filter((cost) => typeof cost === 'number');
  const usefulOpportunityCount = useful.length;
  const costPerUsefulOpportunity =
    usefulCosts.length === usefulOpportunityCount && usefulOpportunityCount > 0
      ? usefulCosts.reduce((a, b) => a + b, 0) / usefulOpportunityCount
      : null;
  const { latencyByRoleModel, costByRoleModel } = computeLatencyAndCostByRoleModel(dataDir, since);
  const budget = listBudgetProviders(instanceConfig).map((providerName) =>
    computeBudgetStatus(dataDir, instanceConfig, providerName)
  );

  return {
    since: since ?? null,
    opportunitiesDiscovered: computeOpportunitiesDiscovered(dataDir, since),
    opportunityAcceptance: computeOpportunityAcceptance(dataDir, since),
    proposalRejection: computeProposalRejection(dataDir, since),
    outreach: computeOutreachFunnel(dataDir, since),
    revenueAttributable: computeRevenueAttributable(dataDir, since),
    usefulOpportunityCount,
    costPerUsefulOpportunity,
    latencyByRoleModel,
    costByRoleModel,
    budget
  };
}

function formatRate(rate) {
  return rate === null ? 'n/a (no data)' : `${(rate * 100).toFixed(1)}%`;
}

export function formatMetricsReport(metrics) {
  const lines = [];
  lines.push(`Evaluation report${metrics.since ? ` (since ${metrics.since})` : ''}`);
  lines.push('');
  lines.push(`Opportunities discovered: ${metrics.opportunitiesDiscovered.total}`);
  for (const [type, count] of Object.entries(metrics.opportunitiesDiscovered.byType)) {
    lines.push(`  ${type}: ${count}`);
  }
  lines.push('');
  lines.push(
    `Opportunity acceptance: pursuing=${metrics.opportunityAcceptance.pursuing} no-value=${metrics.opportunityAcceptance.noValue} rate=${formatRate(metrics.opportunityAcceptance.rate)}`
  );
  lines.push(
    `Proposal rejection: approved=${metrics.proposalRejection.approved} rejected=${metrics.proposalRejection.rejected} rate=${formatRate(metrics.proposalRejection.rate)}`
  );
  lines.push('');
  lines.push(
    `Outreach funnel: sent=${metrics.outreach.sent} replied=${metrics.outreach.replied} (${formatRate(metrics.outreach.responseRate)}) ` +
      `meetingsBooked=${metrics.outreach.meetingsBooked} (${formatRate(metrics.outreach.meetingBookedRate)}) ` +
      `dealsWon=${metrics.outreach.dealsWon} (${formatRate(metrics.outreach.dealWinRate)})`
  );
  lines.push('');
  lines.push(`Revenue attributable: ${metrics.revenueAttributable}`);
  lines.push(`Useful opportunities: ${metrics.usefulOpportunityCount}`);
  lines.push(
    `Cost per useful opportunity: ${metrics.costPerUsefulOpportunity === null ? 'n/a (no cost data recorded yet)' : metrics.costPerUsefulOpportunity}`
  );
  lines.push('');
  lines.push('Budget status:');
  if (!metrics.budget || metrics.budget.length === 0) {
    lines.push('  (no provider budgets configured)');
  } else {
    for (const status of metrics.budget) {
      if (status.unlimited) {
        lines.push(`  ${status.provider}: unlimited`);
      } else {
        lines.push(
          `  ${status.provider}: spent=${status.settled} allocated=${status.limit} outstanding=${status.outstanding} remaining=${status.remaining}`
        );
      }
    }
  }
  lines.push('');
  lines.push('Latency by role/model:');
  const latencyEntries = Object.entries(metrics.latencyByRoleModel);
  if (latencyEntries.length === 0) {
    lines.push('  (no data)');
  } else {
    for (const [key, ms] of latencyEntries) lines.push(`  ${key}: ${Math.round(ms)}ms avg`);
  }
  lines.push('Cost by role/model:');
  const costEntries = Object.entries(metrics.costByRoleModel);
  if (costEntries.length === 0) {
    lines.push('  (no cost data recorded yet)');
  } else {
    for (const [key, cost] of costEntries) lines.push(`  ${key}: ${cost}`);
  }
  return lines.join('\n');
}
