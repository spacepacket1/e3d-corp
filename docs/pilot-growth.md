# Pilot growth loop

Everything here is about Pilot (pilot.e3d.ai): a multi-model debate service (several frontier models answer independently, disagreement is recorded), sold as credit packs and Basic/Pro plans. Sign-up is open; there is an MCP server; the ChatGPT plugin is in OpenAI review (never described as live). Wording rule: "multi-model".

## The loop

1. Research (daily, `ops/run/run-pilot-research.sh`): Tavily searches for multi-model / LLM-council / debate tools, MCP and ChatGPT directory listings, HN and Reddit mentions. `pilot.competitorBrief` writes a `pilot.competitorBrief.created` event with cited URLs. If search fails, the brief is stored with `provenance.degraded = true` and no LLM call is made.
2. Content (weekly, `ops/run/run-pilot-content.sh`): `pilot.contentDraft` drafts X and LinkedIn text/link posts. Every draft lists the fact ids it relies on (`lib/pilot/growthFacts.js`, plus the optional `pilotGrowth.factsFile`, e.g. real metrics and real debate examples). Drafts that cite nothing, cite unknown facts, contain URLs not in the facts, overclaim, or exceed the platform limit are dropped. Each survivor becomes a pending `x-post` or `linkedin-post` Proposal.
3. Ads (opt in with `--with-ads`): `pilot.adCopy` produces Meta copy variants and an audience and creates a pending `pilot-ad-campaign` Proposal.
4. The owner decides. Nothing posts or spends without an owner Decision.
5. Outcomes: an executed post appends `x.posted` / `linkedin.posted` plus a `social.post.published` Outcome carrying the post URL.

The owner posts video natively himself; these actions are text and link posts only (an image path is supported for X).

## Guardrails

- Human gate: all proposals start `pending`. Executors call `assertProposalAuthorized` first, so a pending, rejected, wrong-type or wrong-level proposal cannot post.
- `x-post`, `linkedin-post`: authority level 2 (policy v8): approval and execution are the same call. Posting is idempotent per proposal.
- `pilot-ad-campaign`: authority level 3 and NO executor is registered. Approving records the decision; launching the campaign in Meta stays manual. Payload must carry:
  - monthly ceiling, default and maximum $300 (`pilotGrowth.adMonthlyCeilingUsd`),
  - a per-day cap of at most ceiling / 20 (a full month at that rate cannot breach the ceiling),
  - a kill rule: `pauseIfCpaUsdAbove` (cost per sign-up) and `pauseIfZeroSignupsAfterSpendUsd` (at most half the ceiling).
  Proposals missing any of these are rejected at creation.
- Claims: no "multi-LLM", no accuracy guarantees, no "ChatGPT plugin is live", no clickbait, no invented numbers or URLs.
- `pilotGrowth.dryRun: true` makes the executors return a preview and post nothing.
- Tests never post: they use fake transports and fake fetch.

## How the owner approves

Same as any proposal: the e3d-corp web UI (`run-futco-web.sh`) or the e3d-corp CLI decide command (see `e3d-corp help`). Approving an `x-post` or `linkedin-post` posts immediately. Approving a `pilot-ad-campaign` only records the decision.

## Credentials (names only)

- X search (read): `X_SEARCH_BEARER_TOKEN`; if missing or HTTP 401, an app-only bearer is derived in memory from `X_OAUTH1_CONSUMER_KEY`/`X_OAUTH1_CONSUMER_SECRET` and the result is flagged `auth.degraded`.
- X post: OAuth2 user token from `X_TOKEN_FILE` (or `X_ACCESS_TOKEN`), refreshed with `X_CLIENT_ID`/`X_CLIENT_SECRET` (the token file is rewritten because refresh tokens rotate); fallback OAuth1 `X_OAUTH1_*`.
- LinkedIn: `LINKEDIN_TOKEN_FILE` (access_token, person_urn, expiry_date). Tokens are not refreshed; an expired token fails with a clear message.

## Live vs dry

Live now (verified): X search with the derived bearer (read-only probe returned results). Everything else is built and tested against fakes only and has never touched X, LinkedIn, Meta or Tavily from this code: X/LinkedIn posting, media upload, the three roles' real LLM output, the cron scripts. Nothing is enabled in cron until the owner adds the lines.

## Config transition

`node ops/migrate-instance-to-pilot.js --instance futco` is a dry run (prints the change summary). `--apply` backs up `instance.json` to `instance.json.pre-pilot.<timestamp>.bak` and writes the new config. Old crypto/oppscan/consulting topics, X queries and type weights are kept under `archived`. Note: `x.engagementReply` still grounds replies in e3d.ai crypto findings (`lib/research/e3dFindings.js`), so with Pilot queries it will find no findings and queue no reply drafts until that role is regrounded in Pilot facts.

## Cron

```
# daily Pilot market research, 07:30
30 7 * * * /Users/mini/e3d-corp/ops/run/run-pilot-research.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/pilot-research.log 2>&1
# weekly Pilot content drafts, Mondays 08:00 (append --with-ads to also queue an ad proposal)
0 8 * * 1 /Users/mini/e3d-corp/ops/run/run-pilot-content.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/pilot-content.log 2>&1
```
