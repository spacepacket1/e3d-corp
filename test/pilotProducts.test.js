import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestProduct, DEFAULT_PRODUCTS } from '../lib/pilot/products.js';

const who = (bio, title = '') => ({ bio, evidence: { title } });

test('podcast and video people are pointed at pod2vid, with the words that triggered it', () => {
  const s = suggestProduct(who('I make a weekly AI podcast and edit the video myself', 'How I turn NotebookLM audio into YouTube videos'));
  assert.equal(s.id, 'e3d-pod2vid');
  assert.ok(s.matched.includes('podcast') && s.matched.includes('notebooklm'));
});

test('note-taking and memory people are pointed at brain; codebase-context people at codebase-memory', () => {
  assert.equal(suggestProduct(who('Obsidian power user building a second brain with Claude')).id, 'e3d-brain');
  assert.equal(suggestProduct(who('', 'Giving Claude Code codebase context across a monorepo')).id, 'e3d-codebase-memory');
});

test('network and macro people go to netdoctor and LiquidityWatch', () => {
  assert.equal(suggestProduct(who('Network engineer, Wireshark and packet captures, homelab')).id, 'e3d-netdoctor');
  assert.equal(suggestProduct(who('Macro investor writing about liquidity and the Fed')).id, 'e3d-liquiditywatch');
});

test('Pilot is the default: nothing matches, a tie, or a generic AI-agents bio', () => {
  assert.equal(suggestProduct(who('Gardening and travel')).id, 'e3d-pilot');
  assert.deepEqual(suggestProduct(who('')).matched, []);
  assert.equal(suggestProduct(who('Building AI agents with MCP and Claude')).id, 'e3d-pilot');
  assert.equal(suggestProduct(who('Wants a second opinion on decisions between models')).id, 'e3d-pilot');
});

test('keywords match whole words only ("ai" is not in "email" or "Spain")', () => {
  const s = suggestProduct(who('Email marketing in Spain', 'Mail tips'));
  assert.equal(s.score, 0);
  assert.equal(s.id, 'e3d-pilot');
});

test('the catalog never suggests token or on-chain-payment products', () => {
  const ids = DEFAULT_PRODUCTS.map((p) => p.id);
  for (const banned of ['e3d-token', 'e3d-cast', 'e3d-agent', 'e3d-tokenize', 'e3d-trade']) assert.ok(!ids.includes(banned), banned);
  const text = JSON.stringify(DEFAULT_PRODUCTS).toLowerCase();
  assert.ok(!/\b(token|wallet|on-chain|stripe)\b/.test(text), 'no token or payment wording in any pitch');
});

test('a custom catalog overrides the defaults', () => {
  const custom = [{ id: 'x', name: 'X', url: 'https://x.test', pitch: 'p', strong: ['widget'], weak: [] }];
  assert.equal(suggestProduct(who('I love widget design'), custom).id, 'x');
});

test('one ambiguous word is not enough to leave Pilot ("Obsidian Labs", a game studio)', () => {
  assert.equal(suggestProduct(who('Obsidian Labs: the best uncensored AI for red teaming')).id, 'e3d-pilot');
  assert.equal(suggestProduct(who('Director at Obsidian Entertainment')).id, 'e3d-pilot');
  assert.equal(suggestProduct(who('Obsidian vault and a second brain for my notes')).id, 'e3d-brain');
});
