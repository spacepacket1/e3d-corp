import { createYoutubeClient } from './youtubeApi.js';
import { createOAuthTokenProvider, readApiKeyFile } from './youtubeAuth.js';
import { resolveThresholds } from '../youtube/thresholds.js';

const DEFAULTS = Object.freeze({
  apiKeyEnvVar: 'YOUTUBE_API_KEY',
  minSampleIntervalMinutes: 360,
  maxVideos: 50,
  maxCommentsPerVideo: 20
});

export function resolveYoutubeConfig(instanceConfig) {
  const youtube = instanceConfig?.research?.youtube;
  if (!youtube || typeof youtube.channelId !== 'string' || youtube.channelId.trim() === '') {
    throw new Error('research.youtube.channelId is not configured; the YouTube monitor has nothing to monitor');
  }
  return {
    channelId: youtube.channelId.trim(),
    apiKeyEnvVar: youtube.apiKeyEnvVar ?? DEFAULTS.apiKeyEnvVar,
    apiKeyFile: youtube.apiKeyFile ?? null,
    oauth: youtube.oauth ?? null,
    apiBaseUrl: youtube.apiBaseUrl ?? null,
    minSampleIntervalMs: (youtube.minSampleIntervalMinutes ?? DEFAULTS.minSampleIntervalMinutes) * 60_000,
    maxVideos: youtube.maxVideos ?? DEFAULTS.maxVideos,
    maxCommentsPerVideo: youtube.maxCommentsPerVideo ?? DEFAULTS.maxCommentsPerVideo,
    thresholds: resolveThresholds(youtube.thresholds),
    typeWeights: youtube.typeWeights ?? {}
  };
}

// Builds the client from instance config. Preference order for reads: API key from the env var, API key from a
// private (0600) file, then OAuth. A missing credential does not throw here: the first call will fail with an
// auth error, which the sampler records as a degraded event instead of crashing.
export function createYoutubeClientFromConfig(instanceConfig, { env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const config = resolveYoutubeConfig(instanceConfig);

  let apiKey = env[config.apiKeyEnvVar] || null;
  if (!apiKey && config.apiKeyFile) apiKey = readApiKeyFile(config.apiKeyFile);

  const getAccessToken = config.oauth?.tokenFile && config.oauth?.clientSecretFile
    ? createOAuthTokenProvider({
        tokenFile: config.oauth.tokenFile,
        clientSecretFile: config.oauth.clientSecretFile,
        tokenUrl: config.oauth.tokenUrl ?? undefined,
        fetchImpl,
        now
      })
    : null;

  return createYoutubeClient({
    baseUrl: config.apiBaseUrl ?? undefined,
    apiKey,
    getAccessToken,
    fetchImpl
  });
}
