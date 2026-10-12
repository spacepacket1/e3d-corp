import assert from 'node:assert/strict';
import test from 'node:test';
import { gatherFindings } from '../lib/research/e3dFindings.js';

function toolJsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

test('gatherFindings fails closed (empty findings) when topic is missing', async () => {
  const result = await gatherFindings({});
  assert.equal(result.checked, false);
  assert.deepEqual(result.findings, []);
});

test('gatherFindings returns a story finding when search_stories has a match', async () => {
  const calls = [];
  const callMcp = async (toolName, toolArgs) => {
    calls.push({ toolName, toolArgs });
    if (toolName === 'search_stories') {
      return toolJsonResult([{ symbol: 'WALLETX', headline: 'cluster of 40 wallets rotated into the same token within an hour' }]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({ topic: 'on-chain wallet and address analytics', callMcp });
  assert.equal(result.checked, true);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].text, /WALLETX/);
  assert.equal(result.findings[0].source, 'e3d.ai search_stories');
  assert.equal(calls[0].toolName, 'search_stories');
});

test('gatherFindings falls back to an active thesis when no stories match', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') return toolJsonResult([]);
    if (toolName === 'get_theses') {
      return toolJsonResult([
        { symbol: 'TOKA', direction: 'long', conviction: 0.8, thesis_text: 'accumulation pattern across top holders' }
      ]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({ topic: 'AI trading agents', callMcp });
  assert.equal(result.checked, true);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].text, /TOKA/);
  assert.equal(result.findings[0].source, 'e3d.ai get_theses');
});

test('gatherFindings returns no findings (not an error) when nothing matches either tool', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') return toolJsonResult([]);
    if (toolName === 'get_theses') return toolJsonResult([]);
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({ topic: 'a very obscure topic', callMcp });
  assert.equal(result.checked, true);
  assert.deepEqual(result.findings, []);
});

test('gatherFindings fails closed when e3d-mcp is unavailable', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') throw new Error('stories tool down');
    throw new Error('theses tool down too');
  };

  const result = await gatherFindings({ topic: 'on-chain analytics', callMcp });
  assert.equal(result.checked, false);
  assert.deepEqual(result.findings, []);
  assert.match(result.reason, /e3d-mcp unavailable/);
});
