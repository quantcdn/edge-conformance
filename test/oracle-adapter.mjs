// A test adapter that answers each case with the values that the case
// expects. It checks the runner and that every expectation can be met.
// It is not an implementation of the edge.

import { loadCases, adapterArgs, OPS } from '../src/index.js';

const cases = await loadCases();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function headerValue(matcher) {
  if (Array.isArray(matcher) || typeof matcher === 'string') return matcher;
  return matcher.startsWith || matcher.includes || 'present';
}

function headersFor(expected = {}) {
  const headers = {};
  for (const [name, matcher] of Object.entries(expected)) {
    if (matcher !== null) headers[name] = headerValue(matcher);
  }
  return headers;
}

function bodyFor(expect) {
  if (expect.bodyText !== undefined) return expect.bodyText;
  if (expect.bodyJson !== undefined) return JSON.stringify(expect.bodyJson);
  return (expect.bodyIncludes || []).join(' ');
}

function answer(expect) {
  if ('ruleId' in expect) return { ruleId: expect.ruleId };
  return { status: expect.status, headers: headersFor(expect.headers), bodyText: bodyFor(expect) };
}

// Cases with the same input share one answer that meets all their expectations.
function merge(a, b) {
  if (!a) return b;
  return { ...a, ...b, headers: { ...a.headers, ...b.headers } };
}

export function createAdapter() {
  const answers = new Map();
  for (const c of cases) {
    const key = `${c.op}:${canonical(adapterArgs(c.op, c.input))}`;
    answers.set(key, merge(answers.get(key), c.expect));
  }
  const lookup = (op) => async (...args) => answer(answers.get(`${op}:${canonical(args)}`));
  const adapter = { capabilities: { ops: Object.keys(OPS) }, dispose: async () => {} };
  for (const op of Object.keys(OPS)) adapter[op] = lookup(op);
  return adapter;
}
