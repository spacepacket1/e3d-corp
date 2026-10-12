// Pulls one real, concrete data point from e3d.ai (via the existing local
// e3d-mcp server, same stdio-MCP transport as lib/research/knowledgeBaseMcp.js)
// for a matched engagement topic. Exists so xEngagementReply.js never has to
// invent a number or claim: per the no-fabrication principle, a reply either
// cites something e3d.ai actually returned right now, or it says nothing
// product-specific at all. Degrades to an empty findings list (never throws)
// so a stuck/unavailable e3d-mcp server just means duller, still-honest
// drafts, not a broken cron run.
import fs from 'node:fs';
import path from 'node:path';
import { callMcpToolViaStdio } from './mcpTransport.js';
import { getRootDir } from '../config.js';

const DEFAULT_SERVER_PATH = '../e3d-mcp/server.js';

function resolveServerPath(serverPath) {
  const resolved = serverPath || DEFAULT_SERVER_PATH;
  return path.isAbsolute(resolved) ? resolved : path.resolve(getRootDir(), resolved);
}

function parseToolJson(toolResult) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  const text = content.find((item) => item?.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

async function callTool(toolName, toolArgs, { serverPath, callMcp }) {
  if (callMcp) {
    return callMcp(toolName, toolArgs);
  }
  const resolvedPath = resolveServerPath(serverPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`e3d-mcp server not found: ${resolvedPath}`);
  }
  return callMcpToolViaStdio({
    serverPath: resolvedPath,
    cwd: path.dirname(resolvedPath),
    toolName,
    toolArgs
  });
}

function storyFinding(story) {
  const headline = story?.headline || story?.title || story?.summary;
  if (!headline) return null;
  const symbol = story?.symbol || story?.token_symbol;
  return {
    source: 'e3d.ai search_stories',
    text: symbol ? `${symbol}: ${headline}` : headline
  };
}

function thesisFinding(thesis) {
  if (!thesis?.direction || !thesis?.thesis_text) return null;
  const symbol = thesis?.symbol || thesis?.token_symbol || 'a token';
  return {
    source: 'e3d.ai get_theses',
    text: `${symbol} active ${thesis.direction} thesis (conviction ${thesis.conviction ?? 'n/a'}): ${thesis.thesis_text}`
  };
}

async function searchStories(query, { serverPath, callMcp }) {
  const storiesResult = await callTool('search_stories', { q: query, scope: 'any', limit: 5 }, { serverPath, callMcp });
  const stories = parseToolJson(storiesResult);
  const storyList = Array.isArray(stories) ? stories : stories?.results ?? stories?.data ?? [];
  return storyList.map(storyFinding).filter(Boolean);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were',
  'be', 'with', 'at', 'by', 'this', 'that', 'it', 'as', 'from', 'your', 'you', 'i', 'what', 'how',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'about', 'just', 'like', 'my', 'me', 'we',
  'us', 'our', 'any', 'all', 'not', 'has', 'have', 'had'
]);

// As verified live against e3d.ai's own backend (server/spacepacket.js's
// /stories handler): "DB-wide search is Premium+ only. For non-subscribers
// and free subscribers, the client can still perform client-side filtering
// on the returned payload" - so search_stories' `q` is a documented no-op at
// the anonymous tier this runs at, not a bug to work around with a better
// query string. The fix is doing exactly what that comment says: take the
// unfiltered recent batch and rank it ourselves by real keyword overlap with
// the post, falling back to the next unused item (not always the first) when
// nothing actually overlaps, so a reply never cites the same finding twice in
// a run just because the server returned it first.
function significantWords(text) {
  return ((text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
}

function pickBestFinding(found, exclude, matchWords) {
  const candidates = found.filter((f) => !exclude.has(f.text));
  if (candidates.length === 0) return undefined;
  if (matchWords.length === 0) return candidates[0];

  let best = null;
  for (const candidate of candidates) {
    const text = candidate.text.toLowerCase();
    const score = matchWords.reduce((count, word) => count + (text.includes(word) ? 1 : 0), 0);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }
  return best.score > 0 ? best.candidate : candidates[0];
}

// Never falls all the way to "a token price" alone - a bare price move
// isn't a genuine insight on its own and would read as filler, not a
// finding.
export async function gatherFindings({ topic, postText, serverPath, callMcp, excludeFindingTexts } = {}) {
  const exclude = excludeFindingTexts instanceof Set ? excludeFindingTexts : new Set();
  const hasTopic = typeof topic === 'string' && topic.trim() !== '';
  const hasPostText = typeof postText === 'string' && postText.trim() !== '';
  if (!hasTopic && !hasPostText) {
    return { checked: false, findings: [], reason: 'no topic or post text to search findings for' };
  }

  const matchWords = significantWords(`${postText ?? ''} ${topic ?? ''}`);

  try {
    const stories = await searchStories(postText || topic, { serverPath, callMcp });
    const picked = pickBestFinding(stories, exclude, matchWords);
    if (picked) return { checked: true, findings: [picked] };
  } catch {
    // fall through to theses
  }

  try {
    const thesesResult = await callTool('get_theses', { status: 'active', limit: 5 }, { serverPath, callMcp });
    const theses = parseToolJson(thesesResult);
    const thesisList = Array.isArray(theses) ? theses : theses?.results ?? theses?.data ?? [];
    const picked = pickBestFinding(thesisList.map(thesisFinding).filter(Boolean), exclude, matchWords);
    if (picked) return { checked: true, findings: [picked] };
  } catch (error) {
    return { checked: false, findings: [], reason: `e3d-mcp unavailable: ${error.message}` };
  }

  return { checked: true, findings: [] };
}

export { DEFAULT_SERVER_PATH };
