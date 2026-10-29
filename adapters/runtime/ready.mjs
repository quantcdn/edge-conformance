// Readiness of the runtime adapter. A change to rules, functions or project
// settings takes time to reach the edge. Before the adapter sends the case
// request, it sends probe requests to paths under PROBE_PREFIX until the edge
// shows the new deployment. A probe that a case rule could answer is not
// used; the adapter then waits for a fixed time instead.

import { CANARY_PATH, INLINE_PROBE_PATH, SLASH_PROBE_PATH } from './plan.mjs';

// Headers that a project-wide header cannot set on a function response, or
// that the edge sets for itself. The canary probe does not check them.
const UNCHECKED_HEADERS = ['quant-server', 'cache-control', 'content-type', 'content-length', 'date', 'connection'];

/** True when the URL pattern of a rule could match `path` (a conservative test: the text before the first *). */
export function patternCouldMatch(pattern, path) {
  const star = pattern.indexOf('*');
  const lowerPath = path.toLowerCase();
  if (star === -1) return pattern.toLowerCase() === lowerPath;
  return lowerPath.startsWith(pattern.slice(0, star).toLowerCase());
}

function ruleCouldAnswer(rule, path) {
  return rule.disabled !== true && rule.urls.some((pattern) => patternCouldMatch(pattern, path));
}

const anyRuleCouldAnswer = (rules, path, types) => rules.some((rule) => types.includes(rule.type) && ruleCouldAnswer(rule, path));

/** The value of the Authorization header for the basic authentication of the settings, or null. */
export function basicCredentials(settings) {
  if (!settings.basicAuth) return null;
  const { username, password } = settings.basicAuth;
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** True when the response has each project-wide header and none of the removed ones. */
export function headersShown(headers, wanted, removed) {
  const checked = (name) => !UNCHECKED_HEADERS.includes(name.toLowerCase());
  const present = Object.entries(wanted).filter(([name]) => checked(name)).every(([name, value]) => headerValue(headers, name) === value);
  const absent = removed.filter(checked).every((name) => headerValue(headers, name) === undefined);
  return present && absent;
}

function canaryProbe(deployment, version, removed) {
  return {
    name: 'canary',
    path: CANARY_PATH,
    withCredentials: true,
    check: (res) => res.status === 200 && res.body === version && headersShown(res.headers, deployment.settings.headers, removed)
  };
}

function basicAuthProbe(deployment) {
  const on = deployment.settings.basicAuth !== null;
  return { name: 'basic-auth', path: CANARY_PATH, withCredentials: false, check: (res) => (res.status === 401) === on };
}

function inlineProbe(deployment) {
  const on = deployment.settings.inline;
  return { name: 'inline', path: INLINE_PROBE_PATH, withCredentials: true, check: (res) => res.status === 200 && res.body.includes('{{QUANT_FN') !== on };
}

function slashProbe(deployment) {
  const on = deployment.settings.trailingSlash === 'redirect';
  return { name: 'trailing-slash', path: SLASH_PROBE_PATH, withCredentials: true, check: (res) => (res.status === 301) === on };
}

/**
 * The probes for a deployment, and the names of the probes that a case rule
 * could answer (those are left out).
 * version: the canary version; removed: the project-wide headers that the
 * deployment removed.
 */
export function probesFor(deployment, version, removed = []) {
  const rules = deployment.rules;
  const all = ['function', 'auth', 'filter'];
  const candidates = [
    [canaryProbe(deployment, version, removed), anyRuleCouldAnswer(rules, CANARY_PATH, ['auth'])],
    [basicAuthProbe(deployment), anyRuleCouldAnswer(rules, CANARY_PATH, ['auth'])],
    [inlineProbe(deployment), anyRuleCouldAnswer(rules, INLINE_PROBE_PATH, all)],
    [slashProbe(deployment), anyRuleCouldAnswer(rules, SLASH_PROBE_PATH, all)]
  ];
  return {
    probes: candidates.filter(([, blocked]) => !blocked).map(([probe]) => probe),
    blocked: candidates.filter(([, blocked]) => blocked).map(([probe]) => probe.name)
  };
}

const changedSetting = (ops, field) => ops.some((op) => op.kind === 'project' && field in op.settings);

// For each probe: true when the operations change what the probe shows.
const CONCERNS = {
  canary: (ops) => ops.some((op) => ['function', 'rules', 'headers-set', 'headers-delete'].includes(op.kind)),
  'basic-auth': (ops) => changedSetting(ops, 'basicAuth'),
  inline: (ops) => changedSetting(ops, 'inline') || ops.some((op) => op.kind === 'upload' && `/${op.path}` === INLINE_PROBE_PATH),
  'trailing-slash': (ops) => changedSetting(ops, 'trailingSlash')
};

/** The blocked probes that the operations concern: the adapter waits a fixed time for them. */
export function blindProbes(blocked, ops) {
  return blocked.filter((name) => CONCERNS[name](ops));
}

/**
 * Send the probes until each one passes. Throws when `timeoutMs` passes first.
 * send(path, withCredentials) -> { status, headers, body }
 */
export async function waitUntilReady({ probes, send, timeoutMs, pollMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  let failing = probes.map((probe) => probe.name);
  for (let round = 0; now() <= deadline; round += 1) {
    const results = await Promise.all(probes.map(async (probe) => {
      const res = await send(`${probe.path}?edge-conformance-ready=${round}-${now()}`, probe.withCredentials);
      return probe.check(res) ? null : probe.name;
    }));
    failing = results.filter(Boolean);
    if (!failing.length) return round;
    await sleep(pollMs);
  }
  throw new Error(`the edge did not show the deployment within ${Math.round(timeoutMs / 1000)} s (probes not passed: ${failing.join(', ')})`);
}
