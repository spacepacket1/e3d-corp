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

// As verified live against e3d.ai's own API: search_stories' `q` parameter
// does not filter at all - querying it with postText, a topic label, or
// outright gibberish returns the identical top result every time. The 5
// items it does return are each real and distinct from one another, just
// not query-relevant, so "search on more specific text" cannot fix this -
// the fix has to be rotation. `excludeFindingTexts` (a Set the caller
// accumulates across a run) lets gatherFindings skip whatever was already
// used and surface the next real, distinct item instead of repeating one
// finding across every drafted reply, which would be an obvious bot tell
// and undermine the "genuine insight" the reply is supposed to contain.
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

  const pickFresh = (found) => found.find((f) => !exclude.has(f.text));

  try {
    if (hasPostText) {
      const fresh = pickFresh(await searchStories(postText, { serverPath, callMcp }));
      if (fresh) return { checked: true, findings: [fresh] };
    }
    if (hasTopic) {
      const fresh = pickFresh(await searchStories(topic, { serverPath, callMcp }));
      if (fresh) return { checked: true, findings: [fresh] };
    }
  } catch {
    // fall through to theses
  }

  try {
    const thesesResult = await callTool('get_theses', { status: 'active', limit: 5 }, { serverPath, callMcp });
    const theses = parseToolJson(thesesResult);
    const thesisList = Array.isArray(theses) ? theses : theses?.results ?? theses?.data ?? [];
    const fresh = pickFresh(thesisList.map(thesisFinding).filter(Boolean));
    if (fresh) return { checked: true, findings: [fresh] };
  } catch (error) {
    return { checked: false, findings: [], reason: `e3d-mcp unavailable: ${error.message}` };
  }

  return { checked: true, findings: [] };
}

export { DEFAULT_SERVER_PATH };
