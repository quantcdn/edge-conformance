/**
 * The edge-conformance runner.
 * It loads the JSON vectors, gives each case to an adapter and compares the
 * adapter's answer with the case's expected values.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VECTORS_DIR = fileURLToPath(new URL('../vectors/', import.meta.url));

/** The suite tags. Each case has exactly one; it names the vector directory. */
export const SUITE_TAGS = ['rules', 'static', 'functions', 'inline', 'project'];

/** Every tag that a case can have. */
export const TAGS = [...SUITE_TAGS, 'unverified'];

/** The adapter operations, and the arguments that each one gets from a case input. */
export const OPS = {
  matchRule: (input) => [input.rules, input.functions || [], input.request],
  serveStatic: (input) => [input.files, input.request],
  runFunction: (input) => [input],
  serveSite: (input) => [input]
};

/** The input fields that a case of each operation can have. */
export const INPUT_FIELDS = {
  matchRule: ['rules', 'functions', 'request'],
  serveStatic: ['files', 'request'],
  runFunction: ['uuid', 'type', 'body', 'request', 'response', 'kv'],
  serveSite: ['files', 'functions', 'rules', 'request', 'meta', 'project']
};

/** The fields of the serveSite `project` input: the local project settings. */
export const PROJECT_FIELDS = ['globalHeaders', 'basicAuth', 'trailingSlash'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTextMap = (value) => isObject(value) && Object.values(value).every((item) => typeof item === 'string');

const PROJECT_CHECKS = {
  globalHeaders: (value) => (isTextMap(value) ? null : 'project.globalHeaders must map header names to text'),
  basicAuth: (value) => (isTextMap(value) && typeof value.username === 'string' && typeof value.password === 'string'
    && Object.keys(value).length === 2 ? null : 'project.basicAuth must be { username, password }'),
  trailingSlash: (value) => (['redirect', 'none'].includes(value) ? null : 'project.trailingSlash must be "redirect" or "none"')
};

function projectErrors(project) {
  if (!isObject(project)) return ['project must be an object'];
  return Object.entries(project).map(([key, value]) => (PROJECT_CHECKS[key] ? PROJECT_CHECKS[key](value) : `project.${key} is not a known field`))
    .filter(Boolean);
}

function metaErrors(meta) {
  return isObject(meta) ? [] : ['meta must be an object (the quant/meta.json document)'];
}

/**
 * Check the input of a case against its operation.
 * @returns {string[]} One message for each problem (empty when the input is valid).
 */
export function inputErrors(item) {
  const fields = INPUT_FIELDS[item.op];
  if (!fields) return [`unknown op ${item.op}`];
  if (!isObject(item.input)) return ['input must be an object'];
  const errors = Object.keys(item.input).filter((key) => !fields.includes(key)).map((key) => `${item.op} has no input ${key}`);
  if ('meta' in item.input) errors.push(...metaErrors(item.input.meta));
  if ('project' in item.input) errors.push(...projectErrors(item.input.project));
  return errors;
}

/** The arguments that the runner passes to adapter[op] for a case input. */
export function adapterArgs(op, input) {
  return OPS[op](input);
}

async function vectorFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return vectorFiles(full);
      return entry.name.endsWith('.json') ? [full] : [];
    }));
  return nested.flat();
}

async function readVectorFile(file, dir) {
  const suite = path.relative(dir, file).split(path.sep)[0];
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  return data.cases.map((item) => ({ ...item, suite, file: path.relative(dir, file) }));
}

/**
 * Load every case from the vectors directory, in file order.
 * @param {{ dir?: string }} [options]
 */
export async function loadCases({ dir = VECTORS_DIR } = {}) {
  const files = await vectorFiles(dir);
  const lists = await Promise.all(files.map((file) => readVectorFile(file, dir)));
  return lists.flat();
}

/** The cases that have any of the tags. With no tags, every case. */
export function selectCases(cases, tags) {
  if (!tags || tags.length === 0) return cases;
  return cases.filter((item) => item.tags.some((tag) => tags.includes(tag)));
}

// --- Comparison -------------------------------------------------------------

function lowerKeys(headers = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value;
  return result;
}

function asList(value) {
  return Array.isArray(value) ? value : [value];
}

function asText(value) {
  return Array.isArray(value) ? value.join(', ') : value;
}

function sameList(expected, actual) {
  const list = asList(actual);
  return list.length === expected.length && expected.every((item, i) => item === list[i]);
}

const MATCHERS = {
  present: (_expected, actual) => actual !== undefined,
  startsWith: (expected, actual) => typeof asText(actual) === 'string' && asText(actual).startsWith(expected),
  includes: (expected, actual) => typeof asText(actual) === 'string' && asText(actual).includes(expected)
};

function headerMatches(matcher, actual) {
  if (matcher === null) return actual === undefined;
  if (Array.isArray(matcher)) return actual !== undefined && sameList(matcher, actual);
  if (typeof matcher === 'string') return asText(actual) === matcher;
  return Object.entries(matcher).every(([kind, value]) => MATCHERS[kind] && MATCHERS[kind](value, actual));
}

function headerFailures(expected = {}, actualHeaders = {}) {
  const actual = lowerKeys(actualHeaders);
  return Object.entries(expected)
    .filter(([name, matcher]) => !headerMatches(matcher, actual[name.toLowerCase()]))
    .map(([name, matcher]) => `header ${name}: expected ${JSON.stringify(matcher)}, got ${JSON.stringify(actual[name.toLowerCase()])}`);
}

function isSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, i) => isSubset(item, actual[i]));
  }
  if (expected && typeof expected === 'object') {
    return Boolean(actual) && typeof actual === 'object' && Object.keys(expected).every((key) => isSubset(expected[key], actual[key]));
  }
  return expected === actual;
}

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function jsonFailures(expected, body) {
  if (expected === undefined) return [];
  const parsed = parseJson(body);
  if (!parsed) return [`body: expected JSON, got ${JSON.stringify(body)}`];
  return isSubset(expected, parsed.value) ? [] : [`body JSON: expected to contain ${JSON.stringify(expected)}, got ${body}`];
}

function bodyFailures(expect, body) {
  const failures = [];
  if (expect.bodyText !== undefined && body !== expect.bodyText) {
    failures.push(`body: expected ${JSON.stringify(expect.bodyText)}, got ${JSON.stringify(body)}`);
  }
  for (const part of expect.bodyIncludes || []) {
    if (!body.includes(part)) failures.push(`body: expected to include ${JSON.stringify(part)}`);
  }
  for (const part of expect.bodyExcludes || []) {
    if (body.includes(part)) failures.push(`body: expected not to include ${JSON.stringify(part)}`);
  }
  return [...failures, ...jsonFailures(expect.bodyJson, body)];
}

function ruleFailures(expect, actual) {
  const ruleId = actual && actual.ruleId !== undefined ? actual.ruleId : null;
  return ruleId === expect.ruleId ? [] : [`ruleId: expected ${JSON.stringify(expect.ruleId)}, got ${JSON.stringify(ruleId)}`];
}

function responseFailures(expect, actual) {
  const status = actual.status === expect.status ? [] : [`status: expected ${expect.status}, got ${actual.status}`];
  const body = actual.bodyText == null ? '' : String(actual.bodyText);
  return [...status, ...headerFailures(expect.headers, actual.headers), ...bodyFailures(expect, body)];
}

/**
 * Compare an adapter answer with a case's expected values.
 * @returns {string[]} One message for each difference (empty when it passes).
 */
export function checkResult(expect, actual) {
  if ('ruleId' in expect) return ruleFailures(expect, actual);
  return responseFailures(expect, actual || {});
}

// --- Run ----------------------------------------------------------------------

function skipReason(adapter, item) {
  const capabilities = adapter.capabilities || {};
  const ops = capabilities.ops || Object.keys(OPS).filter((op) => typeof adapter[op] === 'function');
  if (!ops.includes(item.op) || typeof adapter[item.op] !== 'function') return `the adapter has no ${item.op}`;
  const excluded = (capabilities.excludeTags || []).find((tag) => item.tags.includes(tag));
  return excluded ? `the adapter excludes the tag ${excluded}` : null;
}

function errorText(err) {
  return err && typeof err.message === 'string' ? err.message : String(err);
}

async function runCase(adapter, item) {
  const summary = { id: item.id, op: item.op, tags: item.tags, file: item.file };
  const reason = skipReason(adapter, item);
  if (reason) return { ...summary, status: 'skipped', failures: [], reason };
  const invalid = inputErrors(item);
  if (invalid.length) return { ...summary, status: 'failed', failures: invalid.map((text) => `invalid case input: ${text}`) };
  try {
    const input = structuredClone(item.input);
    const actual = await adapter[item.op](...adapterArgs(item.op, input));
    const failures = checkResult(item.expect, actual);
    return { ...summary, status: failures.length ? 'failed' : 'passed', failures };
  } catch (err) {
    return { ...summary, status: 'failed', failures: [`the adapter threw: ${errorText(err)}`] };
  }
}

function count(results, status) {
  return results.filter((item) => item.status === status).length;
}

/**
 * Run the cases against an adapter.
 * @param {Object} options
 * @param {import('./adapter').Adapter} options.adapter
 * @param {string[]} [options.tags] Run only the cases with any of these tags.
 * @param {Object[]} [options.cases] The cases (default: every vector).
 * @returns {Promise<{ passed: number, failed: number, skipped: number, cases: Object[] }>}
 */
export async function run({ adapter, tags, cases }) {
  const selected = selectCases(cases || await loadCases(), tags);
  const results = [];
  try {
    for (const item of selected) results.push(await runCase(adapter, item));
  } finally {
    if (typeof adapter.dispose === 'function') await adapter.dispose();
  }
  return { passed: count(results, 'passed'), failed: count(results, 'failed'), skipped: count(results, 'skipped'), cases: results };
}
