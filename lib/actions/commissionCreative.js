import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import { getRootDir } from '../config.js';

const execFileAsync = promisify(execFile);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

const PROVIDER_FLAGS = Object.freeze({
  conceptGeneration: '--concept-provider',
  critique: '--critique-provider',
  qa: '--qa-provider'
});

// Which provider e3d-creative should use per call site is a deployment fact
// (which API key is actually configured on this machine), not something the
// brief should have to know - CLI flags override the brief's own
// providerSelection either way, confirmed by e3d-creative's own tests.
function buildProviderFlags(defaultProviders) {
  if (!isPlainObject(defaultProviders)) return [];
  return Object.entries(PROVIDER_FLAGS).flatMap(([key, flag]) =>
    typeof defaultProviders[key] === 'string' && defaultProviders[key].trim() !== '' ? [flag, defaultProviders[key].trim()] : []
  );
}

// Default engine runner: actually shells out to e3d-creative's own CLI
// (../e3d-creative/bin/e3d-creative, a sibling repo - same "run a real
// subprocess, don't reimplement its logic here" convention as how a human
// runs e3d-pilot today for a pilot-handoff). Tests inject ctx.runEngine
// instead of exercising the real binary.
async function defaultRunEngine({ enginePath, briefPath, outputDir, providerFlags }) {
  const binPath = path.join(enginePath, 'bin', 'e3d-creative');
  const { stdout } = await execFileAsync('node', [binPath, 'run', briefPath, '--out', outputDir, ...providerFlags]);
  return { stdout };
}

// The action-execution function for `commission-creative` proposals - the
// manifesto's "Corp commissions CAST directly" path (no Pilot hop) for a
// routine creative variant of an existing campaign/product. Authority level
// matches pilot-handoff (external action, approval and execution are the
// same call): unlike pilot-handoff, this one *does* invoke the target engine
// directly, because e3d-creative is a finished, tested CLI e3d-corp can call
// like any other research/action tool - there is no human-judgment "point it
// at a repo" step the way a pilot handoff needs. This only produces a
// creative direction (prompts, scripts, storyboards); it never renders,
// publishes, or spends anything.
export async function commissionCreative(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, 'commission-creative');

  const { dataDir, causationId = null, correlationId, instanceConfig, runEngine = defaultRunEngine } = ctx;
  if (!dataDir) {
    throw new Error('commissionCreative requires a dataDir');
  }
  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));

  const creativeConfig = instanceConfig?.creative;
  if (!isPlainObject(creativeConfig) || typeof creativeConfig.enginePath !== 'string' || creativeConfig.enginePath.trim() === '') {
    throw new Error(
      'Cannot commission creative: instance config has no "creative.enginePath" (path to the e3d-creative repo)'
    );
  }
  const enginePath = path.isAbsolute(creativeConfig.enginePath)
    ? creativeConfig.enginePath
    : path.resolve(getRootDir(), creativeConfig.enginePath);
  const baseOutDir = typeof creativeConfig.outDir === 'string' && creativeConfig.outDir.trim() !== ''
    ? creativeConfig.outDir
    : path.join(dataDir, 'creative-commissions');

  const { opportunityId, brief } = proposal.payload ?? {};
  if (typeof opportunityId !== 'string' || opportunityId.trim() === '' || !isPlainObject(brief)) {
    throw new Error(`Proposal ${proposal.id} is missing opportunityId/brief; refusing to commission creative`);
  }

  const outputDir = path.isAbsolute(baseOutDir) ? path.join(baseOutDir, proposal.id) : path.resolve(dataDir, baseOutDir, proposal.id);
  const briefPath = path.join(outputDir, 'brief.json');
  writeJsonFileAtomic(briefPath, brief);

  const providerFlags = buildProviderFlags(creativeConfig.defaultProviders);

  let runResult;
  try {
    runResult = await runEngine({ enginePath, briefPath, outputDir, providerFlags });
  } catch (error) {
    throw new Error(`e3d-creative run failed for proposal ${proposal.id}: ${error.message}`);
  }

  const event = append({
    type: 'creative-commission.created',
    source: 'action:commission-creative',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      opportunityId,
      enginePath,
      briefPath,
      outputDir,
      summary: typeof runResult?.stdout === 'string' ? runResult.stdout.trim().slice(-2000) : null,
      createdAt: new Date().toISOString()
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return { commissioned: true, outputDir, briefPath, event };
}
