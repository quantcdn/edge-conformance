#!/usr/bin/env node
// Dry run of the runtime adapter: print, for each selected case, the API
// operations, the probes and the request that a live run makes. It sends no
// request and needs no credentials.
//
//   node adapters/runtime/dry-run.mjs [--tags unverified] [--domain conformance.example.net] [--verbose]

import { parseArgs } from 'node:util';
import { adapterArgs, loadCases, selectCases } from '../../src/index.js';
import { runIds } from './index.mjs';
import { createUuidMap } from './mapping.mjs';
import { RULE_TYPES, applyOp, buildDeployment, describeOps, emptyState, placeholderBody, planOps, siteFor } from './plan.mjs';
import { blindProbes, probesFor } from './ready.mjs';

const CONFIG = { organization: 'example-org', project: 'example-project', namespace: 'edge-conformance' };

function describeOp(op) {
  const detail = {
    upload: () => op.path,
    delete: () => op.path,
    function: () => `${op.type} ${op.uuid}${op.version ? ' (canary)' : ''}`,
    project: () => JSON.stringify(op.patch),
    'headers-set': () => JSON.stringify(op.headers),
    'headers-delete': () => op.names.join(', '),
    rules: () => op.manifest.rules.filter((rule) => !rule.disabled).map((rule) => `${rule.id} ${rule.urls.join(' ')}`).join('; '),
    purge: () => '/*'
  }[op.kind]();
  return `    ${op.kind}: ${detail}`;
}

function planCase(item, context, verbose) {
  const site = siteFor(item.op, adapterArgs(item.op, structuredClone(item.input)));
  const deployment = buildDeployment(site, context.mapping);
  deployment.functions.push(...context.placeholders);
  const removed = Object.keys(context.state.headers || {}).filter((name) => !(name in deployment.settings.headers));
  const ops = planOps(context.state, deployment, { ...context.ids, nextVersion: `dry-${context.deploys + 1}` });
  if (ops.length) context.deploys += 1;
  for (const op of ops) applyOp(context.state, op);
  const { probes, blocked: covered } = probesFor(deployment, context.state.version, removed);
  const blocked = blindProbes(covered, ops);
  const request = deployment.request;
  console.log(`${item.id} [${item.op}]`);
  console.log(`  deploy: ${ops.length ? describeOps(ops) : 'nothing (same as the case before)'}`);
  if (verbose) ops.forEach((op) => console.log(describeOp(op)));
  if (ops.length) console.log(`  probes: ${probes.map((probe) => probe.name).join(', ') || 'none'}${blocked.length ? `; blind wait (covered by a case rule: ${blocked.join(', ')})` : ''}`);
  console.log(`  request: ${request.method} https://${request.host}${request.path}`);
  return ops.length;
}

async function main() {
  const { values } = parseArgs({ options: { tags: { type: 'string' }, domain: { type: 'string', default: 'conformance.example.net' }, verbose: { type: 'boolean', default: false } } });
  const tags = values.tags ? values.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined;
  const ids = runIds(CONFIG);
  const context = {
    ids,
    mapping: { uuids: createUuidMap(ids.seed), testDomain: values.domain, canaryUuid: ids.canaryUuid },
    placeholders: RULE_TYPES.map((type) => ({ uuid: ids.placeholders[type], type, body: placeholderBody(type) })),
    state: { ...emptyState(), headers: {} },
    deploys: 0
  };
  const cases = selectCases(await loadCases(), tags);
  for (const item of cases) planCase(item, context, values.verbose);
  console.log(`${cases.length} cases, ${context.deploys} deploys`);
}

await main();
