// The runtime adapter: runs the edge-conformance vectors against the Quant
// edge, on a Quant project made for the test. See README.md in this
// directory for the contract, the environment variables and the steps.
//
// For each case the adapter:
// 1. builds the site of the case and maps it to the test project (plan.mjs),
// 2. writes only what changed since the case before, through the public API
//    (api.mjs): functions, files, project settings, project-wide headers,
//    the rules manifest, then one purge,
// 3. waits until probe requests show the new deployment (ready.mjs),
// 4. sends the case request to the test domain and maps the answer back
//    (edge.mjs).
// dispose() deletes the files, resets the settings, disables the rules and
// purges the project.

import crypto from 'node:crypto';
import { loadCases } from '../../src/index.js';
import { createApi, contentUrl, rulesAcknowledged } from './api.mjs';
import { readConfig } from './config.mjs';
import { sendToEdge, toCaseResponse, toRuleId } from './edge.mjs';
import { createUuidMap, deriveUuid, reverser } from './mapping.mjs';
import {
  INLINE_PROBE_FILE, RULE_TYPES, applyOp, buildDeployment, buildManifest, describeOps, emptyState,
  forgetAfterFailure, functionSite, matchSite, placeholderBody, planOps, siteFor, wholeSite
} from './plan.mjs';
import { basicCredentials, blindProbes, probesFor, waitUntilReady } from './ready.mjs';

const OPS = ['matchRule', 'serveStatic', 'runFunction', 'serveSite'];

/** A content URL in the form used to compare it: lower case, no index.html, no trailing slash. */
export function normalizeUrl(url) {
  const lower = String(url).toLowerCase().replace(/\/index\.html?$/, '/');
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

/** The content URLs that the adapter can write: each file of each vector, and the probe page. */
export async function knownFiles() {
  const names = new Set([INLINE_PROBE_FILE]);
  for (const item of await loadCases()) for (const name of Object.keys(item.input.files || {})) names.add(name);
  return new Map([...names].map((name) => [normalizeUrl(contentUrl(name)), name]));
}

/** The ids that are the same for every case of a run on one project. */
export function runIds(config) {
  const seed = `${config.organization}/${config.project}`;
  const placeholders = Object.fromEntries(RULE_TYPES.map((type) => [type, deriveUuid(seed, `placeholder:${type}`)]));
  return { seed, namespace: config.namespace, canaryUuid: deriveUuid(seed, 'canary'), placeholders };
}

function defaultLog(line) {
  process.stderr.write(`[edge-conformance runtime] ${line}\n`);
}

function createRuntime(config, options) {
  const api = createApi(config, options.fetch);
  const ids = runIds(config);
  const uuids = createUuidMap(ids.seed);
  const placeholderFunctions = RULE_TYPES.map((type) => ({ uuid: ids.placeholders[type], type, body: placeholderBody(type) }));
  const state = emptyState();
  const runId = crypto.randomBytes(4).toString('hex');
  const send = options.sendEdge || ((request) => sendToEdge(config.domain, request));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const log = options.log || defaultLog;
  let deploys = 0;
  let started = null;

  // Refuse a project that has content that the adapter did not write; take
  // over the files and headers that are there.
  async function start() {
    const known = await knownFiles();
    const existing = await api.listContent();
    const foreign = existing.filter((url) => !known.has(normalizeUrl(url)));
    if (foreign.length) {
      throw new Error(`the test project has ${foreign.length} content paths that are not vector files (for example ${foreign.slice(0, 3).join(', ')}): use an empty project made for this test`);
    }
    for (const url of existing) state.files.set(known.get(normalizeUrl(url)), undefined);
    state.headers = await api.listHeaders();
  }

  async function deployRules(manifest) {
    const body = await api.deployRules(manifest);
    if (!rulesAcknowledged(manifest, body)) throw new Error('deploy rules failed: the answer does not acknowledge each rule of the manifest');
  }

  const RUN = {
    upload: (op) => api.upload(op.path, op.content),
    delete: (op) => api.remove(op.path),
    function: (op) => api.deployFunction(op),
    project: (op) => api.patchProject(op.patch),
    'headers-set': (op) => api.setHeaders(op.headers),
    'headers-delete': (op) => api.deleteHeaders(op.names),
    rules: (op) => deployRules(op.manifest),
    purge: () => api.purgeAll()
  };

  async function execute(ops) {
    try {
      for (const op of ops) {
        await RUN[op.kind](op);
        applyOp(state, op);
      }
    } catch (err) {
      forgetAfterFailure(state);
      throw err;
    }
  }

  const probeSender = (settings) => (path, withCredentials) => {
    const credentials = withCredentials ? basicCredentials(settings) : null;
    return send({ method: 'GET', path, host: config.domain, headers: credentials ? { authorization: credentials } : {}, body: null });
  };

  async function settle(deployment, removedHeaders, ops) {
    const { probes, blocked: covered } = probesFor(deployment, state.version, removedHeaders);
    const blocked = blindProbes(covered, ops);
    const began = now();
    await waitUntilReady({ probes, send: probeSender(deployment.settings), timeoutMs: config.readyTimeoutMs, pollMs: config.pollMs, sleep, now });
    if (blocked.length) await sleep(config.blindWaitMs);
    await sleep(config.settleMs);
    const note = blocked.length ? ` (a case rule covers the ${blocked.join(', ')} probe: waited ${config.blindWaitMs} ms more)` : '';
    log(`ready after ${Math.round((now() - began) / 1000)} s${note}`);
  }

  async function deploy(site) {
    started = started || start();
    await started;
    const deployment = buildDeployment(site, { uuids, testDomain: config.domain, canaryUuid: ids.canaryUuid });
    deployment.functions.push(...placeholderFunctions);
    const removedHeaders = Object.keys(state.headers || {}).filter((name) => !(name in deployment.settings.headers));
    const ops = planOps(state, deployment, { ...ids, nextVersion: `${runId}-${deploys + 1}` });
    if (ops.length) {
      deploys += 1;
      log(`deploy ${deploys}: ${describeOps(ops)}`);
      await execute(ops);
      await settle(deployment, removedHeaders, ops);
    }
    return deployment;
  }

  async function respond(site) {
    const deployment = await deploy(site);
    const raw = await send(deployment.request);
    return toCaseResponse(raw, reverser(uuids, config.domain, new URL(site.request.url).hostname));
  }

  async function matchRule(rules, request) {
    const site = matchSite(rules, request);
    const deployment = await deploy(site);
    return toRuleId(await send(deployment.request), site.ruleIds);
  }

  const CLEANUP = [
    ['delete files', async () => {
      for (const name of [...state.files.keys()]) {
        await api.remove(name);
        state.files.delete(name);
      }
    }],
    ['reset project settings', () => api.patchProject({ enable_inline_fn: false, trailing_slash_redirect: false, basic_auth_username: '', basic_auth_password: '' })],
    ['delete project-wide headers', () => (Object.keys(state.headers || {}).length ? api.deleteHeaders(Object.keys(state.headers)) : null)],
    ['disable rules', () => deployRules(buildManifest([], ids, true))],
    ['purge', () => api.purgeAll()]
  ];

  async function dispose() {
    if (!started) return;
    try {
      await started;
    } catch {
      return;
    }
    for (const [name, step] of CLEANUP) {
      try {
        await step();
      } catch (err) {
        log(`cleanup step "${name}" failed: ${err.message}`);
      }
    }
  }

  return { respond, matchRule, dispose };
}

/**
 * The runtime adapter.
 * options (all optional; for tests and embedding):
 *   env       the environment (default process.env)
 *   fetch     the fetch for API calls (default globalThis.fetch)
 *   sendEdge  (request) -> { status, headers, body }: the request to the test domain
 *   sleep, now, log
 */
export function createAdapter(options = {}) {
  const config = readConfig(options.env || process.env);
  const runtime = createRuntime(config, options);
  return {
    capabilities: { ops: [...OPS] },
    matchRule: (rules, _functions, request) => runtime.matchRule(rules, request),
    serveStatic: (files, request) => runtime.respond(siteFor('serveStatic', [files, request])),
    runFunction: (input) => runtime.respond(functionSite(input)),
    serveSite: (input) => runtime.respond(wholeSite(input)),
    dispose: () => runtime.dispose()
  };
}

export default createAdapter;
