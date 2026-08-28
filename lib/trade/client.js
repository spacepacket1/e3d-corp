const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MANDATE_PATH = '/api/mandates/capital';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('e3dTrade.baseUrl is required to submit a capital_mandate');
  }
  return baseUrl.replace(/\/+$/, '');
}

function normalizePath(pathname) {
  if (pathname === undefined) return DEFAULT_MANDATE_PATH;
  if (typeof pathname !== 'string' || pathname.trim() === '') {
    throw new Error('e3dTrade.mandatePath must be a non-empty string');
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
    throw errorWithStatus(`e3d-trade returned non-JSON response (HTTP ${response.status})`, response.status, text);
  }
}

export function createE3dTradeClient(config = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to submit a capital_mandate');
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const mandatePath = normalizePath(config.mandatePath);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('e3dTrade.timeoutMs must be an integer >= 1');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('e3dTrade.maxAttempts must be an integer >= 1');
  }

  async function submitCapitalMandate(mandate) {
    if (!isPlainObject(mandate)) {
      throw new Error('submitCapitalMandate requires a mandate object');
    }
    if (typeof mandate.mandate_id !== 'string' || mandate.mandate_id.trim() === '') {
      throw new Error('submitCapitalMandate requires mandate.mandate_id for idempotency');
    }

    const url = `${baseUrl}${mandatePath}`;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': mandate.mandate_id,
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
          body: JSON.stringify(mandate),
          signal: controller.signal
        });
        clearTimeout(timer);

        const payload = await readJsonResponse(response);
        if (response.ok) {
          return payload;
        }

        const message = payload?.message ?? payload?.error ?? `e3d-trade rejected capital_mandate submission (HTTP ${response.status})`;
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
              ? 'Timed out submitting capital_mandate to e3d-trade; delivery is unconfirmed'
              : `Failed submitting capital_mandate to e3d-trade after retry: ${error.message}`
          );
        }
      }

      await sleep(Math.min(100 * attempt, 1000));
    }

    throw lastError;
  }

  async function revokeCapitalMandate(mandateId, body = {}) {
    if (typeof mandateId !== 'string' || mandateId.trim() === '') {
      throw new Error('revokeCapitalMandate requires a mandate_id');
    }
    const url = `${baseUrl}${mandatePath}/${encodeURIComponent(mandateId)}/revoke`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': `revoke:${mandateId}`,
        ...authHeaders(config)
      },
      body: JSON.stringify(body)
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw errorWithStatus(payload?.message ?? payload?.error ?? `e3d-trade rejected mandate revocation (HTTP ${response.status})`, response.status, payload);
    }
    return payload;
  }

  return { submitCapitalMandate, revokeCapitalMandate };
}
