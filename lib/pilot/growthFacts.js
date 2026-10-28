// The only facts Pilot growth roles may cite. Conservative, honest claims about
// Pilot (pilot.e3d.ai). Instance-specific facts (real metrics, real debate
// examples) are merged in from an optional JSON file (`pilotGrowth.factsFile`):
//   { "facts": [ { "id": "metric-2026-10-26", "text": "...", "source": "..." } ] }
import fs from 'node:fs';

export const BASE_PILOT_FACTS = Object.freeze([
  { id: 'what', text: 'Pilot (pilot.e3d.ai) is a multi-model debate service: several frontier models answer a question independently, and the disagreement between them is recorded.', source: 'pilot.e3d.ai' },
  { id: 'dissent', text: 'Disagreement between models is kept and shown, not smoothed over; the person still makes the decision.', source: 'pilot.e3d.ai' },
  { id: 'record', text: 'Every debate saves a transcript, so you can show later how a decision was reached.', source: 'pilot.e3d.ai' },
  { id: 'pricing', text: 'Pilot is sold as prepaid credit packs and Basic and Pro plans; sign-up is open.', source: 'pilot.e3d.ai' },
  { id: 'mcp', text: 'Pilot has an MCP server, so an AI assistant or agent can run a debate itself.', source: 'pilot.e3d.ai' },
  { id: 'chatgpt', text: 'A Pilot ChatGPT plugin has been submitted to OpenAI and is in review (not yet listed). A demo video is at pilot.e3d.ai/chatgpt.', source: 'pilot.e3d.ai/chatgpt' },
  { id: 'open-source', text: 'The debate engine, e3d-pilot, is open source under the MIT license.', source: 'github e3d-pilot' }
]);

export const WORDING_RULES = Object.freeze([
  'Say "multi-model" (never "multi-LLM"). Do not call Pilot a "council" or claim it is always right.',
  'The ChatGPT plugin is in OpenAI review: never say it is live, available or listed.',
  'Pilot reduces single-model blind spots and shows disagreement; it does not guarantee correct answers.'
]);

export function loadGrowthFacts(instanceConfig, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const byId = new Map(BASE_PILOT_FACTS.map((fact) => [fact.id, { ...fact }]));
  const file = instanceConfig?.pilotGrowth?.factsFile;
  const warnings = [];
  if (file) {
    try {
      const parsed = JSON.parse(readFile(file));
      for (const fact of Array.isArray(parsed?.facts) ? parsed.facts : []) {
        if (typeof fact?.id === 'string' && typeof fact?.text === 'string' && fact.text.trim() !== '') {
          byId.set(fact.id, { id: fact.id, text: fact.text, source: fact.source ?? 'instance facts file' });
        }
      }
    } catch (error) {
      warnings.push(`facts file ${file} unreadable (${error.message}); using base facts only`);
    }
  }
  return { facts: [...byId.values()], warnings };
}
