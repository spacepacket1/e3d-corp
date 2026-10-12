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

test('gatherFindings searches on the post text, not just the broad topic bucket', async () => {
  const calls = [];
  const callMcp = async (toolName, toolArgs) => {
    calls.push({ toolName, toolArgs });
    if (toolName === 'search_stories') {
      return toolJsonResult([{ symbol: 'RSR', headline: 'bridged from ETH to SOL via Wormhole' }]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({
    topic: 'blockchain data tooling, on-chain narratives, or investment theses',
    postText: 'what wallet tools do people actually use for bridging?',
    callMcp
  });
  assert.equal(result.checked, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolArgs.q, 'what wallet tools do people actually use for bridging?');
});

test('gatherFindings ranks the unfiltered batch by real keyword overlap with the post, picking a genuine match over whatever happens to be first', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') {
      // GST is first in the (unfiltered, since q is a documented no-op at this
      // tier) batch; RSR is second but is the one that actually matches what
      // the post is about, and should win on relevance despite its position.
      return toolJsonResult([
        { symbol: 'GST', headline: 'is +80% more expensive on ETH than SOL' },
        { symbol: 'RSR', headline: 'bridged from ETH to SOL via Wormhole' }
      ]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({
    postText: 'did anyone see that wormhole bridge issue today?',
    callMcp
  });
  assert.equal(result.checked, true);
  assert.match(result.findings[0].text, /RSR/);
});

test('gatherFindings falls back to the first unused item when nothing in the batch actually matches', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') {
      return toolJsonResult([
        { symbol: 'GST', headline: 'is +80% more expensive on ETH than SOL' },
        { symbol: 'RSR', headline: 'bridged from ETH to SOL via Wormhole' }
      ]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({ postText: 'gm crypto twitter', callMcp });
  assert.equal(result.checked, true);
  assert.match(result.findings[0].text, /GST/);
});

test('gatherFindings rotates to the next real story when the top one is excluded (the live e3d-mcp bug this guards against: search_stories ignores q and always returns the same top result)', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') {
      return toolJsonResult([
        { symbol: 'RSR', headline: 'bridged from ETH to SOL via Wormhole' },
        { symbol: 'GST', headline: 'is +80% more expensive on ETH than SOL' },
        { symbol: 'GENE', headline: 'is +60.8% more expensive on SOL than ETH' }
      ]);
    }
    throw new Error('unexpected tool call');
  };

  const first = await gatherFindings({ postText: 'post A', callMcp });
  assert.match(first.findings[0].text, /RSR/);

  const second = await gatherFindings({
    postText: 'post B',
    callMcp,
    excludeFindingTexts: new Set([first.findings[0].text])
  });
  assert.match(second.findings[0].text, /GST/);
  assert.notEqual(second.findings[0].text, first.findings[0].text);
});

test('gatherFindings returns no findings once every real result has already been used', async () => {
  const callMcp = async (toolName) => {
    if (toolName === 'search_stories') {
      return toolJsonResult([{ symbol: 'RSR', headline: 'bridged from ETH to SOL via Wormhole' }]);
    }
    if (toolName === 'get_theses') {
      return toolJsonResult([]);
    }
    throw new Error('unexpected tool call');
  };

  const result = await gatherFindings({
    postText: 'another post',
    callMcp,
    excludeFindingTexts: new Set(['RSR: bridged from ETH to SOL via Wormhole'])
  });
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
