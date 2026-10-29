// Tests for the pure parts of the runtime adapter (adapters/runtime): the
// configuration, the name mapping, the deploy plan, the probes, the answer
// mapping and the API error mapping. One test runs the whole adapter against
// a fake API and a fake edge. Nothing here sends a network request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, run } from '../src/index.js';
import { readConfig, REQUIRED } from '../adapters/runtime/config.mjs';
import { createUuidMap, deriveUuid, mapRequestHost, mapRuleDomain, reverser } from '../adapters/runtime/mapping.mjs';
import {
  CANARY_PATH, INLINE_PROBE_FILE, SLASH_PROBE_PATH, applyOp, buildDeployment, buildManifest, emptyState,
  forgetAfterFailure, functionSite, matchSite, planOps, settingsFor, siteFor, slotIds, wholeSite
} from '../adapters/runtime/plan.mjs';
import { blindProbes, headersShown, patternCouldMatch, probesFor, waitUntilReady } from '../adapters/runtime/ready.mjs';
import { toCaseResponse, toRuleId } from '../adapters/runtime/edge.mjs';
import { apiOutcome, contentUrl, createApi, mimeType, redact, rulesAcknowledged } from '../adapters/runtime/api.mjs';
import { createAdapter, normalizeUrl, runIds } from '../adapters/runtime/index.mjs';

const CONTENT_TOKEN = 'content-token-0123456789abcdef0123456789';
const DASHBOARD_TOKEN = 'dashboard-token-0123456789abcdef012345678';

const ENV = {
  EDGE_CONFORMANCE_DOMAIN: 'conformance.test-sites.example.net',
  EDGE_CONFORMANCE_ORGANIZATION: 'test-org',
  EDGE_CONFORMANCE_PROJECT: 'edge-conformance-test',
  EDGE_CONFORMANCE_CONFIRM_PROJECT: 'edge-conformance-test',
  EDGE_CONFORMANCE_CONTENT_API: 'https://content.example.net/v1',
  EDGE_CONFORMANCE_CONTENT_TOKEN: CONTENT_TOKEN,
  EDGE_CONFORMANCE_DASHBOARD_API: 'https://dashboard.example.net/api/v2',
  EDGE_CONFORMANCE_DASHBOARD_TOKEN: DASHBOARD_TOKEN
};

const UUID_A = 'c3d4e5f6-0001-4000-8000-000000000001';
const UUID_B = 'c3d4e5f6-0002-4000-8000-000000000002';
const TEST_DOMAIN = ENV.EDGE_CONFORMANCE_DOMAIN;
const config = readConfig(ENV);
const ids = runIds(config);
const request = (url, extra = {}) => ({ method: 'GET', url, ...extra });

function deploymentFor(site) {
  const uuids = createUuidMap(ids.seed);
  return { uuids, deployment: buildDeployment(site, { uuids, testDomain: TEST_DOMAIN, canaryUuid: ids.canaryUuid }) };
}

describe('runtime adapter: configuration', () => {
  test('names each missing variable and no value', () => {
    const env = { ...ENV };
    delete env.EDGE_CONFORMANCE_DASHBOARD_TOKEN;
    delete env.EDGE_CONFORMANCE_DOMAIN;
    assert.throws(() => readConfig(env), (err) => err.message.includes('EDGE_CONFORMANCE_DASHBOARD_TOKEN')
      && err.message.includes('EDGE_CONFORMANCE_DOMAIN') && !err.message.includes(CONTENT_TOKEN));
  });

  test('needs the project name twice', () => {
    assert.throws(() => readConfig({ ...ENV, EDGE_CONFORMANCE_CONFIRM_PROJECT: 'other' }), /CONFIRM_PROJECT must repeat/);
  });

  test('refuses a host with a scheme, a plain HTTP API and a dashboard URL without /api/v2', () => {
    assert.throws(() => readConfig({ ...ENV, EDGE_CONFORMANCE_DOMAIN: 'https://x.example.net' }), /host name only/);
    assert.throws(() => readConfig({ ...ENV, EDGE_CONFORMANCE_CONTENT_API: 'http://content.example.net/v1' }), /CONTENT_API/);
    assert.throws(() => readConfig({ ...ENV, EDGE_CONFORMANCE_DASHBOARD_API: 'https://dashboard.example.net/api/v3' }), /\/api\/v2/);
  });

  test('gives the defaults and removes a trailing slash from the API URLs', () => {
    const value = readConfig({ ...ENV, EDGE_CONFORMANCE_CONTENT_API: 'https://content.example.net/v1/', EDGE_CONFORMANCE_SETTLE_MS: '0' });
    assert.equal(value.contentApi, 'https://content.example.net/v1');
    assert.equal(value.namespace, 'edge-conformance');
    assert.equal(value.settleMs, 0);
    assert.equal(value.readyTimeoutMs, 600000);
    assert.equal(Object.keys(REQUIRED).length, 8);
  });
});

describe('runtime adapter: name mapping', () => {
  test('derives the same version 5 UUID for the same seed and name', () => {
    const uuid = deriveUuid('org/project', UUID_A);
    assert.equal(uuid, deriveUuid('org/project', UUID_A));
    assert.notEqual(uuid, deriveUuid('org/other', UUID_A));
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('maps each UUID in a text and maps it back', () => {
    const uuids = createUuidMap('seed');
    const text = `{{QUANT_FN:${UUID_A}}} {{QUANT_FN:${UUID_A.toUpperCase()}}} {{QUANT_FN:c3d4e5f6}}`;
    const mapped = uuids.forward(text);
    assert.ok(!mapped.toLowerCase().includes(UUID_A));
    assert.ok(mapped.includes(uuids.uuid(UUID_A).toUpperCase()));
    assert.ok(mapped.includes('{{QUANT_FN:c3d4e5f6}}'));
    assert.equal(uuids.reverse(mapped).toLowerCase(), text.toLowerCase());
  });

  test('maps rule domains by their relation to the request host', () => {
    assert.equal(mapRuleDomain('www.example.com', 'www.example.com', TEST_DOMAIN), TEST_DOMAIN);
    assert.equal(mapRuleDomain('WWW.Example.com', 'www.example.com', TEST_DOMAIN), TEST_DOMAIN.toUpperCase());
    assert.equal(mapRuleDomain('example.com', 'www.example.com', TEST_DOMAIN), 'example.net');
    assert.equal(mapRuleDomain('www.example.com', 'shop.example.com', TEST_DOMAIN), 'www-example-com.unmatched.invalid');
    assert.equal(mapRuleDomain('any', 'shop.example.com', TEST_DOMAIN), 'any');
  });

  test('keeps the port of the case URL in the Host header', () => {
    assert.equal(mapRequestHost(new URL('http://www.example.com:8080/page'), TEST_DOMAIN), `${TEST_DOMAIN}:8080`);
    assert.equal(mapRequestHost(new URL('https://www.example.com/page'), TEST_DOMAIN), TEST_DOMAIN);
  });

  test('maps an answer back to the case host and UUIDs', () => {
    const uuids = createUuidMap('seed');
    const back = reverser(uuids, TEST_DOMAIN, 'www.example.com');
    assert.equal(back(`https://${TEST_DOMAIN}/x ${uuids.uuid(UUID_B)}`), `https://www.example.com/x ${UUID_B}`);
  });
});

describe('runtime adapter: sites', () => {
  test('a filter runs over a function that gives the case response', () => {
    const site = functionSite({ uuid: UUID_A, type: 'filter', body: 'class contentFilter extends TransformStream {}', request: request('https://www.example.com/'), response: { status: 201, headers: { 'x-a': '1' }, body: 'hi' } });
    assert.deepEqual(site.rules.map((rule) => [rule.type, rule.urls]), [['function', ['/', '/*']], ['filter', ['/', '/*']]]);
    assert.match(site.functions[1].body, /"hi"/);
    assert.match(site.functions[1].body, /"status":201/);
  });

  test('matchRule gives each rule a function that answers its id', () => {
    const rules = { version: 1, namespace: 'conformance', rules: [
      { id: 'site', type: 'function', urls: ['/*'], weight: 0, function_ref: 'x' },
      { id: 'members', type: 'auth', urls: ['/members/*'], weight: -1, function_uuid: UUID_A }
    ] };
    const site = matchSite(rules, request('https://www.example.com/page'));
    assert.deepEqual(site.ruleIds, ['site', 'members']);
    assert.match(site.functions[0].body, /"site", \{ status: 200/);
    assert.match(site.functions[1].body, /"members", \{ status: 401/);
    assert.match(site.functions[1].body, /status: 201/);
    assert.notEqual(site.rules[0].function_uuid, site.rules[1].function_uuid);
  });

  test('serveSite resolves function_ref and refuses an unknown one', () => {
    const input = { functions: [{ uuid: UUID_A, id: 'api', type: 'function', body: '' }], rules: { version: 1, namespace: 'n', rules: [{ id: 'r', type: 'function', urls: ['/'], weight: 0, function_ref: 'api' }] }, request: request('https://www.example.com/') };
    assert.equal(wholeSite(input).rules[0].function_uuid, UUID_A);
    input.rules.rules[0].function_ref = 'nope';
    assert.throws(() => wholeSite(input), /no function has the id nope/);
  });

  test('settings default to off, no headers and no redirect', () => {
    assert.deepEqual(settingsFor(), { inline: false, headers: {}, basicAuth: null, trailingSlash: 'none' });
    assert.deepEqual(settingsFor({ project_settings: { enable_inline_fn: true } }, { trailingSlash: 'redirect', globalHeaders: { 'x-a': '1' } }),
      { inline: true, headers: { 'x-a': '1' }, basicAuth: null, trailingSlash: 'redirect' });
  });
});

describe('runtime adapter: deployment and operations', () => {
  const site = wholeSite({
    files: { 'index.html': `<p>{{QUANT_FN:${UUID_A}}}</p>` },
    functions: [{ uuid: UUID_A, id: 'a', type: 'function', body: `return new Response("${UUID_B}");` }],
    rules: { version: 1, namespace: 'n', rules: [{ id: 'api', type: 'function', urls: ['/api/*'], domains: ['www.example.com'], weight: 2, function_uuid: UUID_A }] },
    project: { globalHeaders: { 'x-a': '1' } },
    request: request('https://www.example.com/api/x?q=1', { headers: { 'X-Custom': 'v' } })
  });

  test('maps the files, functions, rules and request to the test project', () => {
    const { uuids, deployment } = deploymentFor(site);
    const mappedA = uuids.uuid(UUID_A);
    assert.equal(deployment.files['index.html'], `<p>{{QUANT_FN:${mappedA}}}</p>`);
    assert.ok(deployment.files[INLINE_PROBE_FILE].includes(ids.canaryUuid));
    assert.equal(deployment.functions[0].uuid, mappedA);
    assert.ok(deployment.functions[0].body.includes(uuids.uuid(UUID_B)));
    assert.deepEqual(deployment.rules, [{ id: 'function-0', type: 'function', urls: ['/api/*'], weight: 2, function_uuid: mappedA, domains: [TEST_DOMAIN] }]);
    assert.deepEqual(deployment.request, { method: 'GET', path: '/api/x?q=1', host: TEST_DOMAIN, headers: { 'X-Custom': 'v' }, body: null });
  });

  test('refuses more rules of one type than there are slots', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, type: 'auth', urls: ['/'], weight: 0, function_uuid: UUID_A }));
    assert.throws(() => deploymentFor({ ...site, rules: many }), /at most 3 rules of type auth/);
  });

  test('the manifest has the canary and every slot; unused slots and a retired manifest are disabled', () => {
    const { deployment } = deploymentFor(site);
    const manifest = buildManifest(deployment.rules, ids);
    assert.equal(manifest.namespace, 'edge-conformance');
    assert.deepEqual(manifest.rules.map((rule) => rule.id), ['ready', ...slotIds()]);
    assert.equal(manifest.rules[0].urls[0], CANARY_PATH);
    assert.equal(manifest.rules.filter((rule) => !rule.disabled).length, 2);
    assert.ok(buildManifest(deployment.rules, ids, true).rules.every((rule) => rule.disabled === true));
  });

  test('plans everything the first time, nothing the second time, and only the change after that', () => {
    const { deployment } = deploymentFor(site);
    const state = { ...emptyState(), headers: {} };
    const first = planOps(state, deployment, { ...ids, nextVersion: 'v1' });
    assert.deepEqual(first.map((op) => op.kind), ['function', 'function', 'upload', 'upload', 'project', 'headers-set', 'rules', 'purge']);
    assert.equal(first[4].patch.basic_auth_preview_only, false);
    first.forEach((op) => applyOp(state, op));
    assert.equal(state.version, 'v1');
    assert.deepEqual(planOps(state, deployment, { ...ids, nextVersion: 'v2' }), []);

    const next = deploymentFor({ ...site, settings: settingsFor(undefined, { trailingSlash: 'redirect' }) }).deployment;
    const ops = planOps(state, next, { ...ids, nextVersion: 'v2' });
    assert.deepEqual(ops.map((op) => op.kind), ['project', 'headers-delete', 'purge']);
    assert.deepEqual(ops[0].patch, { trailing_slash_redirect: true });
    assert.deepEqual(ops[1].names, ['x-a']);
  });

  test('deletes the files of the case before', () => {
    const state = { ...emptyState(), headers: {} };
    state.files.set('old.html', '<p>old</p>');
    const ops = planOps(state, deploymentFor(site).deployment, { ...ids, nextVersion: 'v1' });
    assert.ok(ops.some((op) => op.kind === 'delete' && op.path === 'old.html'));
  });

  test('after a failure, every function, setting and file is written again', () => {
    const { deployment } = deploymentFor(site);
    const state = { ...emptyState(), headers: {} };
    planOps(state, deployment, { ...ids, nextVersion: 'v1' }).forEach((op) => applyOp(state, op));
    forgetAfterFailure(state);
    const kinds = planOps(state, deployment, { ...ids, nextVersion: 'v2' }).map((op) => op.kind);
    assert.deepEqual(kinds, ['function', 'function', 'upload', 'upload', 'project', 'rules', 'purge']);
  });
});

describe('runtime adapter: probes', () => {
  test('a URL pattern could match a probe path when the text before * is a prefix', () => {
    assert.ok(patternCouldMatch('/*', SLASH_PROBE_PATH));
    assert.ok(patternCouldMatch('/__edge-conformance/*', CANARY_PATH));
    assert.ok(!patternCouldMatch('/api/*', CANARY_PATH));
    assert.ok(!patternCouldMatch('/about', CANARY_PATH));
  });

  test('a case rule on every path covers the page probes, and an auth rule also covers the canary', () => {
    const fn = deploymentFor(functionSite({ uuid: UUID_A, type: 'function', body: '', request: request('https://www.example.com/') })).deployment;
    assert.deepEqual(probesFor(fn, 'v').blocked, ['inline', 'trailing-slash']);
    const auth = deploymentFor(functionSite({ uuid: UUID_A, type: 'auth', body: '', request: request('https://www.example.com/') })).deployment;
    assert.deepEqual(probesFor(auth, 'v').blocked, ['canary', 'basic-auth', 'inline', 'trailing-slash']);
    const plain = deploymentFor(siteFor('serveStatic', [{}, request('https://www.example.com/')])).deployment;
    assert.deepEqual(probesFor(plain, 'v').blocked, []);
  });

  test('a covered probe needs a fixed wait only when the operations change what it shows', () => {
    const project = { kind: 'project', settings: { trailingSlash: 'none' } };
    assert.deepEqual(blindProbes(['inline', 'trailing-slash'], [project]), ['trailing-slash']);
    assert.deepEqual(blindProbes(['canary'], [{ kind: 'upload', path: 'a.html' }]), []);
    assert.deepEqual(blindProbes(['canary'], [{ kind: 'rules' }]), ['canary']);
  });

  test('the canary checks the project-wide headers, and ignores the ones that the edge controls', () => {
    assert.ok(headersShown({ 'x-a': '1' }, { 'X-A': '1', 'quant-server': 'x' }, []));
    assert.ok(!headersShown({}, { 'x-a': '1' }, []));
    assert.ok(!headersShown({ 'x-old': '1' }, {}, ['x-old']));
  });

  test('waits until each probe passes, and fails with the names of the probes that did not', async () => {
    let clock = 0;
    const sleep = async (ms) => { clock += ms; };
    const now = () => clock;
    let answers = 0;
    const probes = [{ name: 'canary', path: CANARY_PATH, withCredentials: true, check: (res) => res.body === 'v2' }];
    const send = async (path) => {
      assert.match(path, /^\/__edge-conformance\/ready\?edge-conformance-ready=/);
      answers += 1;
      return { status: 200, headers: {}, body: answers >= 3 ? 'v2' : 'v1' };
    };
    assert.equal(await waitUntilReady({ probes, send, timeoutMs: 60000, pollMs: 1000, sleep, now }), 2);
    await assert.rejects(waitUntilReady({ probes, send: async () => ({ status: 200, headers: {}, body: 'v1' }), timeoutMs: 3000, pollMs: 1000, sleep, now }),
      /within 3 s \(probes not passed: canary\)/);
  });
});

describe('runtime adapter: answers', () => {
  test('gives lower-case header names, set-cookie as a list only with two or more values, and the case names', () => {
    const uuids = createUuidMap('seed');
    const raw = { status: 301, headers: { Location: `https://${TEST_DOMAIN}/about`, 'set-cookie': ['a=1'], 'x-two': ['1', '2'] }, body: `missing ${uuids.uuid(UUID_A)}` };
    const answer = toCaseResponse(raw, reverser(uuids, TEST_DOMAIN, 'www.example.com'));
    assert.deepEqual(answer, { status: 301, headers: { location: 'https://www.example.com/about', 'set-cookie': 'a=1', 'x-two': ['1', '2'] }, bodyText: `missing ${UUID_A}` });
  });

  test('a rule id comes from a 200 or 401 answer of an identity function only', () => {
    assert.deepEqual(toRuleId({ status: 200, body: 'site' }, ['site']), { ruleId: 'site' });
    assert.deepEqual(toRuleId({ status: 401, body: 'members' }, ['site', 'members']), { ruleId: 'members' });
    assert.deepEqual(toRuleId({ status: 404, body: 'site' }, ['site']), { ruleId: null });
    assert.deepEqual(toRuleId({ status: 200, body: '<h1>Home</h1>' }, ['site']), { ruleId: null });
  });
});

describe('runtime adapter: API', () => {
  test('gives the content URL that quant deploy gives', () => {
    assert.equal(contentUrl('index.html'), '/');
    assert.equal(contentUrl('about/index.html'), '/about');
    assert.equal(contentUrl('Contact.html'), '/contact.html');
    assert.equal(contentUrl('css/site.css'), '/css/site.css');
    assert.equal(mimeType('img/logo.svg'), 'image/svg+xml');
    assert.equal(mimeType('files/x.bin'), 'application/octet-stream');
    assert.equal(normalizeUrl('/About/index.html'), '/about');
  });

  test('maps API answers to success or an error without tokens', () => {
    assert.equal(apiOutcome('step', 200, '{"ok":true}', []).ok, true);
    assert.equal(apiOutcome('step', 200, '{"error":true,"errorMsg":"MD5 already matches existing file."}', []).ok, true);
    const refused = apiOutcome('deploy rules', 422, `{"message":"bad token ${DASHBOARD_TOKEN}"}`, [DASHBOARD_TOKEN]);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.message, 'deploy rules failed (HTTP 422): bad token [redacted]');
    assert.match(apiOutcome('upload', 200, '{"error":true,"errorMsg":"Quota"}', []).error.message, /upload failed \(HTTP 200\): Quota/);
    assert.match(apiOutcome('purge', 502, 'gateway', []).error.message, /purge failed \(HTTP 502\): gateway/);
    assert.equal(redact('x'.repeat(400), []).length, 303);
  });

  test('a rules answer must acknowledge each rule in order', () => {
    const manifest = { namespace: 'n', rules: [{ id: 'a' }, { id: 'b' }] };
    assert.ok(rulesAcknowledged(manifest, { namespace: 'n', rules: [{ id: 'a', status: 'created' }, { id: 'b', status: 'unchanged' }] }));
    assert.ok(!rulesAcknowledged(manifest, { namespace: 'n', rules: [{ id: 'a', status: 'drift' }, { id: 'b', status: 'unchanged' }] }));
    assert.ok(!rulesAcknowledged(manifest, { rules: [] }));
  });

  test('sends the requests that quant-cli and the dashboard API take', async () => {
    const calls = [];
    const api = createApi(config, async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    await api.upload('about/index.html', '<h1>About</h1>');
    await api.upload('css/site.css', 'body {}');
    await api.deployFunction({ uuid: UUID_A, type: 'auth', body: 'return null;' });
    await api.patchProject({ enable_inline_fn: true });
    await api.purgeAll();
    assert.equal(calls[0].url, 'https://content.example.net/v1');
    assert.deepEqual(JSON.parse(calls[0].init.body), { url: '/about', content: '<h1>About</h1>', published: true, find_attachments: false });
    assert.equal(calls[0].init.headers['Quant-Token'], CONTENT_TOKEN);
    assert.equal(calls[1].init.headers['Quant-File-Url'], '/css/site.css');
    assert.ok(calls[1].init.body instanceof FormData);
    assert.equal(calls[2].url, 'https://content.example.net/v1/functions/auth');
    assert.equal(calls[3].url, 'https://dashboard.example.net/api/v2/organizations/test-org/projects/edge-conformance-test');
    assert.equal(calls[3].init.method, 'PATCH');
    assert.equal(calls[3].init.headers.Authorization, `Bearer ${DASHBOARD_TOKEN}`);
    assert.deepEqual(JSON.parse(calls[4].init.body), { urls: ['/*'], soft: false });
  });

  test('a network error does not show a token', async () => {
    const api = createApi(config, async () => { throw new Error(`connect failed for ${CONTENT_TOKEN}`); });
    await assert.rejects(api.upload('index.html', 'x'), (err) => !err.message.includes(CONTENT_TOKEN) && err.message.includes('[redacted]'));
  });
});

// --- The whole adapter against a fake API and a fake edge ---------------------

function fakePlatform({ existing = [] } = {}) {
  const calls = [];
  const deployed = new Map();
  let version = null;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.includes('/global-meta')) return Response.json({ global_meta: { total_pages: 1, records: existing.map((path) => ({ meta: { url: path } })) } });
    if (url.endsWith('/custom-headers') && method === 'GET') return Response.json({});
    if (url.endsWith('/rules/deploy')) {
      const manifest = JSON.parse(init.body);
      return Response.json({ namespace: manifest.namespace, rules: manifest.rules.map((rule) => ({ id: rule.id, status: 'updated' })) });
    }
    if (url.includes('/functions')) {
      const fn = JSON.parse(init.body);
      deployed.set(fn.uuid, fn.content);
      if (fn.uuid === ids.canaryUuid) version = JSON.parse(fn.content.match(/new Response\(("[^"]*")/)[1]);
    }
    return Response.json({});
  };
  const sendEdge = async (req) => {
    if (req.path.startsWith(CANARY_PATH)) return { status: 200, headers: {}, body: version };
    if (req.path.startsWith(SLASH_PROBE_PATH)) return { status: 404, headers: {}, body: '' };
    if (req.path.startsWith('/__edge-conformance/inline.html')) return { status: 200, headers: {}, body: '<p>{{QUANT_FN:x}}</p>' };
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'accept-ranges': 'bytes' }, body: '<h1>Home</h1>' };
  };
  return { calls, deployed, fetch, sendEdge };
}

describe('runtime adapter: whole run with fakes', () => {
  const quiet = { sleep: async () => {}, log: () => {} };

  test('deploys, waits for the probes, answers the case and cleans up', async () => {
    const platform = fakePlatform({ existing: ['/'] });
    const adapter = createAdapter({ env: ENV, fetch: platform.fetch, sendEdge: platform.sendEdge, ...quiet });
    const cases = (await loadCases()).filter((item) => item.id === 'static-root-serves-index-html');
    const result = await run({ adapter, cases });
    assert.deepEqual(result.cases[0].failures, []);
    assert.equal(result.passed, 1);
    assert.ok(platform.calls.includes('POST /api/v2/organizations/test-org/projects/edge-conformance-test/rules/deploy'));
    assert.ok(platform.calls.includes('DELETE /v1/delete/all'));
    assert.equal(platform.calls.at(-1), 'POST /api/v2/organizations/test-org/projects/edge-conformance-test/purge');
    assert.ok(!platform.deployed.has(UUID_A));
  });

  test('refuses a project with content that is not a vector file', async () => {
    const platform = fakePlatform({ existing: ['/customer-page'] });
    const adapter = createAdapter({ env: ENV, fetch: platform.fetch, sendEdge: platform.sendEdge, ...quiet });
    const cases = (await loadCases()).filter((item) => item.id === 'static-root-serves-index-html');
    const result = await run({ adapter, cases });
    assert.match(result.cases[0].failures[0], /1 content paths that are not vector files.*\/customer-page/);
    assert.ok(platform.calls.every((call) => call.startsWith('GET ')));
  });

  test('createAdapter throws when the environment is not set', () => {
    assert.throws(() => createAdapter({ env: {} }), /missing environment variables/);
  });
});
