import { sampleChannel } from '../event-sources/youtubeChannelSignal.js';
import { scanYoutubeSignals } from '../opportunities/youtubeOpportunities.js';
import { measureAppliedChanges } from './measure.js';

// The scheduled pass: sample -> scan -> measure. No LLM and no writes to the channel: drafting is `youtube propose`
// and changing the channel needs an approved proposal.
export async function runYoutubePoll({ dataDir, instanceConfig, client, now = new Date(), force = false }) {
  const sample = await sampleChannel({ dataDir, instanceConfig, client, now, force });
  const scan = scanYoutubeSignals({ dataDir, instanceConfig, now });
  const measure = measureAppliedChanges(dataDir, { instanceConfig, now });
  return { sample, scan, measure };
}
