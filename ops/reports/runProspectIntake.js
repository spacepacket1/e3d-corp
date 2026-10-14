#!/usr/bin/env node
// HVAC/Itera prospecting intake: reads already-gathered raw research on
// candidate businesses, scores each against the ICP, and drafts a Day-1
// outreach email for anything that scores Tier A/B - all queued as events
// for a human to review via prospectIntakeDigest.js. Never sends outreach
// itself. No live data source is wired up yet (no HighLevel, no scraping) -
// this reads a manually-maintained local file, so a person can start
// scoring and drafting against real businesses they've researched by hand
// before any integration exists.

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { draftProspectResearchBrief } from '../../lib/roles/prospectResearchBrief.js';
import { draftProspectOutreach } from '../../lib/roles/prospectOutreachDraft.js';
import { scoreIcpFit } from '../../lib/research/icpScoring.js';
import { appendEvent, queryEvents } from '../../lib/events/store.js';

const DATA_DIR = '.e3d-corp/instance/hvac-sandbox';
const INTAKE_FILE = path.join(DATA_DIR, 'prospects-intake.json');

const PROTOTYPE_INSTANCE_CONFIG = {
  llm: {
    providers: {
      // Default maxTokens (1024, set in anthropicClient.js) truncated a real
      // research-brief response mid-JSON during dry-run verification - the
      // brief's shape (13 signals + sourceNotes + leakHypothesis) runs
      // longer than the other roles' short subject/body outputs.
      claude: { kind: 'anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY', maxTokens: 2048 }
    }
  },
  roles: {
    'sales.prospectResearchBrief': { provider: 'claude' },
    'sales.prospectOutreachDraft': { provider: 'claude' }
  }
};

function alreadyScoredIds(dataDir) {
  return new Set(queryEvents(dataDir, { type: 'prospect.scored' }).map((event) => event.subject.id));
}

async function loadIntake() {
  let raw;
  try {
    raw = await readFile(INTAKE_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No intake file at ${INTAKE_FILE}. Copy prospects-intake.example.json there and fill in real research.`);
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${INTAKE_FILE} must contain a JSON array`);
  return parsed;
}

async function main() {
  const entries = await loadIntake();
  const scoredIds = alreadyScoredIds(DATA_DIR);
  let scoredCount = 0;
  let draftedCount = 0;

  for (const entry of entries) {
    const { business, rawResearch } = entry;
    if (!business?.id) {
      process.stderr.write(`Skipping an intake entry with no business.id\n`);
      continue;
    }
    if (scoredIds.has(business.id)) continue;

    const { brief } = await draftProspectResearchBrief({ instanceConfig: PROTOTYPE_INSTANCE_CONFIG, business, rawResearch });
    if (!brief) {
      process.stdout.write(`${business.name}: research brief came back unusable, skipped.\n`);
      continue;
    }

    const scored = scoreIcpFit(brief.signals, { estimatedFields: brief.estimatedFields });
    appendEvent(DATA_DIR, {
      type: 'prospect.scored',
      source: 'ops.runProspectIntake',
      subject: { type: 'prospect', id: business.id },
      payload: {
        business,
        leakHypothesis: brief.leakHypothesis,
        sourceNotes: brief.sourceNotes,
        score: scored.score,
        maxScore: scored.maxScore,
        tier: scored.tier,
        breakdown: scored.breakdown
      },
      correlationId: crypto.randomUUID()
    });
    scoredCount += 1;
    process.stdout.write(`${business.name}: scored ${scored.score}/${scored.maxScore}, Tier ${scored.tier}\n`);

    if (scored.tier === 'archive') {
      process.stdout.write(`${business.name}: Tier archive, no outreach drafted.\n`);
      continue;
    }

    const { draft, channel } = await draftProspectOutreach({
      instanceConfig: PROTOTYPE_INSTANCE_CONFIG,
      business,
      brief,
      day: 1
    });
    if (!draft) {
      process.stdout.write(`${business.name}: leak hypothesis too vague for a Day-1 draft, skipped.\n`);
      continue;
    }

    appendEvent(DATA_DIR, {
      type: 'prospectOutreach.drafted',
      source: 'ops.runProspectIntake',
      subject: { type: 'prospect', id: business.id },
      payload: {
        business,
        day: 1,
        channel,
        tier: scored.tier,
        score: scored.score,
        draftSubject: draft.subject,
        draftBody: draft.body
      },
      correlationId: crypto.randomUUID()
    });
    draftedCount += 1;
    process.stdout.write(`${business.name}: Day-1 ${channel} draft queued.\n`);
  }

  process.stdout.write(`Prospect intake complete: ${entries.length} entries read, ${scoredCount} scored, ${draftedCount} Day-1 draft(s) queued.\n`);
}

main().catch((error) => {
  process.stderr.write(`Prospect intake failed: ${error.message}\n`);
  process.exitCode = 1;
});
