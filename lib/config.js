import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getRootDir() {
  return ROOT_DIR;
}

export function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addError(errors, pathLabel, message) {
  errors.push(`${pathLabel}: ${message}`);
}

function validateStringField(errors, value, pathLabel) {
  if (typeof value !== 'string' || value.trim() === '') {
    addError(errors, pathLabel, 'must be a non-empty string');
  }
}

function validateIntegerField(errors, value, pathLabel, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    addError(errors, pathLabel, `must be an integer >= ${minimum}`);
  }
}

function validateObjectField(errors, value, pathLabel) {
  if (!isPlainObject(value)) {
    addError(errors, pathLabel, 'must be an object');
  }
}

function validateOptionalStringField(errors, value, pathLabel) {
  if (value !== undefined) {
    validateStringField(errors, value, pathLabel);
  }
}

function validateOptionalIntegerField(errors, value, pathLabel, minimum = 1) {
  if (value !== undefined) {
    validateIntegerField(errors, value, pathLabel, minimum);
  }
}

function validateProviderReferenceField(errors, value, pathLabel, providerNames) {
  const values = [];

  if (typeof value === 'string') {
    validateStringField(errors, value, pathLabel);
    if (typeof value === 'string' && value.trim() !== '') {
      values.push(value.trim());
    }
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      addError(errors, pathLabel, 'must be a non-empty string or non-empty array of provider names');
      return;
    }
    value.forEach((entry, index) => {
      const itemPath = `${pathLabel}[${index}]`;
      validateStringField(errors, entry, itemPath);
      if (typeof entry === 'string' && entry.trim() !== '') {
        values.push(entry.trim());
      }
    });
  } else {
    addError(errors, pathLabel, 'must be a non-empty string or non-empty array of provider names');
    return;
  }

  if (providerNames) {
    values.forEach((providerName) => {
      if (!providerNames.has(providerName)) {
        addError(
          errors,
          pathLabel,
          `references unknown provider "${providerName}" (define it under llm.providers)`
        );
      }
    });
  }
}

function validateBudgetConfig(errors, budgetConfig, providerNames) {
  validateObjectField(errors, budgetConfig, 'llm.budget');
  if (!isPlainObject(budgetConfig)) {
    return;
  }

  const allowedFields = new Set(['period', 'limits']);
  for (const key of Object.keys(budgetConfig)) {
    if (!allowedFields.has(key)) {
      addError(errors, `llm.budget.${key}`, 'is not supported');
    }
  }

  if (budgetConfig.period !== undefined && budgetConfig.period !== 'daily') {
    addError(errors, 'llm.budget.period', 'must be "daily"');
  }

  if (budgetConfig.limits !== undefined) {
    validateObjectField(errors, budgetConfig.limits, 'llm.budget.limits');
    if (isPlainObject(budgetConfig.limits)) {
      for (const [providerName, limitConfig] of Object.entries(budgetConfig.limits)) {
        const limitPath = `llm.budget.limits.${providerName}`;
        validateObjectField(errors, limitConfig, limitPath);
        if (!isPlainObject(limitConfig)) {
          continue;
        }

        const limitFields = Object.keys(limitConfig);
        if (limitFields.some((field) => field !== 'tokens')) {
          for (const field of limitFields) {
            if (field !== 'tokens') {
              addError(errors, `${limitPath}.${field}`, 'is not supported');
            }
          }
        }

        validateIntegerField(errors, limitConfig.tokens, `${limitPath}.tokens`);
        if (providerNames && !providerNames.has(providerName)) {
          addError(
            errors,
            limitPath,
            `references unknown provider "${providerName}" (define it under llm.providers)`
          );
        }
      }
    }
  }
}

function detectLegacyLlmConfig(config) {
  const legacyFields = [];

  if (isPlainObject(config.llm)) {
    if (Object.hasOwn(config.llm, 'baseUrlEnvVar')) legacyFields.push('llm.baseUrlEnvVar');
    if (Object.hasOwn(config.llm, 'modelEnvVar')) legacyFields.push('llm.modelEnvVar');
  }

  if (isPlainObject(config.roles)) {
    for (const [roleName, roleConfig] of Object.entries(config.roles)) {
      if (isPlainObject(roleConfig) && Object.hasOwn(roleConfig, 'model')) {
        legacyFields.push(`roles.${roleName}.model`);
      }
    }
  }

  return legacyFields;
}

function validateProviderConfig(errors, providerName, providerConfig) {
  const providerPath = `llm.providers.${providerName}`;
  validateObjectField(errors, providerConfig, providerPath);
  if (!isPlainObject(providerConfig)) {
    return;
  }

  validateStringField(errors, providerConfig.kind, `${providerPath}.kind`);
  if (typeof providerConfig.kind !== 'string' || providerConfig.kind.trim() === '') {
    return;
  }

  const allowedFields = new Set(['kind', 'baseUrlEnvVar', 'modelEnvVar', 'apiKeyEnvVar', 'binEnvVar', 'timeoutMs', 'maxTokens']);
  for (const key of Object.keys(providerConfig)) {
    if (!allowedFields.has(key)) {
      addError(errors, `${providerPath}.${key}`, 'is not supported for this provider');
    }
  }

  switch (providerConfig.kind) {
    case 'local':
      validateStringField(errors, providerConfig.baseUrlEnvVar, `${providerPath}.baseUrlEnvVar`);
      validateStringField(errors, providerConfig.modelEnvVar, `${providerPath}.modelEnvVar`);
      validateOptionalIntegerField(errors, providerConfig.timeoutMs, `${providerPath}.timeoutMs`);
      break;
    case 'openai-compatible':
      validateStringField(errors, providerConfig.baseUrlEnvVar, `${providerPath}.baseUrlEnvVar`);
      validateStringField(errors, providerConfig.modelEnvVar, `${providerPath}.modelEnvVar`);
      validateStringField(errors, providerConfig.apiKeyEnvVar, `${providerPath}.apiKeyEnvVar`);
      validateOptionalIntegerField(errors, providerConfig.timeoutMs, `${providerPath}.timeoutMs`);
      break;
    case 'grok-cli':
      validateOptionalStringField(errors, providerConfig.binEnvVar, `${providerPath}.binEnvVar`);
      validateOptionalStringField(errors, providerConfig.modelEnvVar, `${providerPath}.modelEnvVar`);
      validateOptionalIntegerField(errors, providerConfig.timeoutMs, `${providerPath}.timeoutMs`);
      break;
    case 'anthropic':
      validateStringField(errors, providerConfig.apiKeyEnvVar, `${providerPath}.apiKeyEnvVar`);
      validateOptionalStringField(errors, providerConfig.modelEnvVar, `${providerPath}.modelEnvVar`);
      validateOptionalIntegerField(errors, providerConfig.timeoutMs, `${providerPath}.timeoutMs`);
      validateOptionalIntegerField(errors, providerConfig.maxTokens, `${providerPath}.maxTokens`, 1);
      break;
    default:
      addError(errors, `${providerPath}.kind`, 'must be one of: local, openai-compatible, grok-cli, anthropic');
      break;
  }
}

export function validateInstanceConfig(config) {
  const errors = [];

  validateObjectField(errors, config, 'config');
  if (!isPlainObject(config)) {
    return { valid: false, errors };
  }

  validateStringField(errors, config.name, 'name');
  validateStringField(errors, config.dataDir, 'dataDir');

  const legacyLlmFields = detectLegacyLlmConfig(config);
  if (legacyLlmFields.length > 0) {
    addError(
      errors,
      'llm.providers',
      `replace legacy provider fields (${legacyLlmFields.join(', ')}) with the llm.providers registry`
    );
  }

  validateObjectField(errors, config.llm, 'llm');
  if (isPlainObject(config.llm)) {
    validateObjectField(errors, config.llm.providers, 'llm.providers');
    const providerNames = isPlainObject(config.llm.providers) ? new Set(Object.keys(config.llm.providers)) : null;
    if (isPlainObject(config.llm.providers)) {
      const providerEntries = Object.entries(config.llm.providers);
      if (providerEntries.length === 0) {
        addError(errors, 'llm.providers', 'must define at least one provider');
      }
      for (const [providerName, providerConfig] of providerEntries) {
        validateProviderConfig(errors, providerName, providerConfig);
      }
    }
    if (config.llm.budget !== undefined) {
      validateBudgetConfig(errors, config.llm.budget, providerNames);
    }
  }

  validateObjectField(errors, config.research, 'research');
  if (isPlainObject(config.research)) {
    if (config.research.knowledgeBaseMcpUrl !== undefined) {
      validateStringField(errors, config.research.knowledgeBaseMcpUrl, 'research.knowledgeBaseMcpUrl');
    }
    if (config.research.knowledgeBaseMcpServerPath !== undefined) {
      validateStringField(errors, config.research.knowledgeBaseMcpServerPath, 'research.knowledgeBaseMcpServerPath');
    }
    validateStringField(errors, config.research.webSearchProvider, 'research.webSearchProvider');
    if (config.research.oppscanFeed !== undefined) {
      validateObjectField(errors, config.research.oppscanFeed, 'research.oppscanFeed');
      if (isPlainObject(config.research.oppscanFeed)) {
        validateStringField(errors, config.research.oppscanFeed.url, 'research.oppscanFeed.url');
        validateOptionalStringField(errors, config.research.oppscanFeed.tokenEnvVar, 'research.oppscanFeed.tokenEnvVar');
        validateOptionalIntegerField(errors, config.research.oppscanFeed.limit, 'research.oppscanFeed.limit', 1);
        if (config.research.oppscanFeed.opportunitySignalFitTiers !== undefined) {
          if (!Array.isArray(config.research.oppscanFeed.opportunitySignalFitTiers)) {
            addError(errors, 'research.oppscanFeed.opportunitySignalFitTiers', 'must be an array');
          } else {
            config.research.oppscanFeed.opportunitySignalFitTiers.forEach((tier, index) =>
              validateStringField(errors, tier, `research.oppscanFeed.opportunitySignalFitTiers[${index}]`)
            );
          }
        }
      }
    }
    if (config.research.ga4 !== undefined) {
      validateObjectField(errors, config.research.ga4, 'research.ga4');
      if (isPlainObject(config.research.ga4)) {
        validateOptionalStringField(errors, config.research.ga4.credentialsEnvVar, 'research.ga4.credentialsEnvVar');
        validateOptionalIntegerField(errors, config.research.ga4.lookbackDays, 'research.ga4.lookbackDays', 1);
        if (config.research.ga4.dimensions !== undefined) {
          if (!Array.isArray(config.research.ga4.dimensions)) {
            addError(errors, 'research.ga4.dimensions', 'must be an array');
          } else {
            config.research.ga4.dimensions.forEach((dimension, index) =>
              validateStringField(errors, dimension, `research.ga4.dimensions[${index}]`)
            );
          }
        }
        if (config.research.ga4.metrics !== undefined) {
          if (!Array.isArray(config.research.ga4.metrics)) {
            addError(errors, 'research.ga4.metrics', 'must be an array');
          } else {
            config.research.ga4.metrics.forEach((metric, index) =>
              validateStringField(errors, metric, `research.ga4.metrics[${index}]`)
            );
          }
        }
        if (!Array.isArray(config.research.ga4.properties) || config.research.ga4.properties.length === 0) {
          addError(errors, 'research.ga4.properties', 'must be a non-empty array');
        } else {
          config.research.ga4.properties.forEach((property, index) => {
            const propertyPath = `research.ga4.properties[${index}]`;
            validateObjectField(errors, property, propertyPath);
            if (isPlainObject(property)) {
              validateStringField(errors, property.key, `${propertyPath}.key`);
              validateStringField(errors, property.propertyId, `${propertyPath}.propertyId`);
              validateOptionalStringField(errors, property.label, `${propertyPath}.label`);
            }
          });
        }
      }
    }
    if (config.research.jevDedup !== undefined) {
      validateObjectField(errors, config.research.jevDedup, 'research.jevDedup');
      if (isPlainObject(config.research.jevDedup) && config.research.jevDedup.enabled !== undefined) {
        if (typeof config.research.jevDedup.enabled !== 'boolean') {
          addError(errors, 'research.jevDedup.enabled', 'must be a boolean');
        }
      }
    }
    if (config.research.meta !== undefined) {
      validateObjectField(errors, config.research.meta, 'research.meta');
      if (isPlainObject(config.research.meta)) {
        validateOptionalStringField(errors, config.research.meta.tokenEnvVar, 'research.meta.tokenEnvVar');
        validateStringField(errors, config.research.meta.adAccountId, 'research.meta.adAccountId');
        validateOptionalIntegerField(errors, config.research.meta.lookbackDays, 'research.meta.lookbackDays', 1);
        if (config.research.meta.fields !== undefined) {
          if (!Array.isArray(config.research.meta.fields)) {
            addError(errors, 'research.meta.fields', 'must be an array');
          } else {
            config.research.meta.fields.forEach((field, index) =>
              validateStringField(errors, field, `research.meta.fields[${index}]`)
            );
          }
        }
        if (!Array.isArray(config.research.meta.campaigns) || config.research.meta.campaigns.length === 0) {
          addError(errors, 'research.meta.campaigns', 'must be a non-empty array');
        } else {
          config.research.meta.campaigns.forEach((campaign, index) => {
            const campaignPath = `research.meta.campaigns[${index}]`;
            validateObjectField(errors, campaign, campaignPath);
            if (isPlainObject(campaign)) {
              validateStringField(errors, campaign.key, `${campaignPath}.key`);
              validateStringField(errors, campaign.campaignId, `${campaignPath}.campaignId`);
              validateOptionalStringField(errors, campaign.label, `${campaignPath}.label`);
              // Optional - links a Meta campaign to the product name an
              // ad_mandate's allowed_products uses, so
              // ops/reports/checkAdMandateHealth.js (docs/futco-ad-mandate-spec.md
              // Phase 3) can resolve which campaigns a mandate with
              // allowed_campaign_ids: null actually covers. Left unset means
              // "not yet mapped" - the health check treats that as
              // insufficient data, never a fabricated guess.
              validateOptionalStringField(errors, campaign.product, `${campaignPath}.product`);
            }
          });
        }
        // Optional - which degradation rules are worth raising as a new
        // Opportunity at all (lib/event-sources/adPerformanceSignal.js, the
        // Diagnose-stage trigger for ad performance). A much lower-stakes
        // default than adRiskPolicy - getting this threshold slightly wrong
        // only changes when a human gets asked to look at something, it
        // never commits spend - so an engineering default applies when unset,
        // same as this file's own DEDUP_LOOKBACK_DAYS-style constants.
        if (config.research.meta.opportunitySignalRules !== undefined) {
          if (!Array.isArray(config.research.meta.opportunitySignalRules)) {
            addError(errors, 'research.meta.opportunitySignalRules', 'must be an array');
          } else {
            config.research.meta.opportunitySignalRules.forEach((rule, index) => {
              const rulePath = `research.meta.opportunitySignalRules[${index}]`;
              validateObjectField(errors, rule, rulePath);
              if (isPlainObject(rule)) {
                validateStringField(errors, rule.metric, `${rulePath}.metric`);
                validateOptionalIntegerField(errors, rule.window_days, `${rulePath}.window_days`, 1);
                if (typeof rule.degradation_pct !== 'number' || rule.degradation_pct <= 0 || rule.degradation_pct > 1) {
                  addError(errors, `${rulePath}.degradation_pct`, 'must be a number between 0 (exclusive) and 1 (inclusive)');
                }
              }
            });
          }
        }
      }
    }
    if (config.research.stripe !== undefined) {
      validateObjectField(errors, config.research.stripe, 'research.stripe');
      if (isPlainObject(config.research.stripe)) {
        validateOptionalStringField(errors, config.research.stripe.apiKeyEnvVar, 'research.stripe.apiKeyEnvVar');
        validateOptionalIntegerField(errors, config.research.stripe.lookbackDays, 'research.stripe.lookbackDays', 1);
      }
    }
    // X/Twitter engagement draft-and-queue pipeline (FutCo + e3d.ai user
    // acquisition). Deliberately never posts: ops/reports/runXEngagement.js
    // only reads (app-auth bearer token, search-only scope) and queues
    // candidate replies as x.draftQueued events for a human to review and
    // post by hand via ops/reports/xEngagementDigest.js's email digest. No
    // postingEnabled flag here - there is no autonomous posting path to gate.
    if (config.research.x !== undefined) {
      validateObjectField(errors, config.research.x, 'research.x');
      if (isPlainObject(config.research.x)) {
        validateStringField(errors, config.research.x.bearerTokenEnvVar, 'research.x.bearerTokenEnvVar');
        validateOptionalStringField(errors, config.research.x.e3dMcpServerPath, 'research.x.e3dMcpServerPath');
        validateOptionalStringField(errors, config.research.x.digestToEmailEnvVar, 'research.x.digestToEmailEnvVar');
        if (!Array.isArray(config.research.x.searchQueries) || config.research.x.searchQueries.length === 0) {
          addError(errors, 'research.x.searchQueries', 'must be a non-empty array');
        } else {
          config.research.x.searchQueries.forEach((query, index) =>
            validateStringField(errors, query, `research.x.searchQueries[${index}]`)
          );
        }
        if (!Array.isArray(config.research.x.topics) || config.research.x.topics.length === 0) {
          addError(errors, 'research.x.topics', 'must be a non-empty array');
        } else {
          config.research.x.topics.forEach((topic, index) =>
            validateStringField(errors, topic, `research.x.topics[${index}]`)
          );
        }
        validateOptionalIntegerField(errors, config.research.x.draftsPerRun, 'research.x.draftsPerRun', 1);
        validateOptionalIntegerField(errors, config.research.x.minEngagement, 'research.x.minEngagement', 0);
      }
    }
  }

  if (config.creative !== undefined) {
    validateObjectField(errors, config.creative, 'creative');
    if (isPlainObject(config.creative)) {
      validateStringField(errors, config.creative.enginePath, 'creative.enginePath');
      validateOptionalStringField(errors, config.creative.outDir, 'creative.outDir');
      if (config.creative.defaultProviders !== undefined) {
        validateObjectField(errors, config.creative.defaultProviders, 'creative.defaultProviders');
        if (isPlainObject(config.creative.defaultProviders)) {
          for (const key of ['conceptGeneration', 'critique', 'qa']) {
            validateOptionalStringField(errors, config.creative.defaultProviders[key], `creative.defaultProviders.${key}`);
          }
        }
      }
    }
  }

  if (!Array.isArray(config.eventSources)) {
    addError(errors, 'eventSources', 'must be an array');
  }

  validateObjectField(errors, config.roles, 'roles');
  if (isPlainObject(config.roles)) {
    const providerNames = isPlainObject(config.llm?.providers) ? new Set(Object.keys(config.llm.providers)) : null;
    for (const [roleName, roleConfig] of Object.entries(config.roles)) {
      const rolePath = `roles.${roleName}`;
      validateObjectField(errors, roleConfig, rolePath);
      if (isPlainObject(roleConfig)) {
        validateProviderReferenceField(errors, roleConfig.provider, `${rolePath}.provider`, providerNames);
      }
    }
  }

  if (config.web !== undefined) {
    validateObjectField(errors, config.web, 'web');
    if (isPlainObject(config.web)) {
      validateStringField(errors, config.web.authUserEnvVar, 'web.authUserEnvVar');
      validateStringField(errors, config.web.authPassEnvVar, 'web.authPassEnvVar');
      validateIntegerField(errors, config.web.port, 'web.port');
    }
  }

  if (config.calendar !== undefined) {
    validateObjectField(errors, config.calendar, 'calendar');
    if (isPlainObject(config.calendar)) {
      validateStringField(errors, config.calendar.provider, 'calendar.provider');
      validateStringField(errors, config.calendar.calendarId, 'calendar.calendarId');
      validateStringField(errors, config.calendar.organizerEmail, 'calendar.organizerEmail');
      validateStringField(errors, config.calendar.serviceAccountKeyFileEnvVar, 'calendar.serviceAccountKeyFileEnvVar');
    }
  }

  if (config.leadWebhook !== undefined) {
    validateObjectField(errors, config.leadWebhook, 'leadWebhook');
    if (isPlainObject(config.leadWebhook)) {
      validateStringField(errors, config.leadWebhook.tokenEnvVar, 'leadWebhook.tokenEnvVar');
    }
  }

  if (config.tradeOutcomeWebhook !== undefined) {
    validateObjectField(errors, config.tradeOutcomeWebhook, 'tradeOutcomeWebhook');
    if (isPlainObject(config.tradeOutcomeWebhook)) {
      validateStringField(errors, config.tradeOutcomeWebhook.tokenEnvVar, 'tradeOutcomeWebhook.tokenEnvVar');
    }
  }

  if (config.stripeOutcomeWebhook !== undefined) {
    validateObjectField(errors, config.stripeOutcomeWebhook, 'stripeOutcomeWebhook');
    if (isPlainObject(config.stripeOutcomeWebhook)) {
      validateStringField(errors, config.stripeOutcomeWebhook.signingSecretEnvVar, 'stripeOutcomeWebhook.signingSecretEnvVar');
    }
  }

  // The hard ceiling docs/futco-ad-mandate-spec.md requires: a human-set real
  // ad-budget number, never a fabricated default baked into code. Optional at
  // the config-schema level (an instance with no ad_mandate activity doesn't
  // need it), but lib/actions/adMandate.js refuses to activate any mandate
  // without it present and valid.
  if (config.adRiskPolicy !== undefined) {
    validateObjectField(errors, config.adRiskPolicy, 'adRiskPolicy');
    if (isPlainObject(config.adRiskPolicy)) {
      for (const key of ['max_daily_spend_usd', 'max_monthly_spend_usd']) {
        const value = config.adRiskPolicy[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          addError(errors, `adRiskPolicy.${key}`, 'must be a positive number');
        }
      }
    }
  }

  // docs/futco-ad-mandate-spec.md Phase 3 (circuit breaker): defaults to
  // observe-only (absent or false) so a newly-deployed health check never
  // auto-suspends a mandate before a human has confirmed the degradation
  // signal is trustworthy - flipping this to true is the explicit "enable"
  // step the spec calls for.
  if (config.adMandateHealthCheck !== undefined) {
    validateObjectField(errors, config.adMandateHealthCheck, 'adMandateHealthCheck');
    if (isPlainObject(config.adMandateHealthCheck) && config.adMandateHealthCheck.autoSuspendEnabled !== undefined) {
      if (typeof config.adMandateHealthCheck.autoSuspendEnabled !== 'boolean') {
        addError(errors, 'adMandateHealthCheck.autoSuspendEnabled', 'must be a boolean');
      }
    }
  }

  if (config.authorityNotify !== undefined) {
    validateObjectField(errors, config.authorityNotify, 'authorityNotify');
    if (isPlainObject(config.authorityNotify)) {
      if (config.authorityNotify.email !== undefined) {
        validateStringField(errors, config.authorityNotify.email, 'authorityNotify.email');
      }
      if (config.authorityNotify.command !== undefined) {
        validateStringField(errors, config.authorityNotify.command, 'authorityNotify.command');
      }
    }
  }

  if (config.outreach !== undefined) {
    validateObjectField(errors, config.outreach, 'outreach');
    if (isPlainObject(config.outreach)) {
      validateStringField(errors, config.outreach.provider, 'outreach.provider');
      validateStringField(errors, config.outreach.region, 'outreach.region');
      validateStringField(errors, config.outreach.fromEmail, 'outreach.fromEmail');
      if (config.outreach.fallbackToEmail !== undefined) {
        validateStringField(errors, config.outreach.fallbackToEmail, 'outreach.fallbackToEmail');
      }
    }
  }

  if (config.e3dTrade !== undefined) {
    validateObjectField(errors, config.e3dTrade, 'e3dTrade');
    if (isPlainObject(config.e3dTrade)) {
      validateStringField(errors, config.e3dTrade.baseUrl, 'e3dTrade.baseUrl');
      validateOptionalStringField(errors, config.e3dTrade.mandatePath, 'e3dTrade.mandatePath');
      validateOptionalStringField(errors, config.e3dTrade.apiKeyEnvVar, 'e3dTrade.apiKeyEnvVar');
      validateOptionalStringField(errors, config.e3dTrade.sessionCookieEnvVar, 'e3dTrade.sessionCookieEnvVar');
      validateOptionalIntegerField(errors, config.e3dTrade.timeoutMs, 'e3dTrade.timeoutMs');
      validateOptionalIntegerField(errors, config.e3dTrade.maxAttempts, 'e3dTrade.maxAttempts');
    }
  }

  if (config.anchor !== undefined) {
    validateObjectField(errors, config.anchor, 'anchor');
    if (isPlainObject(config.anchor)) {
      validateStringField(errors, config.anchor.provider, 'anchor.provider');
      validateStringField(errors, config.anchor.toEmailEnvVar, 'anchor.toEmailEnvVar');
    }
  }

  if (config.researchTopics !== undefined) {
    if (!Array.isArray(config.researchTopics)) {
      addError(errors, 'researchTopics', 'must be an array');
    } else {
      config.researchTopics.forEach((topic, index) => {
        validateStringField(errors, topic, `researchTopics[${index}]`);
      });
    }
  }

  if (config.ownDomains !== undefined) {
    if (!Array.isArray(config.ownDomains)) {
      addError(errors, 'ownDomains', 'must be an array');
    } else {
      config.ownDomains.forEach((domain, index) => {
        validateStringField(errors, domain, `ownDomains[${index}]`);
      });
    }
  }

  if (config.scoring !== undefined) {
    validateObjectField(errors, config.scoring, 'scoring');
    if (isPlainObject(config.scoring)) {
      if (config.scoring.weights !== undefined) {
        validateObjectField(errors, config.scoring.weights, 'scoring.weights');
        if (isPlainObject(config.scoring.weights)) {
          for (const key of ['confidence', 'evidenceCount', 'recency']) {
            if (config.scoring.weights[key] !== undefined && typeof config.scoring.weights[key] !== 'number') {
              addError(errors, `scoring.weights.${key}`, 'must be a number');
            }
          }
        }
      }
      if (config.scoring.typeWeights !== undefined) {
        validateObjectField(errors, config.scoring.typeWeights, 'scoring.typeWeights');
        if (isPlainObject(config.scoring.typeWeights)) {
          for (const [type, weight] of Object.entries(config.scoring.typeWeights)) {
            if (typeof weight !== 'number') {
              addError(errors, `scoring.typeWeights.${type}`, 'must be a number');
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function loadInstanceConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    const error = new Error(`Config file not found: ${filePath}`);
    error.code = 'ENOENT';
    throw error;
  }

  let config;
  try {
    config = readJsonFile(filePath);
  } catch (error) {
    throw new Error(`Failed to read JSON config ${filePath}: ${error.message}`);
  }

  const result = validateInstanceConfig(config);
  if (!result.valid) {
    const error = new Error(`Invalid instance config ${filePath}:\n- ${result.errors.join('\n- ')}`);
    error.validationErrors = result.errors;
    throw error;
  }

  return config;
}

export function resolvePath(inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

export function instanceConfigPath(instanceName) {
  return path.join(ROOT_DIR, '.e3d-corp', 'instance', instanceName, 'instance.json');
}

export function loadInstance(instanceName) {
  const configPath = instanceConfigPath(instanceName);
  const config = loadInstanceConfig(configPath);
  const dataDir = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.join(ROOT_DIR, config.dataDir);

  return { config, dataDir, configPath };
}
