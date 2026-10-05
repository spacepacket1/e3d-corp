import { loadServiceAccountCredentials, getServiceAccountAccessToken } from '../calendar/googleServiceAccount.js';

// Reuses the calendar module's hand-rolled service-account OAuth2 (it's
// generic Google JWT-bearer auth, not calendar-specific - the scope param
// is what actually selects the product) rather than duplicating JWT signing
// for a second Google API.
const ANALYTICS_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function unavailableResult(propertyId, label, reason) {
  return {
    status: 'unavailable',
    provider: 'ga4-report',
    propertyId: propertyId ?? null,
    label: label ?? null,
    reason,
    summary: reason,
    rowCount: 0,
    rows: []
  };
}

function normalizeRows(report) {
  const dimensionNames = (report.dimensionHeaders ?? []).map((header) => header.name);
  const metricNames = (report.metricHeaders ?? []).map((header) => header.name);

  return (report.rows ?? []).map((row) => {
    const entry = {};
    (row.dimensionValues ?? []).forEach((value, index) => {
      entry[dimensionNames[index]] = value.value;
    });
    (row.metricValues ?? []).forEach((value, index) => {
      entry[metricNames[index]] = Number(value.value);
    });
    return entry;
  });
}

export async function fetchGa4Report({
  credentialsKeyFile,
  propertyId,
  label,
  dimensions,
  metrics,
  startDate,
  endDate,
  limit
} = {}) {
  if (!propertyId) {
    return unavailableResult(propertyId, label, 'GA4 property id is not configured');
  }
  if (!credentialsKeyFile) {
    return unavailableResult(propertyId, label, 'GA4 credentials file is not configured');
  }

  const resolvedDimensions = dimensions && dimensions.length > 0 ? dimensions : ['date', 'pagePath'];
  const resolvedMetrics = metrics && metrics.length > 0 ? metrics : ['sessions', 'screenPageViews'];
  const resolvedStartDate = startDate ?? '7daysAgo';
  const resolvedEndDate = endDate ?? 'today';

  let accessToken;
  try {
    const { clientEmail, privateKey } = loadServiceAccountCredentials(credentialsKeyFile);
    accessToken = await getServiceAccountAccessToken({
      clientEmail,
      privateKey,
      scope: ANALYTICS_READONLY_SCOPE
    });
  } catch (error) {
    return unavailableResult(propertyId, label, `GA4 auth failed: ${error.message}`);
  }

  let response;
  try {
    response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: resolvedStartDate, endDate: resolvedEndDate }],
        dimensions: resolvedDimensions.map((name) => ({ name })),
        metrics: resolvedMetrics.map((name) => ({ name })),
        limit: limit ?? 250
      })
    });
  } catch (error) {
    return unavailableResult(propertyId, label, `GA4 report request failed: ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text();
    return unavailableResult(
      propertyId,
      label,
      `GA4 runReport returned HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return unavailableResult(propertyId, label, `GA4 report returned invalid JSON: ${error.message}`);
  }

  const rows = normalizeRows(data);
  return {
    status: 'ok',
    provider: 'ga4-report',
    propertyId,
    label: label ?? null,
    query: {
      propertyId,
      startDate: resolvedStartDate,
      endDate: resolvedEndDate,
      dimensions: resolvedDimensions,
      metrics: resolvedMetrics
    },
    rowCount: rows.length,
    rows,
    summary: `${rows.length} row(s) for ${label ?? propertyId}`
  };
}
