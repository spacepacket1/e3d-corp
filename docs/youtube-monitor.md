# YouTube channel monitor

e3d-corp watches a YouTube channel (yours), records how each video is doing, notices when something is worth a human's
attention, drafts what to do about it, and, only after you approve, edits a video's title/description/tags and later
measures whether that helped. Everything is an event in the normal hash-chained log, so it is auditable the same way
as every other e3d-corp workflow.

Nothing here posts anywhere on its own. Posting to X and LinkedIn stays manual (drafts are queued for you).

## What it does, in order

| Step | Command | Authority | Model? |
| --- | --- | --- | --- |
| Sample every upload: views, likes, comment count, current title/description/tags, new comments | `youtube sample` | 0 (read-only) | no |
| Turn signals into scored Opportunities, each citing the sampled events the numbers came from | `youtube scan` | 1 (internal) | no |
| Plain-text weekly report | `youtube report` | 0 | no |
| Draft audience copy, comment replies, and a metadata change for one opportunity | `youtube propose <opportunity-id>` | 1 for drafts, **2 for the metadata Proposal** | yes (`youtube.growthDraft`) |
| Approve (executes at once, as for every level-2 action) | `proposals approve <id> --reason ...` | 2 | no |
| Retry an approved change that was refused or failed | `youtube apply <proposal-id>` | 2 | no |
| Undo a change (creates a new pending proposal; needs approval too) | `youtube rollback <proposal-id>` | 2 | no |
| Record before/after results at +24h and +7d | `youtube measure` | 0 | no |
| Scheduled pass: sample + scan + measure | `youtube poll` / `ops/run/run-youtube-poll.sh` | 0-1 | no |

All commands take `--instance <name>`. `sample`, `poll` accept `--force` (ignore the sampling interval). Every command
accepts `--now <iso>` for replaying a timeline; tests use it, you normally will not.

### Policy: what needs approval and what does not

`ACTION_POLICY` v7 adds one type, **`youtube-metadata-change` (level 2)**: changing a published video's title,
description or tags on the real channel. It is reversible (the previous values are stored and `youtube rollback`
proposes restoring them) but external, so it follows the same rule as outreach: a human approves, and approval executes.

Audience copy (LinkedIn / X / community post) and comment replies are **level 1: internal drafts**, recorded as
`youtube.draftQueued` events (the same precedent as `x.draftQueued`) for you to review and post by hand. Per the repo
convention, level 0-1 things never become Proposals, so they are not in the policy table. Nothing in this feature posts
a comment, a tweet or a community post.

### The signals (all deterministic, no model)

Formulas live in the header of `lib/youtube/metrics.js`; thresholds in `lib/youtube/thresholds.js` (override any under
`research.youtube.thresholds`).

- **views/day** = views at the latest sample / age in days (age floored at 0.25 days).
- **window delta** = views now minus views at the newest sample at or before (now - window). Needs a baseline sample
  within 12h of the window start, otherwise the answer is "insufficient data", never a guess.
- **channel baseline** = median views/day of the *other* videos older than 3 days. Needs at least 2 such videos.
- **stall**: at least 3 days old, gained < 10 views in the last 48h, and lifetime views/day < 0.25 x channel median.
- **breakout**: gained >= 50 views in the last 24h and that rate is >= 3 x channel median.
- **comments**: >= 2 new comments in the last 24h.
- **trend** = (last-24h views/day) / (last-7d views/day): >= 1.5 accelerating, <= 0.5 slowing, otherwise steady.

An Opportunity is raised at most once per video per signal per 7 days. Confidence is a small fixed table (0.5 to 0.9),
scored by the existing scorer with `research.youtube.typeWeights`. Opportunity types: `youtube-underperforming-video`,
`youtube-breakout-video`, `youtube-comments-awaiting-reply`. They are not sales leads (`pursuable: false`).

### The change, and how it is protected

`youtube-metadata-change` proposals store the new values, the previous values (the rollback), and a hash of the video's
snippet when proposed. On approval the executor:

1. refuses unless the proposal is approved and policy-authorized;
2. does nothing if this proposal was already applied (idempotent);
3. reads the live snippet and **refuses on conflict** if the video was edited after the proposal (someone changed it in
   Studio): nothing is overwritten, a `youtube-metadata-change.failed` event records why, and the approval stands so
   `youtube apply` can retry once you decide what you want;
4. needs OAuth (an API key cannot write). Without it, it fails closed;
5. sends the **full** snippet merged with the change. `videos.update` replaces any snippet field you omit and requires
   `title` and `categoryId`, so a partial body would blank the description;
6. records before/after values and the video's views/day at that moment.

A model's suggestion is dropped before it can become a proposal if it has a title over 100 characters, stacked
exclamation marks, ALL-CAPS shouting, stock clickbait phrases, a description that drops an existing link, or no
rationale. The prompt tells the model to answer "no change" when the metadata is already fine.

### Measuring results, honestly

At +24h and +7d after a change, `youtube measure` compares views/day in the equal-length window before vs after, and
divides by the same ratio on the channel's other videos (so a channel-wide rise is not credited to the title). The result
is recorded as outcome type `youtube.metadata_change.measured` with an Experience on the proposal's chain, citing the
sample events used. It is deliberately **not** counted as a positive business outcome in evaluation metrics.

It always carries caveats: correlation is not causation; views/day naturally decays with age; few control videos make the
control weak. Windows with too few views (`measureMinViews`, default 30) are skipped, not recorded. The verdict is
`improved` / `declined` only beyond +/-25% relative to the channel, otherwise `inconclusive`.

## Setup you need to do (nothing below has been done)

### 1. A YouTube Data API key (for monitoring)

A plain API key is enough for everything except editing videos: public statistics need no OAuth, and a key does not
expire (unlike the current OAuth token, below).

1. Google Cloud console, **the project that already has YouTube Data API v3 enabled** (APIs & Services, Library, confirm it
   shows as enabled).
2. APIs & Services, Credentials, **Create credentials, API key**.
3. Edit the key: **API restrictions, Restrict key, YouTube Data API v3 only**. (Optionally restrict by IP if the monitor
   runs from a fixed address.)
4. Save it to a private file and point the config at it, or export it:

   ```
   umask 077; printf '%s' 'YOUR_KEY' > ~/.config/e3d-corp/youtube-api-key
   ```

   The monitor refuses a key file readable by group/others (`chmod 600`). Alternatively set `YOUTUBE_API_KEY`
   (the variable name is configurable with `apiKeyEnvVar`). The key is only ever sent to Google in the request, and is not
   written to events or logs.

### 2. Instance config

Add under `research` in `.e3d-corp/instance/<name>/instance.json`:

```json
"youtube": {
  "channelId": "UC4jv8ol83eYal-TI8O_EveQ",
  "apiKeyFile": "/Users/you/.config/e3d-corp/youtube-api-key",
  "minSampleIntervalMinutes": 360,
  "thresholds": {},
  "typeWeights": {}
}
```

and a model for drafting (only `youtube propose` uses it):

```json
"roles": { "youtube.growthDraft": { "provider": "claude" } }
```

Videos are discovered from the channel's uploads playlist, so new videos appear automatically; no video ids are configured.

### 3. OAuth (only needed to actually apply a change)

Add `research.youtube.oauth` with `tokenFile` (JSON with `access_token`, `expiry_date`, `refresh_token`) and `clientSecretFile` (Google's
downloaded client-secret JSON). The monitor reads them and refreshes the access token in memory; it never rewrites them. **Heads-up:** while the
Google OAuth app is in *Testing* mode the refresh token expires every 7 days (`invalid_grant`), so an approval a week later
can fail with a clear auth error until you re-authorize. Moving the app to production, or re-consenting, fixes that. The
read-only monitor does not depend on OAuth at all.

### 4. Schedule it (optional, not installed)

```
0 */3 * * * /Users/mini/e3d-corp/ops/run/run-youtube-poll.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/youtube-poll.log 2>&1
```

Inside the sampling interval a run makes zero API calls, so this just guarantees a quick retry after a failure. The
wrapper sources the instance's `futco.env`; put `YOUTUBE_API_KEY` there if you use the env var instead of a key file.
Exit code 2 means YouTube could not be read (the failure is stored as degraded evidence and never as zeros).

## Quota

The default is 10,000 units/day. Reads cost 1 unit; `videos.update` costs 50. A sample of N videos costs about
1 (channel) + ceil(N/50) pages of the uploads playlist + ceil(N/50) video batches + 1 per video whose comment count grew.
A 6-hourly sample of a channel with 20 videos is well under 100 units/day. A metadata change costs 51.

## What it cannot see yet

The Data API's public statistics are views, likes and comment counts. **Watch time, average view duration, click-through
rate, impressions and retention are not available without the YouTube Analytics API**, which needs the
`yt-analytics.readonly` scope and a fresh OAuth consent. Those are the numbers that tell you whether a new title or
thumbnail actually worked, so measurement here is views-only and weaker than it will be. That is the natural next step once
OAuth is stable.

Other honest limits: views are a weak signal of quality (they mix search, suggestions, shares and bots); with a few videos
and tens of views, medians and rates are noisy; the monitor cannot change thumbnails or see traffic sources; and it never
verifies that a video's *content* matches a drafted claim, which is why every draft goes past a human.

## Where things live

`lib/research/youtubeApi.js` (client), `lib/event-sources/youtubeChannelSignal.js` (sampler),
`lib/youtube/` (series, metrics, thresholds, measure, report, propose, poll), `lib/opportunities/youtubeOpportunities.js`,
`lib/roles/youtubeGrowthDraft.js`, `lib/proposals/youtubeMetadata*.js`, `lib/actions/youtubeMetadataChange.js`,
`lib/youtubeCli.js`. Tests run entirely against local fakes (`test/helpers/fakeYoutubeServer.js`): no network, no model spend.
