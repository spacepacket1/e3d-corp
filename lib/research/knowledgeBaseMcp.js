import fs from 'node:fs';
import path from 'node:path';
import { callMcpToolViaStdio } from './mcpTransport.js';
import { getRootDir } from '../config.js';

const DEFAULT_MCP_URL = 'http://127.0.0.1:4110';

function resolveServerPath(serverPath) {
  return path.isAbsolute(serverPath) ? serverPath : path.resolve(getRootDir(), serverPath);
}

function isLocalDefaultMcpUrl(url) {
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

async function invokeToolViaStdio(toolName, toolArgs, knowledgeBaseMcpServerPath) {
  const serverPath = resolveServerPath(knowledgeBaseMcpServerPath);
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Configured research.knowledgeBaseMcpServerPath does not exist: ${serverPath}`);
  }

  return callMcpToolViaStdio({
    serverPath,
    cwd: path.dirname(serverPath),
    toolName,
    toolArgs
  });
}

function unavailableResult(toolName, target, reason) {
  return {
    status: 'unavailable',
    provider: 'knowledge-base-mcp',
    tool: toolName,
    target,
    reason,
    summary: reason
  };
}

async function invokeMcp({ knowledgeBaseMcpUrl = DEFAULT_MCP_URL, knowledgeBaseMcpServerPath, toolName, toolArgs }) {
  const httpUrl = knowledgeBaseMcpUrl || DEFAULT_MCP_URL;
  try {
    const result = await invokeTool({ url: httpUrl, toolName, toolArgs });
    return {
      status: 'ok',
      transport: 'http',
      tool: toolName,
      data: result
    };
  } catch (error) {
    if (!isLocalDefaultMcpUrl(httpUrl) || !knowledgeBaseMcpServerPath) {
      return unavailableResult(toolName, toolArgs, `knowledge-base MCP unavailable: ${error.message}`);
    }
  }

  try {
    const result = await invokeToolViaStdio(toolName, toolArgs, knowledgeBaseMcpServerPath);
    return {
      status: 'ok',
      transport: 'stdio',
      tool: toolName,
      data: result
    };
  } catch (error) {
    return unavailableResult(toolName, toolArgs, `knowledge-base MCP unavailable: ${error.message}`);
  }
}

export async function searchKnowledgeBase(query, options = {}) {
  const result = await invokeMcp({
    knowledgeBaseMcpUrl: options.knowledgeBaseMcpUrl,
    knowledgeBaseMcpServerPath: options.knowledgeBaseMcpServerPath,
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
    return unavailableResult('search_knowledge_base', query, `knowledge-base MCP returned invalid JSON: ${error.message}`);
  }

  return {
    status: 'ok',
    provider: 'knowledge-base-mcp',
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
  const result = await invokeMcp({
    knowledgeBaseMcpUrl: options.knowledgeBaseMcpUrl,
    knowledgeBaseMcpServerPath: options.knowledgeBaseMcpServerPath,
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
    return unavailableResult('list_repos', options.status ?? 'all', `knowledge-base MCP returned invalid JSON: ${error.message}`);
  }

  const repos = Array.isArray(parsed) ? parsed : [];
  return {
    status: 'ok',
    provider: 'knowledge-base-mcp',
    transport: result.transport,
    tool: result.tool,
    repos,
    summary: `${repos.length} repos`
  };
}

export async function getRepoInfo(name, options = {}) {
  const result = await invokeMcp({
    knowledgeBaseMcpUrl: options.knowledgeBaseMcpUrl,
    knowledgeBaseMcpServerPath: options.knowledgeBaseMcpServerPath,
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
    provider: 'knowledge-base-mcp',
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

export { DEFAULT_MCP_URL, invokeMcp, unavailableResult };
