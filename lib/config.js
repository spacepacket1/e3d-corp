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

  const allowedFields = new Set(['kind', 'baseUrlEnvVar', 'modelEnvVar', 'apiKeyEnvVar', 'binEnvVar', 'timeoutMs']);
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
    default:
      addError(errors, `${providerPath}.kind`, 'must be one of: local, openai-compatible, grok-cli');
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

  if (config.stressEvaluationWebhook !== undefined) {
    validateObjectField(errors, config.stressEvaluationWebhook, 'stressEvaluationWebhook');
    if (isPlainObject(config.stressEvaluationWebhook)) {
      validateStringField(errors, config.stressEvaluationWebhook.tokenEnvVar, 'stressEvaluationWebhook.tokenEnvVar');
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

  if (config.e3d !== undefined) {
    validateObjectField(errors, config.e3d, 'e3d');
    if (isPlainObject(config.e3d)) {
      validateStringField(errors, config.e3d.baseUrl, 'e3d.baseUrl');
      validateOptionalStringField(errors, config.e3d.releasePath, 'e3d.releasePath');
      validateOptionalStringField(errors, config.e3d.rejectPath, 'e3d.rejectPath');
      validateOptionalStringField(errors, config.e3d.apiKeyEnvVar, 'e3d.apiKeyEnvVar');
      validateOptionalStringField(errors, config.e3d.sessionCookieEnvVar, 'e3d.sessionCookieEnvVar');
      validateOptionalIntegerField(errors, config.e3d.timeoutMs, 'e3d.timeoutMs');
      validateOptionalIntegerField(errors, config.e3d.maxAttempts, 'e3d.maxAttempts');
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
