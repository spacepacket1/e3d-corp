const GRAPH_API_VERSION = 'v21.0';
const DEFAULT_FIELDS = ['campaign_id', 'campaign_name', 'impressions', 'clicks', 'spend', 'cpm', 'actions', 'cost_per_action_type'];

function unavailableResult(adAccountId, reason) {
  return {
    status: 'unavailable',
    provider: 'meta-insights',
    adAccountId: adAccountId ?? null,
    reason,
    summary: reason,
    rowCount: 0,
    rows: []
  };
}

function actionValue(actions, actionType) {
  const match = (actions ?? []).find((action) => action.action_type === actionType);
  return match ? Number(match.value) : null;
}

// Flattens Meta's actions/cost_per_action_type arrays down to the one metric
// this funnel actually cares about (landing_page_view, since that's the
// optimization goal both active campaigns use - see the ops handoff), while
// keeping the raw arrays in the row too so nothing is silently discarded.
function normalizeRow(row) {
  return {
    date: row.date_start,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    impressions: row.impressions !== undefined ? Number(row.impressions) : null,
    clicks: row.clicks !== undefined ? Number(row.clicks) : null,
    spend: row.spend !== undefined ? Number(row.spend) : null,
    cpm: row.cpm !== undefined ? Number(row.cpm) : null,
    landingPageViews: actionValue(row.actions, 'landing_page_view'),
    costPerLandingPageView: actionValue(row.cost_per_action_type, 'landing_page_view'),
    actions: row.actions ?? [],
    costPerActionType: row.cost_per_action_type ?? []
  };
}

export async function fetchMetaInsights({
  token,
  adAccountId,
  campaignIds,
  fields,
  lookbackDays,
  limit
} = {}) {
  if (!adAccountId) {
    return unavailableResult(adAccountId, 'Meta ad account id is not configured');
  }
  if (!token) {
    return unavailableResult(adAccountId, 'Meta access token is not configured');
  }
  if (!Array.isArray(campaignIds) || campaignIds.length === 0) {
    return unavailableResult(adAccountId, 'Meta campaign id list is not configured');
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/act_${adAccountId}/insights`);
  url.searchParams.set('level', 'campaign');
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('date_preset', `last_${lookbackDays ?? 14}d`);
  url.searchParams.set('fields', (fields && fields.length > 0 ? fields : DEFAULT_FIELDS).join(','));
  url.searchParams.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]));
  url.searchParams.set('limit', String(limit ?? 100));

  let response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    return unavailableResult(adAccountId, `Meta insights request failed: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message ?? text;
    } catch {
      // keep the raw text if it isn't JSON
    }
    return unavailableResult(adAccountId, `Meta insights returned HTTP ${response.status}: ${message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return unavailableResult(adAccountId, `Meta insights returned invalid JSON: ${error.message}`);
  }

  const rows = Array.isArray(data.data) ? data.data.map(normalizeRow) : [];
  return {
    status: 'ok',
    provider: 'meta-insights',
    adAccountId,
    query: { adAccountId, campaignIds, lookbackDays: lookbackDays ?? 14 },
    rowCount: rows.length,
    rows,
    summary: `${rows.length} row(s) across ${campaignIds.length} campaign(s)`
  };
}
