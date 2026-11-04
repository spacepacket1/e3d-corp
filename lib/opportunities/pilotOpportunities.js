import crypto from 'node:crypto';
import { appendEvent, queryEvents } from '../events/store.js';
import { normalizeOpportunityCandidate } from './schema.js';
import { scoreOpportunity } from './scoring.js';
import { resolvePilotConfig } from '../pilot/config.js';
import { listPilotSamples, sampleAround, num } from '../pilot/series.js';

export const PILOT_SIGNAL_EVENT_TYPE = 'pilot.signal.detected';
export const PILOT_RETENTION_TYPE = 'pilot-retention-recommendation';
export const PILOT_OPPORTUNITY_TYPES = Object.freeze({
  signupDrop: 'pilot-signup-drop',
  activationGap: 'pilot-activation-gap',
  purchaseStall: 'pilot-purchase-stall',
  errorSpike: 'pilot-error-spike',
  refusalSpike: 'pilot-refusal-spike',
  webhookSilence: 'pilot-webhook-silence',
  billingAlarm: 'pilot-billing-alarm',
  chatHealth: 'pilot-chat-health',
  disputesFrozen: 'pilot-disputes-frozen',
  refundSpike: 'pilot-refund-spike',
  mrrChange: 'pilot-mrr-change',
  retention: PILOT_RETENTION_TYPE
});
export const RETENTION_COHORTS = Object.freeze(['outOfCredits', 'nearAllowance', 'paymentFailed', 'starterExpiringSoon']);

const PROPOSED_BY = Object.freeze({ role: 'pilot.scan', provider: 'deterministic', model: 'n/a' });
const HOUR_MS = 3_600_000;
const clamp = (value, cap) => Math.round(Math.min(value, cap) * 100) / 100;
const fmt = (n, d = 1) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)).toString() : 'n/a');
const pct = (n) => (n === null ? 'n/a' : `${fmt(n * 100, 0)}%`);
const sum = (obj) => Object.values(obj ?? {}).reduce((a, v) => a + (num(v) ?? 0), 0);

const COHORT_COPY = {
  outOfCredits: { label: 'out of credits', rec: 'These people used their credits and have not bought a pack. A short, honest note with the pack link is the highest-intent nudge available.' },
  nearAllowance: { label: 'near their plan allowance', rec: 'They are close to their plan allowance. Heads-up copy (and the upgrade path) lands before they hit a wall instead of after.' },
  paymentFailed: { label: 'with a failed payment', rec: 'A failed payment is the most recoverable churn there is. A plain "your payment did not go through, here is how to fix it" note is warranted.' },
  starterExpiringSoon: { label: 'whose starter credits are about to expire', rec: 'Starter credits that lapse unused are a wasted activation. A reminder that says what one debate would do for them is worth sending.' }
};

// Every detector is a pure function (metrics, baseline, thresholds) -> candidates. A candidate names the signal it
// raised, the cooldown class that dedups it, the exact numbers it relied on, and the confidence.
function detect({ cur, base, t, sampledAt, stripeLatestChargeAt }) {
  const f = cur.funnel ?? {}, u = cur.usage ?? {}, r = cur.revenue ?? {}, c = cur.cohorts ?? {}, h = cur.health ?? {};
  const out = [];
  const add = (x) => out.push(x);

  // 1. signup drop vs the prior 7 days
  const signups7d = num(f.signups7d), baseSignups = num(base?.funnel?.signups7d);
  if (signups7d !== null && baseSignups !== null && baseSignups >= t.signupDropMinBaseline && signups7d < baseSignups * t.signupDropMaxRatio) {
    add({ kind: 'signupDrop', key: 'signup-drop', cooldown: 'Trend', type: PILOT_OPPORTUNITY_TYPES.signupDrop,
      title: `Pilot signups dropped to ${signups7d} this week from ${baseSignups} the week before`,
      description: `${signups7d} signups in the last 7 days against ${baseSignups} in the 7 days sampled a week ago (${pct(signups7d / baseSignups)} of baseline, threshold ${pct(t.signupDropMaxRatio)}). A week-on-week drop can be a broken signup flow, a lapsed traffic source or plain noise: check the funnel entry points first.`,
      rationale: `signups7d ${signups7d} vs prior-week sample ${baseSignups}`,
      confidence: clamp(0.55 + (signups7d < baseSignups * t.signupDropMaxRatio / 2 ? 0.15 : 0) + (baseSignups >= t.signupDropMinBaseline * 3 ? 0.1 : 0), 0.85),
      metrics: { signups7d, priorWeekSignups7d: baseSignups }, usesBaseline: true });
  }

  // 2. activation gap: signed up, never ran a debate
  const noDebate = num(c.signedUpNoDebate7d);
  if (noDebate !== null && signups7d !== null && signups7d >= t.activationGapMinSignups && noDebate / signups7d > t.activationGapMaxRate) {
    const rate = noDebate / signups7d;
    add({ kind: 'activationGap', key: 'activation-gap', cooldown: 'Trend', type: PILOT_OPPORTUNITY_TYPES.activationGap,
      title: `${noDebate} of ${signups7d} recent Pilot signups never ran a debate`,
      description: `${noDebate} of the ${signups7d} people who signed up in the last 7 days have not run their first debate (${pct(rate)}, threshold ${pct(t.activationGapMaxRate)}). The starter grant exists to get them to one; look at what happens between verifying and the first run.`,
      rationale: `signedUpNoDebate7d ${noDebate} / signups7d ${signups7d} = ${pct(rate)}`,
      confidence: clamp(0.55 + (rate > 0.75 ? 0.15 : 0) + (signups7d >= t.activationGapMinSignups * 4 ? 0.1 : 0), 0.85),
      metrics: { signedUpNoDebate7d: noDebate, signups7d, rate } });
  }

  // 3. purchase-conversion stall
  const verified = num(f.verifiedTotal), purchased = num(f.purchasedTotal);
  if (verified !== null && purchased !== null && verified >= t.purchaseStallMinVerified && purchased / verified < t.purchaseStallMaxRate && (num(r.packsSoldWindow) ?? 0) === 0) {
    const rate = purchased / verified;
    add({ kind: 'purchaseStall', key: 'purchase-stall', cooldown: 'Trend', type: PILOT_OPPORTUNITY_TYPES.purchaseStall,
      title: `Pilot purchase conversion is ${pct(rate)}: ${purchased} buyers of ${verified} verified users, none in the window`,
      description: `${purchased} of ${verified} verified users have ever bought a pack (${pct(rate)}, floor ${pct(t.purchaseStallMaxRate)}) and no pack sold in the last ${fmt(cur.windowHours, 0)}h. People are verifying but not paying: check pricing visibility and the out-of-credits path.`,
      rationale: `purchasedTotal ${purchased} / verifiedTotal ${verified} = ${pct(rate)}; packsSoldWindow 0`,
      confidence: clamp(0.5 + (verified >= t.purchaseStallMinVerified * 4 ? 0.15 : 0), 0.8),
      metrics: { purchasedTotal: purchased, verifiedTotal: verified, packsSoldWindow: num(r.packsSoldWindow), rate } });
  }

  // 4. error / refusal spike
  const debates = num(u.debatesWindow) ?? 0, errors = num(u.errorsWindow);
  if (errors !== null && errors >= t.errorSpikeMinCount && errors / Math.max(debates + errors, 1) >= t.errorSpikeMinRate) {
    const rate = errors / Math.max(debates + errors, 1);
    add({ kind: 'errorSpike', key: 'error-spike', cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.errorSpike,
      title: `Pilot errors spiked: ${errors} errors against ${debates} debates in ${fmt(cur.windowHours, 0)}h`,
      description: `${errors} errors and ${debates} completed debates in the last ${fmt(cur.windowHours, 0)} hours (${pct(rate)} of attempts, threshold ${pct(t.errorSpikeMinRate)}). Paying users are hitting failures; check provider status and the server log.`,
      rationale: `errorsWindow ${errors} vs debatesWindow ${debates} = ${pct(rate)}`,
      confidence: clamp(0.6 + (rate >= 0.3 ? 0.15 : 0) + (errors >= t.errorSpikeMinCount * 4 ? 0.1 : 0), 0.9),
      metrics: { errorsWindow: errors, debatesWindow: debates, rate } });
  }
  const refusals = sum(u.refusalsWindow);
  if (refusals >= t.refusalSpikeMinCount && refusals / Math.max(debates + refusals, 1) >= t.refusalSpikeMinRate) {
    const rate = refusals / Math.max(debates + refusals, 1);
    const top = Object.entries(u.refusalsWindow).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
    add({ kind: 'refusalSpike', key: 'refusal-spike', cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.refusalSpike,
      title: `Pilot refused ${refusals} requests in ${fmt(cur.windowHours, 0)}h (${top})`,
      description: `${refusals} refusals against ${debates} debates (${pct(rate)}, threshold ${pct(t.refusalSpikeMinRate)}); top reasons: ${top}. A cluster of one reason points at a product rule, a cap or a payment state worth looking at.`,
      rationale: `refusalsWindow ${refusals} vs debatesWindow ${debates} = ${pct(rate)}; ${top}`,
      confidence: clamp(0.5 + (rate >= 0.4 ? 0.15 : 0), 0.8),
      metrics: { refusalsWindow: u.refusalsWindow, debatesWindow: debates, rate } });
  }

  // 5. webhook silence (only meaningful while the product is otherwise live)
  const webhookAge = num(h.lastWebhookAgeMinutes);
  // Silence only matters if Stripe took a payment after Pilot's last webhook. undefined = Stripe unreachable: alarm as before.
  const lastWebhookAt = webhookAge !== null && sampledAt ? sampledAt - webhookAge * 60_000 : null;
  const stripeAhead = stripeLatestChargeAt === undefined || lastWebhookAt === null
    ? true
    : stripeLatestChargeAt !== null && stripeLatestChargeAt > lastWebhookAt + 30 * 60_000;
  if (webhookAge !== null && webhookAge >= t.webhookSilenceMinutes && (num(u.debates7d) ?? 0) > 0 && stripeAhead) {
    add({ kind: 'webhookSilence', key: 'webhook-silence', cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.webhookSilence,
      title: `No Stripe webhook reached Pilot for ${fmt(webhookAge / 60, 1)} hours`,
      description: `The last billing webhook arrived ${fmt(webhookAge, 0)} minutes ago (threshold ${fmt(t.webhookSilenceMinutes, 0)}) while Pilot still ran ${num(u.debates7d)} debates this week. Silent webhooks mean purchases and renewals may not be credited: check the Stripe endpoint and its recent deliveries.`,
      rationale: `lastWebhookAgeMinutes ${fmt(webhookAge, 0)} >= ${fmt(t.webhookSilenceMinutes, 0)}; debates7d ${num(u.debates7d)}`,
      confidence: clamp(0.6 + (webhookAge >= t.webhookSilenceMinutes * 4 ? 0.2 : 0), 0.9),
      metrics: { lastWebhookAgeMinutes: webhookAge, debates7d: num(u.debates7d) } });
  }

  // 6. billing alarms (the key includes the alarm set, so a different alarm is a different condition)
  const alarms = Array.isArray(h.billingAlarms) ? h.billingAlarms : [];
  if (alarms.length > 0) {
    const shown = alarms.slice(0, 5).map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
    const digest = crypto.createHash('sha256').update(JSON.stringify(alarms)).digest('hex').slice(0, 8);
    add({ kind: 'billingAlarm', key: `billing-alarm:${digest}`, cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.billingAlarm,
      title: `Pilot billing raised ${alarms.length} alarm${alarms.length === 1 ? '' : 's'}: ${shown[0].slice(0, 80)}`,
      description: `Pilot's own billing checks report ${alarms.length} active alarm(s): ${shown.join('; ')}. These come straight from the server; treat them as real until disproved.`,
      rationale: `health.billingAlarms has ${alarms.length} entr${alarms.length === 1 ? 'y' : 'ies'}`,
      confidence: 0.85, metrics: { billingAlarms: shown } });
  }

  // 6b. the website chat (health.chat, null where the chat host pieces are not installed): server or bot down, or a nightly job stale.
  // A null age is "not reported yet" (a fresh install before its first night), never a problem. The key includes the problem set.
  const chat = h.chat && typeof h.chat === 'object' ? h.chat : null;
  if (chat) {
    const problems = [];
    if (chat.serverUp === false) problems.push('serverDown');
    if (chat.botUp === false) problems.push('botDown');
    const backupAge = num(chat.backupAgeHours), purgeAge = num(chat.purgeAgeHours);
    if (backupAge !== null && backupAge >= t.chatJobStaleHours) problems.push('backupStale');
    if (purgeAge !== null && purgeAge >= t.chatJobStaleHours) problems.push('purgeStale');
    if (problems.length > 0) {
      const say = { serverDown: 'the chat server (chat.pilot.e3d.ai) is not answering', botDown: 'the chat bot is not listening', backupStale: `the nightly chat backup last succeeded ${fmt(backupAge, 0)}h ago`, purgeStale: `the 30-day chat purge last succeeded ${fmt(purgeAge, 0)}h ago` };
      const down = problems.includes('serverDown') || problems.includes('botDown');
      add({ kind: 'chatHealth', key: `chat-health:${problems.join('+')}`, cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.chatHealth,
        title: `Pilot chat needs attention: ${problems.map((p) => say[p]).join('; ').slice(0, 110)}`,
        description: `Pilot's website chat reports: ${problems.map((p) => say[p]).join('; ')}. ${down ? 'Visitors may see a chat bubble that does not answer; the site itself is unaffected.' : 'The chat still answers, but the retention or backup promise (30-day deletion, 7-day backups) is not being kept.'} Check runbook 12d on the Pilot host (timers, container, nginx).`,
        rationale: `health.chat ${JSON.stringify({ serverUp: chat.serverUp, botUp: chat.botUp, backupAgeHours: backupAge, purgeAgeHours: purgeAge })}`,
        confidence: down ? 0.9 : 0.8,
        metrics: { serverUp: chat.serverUp ?? null, botUp: chat.botUp ?? null, backupAgeHours: backupAge, purgeAgeHours: purgeAge } });
    }
  }

  // 7. open disputes / frozen subscriptions
  const disputes = num(r.disputesOpen) ?? 0, frozen = num(r.frozenSubscriptions) ?? 0;
  if (disputes > 0 || frozen > 0) {
    add({ kind: 'disputesFrozen', key: `disputes-frozen:${disputes}:${frozen}`, cooldown: 'Health', type: PILOT_OPPORTUNITY_TYPES.disputesFrozen,
      title: `Pilot has ${disputes} open dispute${disputes === 1 ? '' : 's'} and ${frozen} frozen subscription${frozen === 1 ? '' : 's'}`,
      description: `${disputes} open Stripe dispute(s) and ${frozen} subscription(s) frozen. Disputes have evidence deadlines; frozen subscriptions are customers who are paying or owed and cannot use the product.`,
      rationale: `disputesOpen ${disputes}, frozenSubscriptions ${frozen}`,
      confidence: clamp(0.7 + (disputes > 0 ? 0.15 : 0), 0.9), metrics: { disputesOpen: disputes, frozenSubscriptions: frozen } });
  }

  // 8. refund spike
  const refunds = num(r.refundsWindow), sold = num(r.packsSoldWindow) ?? 0;
  if (refunds !== null && refunds >= t.refundSpikeMinCount && refunds / Math.max(sold, 1) >= t.refundSpikeMinRate) {
    add({ kind: 'refundSpike', key: 'refund-spike', cooldown: 'Trend', type: PILOT_OPPORTUNITY_TYPES.refundSpike,
      title: `Pilot refunded ${refunds} purchases against ${sold} sold in ${fmt(cur.windowHours, 0)}h`,
      description: `${refunds} refunds in the window against ${sold} packs sold (threshold: at least ${t.refundSpikeMinCount} and ${pct(t.refundSpikeMinRate)} of sales). Look at what the refunded customers had in common.`,
      rationale: `refundsWindow ${refunds} vs packsSoldWindow ${sold}`,
      confidence: clamp(0.55 + (refunds >= t.refundSpikeMinCount * 3 ? 0.15 : 0), 0.8), metrics: { refundsWindow: refunds, packsSoldWindow: sold } });
  }

  // 9. MRR change vs a week ago
  const mrr = num(r.mrrUsd), baseMrr = num(base?.revenue?.mrrUsd);
  if (mrr !== null && baseMrr !== null && Math.abs(mrr - baseMrr) >= t.mrrChangeMinUsd && Math.abs(mrr - baseMrr) / Math.max(baseMrr, 1) >= t.mrrChangeMinFraction) {
    const up = mrr > baseMrr;
    add({ kind: 'mrrChange', key: `mrr-change:${up ? 'up' : 'down'}`, cooldown: 'Trend', type: PILOT_OPPORTUNITY_TYPES.mrrChange,
      title: `Pilot MRR ${up ? 'rose' : 'fell'} to $${fmt(mrr, 0)} from $${fmt(baseMrr, 0)} in a week`,
      description: `MRR is $${fmt(mrr, 2)} against $${fmt(baseMrr, 2)} in the sample a week ago (${up ? '+' : '-'}${pct(Math.abs(mrr - baseMrr) / Math.max(baseMrr, 1))}). ${up ? 'Worth knowing what drove it so it can be repeated.' : 'Check for cancellations, failed payments and frozen subscriptions.'}`,
      rationale: `mrrUsd ${fmt(mrr, 2)} vs prior-week ${fmt(baseMrr, 2)}`,
      confidence: clamp(0.55 + (Math.abs(mrr - baseMrr) / Math.max(baseMrr, 1) >= t.mrrChangeMinFraction * 3 ? 0.15 : 0), 0.8),
      metrics: { mrrUsd: mrr, priorWeekMrrUsd: baseMrr }, usesBaseline: true });
  }

  // 10. retention cohorts: each a recommendation. Counts only, never people.
  for (const cohort of RETENTION_COHORTS) {
    const count = num(c[cohort]);
    if (count === null || count < Math.max(t.cohortMinCount, 1)) continue;
    const copy = COHORT_COPY[cohort];
    add({ kind: 'retention', key: `retention:${cohort}`, cooldown: 'Cohort', type: PILOT_RETENTION_TYPE, cohort,
      title: `Recommendation: nudge ${count} Pilot user${count === 1 ? '' : 's'} ${copy.label}`,
      description: `${count} user(s) are ${copy.label}. ${copy.rec} This is a recommendation to draft a retention nudge (a Proposal for you to approve); the cohort is a head-count only, no addresses are held here.`,
      rationale: `cohorts.${cohort} = ${count}`,
      confidence: clamp(0.5 + (cohort === 'paymentFailed' ? 0.2 : 0) + (count >= 10 ? 0.1 : 0), 0.85),
      metrics: { cohort, count } });
  }
  return out;
}

// One signal per (condition key, cooldown bucket): a persistent problem raises one Opportunity per cooldown, not one per
// poll, yet resurfaces next bucket instead of being silenced for good (same idea as youtubeOpportunities.js).
function signalId(key, cooldownHours, now) {
  return `${key}:${Math.floor(now.getTime() / (cooldownHours * HOUR_MS))}`;
}

function alreadyHandledSignalIds(dataDir) {
  const handledCausation = new Set(queryEvents(dataDir, { type: 'opportunity.created' }).map((e) => e.causationId).filter(Boolean));
  const handled = new Set();
  for (const signal of queryEvents(dataDir, { type: PILOT_SIGNAL_EVENT_TYPE })) {
    if (handledCausation.has(signal.id) && signal.subject?.id) handled.add(signal.subject.id);
  }
  return handled;
}

// Level 0/1: reads the latest pilot.metrics.sampled event, writes evidence + signal + scored Opportunity. No model, no network.
export function scanPilotSignals({ dataDir, instanceConfig, now = new Date(), stripeLatestChargeAt } = {}) {
  if (!dataDir) throw new Error('scanPilotSignals requires a dataDir');
  const { thresholds: t, typeWeights } = resolvePilotConfig(instanceConfig);
  const samples = listPilotSamples(dataDir);
  const result = { created: [], alreadySignaled: [], sampled: samples.length > 0, noBaseline: false };
  const latest = samples[samples.length - 1];
  if (!latest) return result;

  // A scan only ever judges the newest sample, and only if it is recent: a stale sample is the monitor's own outage,
  // already visible as degraded evidence, not a Pilot problem.
  if (now.getTime() - latest.at > 6 * HOUR_MS) return { ...result, stale: true };

  const baseSample = sampleAround(samples, latest, 24 * 7, t.baselineToleranceHours);
  if (!baseSample) result.noBaseline = true;
  const candidates = detect({ cur: latest.metrics, base: baseSample?.metrics ?? null, t, sampledAt: latest.at, stripeLatestChargeAt });
  const handled = alreadyHandledSignalIds(dataDir);

  for (const cand of candidates) {
    const hours = t[`cooldownHours${cand.cooldown}`];
    const id = signalId(cand.key, hours, now);
    if (handled.has(id)) { result.alreadySignaled.push(id); continue; }

    const correlationId = crypto.randomUUID();
    const sampleEventIds = [latest.event.id, ...(cand.usesBaseline && baseSample ? [baseSample.event.id] : [])];
    const evidenceEvent = appendEvent(dataDir, {
      type: 'evidence.gathered', source: 'research.pilot', subject: { type: 'research', id: crypto.randomUUID() },
      payload: {
        kind: 'pilot-metrics-signal', query: { signal: cand.kind, key: cand.key, cooldownHours: hours },
        resultSummary: cand.rationale,
        result: { status: 'ok', kind: cand.kind, sampleEventIds, sampledAt: latest.event.occurredAt, windowHours: latest.metrics.windowHours ?? null, metrics: cand.metrics },
        degraded: false
      },
      causationId: null, correlationId, occurredAt: now.toISOString()
    });
    const signalEvent = appendEvent(dataDir, {
      type: PILOT_SIGNAL_EVENT_TYPE, source: 'pilot.scan', subject: { type: 'pilot-signal', id },
      payload: { signalId: id, kind: cand.kind, cohort: cand.cohort ?? null, rationale: cand.rationale },
      causationId: evidenceEvent.id, correlationId, occurredAt: now.toISOString()
    });

    const candidate = normalizeOpportunityCandidate({
      type: cand.type, title: cand.title, description: cand.description, rationale: cand.rationale, confidence: cand.confidence,
      evidenceEventIds: [evidenceEvent.id, ...sampleEventIds],
      counterparty: { kind: 'none', name: null, contactHint: null }
    });
    const opportunityId = crypto.randomUUID();
    const record = {
      id: opportunityId, type: candidate.type, title: candidate.title, description: candidate.description,
      evidence: candidate.evidenceEventIds, score: null, status: 'candidate', counterparty: candidate.counterparty,
      pursuable: false, sourceEventIds: [signalEvent.id, ...candidate.evidenceEventIds], correlationId,
      proposedBy: PROPOSED_BY, signal: { kind: cand.kind, cohort: cand.cohort ?? null, signalId: id }, createdAt: now.toISOString()
    };
    const createdEvent = appendEvent(dataDir, {
      type: 'opportunity.created', source: 'pilot.scan', subject: { type: 'opportunity', id: opportunityId },
      payload: { ...record, roleConfidence: candidate.confidence, roleRationale: candidate.rationale },
      causationId: signalEvent.id, correlationId, occurredAt: now.toISOString()
    });
    const score = scoreOpportunity({
      confidence: candidate.confidence, evidenceCount: candidate.evidenceEventIds.length,
      triggerOccurredAt: signalEvent.occurredAt, type: candidate.type, typeWeights, now: now.getTime()
    });
    appendEvent(dataDir, {
      type: 'opportunity.scored', source: 'opportunity.engine', subject: { type: 'opportunity', id: opportunityId },
      payload: { id: opportunityId, score, status: 'scored' }, causationId: createdEvent.id, correlationId, occurredAt: now.toISOString()
    });
    handled.add(id);
    result.created.push({ ...record, score, status: 'scored' });
  }
  return result;
}
