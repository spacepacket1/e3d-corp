import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getRootDir } from '../config.js';

const DEFAULT_GROK_TIMEOUT_MS = 900_000;
const DEFAULT_GROK_BINARY = 'grok';
export const DEFAULT_GROK_MODEL = 'grok-cli-default';

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const promptTokens = usage.input_tokens;
  const completionTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (![promptTokens, completionTokens, totalTokens].every((value) => Number.isFinite(value))) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findBinary(binaryName) {
  if (!binaryName) {
    return null;
  }

  if (binaryName.includes(path.sep)) {
    return isExecutable(binaryName) ? binaryName : null;
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveGrokCliSettings(providerConfig) {
  const binEnvVar = providerConfig?.binEnvVar;
  const modelEnvVar = providerConfig?.modelEnvVar;

  let binaryName = DEFAULT_GROK_BINARY;
  if (binEnvVar) {
    binaryName = process.env[binEnvVar];
    if (!binaryName) {
      throw new Error(`Grok binary env var "${binEnvVar}" is not set`);
    }
  }

  const binaryPath = findBinary(binaryName);
  if (!binaryPath) {
    throw new Error(`Grok binary not found: ${binaryName}`);
  }

  let model = DEFAULT_GROK_MODEL;
  if (modelEnvVar) {
    model = process.env[modelEnvVar];
    if (!model) {
      throw new Error(`Grok model env var "${modelEnvVar}" is not set`);
    }
  }

  return {
    binaryPath,
    binaryName,
    model,
    timeoutMs: providerConfig?.timeoutMs ?? DEFAULT_GROK_TIMEOUT_MS
  };
}

function buildPromptFileContents(systemPrompt, userPrompt) {
  return `${systemPrompt}\n\n${userPrompt}\n`;
}

export async function callGrokCli({ binaryPath, model, systemPrompt, userPrompt, timeoutMs = DEFAULT_GROK_TIMEOUT_MS }) {
  const promptFile = path.join(os.tmpdir(), `e3d-corp-grok-${process.pid}-${Date.now()}.prompt.txt`);
  fs.writeFileSync(promptFile, buildPromptFileContents(systemPrompt, userPrompt), 'utf8');

  const args = [
    '--no-auto-update',
    '--cwd',
    getRootDir(),
    '--prompt-file',
    promptFile,
    '--output-format',
    'json',
    '--no-memory',
    '--no-subagents',
    '--always-approve',
    '--sandbox',
    'read-only'
  ];
  if (model !== DEFAULT_GROK_MODEL) {
    args.push('--model', model);
  }

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binaryPath, args, {
        cwd: getRootDir(),
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Grok CLI timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : signal ? ` (signal ${signal})` : '';
          reject(new Error(`Grok CLI exited with code ${code}${suffix}`));
          return;
        }
        const content = stdout.trim();
        if (!content) {
          reject(new Error('Grok CLI returned empty output'));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (error) {
          reject(new Error(`Grok CLI returned invalid JSON: ${error.message}`));
          return;
        }
        if (typeof parsed?.text !== 'string' || parsed.text.trim() === '') {
          reject(new Error('Grok CLI response did not include text'));
          return;
        }
        resolve({
          text: parsed.text,
          usage: normalizeUsage(parsed.usage),
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null
        });
      });
    });
  } finally {
    fs.rmSync(promptFile, { force: true });
  }
}
