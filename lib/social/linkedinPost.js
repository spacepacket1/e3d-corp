// LinkedIn Posts API transport (POST /rest/posts). Only called from the
// registered `linkedin-post` executor after assertProposalAuthorized.
// Token file (LINKEDIN_TOKEN_FILE json): access_token, person_urn, expiry_date.
import fs from 'node:fs';

export const LINKEDIN_POSTS_URL = 'https://api.linkedin.com/rest/posts';
export const LINKEDIN_API_VERSION = '202504';

export async function postToLinkedIn({ text }, { env = process.env, fetchImpl = fetch, now = Date.now, apiVersion = LINKEDIN_API_VERSION } = {}) {
  const file = env.LINKEDIN_TOKEN_FILE;
  if (!file) throw new Error('LINKEDIN_TOKEN_FILE is not set');
  let tokenData;
  try {
    tokenData = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`LinkedIn token file unreadable: ${error.message}`);
  }
  if (!tokenData.access_token || !tokenData.person_urn) {
    throw new Error('LinkedIn token file needs access_token and person_urn');
  }
  if (tokenData.expiry_date && Number(tokenData.expiry_date) <= now()) {
    throw new Error('LinkedIn access token has expired; re-authorize (LinkedIn tokens are not refreshed here)');
  }
  const author = String(tokenData.person_urn).startsWith('urn:li:') ? tokenData.person_urn : `urn:li:person:${tokenData.person_urn}`;
  const response = await fetchImpl(LINKEDIN_POSTS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenData.access_token}`,
      'content-type': 'application/json',
      'x-restli-protocol-version': '2.0.0',
      'linkedin-version': apiVersion
    },
    body: JSON.stringify({
      author,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    })
  });
  if (!response.ok) throw new Error(`LinkedIn post returned HTTP ${response.status}`);
  const urn = response.headers?.get?.('x-restli-id') ?? response.headers?.get?.('x-linkedin-id');
  if (!urn) throw new Error('LinkedIn did not return a post id (x-restli-id header)');
  return { postId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}
