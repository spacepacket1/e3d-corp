import fs from 'node:fs';
import path from 'node:path';
import { callMcpToolViaStdio } from './mcpTransport.js';
import { getRootDir } from '../config.js';

const FUTCO_DEFAULT_URL = 'http://127.0.0.1:4110';
const FUTCO_REPO_SERVER_PATH = path.resolve(getRootDir(), '..', 'futco-mcp', 'server.js');

function isLocalFutcoUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port === '4110'
    );
  } catch {
    return false;
  }
}

function parseToolContent(toolResult) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  const text = content.find((item) => item?.type === 'text')?.text ?? '';
  return text;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw };
  }

  const meta = {};
  for (const line of match[1].split('\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    meta[key] = value;
  }

  return { meta, body: match[2] };
}

async function invokeTool({ url, toolName, toolArgs }) {
  const endpoint = new URL(url);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArgs
      }
    })
  });

  if (!response.ok) {
    throw new Error(`MCP bridge returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body?.error) {
    throw new Error(body.error.message || `MCP tool ${toolName} failed`);
  }

  return body.result;
}

async function invokeToolViaStdio(toolName, toolArgs) {
  if (!fs.existsSync(FUTCO_REPO_SERVER_PATH)) {
    throw new Error(`Fallback futco-mcp server missing: ${FUTCO_REPO_SERVER_PATH}`);
  }

  return callMcpToolViaStdio({
    serverPath: FUTCO_REPO_SERVER_PATH,
    cwd: path.dirname(FUTCO_REPO_SERVER_PATH),
    toolName,
    toolArgs
  });
}

function unavailableResult(toolName, target, reason) {
  return {
    status: 'unavailable',
    provider: 'futco-mcp',
    tool: toolName,
    target,
    reason,
    summary: reason
  };
}

async function invokeFutcoMcp({ futcoMcpUrl = FUTCO_DEFAULT_URL, toolName, toolArgs }) {
  const httpUrl = futcoMcpUrl || FUTCO_DEFAULT_URL;
  try {
    const result = await invokeTool({ url: httpUrl, toolName, toolArgs });
    return {
      status: 'ok',
      transport: 'http',
      tool: toolName,
      data: result
    };
  } catch (error) {
    if (!isLocalFutcoUrl(httpUrl)) {
      return unavailableResult(toolName, toolArgs, `futco-mcp unavailable: ${error.message}`);
    }
  }

  try {
    const result = await invokeToolViaStdio(toolName, toolArgs);
    return {
      status: 'ok',
      transport: 'stdio',
      tool: toolName,
      data: result
    };
  } catch (error) {
    return unavailableResult(toolName, toolArgs, `futco-mcp unavailable: ${error.message}`);
  }
}

export async function searchKnowledgeBase(query, options = {}) {
  const result = await invokeFutcoMcp({
    futcoMcpUrl: options.futcoMcpUrl,
    toolName: 'search_knowledge_base',
    toolArgs: {
      query,
      limit: options.limit ?? 15
    }
  });

  if (result.status !== 'ok') {
    return result;
  }

  const text = parseToolContent(result.data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unavailableResult('search_knowledge_base', query, `futco-mcp returned invalid JSON: ${error.message}`);
  }

  return {
    status: 'ok',
    provider: 'futco-mcp',
    transport: result.transport,
    tool: result.tool,
    query,
    matchCount: parsed.matchCount ?? 0,
    results: Array.isArray(parsed.results) ? parsed.results : [],
    raw: parsed,
    summary: `${parsed.matchCount ?? 0} matches across ${(parsed.results ?? []).length} excerpts`
  };
}

export async function listRepos(options = {}) {
  const result = await invokeFutcoMcp({
    futcoMcpUrl: options.futcoMcpUrl,
    toolName: 'list_repos',
    toolArgs: options.status ? { status: options.status } : {}
  });

  if (result.status !== 'ok') {
    return result;
  }

  const text = parseToolContent(result.data);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unavailableResult('list_repos', options.status ?? 'all', `futco-mcp returned invalid JSON: ${error.message}`);
  }

  const repos = Array.isArray(parsed) ? parsed : [];
  return {
    status: 'ok',
    provider: 'futco-mcp',
    transport: result.transport,
    tool: result.tool,
    repos,
    summary: `${repos.length} repos`
  };
}

export async function getRepoInfo(name, options = {}) {
  const result = await invokeFutcoMcp({
    futcoMcpUrl: options.futcoMcpUrl,
    toolName: 'get_repo',
    toolArgs: { name }
  });

  if (result.status !== 'ok') {
    return result;
  }

  const text = parseToolContent(result.data);
  const { meta, body } = parseFrontmatter(text);

  return {
    status: 'ok',
    provider: 'futco-mcp',
    transport: result.transport,
    tool: result.tool,
    name,
    repo: {
      meta,
      body,
      raw: text
    },
    summary: meta.one_liner || body.slice(0, 240).trim()
  };
}

export { FUTCO_DEFAULT_URL, invokeFutcoMcp, unavailableResult };
