import crypto from 'node:crypto';
import { appendEventWithinLock, readAllEventRecords, withEventsLockAsync } from '../events/store.js';

const SUPPORTED_PERIOD = 'daily';

// Phase 2's reservation step needs a deterministic ceiling before the call
// happens. Until real operating data justifies differentiated ceilings, the
// supported provider kinds use the same conservative reservation size.
export const RESERVED_TOKENS_BY_PROVIDER_KIND = {
  local: 500,
  'openai-compatible': 500,
  'grok-cli': 500
};

function getBudgetConfig(instanceConfig) {
  return instanceConfig?.llm?.budget ?? null;
}

function getProviderConfig(instanceConfig, providerName) {
  return instanceConfig?.llm?.providers?.[providerName] ?? null;
}

function getProviderLimit(instanceConfig, providerName) {
  return getBudgetConfig(instanceConfig)?.limits?.[providerName]?.tokens ?? null;
}

function utcPeriodBounds(now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
  return {
    periodStart,
    periodEnd
  };
}

function isWithinPeriod(occurredAt, periodStart, periodEnd) {
  const time = new Date(occurredAt).getTime();
  return time >= periodStart.getTime() && time < periodEnd.getTime();
}

function isSettledBudgetEvent(event) {
  return event.type === 'role.provider.completed' || event.type === 'role.provider.failed';
}

function providerForEvent(event) {
  return event.payload?.provider ?? event.subject?.id ?? null;
}

function collectProviderEvents(events, providerName) {
  return events.filter((event) => providerForEvent(event) === providerName);
}

function computeFold(events, providerName, now = new Date()) {
  const { periodStart, periodEnd } = utcPeriodBounds(now);
  const providerEvents = collectProviderEvents(events, providerName);
  const settledReservationIds = new Set(
    providerEvents
      .filter(isSettledBudgetEvent)
      .map((event) => event.payload?.reservationId)
      .filter((reservationId) => typeof reservationId === 'string' && reservationId.trim() !== '')
  );

  let settled = 0;
  let outstanding = 0;
  const countedSettlements = new Set();
  for (const event of providerEvents) {
    if (!isWithinPeriod(event.occurredAt, periodStart, periodEnd)) {
      continue;
    }

    if (isSettledBudgetEvent(event)) {
      const reservationId = event.payload?.reservationId;
      if (typeof reservationId === 'string' && reservationId.trim() !== '') {
        if (countedSettlements.has(reservationId)) {
          continue;
        }
        countedSettlements.add(reservationId);
      }
      const totalTokens = event.payload?.usage?.totalTokens;
      if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
        settled += totalTokens;
      }
      continue;
    }

    if (event.type !== 'role.provider.reserved') {
      continue;
    }

    const reservationId = event.payload?.reservationId;
    if (typeof reservationId === 'string' && settledReservationIds.has(reservationId)) {
      continue;
    }

    const estimatedTokens = event.payload?.estimatedTokens;
    if (typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens)) {
      outstanding += estimatedTokens;
    }
  }

  return {
    settled,
    outstanding,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString()
  };
}

function reservationSizeForProvider(instanceConfig, providerName) {
  const providerConfig = getProviderConfig(instanceConfig, providerName);
  if (!providerConfig) {
    throw new Error(`Provider "${providerName}" is not defined under llm.providers`);
  }

  const estimatedTokens = RESERVED_TOKENS_BY_PROVIDER_KIND[providerConfig.kind];
  if (!estimatedTokens) {
    throw new Error(`Provider "${providerName}" has unsupported kind "${providerConfig.kind}" for budgeting`);
  }

  return estimatedTokens;
}

export async function reserveBudget(dataDir, instanceConfig, providerName, options = {}) {
  const limit = getProviderLimit(instanceConfig, providerName);
  const reservationId = crypto.randomUUID();
  // Every grant records a role.provider.reserved event, unlimited providers
  // included - settleReservation always requires a matching reservation to
  // exist, so "unlimited" must still mean "always grants," never "skips the
  // reservation record." Keeping every settle backed by exactly one prior
  // reserve avoids a second, reservation-less code path in settle.
  const estimatedTokens = limit === null ? 0 : reservationSizeForProvider(instanceConfig, providerName);

  return withEventsLockAsync(dataDir, async () => {
    if (limit !== null) {
      const fold = computeFold(readAllEventRecords(dataDir), providerName);
      if (fold.settled + fold.outstanding + estimatedTokens > limit) {
        return { granted: false, reason: 'budget exhausted' };
      }
    }

    appendEventWithinLock(dataDir, {
      type: 'role.provider.reserved',
      source: options.source ?? 'llm.budget',
      subject: options.subject ?? { type: 'provider', id: providerName },
      payload: {
        role: options.role ?? null,
        provider: providerName,
        reservationId,
        estimatedTokens
      },
      causationId: options.causationId ?? null,
      correlationId: options.correlationId ?? reservationId
    });

    return { granted: true, reservationId };
  });
}

export async function settleReservation(dataDir, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('settleReservation requires an event object');
  }
  if (!isSettledBudgetEvent(event)) {
    throw new Error('settleReservation only supports role.provider.completed or role.provider.failed events');
  }

  const reservationId = event.payload?.reservationId;
  if (typeof reservationId !== 'string' || reservationId.trim() === '') {
    throw new Error('settleReservation requires payload.reservationId');
  }

  return withEventsLockAsync(dataDir, async () => {
    const events = readAllEventRecords(dataDir);
    const reservation = events.find(
      (entry) => entry.type === 'role.provider.reserved' && entry.payload?.reservationId === reservationId
    );
    if (!reservation) {
      throw new Error(`No reservation found for reservationId "${reservationId}"`);
    }

    const alreadySettled = events.find(
      (entry) => isSettledBudgetEvent(entry) && entry.payload?.reservationId === reservationId
    );
    if (alreadySettled) {
      throw new Error(`Reservation "${reservationId}" is already settled`);
    }

    const reservedProvider = reservation.payload?.provider ?? reservation.subject?.id;
    const settledProvider = providerForEvent(event);
    if (reservedProvider && settledProvider && reservedProvider !== settledProvider) {
      throw new Error(
        `Reservation "${reservationId}" belongs to provider "${reservedProvider}", not "${settledProvider}"`
      );
    }

    return appendEventWithinLock(dataDir, event);
  });
}

export function computeBudgetStatus(dataDir, instanceConfig, providerName) {
  const budgetConfig = getBudgetConfig(instanceConfig);
  const limit = getProviderLimit(instanceConfig, providerName);
  if (!budgetConfig || limit === null) {
    return { provider: providerName, unlimited: true };
  }
  if (budgetConfig.period !== undefined && budgetConfig.period !== SUPPORTED_PERIOD) {
    throw new Error(`Unsupported budget period "${budgetConfig.period}"`);
  }

  const fold = computeFold(readAllEventRecords(dataDir), providerName);
  return {
    provider: providerName,
    limit,
    settled: fold.settled,
    outstanding: fold.outstanding,
    remaining: Math.max(0, limit - (fold.settled + fold.outstanding)),
    periodStart: fold.periodStart,
    periodEnd: fold.periodEnd
  };
}

export function listBudgetProviders(instanceConfig) {
  return Object.keys(getBudgetConfig(instanceConfig)?.limits ?? {});
}
