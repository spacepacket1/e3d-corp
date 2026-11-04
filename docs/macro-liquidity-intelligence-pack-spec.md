# Feature Ticket: Macro & Liquidity Signal Source (V1)

## Status

This is a rescoped, implementation-ready cut of a much larger draft ("E3D Macro & Liquidity Intelligence Pack") that proposed a standalone intelligence framework — its own Thesis/Story object model, an 8-way regime classifier, 5 derived scores, a native dashboard, a historical-replay engine, and a generic multi-pack architecture for future regulatory/geopolitical/energy intelligence.

A direct read of `e3d-corp` before writing this version found that most of that architecture already exists, elsewhere in this stack, doing the same job:

- **Theses and Stories are not this ticket's to build.** They are first-class objects owned by `e3d.ai` (the `spacepacket` hub) already. `e3d-trade` already consumes them. `e3d-corp` already has an `opportunity.investing` role (`lib/roles/investingOpportunity.js`) whose entire job is turning real thesis/story evidence plus a `marketState` snapshot into a structured, evidence-cited investment view (`view`, `confidence`, `rationale`, `invalidationCondition`, `thesisRefs`, `storyRefs`) — this is section 14 of the original draft's "Thesis Candidate," already implemented. This ticket's job is narrower and more useful than the original draft assumed: **produce a trustworthy `marketState` object**, not a parallel thesis system.
- **There is no event bus and this ticket doesn't need one.** `events.jsonl` (hash-chained, tamper-evident, `causationId`/`correlationId`-linked) already is the append-only, provenance-carrying store the original draft's "Raw Observation" / "Derived Signal" schemas and `ExternalSignalUpdated`-style outputs were reinventing. Every output type in the original draft's section 13 maps onto a plain `appendEvent` call.
- **`docs/build-portfolio-sheet-source.md`** (reviewed, not yet built) is the architectural template to copy exactly: read external source → normalize by an explicit contract → deterministic diff/classify against folded event history → append events → feed the *existing* `runOpportunityEngine`. This ticket follows the same shape with a different upstream (public macro/market data APIs instead of a spreadsheet) and no genericity constraint (these are public economic series, not an operator's private financial data — nothing here needs scrubbing from the tracked tree).
- **The authority boundary is identical to every other evidence source in this system.** Everything this ticket produces is level 0 (observation) or level 1 (internal write — an Opportunity for human review). No action executor, no new `ACTION_POLICY` entry, no code path from a macro signal to money moving.

Everything the original draft asked for that isn't in this ticket — a second/third derived score, an 8-regime classifier, a native dashboard, historical backtesting, regulatory/news NLP ingestion, a generic multi-pack framework, Google Sheets sync — is explicitly deferred below, not silently dropped. V1's job is to prove the mechanism (can a rising 30Y yield simultaneously raise both an immediate-pressure score and a later-response-probability score, and can that reach a human as a reviewable Opportunity) before any of that is worth building.

## The Idea

Give `e3d-corp` a read-only signal source that pulls a small set of public macro/liquidity/crypto series on a daily cadence, deterministically derives two scores that must be able to disagree by design — **Current Crypto Pressure** (immediate, first-order hostility of financial conditions to crypto) and **Forced-Liquidity Probability** (how much pressure is building toward a future policy-liquidity response) — assigns one of four regime labels from those scores plus a small rule table, and feeds the result into the **existing** `opportunity.investing` role as `marketState`. A human reviews whatever Opportunity comes out of that, exactly like every other Opportunity in this system.

The specific product insight this preserves (the reason two scores instead of one): a rising 30Y yield can raise Current Crypto Pressure (tighter financial conditions, bad for crypto now) and raise Forced-Liquidity Probability (more likely the Fed/Treasury eventually eases, good for crypto later) *at the same time*. Collapsing that into one directional number would throw away the one thing that makes this evidence source worth building.

## Product Goals

- A generic macro/market-data read client (`lib/macro/fred.js`) — thin `fetch` wrapper over the St. Louis Fed's FRED API (`api.stlouisfed.org/fred/series/observations`), matching the dependency-free-`fetch` convention already used by `lib/calendar/googleCalendarApi.js` and `lib/trade/client.js`. No SDK dependency.
- A second thin client (`lib/macro/coingecko.js`) for BTC/USD and XRP/BTC — CoinGecko's public `simple/price` endpoint, no API key required for V1's call volume.
- A static signal registry (`lib/macro/signalDefinitions.js`) listing V1's ~10 series by id, source, expected frequency, and units — see V1 Signal Universe below. Unlike the portfolio-sheet ticket, this is **not** a genericity-constrained, operator-private contract: these are public economic series, so the registry lives in code, not instance config. (An instance can still turn the whole `macro` source off by omitting the config block — see Config below.)
- Deterministic, event-sourced ingestion (`lib/event-sources/macroSignals.js`): fetch every V1 series → normalize into raw observations with provenance (source, series id, observed-at, retrieved-at, expected frequency, staleness) → append one `macro.observation` event per series on every successful poll → compute the two derived scores and the regime label purely from those observations → append `macro.regime.snapshot` unconditionally and `macro.regime.changed` only when the regime label differs from the last folded value.
- A source-health state machine matching the portfolio-sheet ticket's pattern exactly: `macro.data.degraded` on a fetch/parse failure for any series (fail closed — never fabricate a missing observation), `macro.data.restored` on the next fully-successful poll after a degraded one. A single series being late (e.g. CPI's monthly cadence) is *not* degraded — see Freshness below; degraded means the fetch itself failed.
- Regime-change events feed the **existing** `runInvestingOpportunityEngine` (`lib/opportunities/investingEngine.js`) as their `triggerEvent`, with `marketState` populated from the snapshot (regime, both scores, supporting/contradictory evidence, freshness state). No second opportunity engine, no bypass of existing scoring/evidence machinery, no schema change to the investing role.
- A cron-polled ingestion script (`ops/reports/pollMacroSignals.js` + `ops/run/run-macro-poll.sh`), matching the calendar/portfolio poll pattern exactly, plus a manual CLI command (`e3d-corp macro status --instance <name>`) for on-demand inspection.
- Preserve every convention this codebase has already earned: config holds env var *names*, never secret values; nothing fails open on a fetch/parse error; the authority system is not touched, weakened, or given a new bypass path; derived scores are reproducible — same inputs and `model_version`, same output, no LLM in the scoring path.

## Non-Goals (V1)

- **No action executor of any kind.** Not a stub, not a disabled flag. This ticket adds zero lines of code capable of moving money or placing an order. No new `ACTION_POLICY` entry in `lib/authority/policy.js`.
- **No Thesis/Story object model.** Theses and Stories stay owned by `e3d.ai`. This ticket never creates, scores, or stores anything called a thesis or story — it only produces `marketState` evidence that the existing `opportunity.investing` role can reason over alongside the real theses/stories it already pulls from research evidence.
- **No Fed Flexibility, Break Risk, or Crypto Liquidity Transmission scores in V1.** All three mostly decompose from the same input observations as the two V1 scores; adding three more scoring surfaces before V1's two have run against live data risks exactly the false-precision problem the original draft itself warned against (its own section E). They are the first candidates for a v1.1 ticket once V1's regime/score history has a few weeks of real data to sanity-check against.
- **No 8-way regime classifier.** V1 ships four regimes (below), derived by a small, fully-specified threshold table over the two scores plus one credit-stress input — not an open-ended taxonomy that can't be unit-tested exhaustively.
- **No native dashboard, no "Causal Flow" visualization, no "What changed?" natural-language generator.** CLI output + the event log are the only surfaces, matching the portfolio-sheet ticket's own scope cut. `macro status` prints the current snapshot and day-over-day delta in plain text; that's the entire UI.
- **No historical replay/backtesting engine.** The event log is already append-only and queryable by time (`queryEvents(dataDir, { type, since })`); "what would the regime have been on date X" is a follow-up script over existing data once V1's derivation functions exist, not new infrastructure this ticket needs to build. Deferred, not impossible.
- **No regulatory/news/event-text ingestion, no LLM-generated scores.** Scores are pure functions of numeric observations, versioned and reproducible without an LLM, per the original draft's own section 11 recommendation. If a human wants a narrated summary of a regime change, that's the `opportunity.investing` role's existing job on the resulting Opportunity — this ticket does not add a second explanation-generating role.
- **No Google Sheets sync in either direction.** The operator's existing spreadsheet is explicitly out of scope as a data source (per the original draft) and V1 does not write to it either. If daily snapshot export to that sheet is wanted later, it is a small follow-up (`lib/sheets/` from the portfolio-sheet ticket, once that ticket exists, could write instead of only read) — not part of this ticket.
- **No generic "External Intelligence Framework."** This ticket is one event source feeding one existing engine. If a second, unrelated intelligence pack (energy, regulatory, etc.) is proposed later and turns out to share real code with this one, extract the shared piece then, against two concrete implementations — not now, against a hypothetical third.

## V1 Signal Universe

All ten series are free, keyed or unkeyed public APIs, no licensing cost. FRED requires a free registered API key (env var, never a config value); CoinGecko's public tier needs none for this call volume.

| id | name | source | series/pair | frequency | units |
|---|---|---|---|---|---|
| `us2y` | 2Y Treasury yield | FRED | `DGS2` | daily | percent |
| `us10y` | 10Y Treasury yield | FRED | `DGS10` | daily | percent |
| `us30y` | 30Y Treasury yield | FRED | `DGS30` | daily | percent |
| `dollar_index` | Trade-weighted USD (broad) | FRED | `DTWEXBGS` | daily | index |
| `hy_oas` | US high-yield credit spread | FRED | `BAMLH0A0HYM2` | daily | percent |
| `fed_balance_sheet` | Fed total assets | FRED | `WALCL` | weekly | USD millions |
| `wti` | WTI crude spot | FRED | `DCOILWTICO` | daily | USD/barrel |
| `cpi_core` | CPI, core (less food & energy) | FRED | `CPILFESL` | monthly | index |
| `btc_usd` | BTC/USD | CoinGecko | `bitcoin/usd` | real-time (sampled daily) | USD |
| `xrp_btc` | XRP/BTC | CoinGecko | `ripple/btc` | real-time (sampled daily) | ratio |

Deliberately excluded from V1, with the original draft's section for reference: auction internals/bid-to-cover/term-premium (5.1 — no clean free source, high effort for uncertain signal value), breakevens/inflation swaps (5.2 — CPI core alone is enough to test the mechanism), MOVE index (5.4 — no free source found; HY OAS alone carries V1's credit-stress input), BTC ETF flows and stablecoin supply (5.7 — real signal but another new provider integration; first candidate to add once V1 is running), all of 5.6 (growth/labor) and 5.8 (regulatory events) — both explicitly deferred per the original draft's own section 24.

## Two Derived Scores (V1)

Both are `0–100`, computed by pure functions in `lib/macro/derivedMetrics.js`, taking only the day's normalized observations (level + 5-day and 20-day percent/point change) and a versioned weight table. No score is computed from fewer than 3 of its listed inputs on a given day; if more than half an input's required series are missing/stale, the score is still computed but flagged `confidence: "low"` rather than withheld (never withheld — a stale score with visible low confidence beats no score, per the original draft's own section 4.4/19 on graceful degradation).

**`current_crypto_pressure`** — how hostile financial conditions are to crypto *right now*.
Inputs: `us10y` level + velocity, `us30y` level + velocity, `dollar_index` level + velocity, `hy_oas` level + velocity, `btc_usd` 20-day volatility.
Higher = more hostile.

**`forced_liquidity_probability`** — how much pressure is building toward a future policy-liquidity response.
Inputs: `us30y` level + velocity (weighted higher than in the pressure score — long-end stress is the headline signal the original draft called out specifically), `hy_oas` velocity (credit confirming or not confirming Treasury stress), `fed_balance_sheet` velocity, `wti`/`cpi_core` trend (policy room — falling inflation pressure raises this score independent of yield level, per the original draft's Fed-flexibility framing folded into this one score for V1 rather than split into its own).
Higher = more forced-liquidity pressure. Explicitly must NOT move in lockstep with `current_crypto_pressure` — the acceptance criteria below test this directly.

Exact weights, the velocity-window definitions (5-day, 20-day; z-score against a rolling 252-observation window where available), and `macro_model_version = "v1.0.0"` live in `lib/macro/derivedMetrics.js`'s own weight table, overridable via instance config the same way `scoring.weights`/`scoring.typeWeights` already are for Opportunity scoring — see Config below.

## Regime Label (V1)

Four regimes, assigned by one small threshold function over the two scores plus `hy_oas` velocity as the credit-confirmation gate — not an LLM classifier, not an open taxonomy:

| regime | rule (illustrative — exact thresholds live in code, config-overridable) |
|---|---|
| `calm` | both scores below their low threshold |
| `pressure_building` | `current_crypto_pressure` elevated or rising, `forced_liquidity_probability` rising, `hy_oas` not yet spiking |
| `breaking` | `hy_oas` spiking rapidly (credit confirms stress) alongside elevated `current_crypto_pressure` |
| `liquidity_response` | `fed_balance_sheet` expanding week-over-week alongside falling `us30y`/`us10y` |

Every regime assignment carries `supportingSignals` and `contradictorySignals` arrays (signal id + current value + direction) rather than hiding the disagreement the original draft's section 4.6 insisted on preserving — e.g. a `pressure_building` regime with `hy_oas` still calm shows that explicitly as a contradictory signal, not silently.

## Existing Integrations to Read First

- `lib/event-sources/googleCalendarBooking.js` + `ops/reports/pollCalendarBookings.js` — the end-to-end pattern (external read → normalize → dedupe against folded event history → append events → feed `runOpportunityEngine`) that this ticket mirrors exactly, with `runInvestingOpportunityEngine` in place of `runOpportunityEngine`.
- `docs/build-portfolio-sheet-source.md` in full — the closest sibling ticket architecturally (same event-sourced diff/classify/degrade pattern, same authority boundary language). Not yet implemented; read it as a design precedent, don't assume its code exists.
- `lib/opportunities/investingEngine.js` and `lib/roles/investingOpportunity.js` — read before Phase 3. Confirm `marketState` is accepted as an arbitrary object on `triggerEvent.payload.marketState` or passed directly to `runInvestingOpportunityEngine({ marketState, ... })` (both paths exist today, per `lib/roles/investingOpportunity.js`'s `resolvedMarketState = marketState ?? triggerEvent.payload?.marketState ?? null`) — this ticket uses the explicit parameter, not the payload fallback.
- `lib/opportunities/investingSchema.js` — confirms `thesisRefs`/`storyRefs` are validated against real ids surfaced via `evidence.gathered` events, not invented by the role. This ticket produces zero thesis/story ids itself — it only ever populates `marketState`.
- `lib/events/store.js` — `appendEvent`, `queryEvents(dataDir, { type, since })`, hash chain. No new persistence layer.
- `lib/config.js`'s `validateInstanceConfig` and `.e3d-corp/config.schema.json` — read before Phase 1, specifically the `calendar`/`research` object shapes (`*EnvVar`-suffixed secret fields) as the convention to match for the new `macro` config object.
- `lib/authority/policy.js` — read before every phase, as the boundary this ticket must never cross. `ACTION_POLICY` gets no new entry.
- `examples/instance.example.json` and `.gitignore` — confirm which files are tracked before adding the example `macro` block (fully generic — a public FRED API key env var *name*, never a value).

## Shared Constraints

### The authority boundary (non-negotiable, applies to every phase)

Every event and Opportunity this ticket's code produces is authority level 0 (`macro.observation`, `macro.regime.snapshot`, `macro.data.degraded`/`.restored`) or level 1 (an Opportunity from `runInvestingOpportunityEngine`, same as any other Opportunity today). Nothing produced by this ticket reaches level 2+. If a human decision on a macro-derived Opportunity later leads to a real trade, that flows through the **existing, unmodified** `e3d-corp` ↔ `e3d-trade` `capital_mandate` proposal path (see `docs/e3d-corp-e3d-trade-stack-spec.md`) — this ticket defines no new action type and has no shorter path to money moving than "human writes and approves a mandate through the already-existing, separately-reviewed governance layer."

### Provenance is the event itself

No separate "Raw Observation" table. Every `macro.observation` event's payload carries `{ signalId, sourceName, sourceSeriesId, value, units, observedAt, retrievedAt, expectedFrequency, freshnessSeconds }`; the event's own `occurredAt`, hash chain position, and `causationId`/`correlationId` (one correlation id per poll cycle, matching the portfolio-sheet ticket's convention) provide the rest. No new schema for provenance is needed beyond this payload shape.

### Freshness and staleness, not fabrication

Each signal's `expectedFrequency` (`daily`/`weekly`/`monthly`) sets its staleness threshold (e.g. a monthly CPI print is not stale at 25 days old; a daily Treasury yield is stale if unchanged for more than 3 calendar days, which also flags a market-holiday gap correctly rather than as an error). A stale-but-present observation still feeds the derived scores, marked stale in its payload; a derived score computed with any stale input is marked `confidence: "low"`. A fetch that fails outright (network error, malformed response, missing series) does **not** get a fabricated value substituted — see source-health state machine below.

### Source-health state machine

Matches the portfolio-sheet ticket's pattern exactly: `macro.data.degraded` on a poll where any series' fetch/parse fails, appended only if not already degraded (no repeat spam); `macro.data.restored` on the next poll where every series fetches successfully. Degraded state is folded from event history (`foldMacroSourceState(dataDir)`), not a side file. A degraded poll still computes and appends `macro.regime.snapshot` from whatever observations *did* succeed, marked low-confidence, rather than skipping the poll entirely — partial data beats no data as long as it's marked as partial.

### Reproducibility

`computeCryptoPressure`, `computeForcedLiquidityProbability`, and `assignRegime` are pure functions: same observations + same `macroModelVersion` → byte-identical output. No LLM call anywhere in the derivation path. `macroModelVersion` is stamped on every `macro.regime.snapshot`/`.changed` event so a later change to weights or thresholds is visible in the historical record rather than silently reinterpreting old data.

## Config

New optional `macro` section in instance config, matching the `calendar`/`research` convention (secret *names*, not values):

```json
"macro": {
  "fredApiKeyEnvVar": "EXAMPLECO_FRED_API_KEY",
  "weights": {
    "cryptoPressureVersion": "v1.0.0",
    "forcedLiquidityVersion": "v1.0.0"
  }
}
```

Omitting the `macro` key entirely is valid — an instance with no macro source configured simply never polls one, same as `calendar`/`portfolio` are optional today. `weights` is optional; omitted, it uses the code-default weight table for the current `macro_model_version`.

## Phase 1 — Data Clients

### Requirements

- `lib/macro/fred.js`: `getFredSeries({ apiKey, seriesId, observationStart })` — thin `fetch` wrapper over FRED's `series/observations` endpoint, returning `{ seriesId, observations: [{ date, value }] }`, filtering out FRED's `"."` (missing observation) sentinel rather than passing it through as a numeric 0. Non-2xx → throw with status + body text, matching `lib/calendar/googleCalendarApi.js`'s error-handling shape.
- `lib/macro/coingecko.js`: `getSimplePrice({ ids, vsCurrencies })` — thin `fetch` wrapper over `/api/v3/simple/price`, returning the parsed price map. No API key parameter required for V1 (public tier).
- `lib/macro/signalDefinitions.js`: static array of the 10 V1 signal definitions (id, name, source, seriesOrPair, expectedFrequency, units, higherIs semantics per signal — documented, not code-enforced).

### Acceptance Criteria

- `getFredSeries` against a mocked HTTP response returns parsed `{ date, value }` pairs and correctly drops `"."` sentinel rows; against a mocked 4xx/5xx, throws with status + body in the message.
- `getSimplePrice` against a mocked response returns the parsed price map; against a mocked error response, throws rather than returning `undefined`/`NaN`.
- No test makes a live network call; both clients are tested against fixture responses only.
- `signalDefinitions.js` exports exactly the 10 signals in the table above, each with a non-empty `expectedFrequency` in `{daily, weekly, monthly}`.

## Phase 2 — Ingestion, Normalization, Derived Metrics

### Requirements

- Add `macro` to `.e3d-corp/config.schema.json` and `validateInstanceConfig` (`lib/config.js`): `{ fredApiKeyEnvVar: string, weights?: object }`, optional section. `examples/instance.example.json` gets a generic example block (placeholder env var name only).
- `lib/event-sources/macroSignals.js`:
  - `fetchAllSignals({ fredApiKey })` — calls both clients for all 10 signals, returns `{ observations: [...], errors: [...] }` (partial failures collected, not thrown, so one bad series doesn't kill the whole poll).
  - `foldMacroState(dataDir)` — queries `queryEvents` for the most recent `macro.regime.snapshot` and current `macro.data.degraded`/`.restored` status, returning `{ priorSnapshot, degraded }`.
  - `ingestMacroSnapshot(dataDir, instanceConfig)` — orchestrates: fetch → append one `macro.observation` event per successfully-fetched signal → on any failures, append `macro.data.degraded` (only if not already degraded) → on full recovery, append `macro.data.restored` → compute both derived scores and the regime label from the successful observations (Phase 2's `lib/macro/derivedMetrics.js`) → append `macro.regime.snapshot` unconditionally → append `macro.regime.changed` only if the regime label differs from `priorSnapshot.regime`. Returns the list of newly appended events. One `correlationId` per call, generated once, shared across every event from that poll.
- `lib/macro/derivedMetrics.js`: `computeCryptoPressure(observations, weights)`, `computeForcedLiquidityProbability(observations, weights)`, `assignRegime({ cryptoPressure, forcedLiquidityProbability, hyOasVelocity }, thresholds)` — all pure, all documented above under "Two Derived Scores" / "Regime Label."

### Acceptance Criteria

- Given identical fixture observations and the same `macroModelVersion`, `computeCryptoPressure`/`computeForcedLiquidityProbability`/`assignRegime` return byte-identical output across repeated calls (reproducibility, per Shared Constraints).
- A fixture where `us30y` rises sharply while `hy_oas` stays flat produces `current_crypto_pressure` increasing **and** `forced_liquidity_probability` increasing, with `assignRegime` returning `pressure_building`, not `breaking` — this is the test that proves the core product insight (both scores can rise together without collapsing into one number, and the credit-confirmation gate correctly withholds `breaking` until `hy_oas` actually moves).
- A fixture where every series fetch fails produces exactly one `macro.data.degraded` event, zero `macro.observation` events, and no `macro.regime.snapshot` (nothing to compute a snapshot from — a fully degraded poll produces no scores rather than scores from zero inputs).
- A fixture where only `cpi_core` fails (partial failure) still produces a `macro.regime.snapshot` computed from the other 9 signals, marked `confidence: "low"`, plus a `macro.data.degraded` event for the one failed series.
- A degraded-then-recovered sequence (fail, fail, succeed-fully) produces exactly one `macro.data.degraded` and exactly one `macro.data.restored`.
- Two consecutive polls with no regime change produce two `macro.regime.snapshot` events but zero `macro.regime.changed` events; a poll where the regime label differs from the prior snapshot produces exactly one `macro.regime.changed`.
- `config validate` accepts an instance config with a generic `macro` block and rejects one missing `fredApiKeyEnvVar`; omitting `macro` entirely remains valid.

## Phase 3 — Opportunity Integration, CLI, Cron Wiring

### Requirements

- `ops/reports/pollMacroSignals.js` (mirrors `pollCalendarBookings.js`/the portfolio-sheet ticket's poll script structure): loads instance config, requires `config.macro`, reads the FRED key from the configured env var, calls `ingestMacroSnapshot`, and for a resulting `macro.regime.changed` event (not the plain `.snapshot`), builds a `triggerEvent` and calls `runInvestingOpportunityEngine({ instanceConfig, dataDir, triggerEvent, researchAdapter, marketState })` where `marketState` is the full snapshot (`regime`, `currentCryptoPressure`, `forcedLiquidityProbability`, `supportingSignals`, `contradictorySignals`, `confidence`). Logs the resulting Opportunity id/title/score, matching the calendar poll's logging pattern. A plain `.snapshot` with no regime change does not trigger the opportunity engine — only an actual regime transition does, to avoid a daily flood of near-duplicate Opportunities.
- `ops/run/run-macro-poll.sh` (new, mirrors `run-calendar-poll.sh`: sources instance `.env`, execs the poll script). Daily cadence (once per morning, after markets/FRED update overnight data) — not 15-minute, since most V1 series are daily-or-slower; document the exact cron line in Deployment Notes but do not touch `ecosystem.config.cjs` (scheduled work runs via crontab, matching the portfolio-sheet ticket's own deployment note about this instance's PM2/crontab split).
- `e3d-corp macro status --instance <name>` CLI command (added to `lib/cli.js`'s `COMMANDS` table, matching `portfolio status`/`budget status` style): runs one on-demand `ingestMacroSnapshot` call and prints the current regime, both scores, each signal's latest value + freshness, and — if a prior snapshot exists — the day-over-day delta on both scores. Reports source health (`ok` / `degraded since <event time>`).

### Acceptance Criteria

- A stubbed `macro.regime.changed` event run through `pollMacroSignals.js` (both API clients and `runInvestingOpportunityEngine` mocked) produces exactly one Opportunity, attributed to the poll's `correlationId`, with `marketState.regime` matching the computed regime — and produces no Proposal, no send-outreach, nothing above authority level 1.
- `macro status --instance <name>` run against mocked clients prints regime, both scores, and per-signal freshness; with a prior snapshot present, also prints day-over-day score deltas.
- `config validate` continues to pass unmodified for every existing example/fixture instance config (macro block is optional).
- `event verify --instance <name>` passes over a chain including macro-sourced events.
- Full existing suite (`npm test`) passes unmodified in behavior; new tests live in `test/macroSignals.test.js` (event-sourcing/ingestion), `test/macroDerivedMetrics.test.js` (pure scoring functions), and CLI tests added alongside existing CLI tests — matching this repo's recent convention of topical test files (`capitalMandateProposal.test.js`, `tradeOutcomeWebhook.test.js`) rather than a new `phase11.test.js`.
- No test makes a live network call to FRED or CoinGecko.

## Deployment Notes (for whoever executes this spec, not itself a phase)

- Register a free FRED API key (api.stlouisfed.org) before this can run against real data; the key's value goes in `.e3d-corp/instance/<name>/<name>.env` as the value of whatever env var `macro.fredApiKeyEnvVar` names — never in a tracked file.
- CoinGecko's public tier is rate-limited; a once-daily poll is well within it. If a future ticket increases polling frequency, revisit whether a paid tier or API key is needed then.
- Do not commit or push until the operator has reviewed the diff.

## Deferred (explicitly, not forgotten)

In rough order of "most likely useful next," once V1's two scores and four regimes have run against real data long enough to sanity-check:

1. Fed Flexibility, Break Risk, Crypto Liquidity Transmission as separate scores (or a decision that they're not worth separating from the two V1 scores after all — that's a legitimate outcome too).
2. BTC ETF flow data and stablecoin supply as additional crypto-transmission evidence (new provider integration).
3. A `macro replay --since <date>` CLI command over the existing event log — no new storage, just a query + the same pure derivation functions run against historical observations.
4. Daily snapshot export to the operator's existing Google Sheet (extends, doesn't require, the portfolio-sheet ticket's `lib/sheets/` client once that ticket exists).
5. Regulatory/Fed-speech event ingestion as structured events (would need the same untrusted-external-text handling discipline as any future news/NLP source in this stack — not started until a concrete need appears).
6. An 8-way (or dimensional) regime model, if the 4-regime V1 model turns out to be too coarse in practice.
