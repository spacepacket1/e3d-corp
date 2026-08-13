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

export function validateInstanceConfig(config) {
  const errors = [];

  validateObjectField(errors, config, 'config');
  if (!isPlainObject(config)) {
    return { valid: false, errors };
  }

  validateStringField(errors, config.name, 'name');
  validateStringField(errors, config.dataDir, 'dataDir');

  validateObjectField(errors, config.llm, 'llm');
  if (isPlainObject(config.llm)) {
    validateStringField(errors, config.llm.baseUrlEnvVar, 'llm.baseUrlEnvVar');
    validateStringField(errors, config.llm.modelEnvVar, 'llm.modelEnvVar');
  }

  validateObjectField(errors, config.research, 'research');
  if (isPlainObject(config.research)) {
    validateStringField(errors, config.research.futcoMcpUrl, 'research.futcoMcpUrl');
    validateStringField(errors, config.research.webSearchProvider, 'research.webSearchProvider');
  }

  if (!Array.isArray(config.eventSources)) {
    addError(errors, 'eventSources', 'must be an array');
  }

  validateObjectField(errors, config.roles, 'roles');
  if (isPlainObject(config.roles)) {
    for (const [roleName, roleConfig] of Object.entries(config.roles)) {
      const rolePath = `roles.${roleName}`;
      validateObjectField(errors, roleConfig, rolePath);
      if (isPlainObject(roleConfig)) {
        validateStringField(errors, roleConfig.provider, `${rolePath}.provider`);
        validateStringField(errors, roleConfig.model, `${rolePath}.model`);
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
