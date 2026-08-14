import http from 'node:http';
import { URL } from 'node:url';
import { loadWebCredentials, checkBasicAuth } from './auth.js';
import { generateCsrfToken, csrfCookieHeader, verifyCsrf, parseCookies, CSRF_COOKIE_NAME } from './csrf.js';
import { listOpportunities, getOpportunity } from '../opportunities/store.js';
import { listProposals, getProposal } from '../proposals/store.js';
import { reconstructChain } from '../events/chain.js';
import { decideOpportunity, decideProposal, confirmAndExecute } from '../decisions/decide.js';
import { listExecutedActions } from '../actions/log.js';
import { createResearchAdapter } from '../research/adapter.js';
import { proposePilotHandoff } from '../proposals/pilotHandoff.js';
import { checkCapabilityShipped } from '../pilot/checkShipped.js';
import { recordOutcome } from '../outcomes/record.js';
import { listOutcomes } from '../outcomes/store.js';
import { assembleExperience } from '../experience/assemble.js';
import {
  renderPage,
  renderOpportunitiesList,
  renderOpportunityDetail,
  renderProposalsList,
  renderProposalDetail,
  renderActionsList,
  renderOutcomesList,
  renderExperience
} from './render.js';

const MAX_BODY_BYTES = 1_000_000;

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseFormBody(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams();
  }
  const body = await readRequestBody(req);
  return new URLSearchParams(body);
}

function ensureCsrfCookie(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies[CSRF_COOKIE_NAME];
  if (!token) {
    token = generateCsrfToken();
    res.setHeader('Set-Cookie', csrfCookieHeader(token));
  }
  return token;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function notFound(res) {
  sendHtml(res, 404, renderPage('Not found', '<p>Not found.</p>'));
}

function badRequest(res, message) {
  sendHtml(res, 400, renderPage('Bad request', `<p class="error">${message}</p>`));
}

// The double-submit CSRF check every mutating route runs before touching any
// decision function: the cookie is SameSite=Strict, so a genuinely
// cross-site forged POST never carries it at all; a same-site request must
// also echo the cookie's token back as a form field.
async function requireCsrf(req, res) {
  const form = await parseFormBody(req);
  if (!verifyCsrf(req, form.get('_csrf'))) {
    sendHtml(res, 403, renderPage('Forbidden', '<p class="error">CSRF validation failed.</p>'));
    return null;
  }
  return form;
}

function handleOpportunitiesList(req, res, dataDir, url) {
  const status = url.searchParams.get('status') || undefined;
  const type = url.searchParams.get('type') || undefined;
  const minScoreRaw = url.searchParams.get('minScore');
  const minScore = minScoreRaw ? Number(minScoreRaw) : undefined;

  let opportunities = listOpportunities(dataDir, { status, minScore: Number.isNaN(minScore) ? undefined : minScore });
  if (type) {
    opportunities = opportunities.filter((o) => o.type === type);
  }

  sendHtml(
    res,
    200,
    renderPage('Opportunities', renderOpportunitiesList(opportunities, { status, type, minScore: minScoreRaw }))
  );
}

function handleOpportunityDetail(req, res, dataDir, id, options = {}) {
  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    notFound(res);
    return;
  }
  const chain = reconstructChain(dataDir, opportunity.correlationId);
  const csrfToken = ensureCsrfCookie(req, res);
  sendHtml(
    res,
    options.error ? 400 : 200,
    renderPage(
      opportunity.title,
      renderOpportunityDetail(opportunity, chain, { csrfToken, error: options.error, info: options.info })
    )
  );
}

async function handleOpportunityDecide(req, res, dataDir, id, credentials) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  const status = form.get('status');
  const reason = form.get('reason');

  try {
    decideOpportunity(dataDir, id, status, reason, credentials.user, 'web');
  } catch (error) {
    return handleOpportunityDetail(req, res, dataDir, id, { error: error.message });
  }

  res.writeHead(302, { Location: `/opportunities/${encodeURIComponent(id)}` });
  res.end();
}

// Thin call into Phase 8's proposePilotHandoff - a deterministic, human-
// specified proposal (no LLM role involved), same "one implementation, two
// front doors" rule as every other mutation in this file.
async function handleOpportunityProposeHandoff(req, res, dataDir, id, credentials, config) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  const repo = form.get('repo');
  const reason = form.get('reason');

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    notFound(res);
    return;
  }

  try {
    const { proposal } = proposePilotHandoff(dataDir, {
      opportunity,
      targetRepo: repo,
      reason,
      instanceConfig: config
    });
    return handleOpportunityDetail(req, res, dataDir, id, {
      info: `Proposed pilot-handoff ${proposal.id} - review and approve it under /proposals/${proposal.id}.`
    });
  } catch (error) {
    return handleOpportunityDetail(req, res, dataDir, id, { error: error.message });
  }
}

// Thin call into Phase 8's checkCapabilityShipped - observational, appends
// capability.shipped only when a real match is found in futco-mcp's repo
// listing.
async function handleOpportunityCheckShipped(req, res, dataDir, id, config) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    notFound(res);
    return;
  }

  try {
    const researchAdapter = createResearchAdapter(config, { dataDir });
    const result = await checkCapabilityShipped({
      dataDir,
      opportunityId: id,
      listRepos: () => researchAdapter.listRepos({ correlationId: opportunity.correlationId })
    });
    const info = result.matched
      ? `Capability shipped: ${result.repo.name} (matched "${result.matchedKeyword}") - ${result.repo.one_liner ?? ''}`
      : `No shipped capability found yet (checked ${result.checkedRepoCount} repos).`;
    return handleOpportunityDetail(req, res, dataDir, id, { info });
  } catch (error) {
    return handleOpportunityDetail(req, res, dataDir, id, { error: error.message });
  }
}

// Thin call into Phase 9's recordOutcome - a human-recorded fact, not gated
// behind the authority/Decision framework (recording isn't an action
// performed on the world).
async function handleOpportunityRecordOutcome(req, res, dataDir, id) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    notFound(res);
    return;
  }

  const type = form.get('type');
  const payloadRaw = form.get('payload');

  try {
    let payload;
    try {
      payload = JSON.parse(payloadRaw);
    } catch (error) {
      throw new Error(`Invalid JSON for payload: ${error.message}`);
    }
    const { outcome } = recordOutcome(dataDir, { correlationId: opportunity.correlationId, type, payload });
    return handleOpportunityDetail(req, res, dataDir, id, { info: `Recorded outcome ${outcome.id} (type=${outcome.type}).` });
  } catch (error) {
    return handleOpportunityDetail(req, res, dataDir, id, { error: error.message });
  }
}

// Read-only - GET, no CSRF needed. Always a live recompute from the event
// log (lib/experience/assemble.js), not a read of the persisted
// experience.jsonl snapshot, so it reflects the chain's current state even
// for correlationIds that haven't recorded an Outcome yet.
function handleOpportunityExperience(req, res, dataDir, id) {
  const opportunity = getOpportunity(dataDir, id);
  if (!opportunity) {
    notFound(res);
    return;
  }

  const experience = assembleExperience(dataDir, opportunity.correlationId);
  sendHtml(res, 200, renderPage(`Experience: ${opportunity.title}`, renderExperience(experience)));
}

// The primary view is the pending queue - status defaults to "pending"
// unless the query string explicitly asks for something else (or "all").
function handleProposalsList(req, res, dataDir, url) {
  const statusParam = url.searchParams.get('status');
  const status = statusParam === null ? 'pending' : statusParam === '' || statusParam === 'all' ? undefined : statusParam;
  const type = url.searchParams.get('type') || undefined;
  const proposals = listProposals(dataDir, { status, type });
  sendHtml(res, 200, renderPage('Proposals', renderProposalsList(proposals, { status: status ?? 'all', type })));
}

function handleProposalDetail(req, res, dataDir, id, options = {}) {
  const proposal = getProposal(dataDir, id);
  if (!proposal) {
    notFound(res);
    return;
  }
  const chain = reconstructChain(dataDir, proposal.correlationId);
  const csrfToken = ensureCsrfCookie(req, res);
  sendHtml(
    res,
    options.error ? 400 : 200,
    renderPage(`Proposal ${proposal.id}`, renderProposalDetail(proposal, chain, {
      csrfToken,
      error: options.error,
      executed: options.executed
    }))
  );
}

// Approve/reject are both thin calls into decideProposal (Phase 5) - this
// handler never decides authority or execution itself. For a level-2
// proposal, decideProposal fires the action in the same call; for level-3/4,
// it only flips status to `approved`, regardless of what the form submitted,
// because that branching lives inside decide.js, not here.
async function handleProposalDecide(req, res, dataDir, id, decisionValue, credentials, config) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  const reason = form.get('reason');

  let result;
  try {
    result = await decideProposal(dataDir, id, decisionValue, reason, credentials.user, 'web', config);
  } catch (error) {
    return handleProposalDetail(req, res, dataDir, id, { error: error.message });
  }

  return handleProposalDetail(req, res, dataDir, id, { executed: result.executed });
}

// The separate, explicit confirmation step for level-3/4 proposals. Also a
// thin call into Phase 5's confirmAndExecute, which itself refuses anything
// not already `approved` at authority level >= 3 - enforced there, not here.
async function handleProposalConfirm(req, res, dataDir, id, credentials, config) {
  const form = await requireCsrf(req, res);
  if (!form) return;

  try {
    await confirmAndExecute(dataDir, id, credentials.user, 'web', config);
  } catch (error) {
    return handleProposalDetail(req, res, dataDir, id, { error: error.message });
  }

  return handleProposalDetail(req, res, dataDir, id, { executed: true });
}

// Builds the request listener. Throws (synchronously, before any request is
// ever served) if the instance config has no usable web credentials - this
// is what makes "refuses to start with no auth env vars configured" true for
// both the CLI wrapper and any test that calls this directly.
export function createRequestListener({ config, dataDir }) {
  const credentials = loadWebCredentials(config);

  return async function requestListener(req, res) {
    try {
      if (!checkBasicAuth(req, credentials)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="e3d-corp"', 'Content-Type': 'text/plain' });
        res.end('Authentication required');
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && segments.length === 0) {
        res.writeHead(302, { Location: '/opportunities' });
        res.end();
        return;
      }

      if (req.method === 'GET' && segments[0] === 'opportunities' && segments.length === 1) {
        return handleOpportunitiesList(req, res, dataDir, url);
      }
      if (req.method === 'GET' && segments[0] === 'opportunities' && segments.length === 2) {
        return handleOpportunityDetail(req, res, dataDir, segments[1]);
      }
      if (req.method === 'POST' && segments[0] === 'opportunities' && segments.length === 3 && segments[2] === 'decide') {
        return await handleOpportunityDecide(req, res, dataDir, segments[1], credentials);
      }
      if (
        req.method === 'POST' &&
        segments[0] === 'opportunities' &&
        segments.length === 3 &&
        segments[2] === 'propose-handoff'
      ) {
        return await handleOpportunityProposeHandoff(req, res, dataDir, segments[1], credentials, config);
      }
      if (
        req.method === 'POST' &&
        segments[0] === 'opportunities' &&
        segments.length === 3 &&
        segments[2] === 'check-shipped'
      ) {
        return await handleOpportunityCheckShipped(req, res, dataDir, segments[1], config);
      }
      if (req.method === 'POST' && segments[0] === 'opportunities' && segments.length === 3 && segments[2] === 'outcomes') {
        return await handleOpportunityRecordOutcome(req, res, dataDir, segments[1]);
      }
      if (req.method === 'GET' && segments[0] === 'opportunities' && segments.length === 3 && segments[2] === 'experience') {
        return handleOpportunityExperience(req, res, dataDir, segments[1]);
      }

      if (req.method === 'GET' && segments[0] === 'outcomes' && segments.length === 1) {
        return sendHtml(res, 200, renderPage('Outcomes', renderOutcomesList(listOutcomes(dataDir))));
      }

      if (req.method === 'GET' && segments[0] === 'proposals' && segments.length === 1) {
        return handleProposalsList(req, res, dataDir, url);
      }
      if (req.method === 'GET' && segments[0] === 'proposals' && segments.length === 2) {
        return handleProposalDetail(req, res, dataDir, segments[1]);
      }
      if (
        req.method === 'POST' &&
        segments[0] === 'proposals' &&
        segments.length === 3 &&
        (segments[2] === 'approve' || segments[2] === 'reject')
      ) {
        return await handleProposalDecide(
          req,
          res,
          dataDir,
          segments[1],
          segments[2] === 'approve' ? 'approved' : 'rejected',
          credentials,
          config
        );
      }
      if (req.method === 'POST' && segments[0] === 'proposals' && segments.length === 3 && segments[2] === 'confirm') {
        return await handleProposalConfirm(req, res, dataDir, segments[1], credentials, config);
      }

      if (req.method === 'GET' && segments[0] === 'actions' && segments.length === 1) {
        return sendHtml(res, 200, renderPage('Actions', renderActionsList(listExecutedActions(dataDir))));
      }

      notFound(res);
    } catch (error) {
      if (error.message === 'Request body too large') {
        badRequest(res, 'Request body too large');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal error: ${error.message}`);
    }
  };
}

export function startWebServer({ config, dataDir, port }) {
  const listener = createRequestListener({ config, dataDir });
  const server = http.createServer(listener);
  server.listen(port);
  return server;
}
