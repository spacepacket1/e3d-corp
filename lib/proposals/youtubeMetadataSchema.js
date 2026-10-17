export const YOUTUBE_METADATA_PROPOSAL_TYPE = 'youtube-metadata-change';
const CHANGEABLE = ['title', 'description', 'tags'];
export const YOUTUBE_LIMITS = Object.freeze({ title: 100, description: 5000, tagsTotalChars: 500 });

const isString = (v) => typeof v === 'string';

// Validates and normalizes a youtube-metadata-change payload. Throws with every problem listed.
export function normalizeYoutubeMetadataPayload(payload) {
  const errors = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!isString(p.videoId) || p.videoId.trim() === '') errors.push('videoId: required');
  if (!p.changes || typeof p.changes !== 'object') errors.push('changes: required object');
  const changes = {};
  for (const key of CHANGEABLE) {
    const value = p.changes?.[key];
    if (value === undefined) continue;
    if (key === 'tags') {
      if (!Array.isArray(value) || value.some((t) => !isString(t) || t.trim() === '')) errors.push('changes.tags: must be an array of non-empty strings');
      else if (value.join(',').length > YOUTUBE_LIMITS.tagsTotalChars) errors.push(`changes.tags: over ${YOUTUBE_LIMITS.tagsTotalChars} characters in total`);
      else changes.tags = value.map((t) => t.trim());
    } else if (!isString(value) || (key === 'title' && value.trim() === '')) {
      errors.push(`changes.${key}: must be a${key === 'title' ? ' non-empty' : ''} string`);
    } else if (value.length > YOUTUBE_LIMITS[key]) {
      errors.push(`changes.${key}: over the ${YOUTUBE_LIMITS[key]} character limit`);
    } else {
      changes[key] = key === 'title' ? value.trim() : value;
    }
  }
  const unknown = Object.keys(p.changes ?? {}).filter((k) => !CHANGEABLE.includes(k));
  if (unknown.length) errors.push(`changes: unsupported field(s) ${unknown.join(', ')}`);
  if (Object.keys(changes).length === 0 && errors.length === 0) errors.push('changes: nothing to change');
  if (!p.before || typeof p.before !== 'object') errors.push('before: the current values of the changed fields are required (they are the rollback)');
  else for (const key of Object.keys(changes)) if (p.before[key] === undefined) errors.push(`before.${key}: required`);
  if (!isString(p.reason) || p.reason.trim() === '') errors.push('reason: required');
  if (errors.length) throw new Error(`Invalid youtube-metadata-change payload:\n- ${errors.join('\n- ')}`);
  const before = {};
  for (const key of Object.keys(changes)) before[key] = p.before[key];
  return {
    videoId: p.videoId.trim(),
    videoTitle: isString(p.videoTitle) ? p.videoTitle : null,
    changes,
    before,
    baseSnippetHash: isString(p.baseSnippetHash) ? p.baseSnippetHash : null,
    reason: p.reason.trim(),
    hypothesis: isString(p.hypothesis) ? p.hypothesis.trim() : null,
    opportunityId: isString(p.opportunityId) ? p.opportunityId : null,
    rollbackOf: isString(p.rollbackOf) ? p.rollbackOf : null
  };
}
