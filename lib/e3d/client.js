const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RELEASE_PATH = '/webhooks/e3d-financial-stress-evaluation/release';
const DEFAULT_REJECT_PATH = '/webhooks/e3d-financial-stress-evaluation/reject';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('e3d.baseUrl is required for financial stress callbacks');
  }
  return baseUrl.replace(/\/+$/, '');
}

function normalizePath(pathname, defaultPath, configPath) {
  if (pathname === undefined) return defaultPath;
  if (typeof pathname !== 'string' || pathname.trim() === '') {
    throw new Error(`${configPath} must be a non-empty string`);
  }
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function readEnvHeader(envVar, headerName) {
  if (typeof envVar !== 'string' || envVar.trim() === '') return {};
  const value = process.env[envVar];
  if (typeof value !== 'string' || value.trim() === '') return {};
  return { [headerName]: value.trim() };
}

function authHeaders(config = {}) {
  return {
    ...readEnvHeader(config.apiKeyEnvVar, 'x-api-key'),
    ...readEnvHeader(config.apiKeyEnvVar, 'x-e3d-api-key'),
    ...readEnvHeader(config.sessionCookieEnvVar, 'Cookie')
  };
}

function isRetryableStatus(status) {
  return status >= 500 && status <= 599;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function errorWithStatus(message, status, payload) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw errorWithStatus(`e3d returned non-JSON response (HTTP ${response.status})`, response.status, text);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function createE3dClient(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for financial stress callbacks');
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const releasePath = normalizePath(config.releasePath, DEFAULT_RELEASE_PATH, 'e3d.releasePath');
  const rejectPath = normalizePath(config.rejectPath, DEFAULT_REJECT_PATH, 'e3d.rejectPath');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('e3d.timeoutMs must be an integer >= 1');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('e3d.maxAttempts must be an integer >= 1');
  }

  async function postJson(pathname, body, idempotencyKey, errorLabel) {
    const url = `${baseUrl}${pathname}`;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...authHeaders(config)
    };

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timer);

        const payload = await readJsonResponse(response);
        if (response.ok) {
          return payload;
        }

        const message = payload?.message ?? payload?.error ?? `e3d rejected ${errorLabel} (HTTP ${response.status})`;
        const error = errorWithStatus(message, response.status, payload);
        if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
      } catch (error) {
        clearTimeout(timer);
        if (!isAbortError(error) && !(error?.status && isRetryableStatus(error.status))) {
          throw error;
        }
        lastError = error;
        if (attempt === maxAttempts) {
          throw new Error(
            isAbortError(error)
              ? `Timed out sending ${errorLabel} to e3d; delivery is unconfirmed`
              : `Failed sending ${errorLabel} to e3d after retry: ${error.message}`
          );
        }
      }

      await sleep(Math.min(100 * attempt, 1000));
    }

    throw lastError;
  }

  async function releaseFinancialStressChange(payload) {
    if (!isPlainObject(payload)) {
      throw new Error('releaseFinancialStressChange requires a payload object');
    }
    const runId = requireNonEmptyString(payload.run_id, 'releaseFinancialStressChange payload.run_id');
    const eventId = requireNonEmptyString(payload.event_id, 'releaseFinancialStressChange payload.event_id');
    return postJson(releasePath, payload, `release:${runId}:${eventId}`, 'financial stress release');
  }

  async function rejectFinancialStressChange(payload) {
    if (!isPlainObject(payload)) {
      throw new Error('rejectFinancialStressChange requires a payload object');
    }
    const runId = requireNonEmptyString(payload.run_id, 'rejectFinancialStressChange payload.run_id');
    return postJson(rejectPath, payload, `reject:${runId}`, 'financial stress rejection');
  }

  return { releaseFinancialStressChange, rejectFinancialStressChange };
}
