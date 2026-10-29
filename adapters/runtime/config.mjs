// The configuration of the runtime adapter, from environment variables.
// An error names the variables, never their values.

export const REQUIRED = {
  domain: 'EDGE_CONFORMANCE_DOMAIN',
  organization: 'EDGE_CONFORMANCE_ORGANIZATION',
  project: 'EDGE_CONFORMANCE_PROJECT',
  confirmProject: 'EDGE_CONFORMANCE_CONFIRM_PROJECT',
  contentApi: 'EDGE_CONFORMANCE_CONTENT_API',
  contentToken: 'EDGE_CONFORMANCE_CONTENT_TOKEN',
  dashboardApi: 'EDGE_CONFORMANCE_DASHBOARD_API',
  dashboardToken: 'EDGE_CONFORMANCE_DASHBOARD_TOKEN'
};

export const OPTIONAL = {
  namespace: ['EDGE_CONFORMANCE_NAMESPACE', 'edge-conformance'],
  readyTimeoutMs: ['EDGE_CONFORMANCE_READY_TIMEOUT_MS', 600000],
  pollMs: ['EDGE_CONFORMANCE_POLL_MS', 5000],
  settleMs: ['EDGE_CONFORMANCE_SETTLE_MS', 5000],
  blindWaitMs: ['EDGE_CONFORMANCE_BLIND_WAIT_MS', 120000]
};

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
const isSet = (value) => typeof value === 'string' && value.length > 0;

function httpsBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const CHECKS = [
  [(c) => HOST.test(c.domain), `${REQUIRED.domain} must be a host name only (no scheme, port or path)`],
  [(c) => c.confirmProject === c.project, `${REQUIRED.confirmProject} must repeat ${REQUIRED.project}: the adapter replaces the content, settings and rules of that project`],
  [(c) => httpsBase(c.contentApi), `${REQUIRED.contentApi} must be an HTTPS URL (the content API, ending in /v1)`],
  [(c) => httpsBase(c.dashboardApi) && /\/api\/v2$/.test(c.dashboardApi), `${REQUIRED.dashboardApi} must be an HTTPS URL that ends in /api/v2`],
  [(c) => SLUG.test(c.namespace), `${OPTIONAL.namespace[0]} must match ^[a-z][a-z0-9-]{0,47}$`],
  [(c) => ['readyTimeoutMs', 'pollMs', 'settleMs', 'blindWaitMs'].every((key) => Number.isInteger(c[key]) && c[key] >= 0), 'the EDGE_CONFORMANCE_*_MS values must be whole numbers of 0 or more']
];

function optionalValue(env, [name, fallback]) {
  if (!isSet(env[name])) return fallback;
  return typeof fallback === 'number' ? Number(env[name]) : env[name];
}

/** The configuration, or an Error that lists each problem. */
export function readConfig(env) {
  const missing = Object.values(REQUIRED).filter((name) => !isSet(env[name]));
  if (missing.length) throw new Error(`runtime adapter: missing environment variables: ${missing.join(', ')}`);
  const config = {};
  for (const [key, name] of Object.entries(REQUIRED)) config[key] = env[name].trim();
  for (const [key, spec] of Object.entries(OPTIONAL)) config[key] = optionalValue(env, spec);
  config.contentApi = config.contentApi.replace(/\/+$/, '');
  config.dashboardApi = config.dashboardApi.replace(/\/+$/, '');
  const problems = CHECKS.filter(([holds]) => !holds(config)).map(([, message]) => message);
  if (problems.length) throw new Error(`runtime adapter: ${problems.join('; ')}`);
  return config;
}
