# Pilot monitor

e3d-corp watches the Pilot product (pilot.e3d.ai) the same way it watches the YouTube channel: it samples a read-only
aggregate, notices when something deserves a human's attention, turns that into scored Opportunities that cite the
sampled numbers, and, for retention, drafts a nudge you approve. Everything is an event in the hash-chained log.

Nothing here writes to Pilot, sends mail, or talks to Stripe. e3d-corp never holds customer addresses or a Stripe key.

## Data flow

```
Pilot server: ops/pilot-metrics.js (read-only, one aggregate JSON document, schema v1, no PII)
      |  ssh (BatchMode, key file, timeout)             lib/event-sources/pilotMetrics.js
      v
pilot.metrics.sampled event (whole document)            degraded evidence.gathered when unreachable / malformed
      |
      +--> lib/opportunities/pilotOpportunities.js      deterministic scan, no model -> scored Opportunities
      +--> lib/pilot/revenue.js                         pilot.revenue.observed Outcome (replaces the Stripe poll)
      +--> lib/pilot/summary.js                         daily digest "Pilot" section + web /pilot page
Retention Opportunity --> `pilot nudge` --> pilot-retention-nudge Proposal (level 2) --> approve --> recorded no-op handoff
```

## Config

Add to the instance's `instance.json` (not tracked; `examples/instance.example.json` shows the shape):

```json
"research": {
  "pilot": {
    "sshHost": "pilot.example.com",
    "sshKeyFile": "/Users/mini/.ssh/pilot-metrics-readonly",
    "remoteCommand": "node /srv/pilot/ops/pilot-metrics.js --window-hours 24",
    "windowHours": 24,
    "minPollIntervalMinutes": 25,
    "timeoutSeconds": 30,
    "thresholds": { "webhookSilenceMinutes": 240 },
    "typeWeights": { "pilot-billing-alarm": 1.2 }
  }
},
"roles": { "pilot.retentionCopy": { "provider": "claude" } }
```

| Field | Meaning |
| --- | --- |
| `sshHost` | Plain host name (letters, digits, `. _ @ -`). Anything that could be read as an ssh option is refused. |
| `sshKeyFile` | Private key for a user that can run only the metrics command (use `command="..."` in that user's `authorized_keys`). |
| `remoteCommand` | The one command run remotely. It comes from this file only; no data is ever substituted into it. |
| `windowHours` | Documentation of the window the server computes; the document's own `windowHours` wins. |
| `minPollIntervalMinutes` | A poll inside this interval of the last good sample makes no ssh call (default 25). |
| `thresholds` | Override any key in the table below. |

ssh is run with `execFile` (argv array, no local shell): `ssh -o BatchMode=yes -o ConnectTimeout=15 [-i KEY -o IdentitiesOnly=yes] -- HOST COMMAND`.
Host-key checking is ssh's default, so add the host to `known_hosts` once by hand.

## Cron

Not installed automatically. Add this line yourself:

```
*/30 * * * * /Users/mini/e3d-corp/ops/run/run-pilot-poll.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/pilot-poll.log 2>&1
```

Exit codes: 0 ok, 2 Pilot unreachable or bad output (recorded as degraded evidence, shows up in the daily digest),
1 misconfigured. The old `run-stripe-poll.sh` line can be deleted. If left in place it no longer fails: once
`research.pilot` is configured, `ops/reports/pollStripeRevenue.js` records the revenue Outcome from the latest Pilot sample and exits 0.

CLI equivalents: `e3d-corp pilot sample|scan|poll|summary --instance futco`, and `pilot nudge <opportunity-id>`.

## Signals and thresholds

All deterministic. Defaults live in `lib/pilot/config.js` (`DEFAULT_THRESHOLDS`); override under `research.pilot.thresholds`.
A baseline means the sample taken about 7 days earlier (within 12h); if there is none, week-on-week signals are skipped, never guessed.

| Signal (type) | Fires when | Cooldown |
| --- | --- | --- |
| Signup drop (`pilot-signup-drop`) | `signups7d` < 50% of the sample a week ago, baseline >= 10 | 72h |
| Activation gap (`pilot-activation-gap`) | `signedUpNoDebate7d / signups7d` > 50%, signups7d >= 5 | 72h |
| Purchase stall (`pilot-purchase-stall`) | verified >= 25, purchased/verified < 2%, no pack sold in the window | 72h |
| Error spike (`pilot-error-spike`) | errors >= 3 and >= 10% of attempts in the window | 24h |
| Refusal spike (`pilot-refusal-spike`) | refusals >= 5 and >= 20% of attempts | 24h |
| Webhook silence (`pilot-webhook-silence`) | `lastWebhookAgeMinutes` >= 360 while debates7d > 0 | 24h |
| Billing alarm (`pilot-billing-alarm`) | `health.billingAlarms` not empty (a different alarm set is a new condition) | 24h |
| Chat health (`pilot-chat-health`) | `health.chat` (null where the chat host pieces are not installed) has `serverUp` or `botUp` false, or `backupAgeHours` / `purgeAgeHours` >= 36 (null ages are "not reported yet", never a problem); a different problem set is a new condition | 24h |
| Disputes / frozen (`pilot-disputes-frozen`) | `disputesOpen` > 0 or `frozenSubscriptions` > 0 (a changed count is a new condition) | 24h |
| Refund spike (`pilot-refund-spike`) | refunds >= 2 and >= 20% of packs sold | 72h |
| MRR change (`pilot-mrr-change`) | MRR moved >= 10% and >= $20 vs a week ago (up or down are separate) | 72h |
| Retention (`pilot-retention-recommendation`) | any of `outOfCredits`, `nearAllowance`, `paymentFailed`, `starterExpiringSoon` >= 1; one Opportunity per cohort | 168h |

Dedup: each condition gets a signal id `key:bucket` where bucket = floor(now / cooldown). A condition raises at most one
Opportunity per bucket, and only counts as handled once the Opportunity exists (a crash in between is retried). A
persistent problem resurfaces in the next bucket instead of being silenced for good. A scan also refuses to judge a
sample older than 6 hours: a dead monitor is the monitor's own outage (degraded evidence), not a Pilot problem.

Every Opportunity cites an `evidence.gathered` event (kind `pilot-metrics-signal`, holding the exact numbers) and the
`pilot.metrics.sampled` event(s) they came from.

## Revenue

`pilot.revenue.observed` Outcome per sample (id `pilot-revenue:<sample event id>`) with packs sold/revenue, MRR, plans and
refunds. Windows overlap between samples, so this type is neutral: it is not a positive outcome type and is never added into
`revenueAttributable`. It is an observation, not new money.

## Daily digest and web

`ops/reports/dailyDigest.js` adds a "Pilot (pilot.e3d.ai)" section (text and HTML) when `research.pilot` is configured:
funnel vs the sample ~24h earlier, usage, revenue, health, top open Pilot opportunities, and a warning when the latest
sample is stale. The web UI has the same summary at `/pilot` (nav: Pilot). Degraded Pilot pulls also appear in the digest's
existing "Degraded evidence pulls" block.

## Retention nudges (`pilot-retention-nudge`)

`e3d-corp pilot nudge <retention-opportunity-id>` asks the `pilot.retentionCopy` role (provider `claude`) for a subject and
body, validates them (no email addresses, no links other than https://pilot.e3d.ai, no clickbait, length caps) and creates a
pending Proposal. The payload is a cohort name, a head-count and the copy, nothing else; unknown fields are refused so an
address cannot ride along. One model call per Opportunity.

Policy v8 puts `pilot-retention-nudge` at level 2: approving it executes at once, but the executor is a recorded no-op
handoff. It writes `<dataDir>/pilot-nudges/<proposalId>.json` (status `handoff-recorded-not-sent`) and appends
`pilot-retention-nudge.handed-off` with `sent: false`. The real send is a future Pilot-side command that resolves the
cohort to recipients on the Pilot server, where the addresses live.

## Adding a metric

1. Server: add the field to `ops/pilot-metrics.js` in e3d-pilot-cloud and keep it inside schema v1 (new optional fields are fine; a changed meaning needs schema 2).
2. The sample stores the whole document, so the new field is available immediately with no ingestion change.
3. Add a threshold to `DEFAULT_THRESHOLDS` in `lib/pilot/config.js` if it needs one.
4. Add a detector: push a candidate in `detect()` in `lib/opportunities/pilotOpportunities.js` with a unique `key`, a cooldown class (`Health`, `Trend`, `Cohort`), a type, honest copy, a confidence and the `metrics` it relied on. Add the type to `PILOT_OPPORTUNITY_TYPES`.
5. To show it in the digest and `/pilot`, add it to `FUNNEL_FIELDS` or the usage/revenue lines in `lib/pilot/summary.js`, `digestHtml.js` and `render.js`.
6. Add the case to `test/pilotMonitor.test.js` using `test/fixtures/pilot-metrics.v1.json` and `test/helpers/fakePilotServer.js`.

## Tests

`node --test test/pilotMonitor.test.js test/pilotRetentionNudge.test.js` (plus `test/youtubeMetadataChange.test.js` for the policy version).
They use a fake transport (`test/helpers/fakePilotServer.js`) and never open an ssh connection.
