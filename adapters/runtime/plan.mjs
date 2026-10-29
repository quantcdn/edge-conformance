// The deploy plan of the runtime adapter. Pure functions only: no network.
// 1. siteFor() turns the arguments of an operation into one site: files,
//    functions, rules, project settings and a request.
// 2. buildDeployment() maps the site to the test project (UUIDs, domains,
//    rule slots, the probe page).
// 3. planOps() compares the deployment with what the project has now and
//    gives the API operations that make them the same. applyOp() records an
//    operation that succeeded.

import { mapRequestHost, mapRuleDomain } from './mapping.mjs';

/** Every path that the adapter uses for itself starts with this prefix. */
export const PROBE_PREFIX = '/__edge-conformance/';
export const CANARY_PATH = `${PROBE_PREFIX}ready`;
export const SLASH_PROBE_PATH = `${PROBE_PREFIX}slash/`;
export const INLINE_PROBE_FILE = '__edge-conformance/inline.html';
export const INLINE_PROBE_PATH = `/${INLINE_PROBE_FILE}`;

/** The rule types, and the number of rule slots of each type in the namespace. */
export const RULE_TYPES = ['function', 'auth', 'filter'];
export const SLOTS_PER_TYPE = 3;
const CANARY_WEIGHT = -100000;
const UNUSED_PATH = `${PROBE_PREFIX}unused`;

// A case UUID that is not in any vector: the function that gives a filter its response.
const UPSTREAM_UUID = 'e0c0f0a0-0000-4000-8000-000000000001';

// --- Sites ------------------------------------------------------------------

/** The project settings of a case: the contract defaults for each one that the case does not give. */
export function settingsFor(meta, project) {
  const settings = project || {};
  return {
    inline: Boolean(meta && meta.project_settings && meta.project_settings.enable_inline_fn === true),
    headers: { ...(settings.globalHeaders || {}) },
    basicAuth: settings.basicAuth ? { username: settings.basicAuth.username, password: settings.basicAuth.password } : null,
    trailingSlash: settings.trailingSlash === 'redirect' ? 'redirect' : 'none'
  };
}

const everyPath = (id, type, uuid) => ({ id, type, urls: ['/', '/*'], weight: 0, function_uuid: uuid });

function upstreamBody(response) {
  const init = JSON.stringify({ status: response.status, headers: response.headers || {} });
  return `return new Response(${JSON.stringify(response.body ?? null)}, ${init});`;
}

/** runFunction: one rule of the function's type on / and /*; a filter also gets a function that answers `response`. */
export function functionSite(input) {
  const subject = { uuid: input.uuid, id: 'subject', type: input.type, body: input.body };
  const site = { files: {}, functions: [subject], rules: [everyPath('subject', input.type, input.uuid)], settings: settingsFor(), request: input.request };
  if (input.type !== 'filter') return site;
  const upstream = { uuid: UPSTREAM_UUID, id: 'upstream', type: 'function', body: upstreamBody(input.response || { status: 200 }) };
  return { ...site, functions: [subject, upstream], rules: [everyPath('upstream', 'function', UPSTREAM_UUID), site.rules[0]] };
}

// The function bodies that tell which rule answered (matchRule). A probe path
// is let through, so that an auth rule never hides the probes of the adapter.
const IDENTITY = {
  function: (id) => `return new Response(${JSON.stringify(id)}, { status: 200, headers: { 'content-type': 'text/plain' } });`,
  auth: (id) => [
    `if (new URL(event.request.url).pathname.startsWith(${JSON.stringify(PROBE_PREFIX)})) return new Response(null, { status: 201 });`,
    `return new Response(${JSON.stringify(id)}, { status: 401, headers: { 'content-type': 'text/plain' } });`
  ].join('\n'),
  filter: () => 'class contentFilter extends TransformStream {\n  constructor() {\n    super();\n  }\n}'
};

/** A case UUID for the identity function of the rule at `index` (not in any vector). */
export function identityUuid(index) {
  return `f0e0d0c0-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** matchRule: each rule runs a function that answers its id (200 for a function rule, 401 for an auth rule). */
export function matchSite(rules, request) {
  const list = rules.rules.map((rule, index) => ({ ...rule, function_ref: undefined, function_uuid: identityUuid(index) }));
  const functions = list.map((rule) => ({ uuid: rule.function_uuid, id: rule.id, type: rule.type, body: IDENTITY[rule.type](rule.id) }));
  return { files: {}, functions, rules: list, settings: settingsFor(), request, ruleIds: list.map((rule) => rule.id) };
}

function resolveRule(rule, functions) {
  if (rule.function_ref === undefined) return rule;
  const target = functions.find((fn) => fn.id === rule.function_ref);
  if (!target) throw new Error(`rule ${rule.id}: no function has the id ${rule.function_ref}`);
  return { ...rule, function_ref: undefined, function_uuid: target.uuid };
}

/** serveSite and serveStatic: the case site as given, with each function_ref resolved. */
export function wholeSite(input) {
  const functions = input.functions || [];
  const rules = input.rules ? input.rules.rules.map((rule) => resolveRule(rule, functions)) : [];
  return { files: input.files || {}, functions, rules, settings: settingsFor(input.meta, input.project), request: input.request };
}

/** The site for the arguments of an operation. */
export function siteFor(op, args) {
  if (op === 'matchRule') return matchSite(args[0], args[2]);
  if (op === 'serveStatic') return wholeSite({ files: args[0], request: args[1] });
  if (op === 'runFunction') return functionSite(args[0]);
  return wholeSite(args[0]);
}

// --- Deployment ---------------------------------------------------------------

/** The rule slot ids: function-0 ... filter-2. */
export function slotIds() {
  return RULE_TYPES.flatMap((type) => Array.from({ length: SLOTS_PER_TYPE }, (_, i) => `${type}-${i}`));
}

function slotFor(type, counts) {
  const index = counts[type] || 0;
  if (index >= SLOTS_PER_TYPE) throw new Error(`a case can have at most ${SLOTS_PER_TYPE} rules of type ${type}`);
  counts[type] = index + 1;
  return `${type}-${index}`;
}

function deployRule(rule, slot, ctx, requestHost) {
  const out = { id: slot, type: rule.type, urls: [...rule.urls], weight: rule.weight, function_uuid: ctx.uuids.uuid(rule.function_uuid) };
  if (rule.disabled !== undefined) out.disabled = rule.disabled;
  if (rule.methods) out.methods = [...rule.methods];
  if (rule.domains) out.domains = rule.domains.map((domain) => mapRuleDomain(domain, requestHost, ctx.testDomain));
  return out;
}

function deployRules(rules, ctx, requestHost) {
  const counts = {};
  return rules.map((rule) => deployRule(rule, slotFor(rule.type, counts), ctx, requestHost));
}

function deployFiles(files, ctx) {
  const out = {};
  for (const [name, content] of Object.entries(files)) out[name] = ctx.uuids.forward(content);
  out[INLINE_PROBE_FILE] = `<p>{{QUANT_FN:${ctx.canaryUuid}}}</p>`;
  return out;
}

function deployRequest(request, ctx) {
  const url = new URL(request.url);
  return {
    method: request.method || 'GET',
    path: `${url.pathname}${url.search}`,
    host: mapRequestHost(url, ctx.testDomain),
    headers: { ...(request.headers || {}) },
    body: request.body ?? null
  };
}

/**
 * The deployment of a site on the test project.
 * ctx: { uuids (createUuidMap), testDomain, canaryUuid }
 */
export function buildDeployment(site, ctx) {
  const requestHost = new URL(site.request.url).hostname;
  return {
    files: deployFiles(site.files, ctx),
    functions: site.functions.map((fn) => ({ uuid: ctx.uuids.uuid(fn.uuid), type: fn.type, body: ctx.uuids.forward(fn.body || '') })),
    rules: deployRules(site.rules, ctx, requestHost),
    settings: site.settings,
    request: deployRequest(site.request, ctx)
  };
}

// --- Rules manifest -----------------------------------------------------------

/** The function of the canary rule: it answers the version of the deployment. */
export function canaryBody(version) {
  return `return new Response(${JSON.stringify(version)}, { status: 200, headers: { 'content-type': 'text/plain' } });`;
}

/** The body of the function that an unused slot of a type points at (the slot is disabled). */
export function placeholderBody(type) {
  return type === 'filter' ? IDENTITY.filter() : `return new Response(null, { status: ${type === 'auth' ? 201 : 404} });`;
}

function unusedSlot(id, placeholders) {
  const type = id.slice(0, id.lastIndexOf('-'));
  return { id, type, urls: [UNUSED_PATH], weight: 0, disabled: true, function_uuid: placeholders[type] };
}

/**
 * The rules manifest: the canary rule, then every slot (the slots that the
 * case does not use are disabled). With `retire`, every rule is disabled.
 * ids: { namespace, canaryUuid, placeholders: { function, auth, filter } }
 */
export function buildManifest(rules, ids, retire = false) {
  const used = new Map(rules.map((rule) => [rule.id, rule]));
  const canary = { id: 'ready', type: 'function', urls: [CANARY_PATH], weight: CANARY_WEIGHT, function_uuid: ids.canaryUuid };
  const slots = slotIds().map((id) => (retire || !used.has(id) ? unusedSlot(id, ids.placeholders) : used.get(id)));
  return { version: 1, namespace: ids.namespace, rules: [retire ? { ...canary, disabled: true } : canary, ...slots] };
}

// --- Operations ---------------------------------------------------------------

/** What the adapter knows about the test project. `null` is unknown. */
export function emptyState() {
  return { files: new Map(), functions: new Map(), settings: null, headers: null, manifest: null, version: null };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const functionKey = (fn) => `${fn.type}\n${fn.body}`;

function fileOps(state, files) {
  const uploads = Object.entries(files).filter(([name, content]) => state.files.get(name) !== content)
    .map(([name, content]) => ({ kind: 'upload', path: name, content }));
  const deletes = [...state.files.keys()].filter((name) => !(name in files)).map((name) => ({ kind: 'delete', path: name }));
  return [...uploads, ...deletes];
}

function functionOps(state, functions) {
  return functions.filter((fn) => state.functions.get(fn.uuid) !== functionKey(fn))
    .map((fn) => ({ kind: 'function', uuid: fn.uuid, type: fn.type, body: fn.body }));
}

const PROJECT_FIELDS = {
  inline: (s) => ({ enable_inline_fn: s.inline }),
  trailingSlash: (s) => ({ trailing_slash_redirect: s.trailingSlash === 'redirect' }),
  basicAuth: (s) => ({ basic_auth_username: s.basicAuth ? s.basicAuth.username : '', basic_auth_password: s.basicAuth ? s.basicAuth.password : '' })
};

function projectOps(state, settings) {
  const known = state.settings;
  const changed = Object.keys(PROJECT_FIELDS).filter((field) => !known || !sameJson(known[field], settings[field]));
  if (!changed.length) return [];
  const patch = Object.assign(known ? {} : { basic_auth_preview_only: false }, ...changed.map((field) => PROJECT_FIELDS[field](settings)));
  return [{ kind: 'project', patch, settings: Object.fromEntries(changed.map((field) => [field, settings[field]])) }];
}

function headerOps(state, headers) {
  const current = state.headers || {};
  const set = Object.fromEntries(Object.entries(headers).filter(([name, value]) => current[name] !== value));
  const remove = Object.keys(current).filter((name) => !(name in headers));
  return [
    ...(Object.keys(set).length ? [{ kind: 'headers-set', headers: set }] : []),
    ...(remove.length ? [{ kind: 'headers-delete', names: remove }] : [])
  ];
}

/**
 * The operations that make the project hold `deployment`, in the order to run
 * them: functions, the canary, files, settings, rules, then one purge.
 * ids: as for buildManifest, plus nextVersion (the version for a new canary).
 */
export function planOps(state, deployment, ids) {
  const manifest = buildManifest(deployment.rules, ids);
  const functions = functionOps(state, deployment.functions);
  const rulesChanged = !sameJson(state.manifest, manifest);
  const canary = functions.length || rulesChanged || state.version === null
    ? [{ kind: 'function', uuid: ids.canaryUuid, type: 'function', body: canaryBody(ids.nextVersion), version: ids.nextVersion }]
    : [];
  const ops = [
    ...functions,
    ...canary,
    ...fileOps(state, deployment.files),
    ...projectOps(state, deployment.settings),
    ...headerOps(state, deployment.settings.headers),
    ...(rulesChanged ? [{ kind: 'rules', manifest }] : [])
  ];
  return ops.length ? [...ops, { kind: 'purge' }] : [];
}

const APPLY = {
  upload: (state, op) => state.files.set(op.path, op.content),
  delete: (state, op) => state.files.delete(op.path),
  function: (state, op) => {
    state.functions.set(op.uuid, functionKey(op));
    if (op.version !== undefined) state.version = op.version;
  },
  project: (state, op) => {
    state.settings = { ...(state.settings || {}), ...op.settings };
  },
  'headers-set': (state, op) => {
    state.headers = { ...(state.headers || {}), ...op.headers };
  },
  'headers-delete': (state, op) => {
    state.headers = Object.fromEntries(Object.entries(state.headers || {}).filter(([name]) => !op.names.includes(name)));
  },
  rules: (state, op) => {
    state.manifest = op.manifest;
  },
  purge: () => {}
};

/** Record in `state` an operation that succeeded. */
export function applyOp(state, op) {
  APPLY[op.kind](state, op);
}

/** Forget what a failed operation could have changed, so that the next case writes it again. */
export function forgetAfterFailure(state) {
  state.functions.clear();
  state.settings = null;
  state.manifest = null;
  state.version = null;
  for (const name of state.files.keys()) state.files.set(name, undefined);
}

/** A short summary of the operations, for the progress log. */
export function describeOps(ops) {
  const counts = {};
  for (const op of ops) counts[op.kind] = (counts[op.kind] || 0) + 1;
  return Object.entries(counts).map(([kind, n]) => `${kind} x${n}`).join(', ');
}
