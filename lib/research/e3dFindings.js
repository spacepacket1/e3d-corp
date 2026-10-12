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

// Tries, in order, the most specific real evidence down to the most general:
// a matching on-chain story, then any active thesis, then nothing. Never
// falls all the way to "a token price" alone - a bare price move isn't a
// genuine insight on its own and would read as filler, not a finding.
export async function gatherFindings({ topic, serverPath, callMcp } = {}) {
  if (typeof topic !== 'string' || topic.trim() === '') {
    return { checked: false, findings: [], reason: 'no topic to search findings for' };
  }

  try {
    const storiesResult = await callTool('search_stories', { q: topic, scope: 'any', limit: 3 }, { serverPath, callMcp });
    const stories = parseToolJson(storiesResult);
    const storyList = Array.isArray(stories) ? stories : stories?.results ?? stories?.data ?? [];
    const found = storyList.map(storyFinding).filter(Boolean);
    if (found.length > 0) {
      return { checked: true, findings: found.slice(0, 1) };
    }
  } catch {
    // fall through to theses
  }

  try {
    const thesesResult = await callTool('get_theses', { status: 'active', limit: 5 }, { serverPath, callMcp });
    const theses = parseToolJson(thesesResult);
    const thesisList = Array.isArray(theses) ? theses : theses?.results ?? theses?.data ?? [];
    const found = thesisList.map(thesisFinding).filter(Boolean);
    if (found.length > 0) {
      return { checked: true, findings: found.slice(0, 1) };
    }
  } catch (error) {
    return { checked: false, findings: [], reason: `e3d-mcp unavailable: ${error.message}` };
  }

  return { checked: true, findings: [] };
}

export { DEFAULT_SERVER_PATH };
