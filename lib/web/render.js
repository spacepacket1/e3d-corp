import { AUTHORITY_LEVELS } from '../authority/policy.js';
import { OUTCOME_TYPES } from '../outcomes/schema.js';

const OPPORTUNITY_DECISIONS = ['reviewed', 'pursuing', 'no-value'];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  nav a { margin-right: 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
  .chain li { font-family: ui-monospace, monospace; font-size: 0.85rem; }
  form.inline { display: inline-block; margin-right: 0.5rem; }
  fieldset { margin: 1rem 0; }
  .error { color: #b00020; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 0.3rem; background: #eee; font-size: 0.8rem; }
`;

export function renderPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} - e3d-corp</title>
<style>${STYLE}</style>
</head>
<body>
<nav><a href="/opportunities">Opportunities</a><a href="/proposals">Proposals</a><a href="/actions">Actions</a><a href="/outcomes">Outcomes</a></nav>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
}

function csrfField(csrfToken) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
}

export function renderOpportunitiesList(opportunities, filters) {
  const rows = opportunities
    .map(
      (o) => `<tr>
        <td><a href="/opportunities/${encodeURIComponent(o.id)}">${escapeHtml(o.title)}</a></td>
        <td>${escapeHtml(o.type)}</td>
        <td><span class="badge">${escapeHtml(o.status)}</span></td>
        <td>${o.score ? escapeHtml(o.score.value) : '-'}</td>
      </tr>`
    )
    .join('\n');

  return `
<form method="get" action="/opportunities">
  <label>Status <input type="text" name="status" value="${escapeHtml(filters.status ?? '')}"></label>
  <label>Type <input type="text" name="type" value="${escapeHtml(filters.type ?? '')}"></label>
  <label>Min score <input type="text" name="minScore" value="${escapeHtml(filters.minScore ?? '')}"></label>
  <button type="submit">Filter</button>
</form>
<table>
  <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Score</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">No opportunities found.</td></tr>'}</tbody>
</table>`;
}

function renderChain(chain) {
  const items = chain
    .map(
      (event) =>
        `<li>${escapeHtml(event.occurredAt)} &mdash; [${escapeHtml(event.type)}] id=${escapeHtml(event.id)} causation=${escapeHtml(event.causationId ?? '-')} source=${escapeHtml(event.source)}<br>payload: ${escapeHtml(JSON.stringify(event.payload))}</li>`
    )
    .join('\n');
  return `<ol class="chain">${items || '<li>No events found.</li>'}</ol>`;
}

export function renderOpportunityDetail(opportunity, chain, { csrfToken, error, info } = {}) {
  const evidence = (opportunity.evidence ?? []).join(', ') || '-';
  const options = OPPORTUNITY_DECISIONS.map(
    (value) => `<option value="${value}">${value}</option>`
  ).join('');

  return `
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${info ? `<p>${escapeHtml(info)}</p>` : ''}
<dl>
  <dt>id</dt><dd>${escapeHtml(opportunity.id)}</dd>
  <dt>type</dt><dd>${escapeHtml(opportunity.type)}</dd>
  <dt>status</dt><dd>${escapeHtml(opportunity.status)}</dd>
  <dt>score</dt><dd>${opportunity.score ? escapeHtml(opportunity.score.value) : '-'}</dd>
  <dt>rationale</dt><dd>${opportunity.score ? escapeHtml(opportunity.score.rationale) : '-'}</dd>
  <dt>description</dt><dd>${escapeHtml(opportunity.description)}</dd>
  <dt>evidence</dt><dd>${escapeHtml(evidence)}</dd>
  <dt>correlationId</dt><dd>${escapeHtml(opportunity.correlationId)}</dd>
  <dt>createdAt</dt><dd>${escapeHtml(opportunity.createdAt)}</dd>
</dl>
<h2>Causal chain</h2>
${renderChain(chain)}
<h2>Decide</h2>
<form method="post" action="/opportunities/${encodeURIComponent(opportunity.id)}/decide">
  ${csrfField(csrfToken)}
  <fieldset>
    <label>Decision <select name="status">${options}</select></label>
    <label>Reason <input type="text" name="reason" required></label>
    <button type="submit">Decide</button>
  </fieldset>
</form>
<h2>e3d-pilot handoff</h2>
<form method="post" action="/opportunities/${encodeURIComponent(opportunity.id)}/propose-handoff">
  ${csrfField(csrfToken)}
  <fieldset>
    <label>Target repo path <input type="text" name="repo" required></label>
    <label>Reason <input type="text" name="reason" required></label>
    <button type="submit">Propose handoff</button>
  </fieldset>
</form>
<form method="post" action="/opportunities/${encodeURIComponent(opportunity.id)}/check-shipped">
  ${csrfField(csrfToken)}
  <button type="submit">Check shipped</button>
</form>
<h2>Record an outcome</h2>
<form method="post" action="/opportunities/${encodeURIComponent(opportunity.id)}/outcomes">
  ${csrfField(csrfToken)}
  <fieldset>
    <label>Type <select name="type">${OUTCOME_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></label>
    <label>Payload (JSON) <textarea name="payload" rows="3" cols="50">{}</textarea></label>
    <button type="submit">Record outcome</button>
  </fieldset>
</form>
<p><a href="/opportunities/${encodeURIComponent(opportunity.id)}/experience">View experience record</a></p>`;
}

function summarizeProposal(proposal) {
  const parts = [`type=${proposal.type}`, `level=${proposal.authorityLevel}`];
  if (typeof proposal.payload?.amount === 'number') {
    parts.push(`amount=${proposal.payload.amount}`);
  }
  const recipient = proposal.payload?.to ?? proposal.payload?.recipient;
  if (recipient) {
    parts.push(`recipient=${recipient}`);
  }
  return parts.join(', ');
}

export function renderProposalsList(proposals, filters) {
  const rows = proposals
    .map(
      (p) => `<tr>
        <td><a href="/proposals/${encodeURIComponent(p.id)}">${escapeHtml(p.id)}</a></td>
        <td>${escapeHtml(p.type)}</td>
        <td>${escapeHtml(p.authorityLevel)}</td>
        <td><span class="badge">${escapeHtml(p.status)}</span></td>
        <td>${escapeHtml(summarizeProposal(p))}</td>
      </tr>`
    )
    .join('\n');

  return `
<form method="get" action="/proposals">
  <label>Status <input type="text" name="status" value="${escapeHtml(filters.status ?? '')}"></label>
  <label>Type <input type="text" name="type" value="${escapeHtml(filters.type ?? '')}"></label>
  <button type="submit">Filter</button>
</form>
<table>
  <thead><tr><th>Id</th><th>Type</th><th>Level</th><th>Status</th><th>Summary</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5">No proposals found.</td></tr>'}</tbody>
</table>`;
}

export function renderActionsList(actions) {
  const rows = actions
    .map(
      (action) => `<tr>
        <td>${escapeHtml(action.occurredAt)}</td>
        <td>${escapeHtml(action.type)}</td>
        <td>${escapeHtml(action.summary)}</td>
        <td>${action.proposalId ? `<a href="/proposals/${encodeURIComponent(action.proposalId)}">${escapeHtml(action.proposalId)}</a>` : '-'}</td>
        <td>${action.opportunityId ? `<a href="/opportunities/${encodeURIComponent(action.opportunityId)}">${escapeHtml(action.opportunityId)}</a>` : '-'}</td>
      </tr>`
    )
    .join('\n');

  return `
<p>Observational log of actions that have actually fired. Approving already happened upstream at the Proposal - nothing here is itself something to approve.</p>
<table>
  <thead><tr><th>When</th><th>Type</th><th>Summary</th><th>Proposal</th><th>Opportunity</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5">No actions have fired yet.</td></tr>'}</tbody>
</table>`;
}

export function renderProposalDetail(proposal, chain, { csrfToken, error, executed } = {}) {
  const needsConfirm = proposal.status === 'approved' && proposal.authorityLevel >= AUTHORITY_LEVELS.FINANCIAL_ACTION;
  const decideForms =
    proposal.status === 'pending'
      ? `
<form class="inline" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/approve">
  ${csrfField(csrfToken)}
  <label>Reason <input type="text" name="reason" required></label>
  <button type="submit">Approve${proposal.authorityLevel >= AUTHORITY_LEVELS.FINANCIAL_ACTION ? ' (requires confirm)' : ''}</button>
</form>
<form class="inline" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/reject">
  ${csrfField(csrfToken)}
  <label>Reason <input type="text" name="reason" required></label>
  <button type="submit">Reject</button>
</form>`
      : '';
  const confirmForm = needsConfirm
    ? `
<form method="post" action="/proposals/${encodeURIComponent(proposal.id)}/confirm">
  ${csrfField(csrfToken)}
  <p>This proposal is authority level ${proposal.authorityLevel} and has been approved but not yet executed. Confirm to fire the action.</p>
  <button type="submit">Confirm and execute</button>
</form>`
    : '';

  return `
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${executed ? '<p><strong>Action executed.</strong></p>' : ''}
<dl>
  <dt>id</dt><dd>${escapeHtml(proposal.id)}</dd>
  <dt>type</dt><dd>${escapeHtml(proposal.type)}</dd>
  <dt>authorityLevel</dt><dd>${escapeHtml(proposal.authorityLevel)}</dd>
  <dt>status</dt><dd>${escapeHtml(proposal.status)}</dd>
  <dt>proposedBy</dt><dd>${escapeHtml(JSON.stringify(proposal.proposedBy))}</dd>
  <dt>payload</dt><dd>${escapeHtml(JSON.stringify(proposal.payload))}</dd>
  <dt>correlationId</dt><dd>${escapeHtml(proposal.correlationId)}</dd>
  <dt>createdAt</dt><dd>${escapeHtml(proposal.createdAt)}</dd>
</dl>
<h2>Causal chain</h2>
${renderChain(chain)}
<h2>Decide</h2>
${decideForms || `<p>Status: ${escapeHtml(proposal.status)}</p>`}
${confirmForm}`;
}

export function renderOutcomesList(outcomes) {
  const rows = outcomes
    .map(
      (outcome) => `<tr>
        <td>${escapeHtml(outcome.occurredAt)}</td>
        <td>${escapeHtml(outcome.type)}</td>
        <td>${escapeHtml(outcome.correlationId)}</td>
        <td>${escapeHtml(JSON.stringify(outcome.payload))}</td>
      </tr>`
    )
    .join('\n');

  return `
<p>Real-world facts recorded about what actually happened - distinct from and never a substitute for approval Decisions.</p>
<table>
  <thead><tr><th>When</th><th>Type</th><th>correlationId</th><th>Payload</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4">No outcomes recorded yet.</td></tr>'}</tbody>
</table>`;
}

export function renderExperience(experience) {
  return `
<dl>
  <dt>correlationId</dt><dd>${escapeHtml(experience.correlationId)}</dd>
  <dt>context</dt><dd>${escapeHtml(experience.context)}</dd>
  <dt>role</dt><dd>${escapeHtml(experience.role ?? '-')}</dd>
  <dt>model</dt><dd>${escapeHtml(experience.model ?? '-')}</dd>
  <dt>originatingEvent</dt><dd>[${escapeHtml(experience.originatingEvent.type)}] ${escapeHtml(experience.originatingEvent.id)}</dd>
  <dt>evidence</dt><dd>${experience.evidence.length} item(s)</dd>
  <dt>proposal</dt><dd>${experience.proposal ? escapeHtml(experience.proposal.type) : '-'}</dd>
  <dt>decision</dt><dd>${experience.decision ? escapeHtml(experience.decision.decision ?? experience.decision.status ?? '') : '-'}</dd>
  <dt>action</dt><dd>${experience.action ? escapeHtml(experience.action.type) : '-'}</dd>
  <dt>outcome</dt><dd>${experience.outcome ? escapeHtml(experience.outcome.type) : '-'}</dd>
  <dt>latencyMs</dt><dd>${experience.latencyMs ?? '-'}</dd>
  <dt>costEstimate</dt><dd>${experience.costEstimate ?? '-'}</dd>
</dl>`;
}
