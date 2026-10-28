import { listOpportunities } from '../opportunities/store.js';
import { queryEvents } from '../events/store.js';
import { latestPilotSample, listPilotSamples, sampleAround, num } from './series.js';

const OPEN = new Set(['candidate', 'scored', 'reviewed', 'pursuing']);

export function isPilotOpportunity(o) {
  return typeof o.type === 'string' && o.type.startsWith('pilot-');
}

const FUNNEL_FIELDS = ['signupsTotal', 'signupsWindow', 'signups7d', 'verifiedTotal', 'starterGrantedTotal', 'firstDebateTotal', 'firstDebateWindow', 'purchasedTotal', 'subscribedTotal'];

// What the daily digest and the web UI show about Pilot: funnel vs yesterday, revenue, health and the top open Pilot
// opportunities. Pure read of the event log. `available` is false until a sample exists, and every number may be null.
export function buildPilotSummary(dataDir, { now = new Date(), topN = 5, toleranceHours = 12 } = {}) {
  const samples = listPilotSamples(dataDir);
  const latest = samples[samples.length - 1] ?? null;
  const degraded = queryEvents(dataDir, { type: 'evidence.gathered' }).filter((e) => e.source === 'research.pilot' && e.payload?.degraded === true);
  const lastDegraded = degraded[degraded.length - 1] ?? null;
  const opportunities = listOpportunities(dataDir).filter((o) => isPilotOpportunity(o) && OPEN.has(o.status)).slice(0, topN);
  const base = { available: false, opportunities, lastDegradedAt: lastDegraded?.occurredAt ?? null, lastDegradedReason: lastDegraded?.payload?.result?.reason ?? null };
  if (!latest) return base;

  const yesterday = sampleAround(samples, latest, 24, toleranceHours);
  const m = latest.metrics;
  const funnel = FUNNEL_FIELDS.map((key) => {
    const value = num(m.funnel?.[key]);
    const prior = yesterday ? num(yesterday.metrics.funnel?.[key]) : null;
    return { key, value, yesterday: prior, delta: value !== null && prior !== null ? value - prior : null };
  });
  const ageMinutes = Math.round((now.getTime() - latest.at) / 60_000);
  return {
    ...base,
    available: true,
    sampledAt: latest.event.occurredAt,
    sampleAgeMinutes: ageMinutes,
    stale: ageMinutes > 6 * 60,
    hasYesterday: Boolean(yesterday),
    funnel,
    usage: m.usage ?? {},
    revenue: m.revenue ?? {},
    cohorts: m.cohorts ?? {},
    health: m.health ?? {},
    notes: m.notes ?? []
  };
}

export function formatPilotSummaryText(s) {
  const lines = [];
  if (!s.available) {
    lines.push('(no Pilot metrics sampled yet)');
    if (s.lastDegradedAt) lines.push(`Last attempt failed at ${s.lastDegradedAt}: ${s.lastDegradedReason ?? 'unavailable'}`);
    return lines;
  }
  lines.push(`Sampled ${s.sampledAt} (${s.sampleAgeMinutes} min ago)${s.stale ? ' - STALE, the monitor may be failing' : ''}`);
  lines.push(`Funnel${s.hasYesterday ? ' (vs ~24h ago)' : ' (no sample from yesterday to compare)'}:`);
  for (const f of s.funnel) {
    const d = f.delta === null ? '' : ` (${f.delta >= 0 ? '+' : ''}${f.delta})`;
    lines.push(`  ${f.key}: ${f.value ?? 'n/a'}${d}`);
  }
  const r = s.revenue, u = s.usage, h = s.health;
  lines.push(`Usage: debates ${u.debatesWindow ?? 'n/a'} (24h) / ${u.debates7d ?? 'n/a'} (7d), errors ${u.errorsWindow ?? 'n/a'}, credits spent ${u.creditsSpentWindow ?? 'n/a'}`);
  lines.push(`Revenue: packs ${r.packsSoldWindow ?? 'n/a'} sold = $${r.packsRevenueUsdWindow ?? 'n/a'} (7d $${r.packsRevenueUsd7d ?? 'n/a'}), MRR $${r.mrrUsd ?? 'n/a'}, refunds ${r.refundsWindow ?? 'n/a'}, open disputes ${r.disputesOpen ?? 'n/a'}, frozen subs ${r.frozenSubscriptions ?? 'n/a'}`);
  const alarms = Array.isArray(h.billingAlarms) ? h.billingAlarms : [];
  lines.push(`Health: billing alarms ${alarms.length}${alarms.length ? ` (${alarms.slice(0, 3).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('; ')})` : ''}, last webhook ${h.lastWebhookAgeMinutes ?? 'n/a'} min ago, last debate ${h.lastDebateAgeMinutes ?? 'n/a'} min ago`);
  lines.push('Open Pilot opportunities:');
  if (s.opportunities.length === 0) lines.push('  (none)');
  for (const o of s.opportunities) lines.push(`  [${o.score?.value !== undefined ? o.score.value.toFixed(2) : '?.??'}] ${o.title} (${o.id.slice(0, 8)})`);
  return lines;
}
