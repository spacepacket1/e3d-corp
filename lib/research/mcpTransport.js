import fs from 'node:fs';
import { spawn } from 'node:child_process';

export async function callMcpToolViaStdio({
  serverPath,
  toolName,
  toolArgs = {},
  cwd,
  env = {},
  timeoutMs = 15_000
}) {
  if (!fs.existsSync(serverPath)) {
    throw new Error(`MCP server not found: ${serverPath}`);
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    child.kill('SIGTERM');
    child.stdout.destroy();
    child.stdin.destroy();
    child.stderr.destroy();
  };

  const failAll = (error) => {
    for (const pendingEntry of pending.values()) {
      pendingEntry.reject(error);
    }
    pending.clear();
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      let message;
      try {
        message = line.trim() ? JSON.parse(line) : null;
      } catch {
        newlineIndex = stdoutBuffer.indexOf('\n');
        continue;
      }

      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message || `MCP error for ${toolName}`));
        } else {
          resolve(message.result);
        }
      }

      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
  });

  const exited = new Promise((_, reject) => {
    child.on('exit', (code, signal) => {
      if (pending.size === 0) {
        return;
      }
      reject(
        new Error(
          `MCP server exited before replying (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${stderrBuffer.trim()}`
        )
      );
    });
    child.on('error', reject);
  });

  const sendRequest = (method, params) => {
    const id = nextId;
    nextId += 1;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    child.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, timeoutMs);

      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  };

  try {
    const initializeResult = await Promise.race([
      sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e3d-corp', version: '0.1.0' }
      }),
      exited
    ]);

    if (!initializeResult || typeof initializeResult !== 'object') {
      throw new Error('MCP initialize returned an invalid response');
    }

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
    );

    const toolResult = await Promise.race([
      sendRequest('tools/call', {
        name: toolName,
        arguments: toolArgs
      }),
      exited
    ]);

    return toolResult;
  } catch (error) {
    failAll(error);
    throw error;
  } finally {
    cleanup();
  }
}
