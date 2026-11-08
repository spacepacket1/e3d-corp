// Which E3D tool should we invite a given person to try? Deterministic keyword matching on what they say about
// themselves (bio) and the public post or video that surfaced them. No model call, nothing demographic.
// E3D Pilot is the default: it wins ties and wins when nothing else matches. Every suggestion carries the words
// that triggered it, so a human can see why and overrule it. Edit or extend via research.pilotCandidates.products.
//
// Deliberately excluded from the catalog: anything whose public pitch is about the E3D token or on-chain payments
// (not decided for public copy yet).
export const DEFAULT_PRODUCTS = Object.freeze([
  { id: 'e3d-pilot', name: 'E3D Pilot', url: 'https://pilot.e3d.ai',
    pitch: 'multi-model second opinions, with the disagreement kept',
    strong: ['second opinion', 'multi-model', 'llm council', 'model comparison', 'compare models', 'debate', 'decision', 'decisions'],
    weak: ['agent', 'agents', 'agentic', 'mcp', 'claude', 'gpt', 'llm', 'prompt', 'prompts', 'ai'] },
  { id: 'e3d-pod2vid', name: 'e3d-pod2vid', url: 'https://github.com/spacepacket1/e3d-pod2vid',
    pitch: 'turns a podcast or interview audio file into a YouTube-ready video with matched B-roll and subtitles',
    strong: ['podcast', 'podcasts', 'podcasting', 'notebooklm', 'b-roll', 'broll', 'video editing', 'subtitles', 'captions', 'text to video', 'voiceover', 'tts', 'youtube automation'],
    weak: ['video', 'videos', 'youtube', 'creator', 'content creator', 'shorts'] },
  { id: 'e3d-brain', name: 'e3d-brain', url: 'https://github.com/spacepacket1/e3d-brain',
    pitch: 'local-first memory for AI sessions: a folder of Markdown you own, served over MCP',
    strong: ['second brain', 'pkm', 'personal knowledge', 'knowledge base', 'ai memory', 'agent memory', 'memory for', 'markdown'],
    weak: ['obsidian', 'memory', 'notes', 'note-taking', 'mcp', 'knowledge'] },
  { id: 'e3d-codebase-memory', name: 'e3d-codebase-memory', url: 'https://github.com/spacepacket1/e3d-codebase-memory',
    pitch: 'a local, searchable memory of your codebase for Claude Code, over MCP',
    strong: ['codebase memory', 'code index', 'repo context', 'codebase context', 'context window', 'code search'],
    weak: ['claude code', 'codebase', 'monorepo', 'repo'] },
  { id: 'e3d-code', name: 'e3d-code', url: 'https://github.com/spacepacket1/e3d-code',
    pitch: 'runs Codex CLI or Claude CLI phase by phase from Markdown feature specs',
    strong: ['spec-driven', 'spec driven', 'feature spec', 'feature specs', 'codex cli', 'claude cli', 'agent workflow', 'coding agents'],
    weak: ['claude code', 'cursor', 'codex', 'coding agent', 'vibe coding', 'cli'] },
  { id: 'e3d-netdoctor', name: 'e3d-netdoctor', url: 'https://github.com/spacepacket1/e3d-netdoctor',
    pitch: 'diagnoses network slowdowns: your ISP, your device, or one flaky destination',
    strong: ['wifi', 'wi-fi', 'isp', 'latency', 'wireshark', 'packet', 'packets', 'network', 'networking', 'bandwidth', 'sysadmin', 'homelab'],
    weak: ['router', 'dns', 'devops'] },
  { id: 'e3d-liquiditywatch', name: 'LiquidityWatch', url: 'https://liquiditywatch.e3d.ai',
    pitch: 'a daily U.S. financial stress score with plain-English scenarios',
    strong: ['macro', 'liquidity', 'financial stress', 'treasury', 'yield curve', 'fed', 'federal reserve', 'markets'],
    weak: ['stocks', 'investing', 'rates', 'economy', 'trading'] }
]);

const MIN_SPECIFIC_SCORE = 2;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hit = (text, kw) => new RegExp(`(^|[^a-z0-9])${esc(kw)}([^a-z0-9]|$)`, 'i').test(text);

// -> { id, name, url, pitch, matched: [keywords], score } ; Pilot when nothing beats it.
export function suggestProduct(candidate, products = DEFAULT_PRODUCTS) {
  const text = `${candidate?.bio ?? ''} ${candidate?.evidence?.title ?? ''}`.toLowerCase();
  const scored = products.map((p, order) => {
    const strong = (p.strong ?? []).filter((k) => hit(text, k));
    const weak = (p.weak ?? []).filter((k) => hit(text, k));
    return { p, order, score: strong.length * 2 + weak.length, matched: [...strong, ...weak] };
  });
  // Highest score wins; on a tie the earlier catalog entry (Pilot) wins. Any other tool needs at least two points
  // (one strong keyword, or two weak), so a single ambiguous word such as "obsidian" cannot reroute someone.
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
  const chosen = best.order !== 0 && best.score < MIN_SPECIFIC_SCORE ? scored[0] : best.score > 0 ? best : scored[0];
  const { p } = chosen;
  return { id: p.id, name: p.name, url: p.url, pitch: p.pitch, matched: chosen.score > 0 ? chosen.matched.slice(0, 4) : [], score: chosen.score };
}
