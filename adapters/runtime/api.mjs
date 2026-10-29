// The public Quant API calls of the runtime adapter. They are the calls that
// quant-cli makes (`quant deploy`, `quant functions`, `quant rules`,
// `quant delete`) and the documented dashboard API (/api/v2) for project
// settings, project-wide headers and purge.
//
// No token is ever put in an error message or a log line.

const HTML = /\.html?$/i;
const MESSAGE_MAX = 300;

const MIME = {
  css: 'text/css', js: 'application/javascript', mjs: 'application/javascript', json: 'application/json',
  svg: 'image/svg+xml', txt: 'text/plain', xml: 'application/xml', htm: 'text/html', html: 'text/html'
};

/** The content type for an upload, from the file extension. */
export function mimeType(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * The URL of a site file on Quant, as `quant deploy` gives it: an HTML file
 * loses index.html and the trailing slash and is in lower case; another file
 * keeps its path.
 */
export function contentUrl(name) {
  const path = `/${name.replace(/^\/+/, '')}`;
  if (!HTML.test(name)) return path;
  const url = path.toLowerCase().replace(/(\/)index\.html?$/, '$1');
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Put [redacted] in place of each secret, and shorten the text. */
export function redact(text, secrets) {
  const clean = secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), String(text ?? ''));
  return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX)}...` : clean;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bodyMessage(body, text) {
  if (!body || typeof body !== 'object') return text;
  if (Array.isArray(body.errors)) return body.errors.map((item) => item.errorMsg || item.message || JSON.stringify(item)).join('; ');
  return body.errorMsg || body.message || body.msg || body.error || text;
}

const MD5_MATCH = /MD5 already matches|already has md5/i;

/** True when the content API refused an upload only because the content is already there. */
export function isUnchanged(text) {
  return MD5_MATCH.test(text);
}

function contentFailed(status, body) {
  if (status < 200 || status >= 300) return true;
  if (!body || typeof body !== 'object') return false;
  return Boolean(body.error) || (typeof body.errorMsg === 'string' && body.errorMsg.length > 0) || Array.isArray(body.errors);
}

/**
 * The outcome of an API answer: { ok: true, body } or { ok: false, error }.
 * The error message names the step and the HTTP status, never a token.
 */
export function apiOutcome(step, status, text, secrets) {
  const body = parseJson(text);
  if (!contentFailed(status, body) || isUnchanged(text)) return { ok: true, body };
  const detail = redact(bodyMessage(body, text), secrets);
  return { ok: false, error: new Error(`${step} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`) };
}

/**
 * The API client.
 * config: { organization, project, contentApi, contentToken, dashboardApi, dashboardToken }
 */
export function createApi(config, fetchFn = globalThis.fetch) {
  const secrets = [config.contentToken, config.dashboardToken];
  const contentHeaders = {
    'Quant-Customer': config.organization,
    'Quant-Organisation': config.organization,
    'Quant-Project': config.project,
    'Quant-Token': config.contentToken
  };
  const projectBase = `${config.dashboardApi}/organizations/${encodeURIComponent(config.organization)}/projects/${encodeURIComponent(config.project)}`;

  async function call(step, url, init) {
    let res;
    try {
      res = await fetchFn(url, { ...init, redirect: 'manual' });
    } catch (err) {
      throw new Error(`${step} failed: ${redact(err && err.message, secrets)}`);
    }
    const outcome = apiOutcome(step, res.status, await res.text().catch(() => ''), secrets);
    if (!outcome.ok) throw outcome.error;
    return outcome.body;
  }

  const content = (step, path, init) => call(step, `${config.contentApi}${path}`, { ...init, headers: { ...contentHeaders, ...init.headers } });
  const dashboard = (step, path, method, body) => call(step, `${projectBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.dashboardToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  function uploadHtml(name, text) {
    const body = JSON.stringify({ url: contentUrl(name), content: text, published: true, find_attachments: false });
    return content(`upload ${name}`, '', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  }

  function uploadFile(name, text) {
    const form = new FormData();
    form.append('data', new Blob([text], { type: mimeType(name) }), name.slice(name.lastIndexOf('/') + 1));
    return content(`upload ${name}`, '', { method: 'POST', headers: { 'Quant-File-Url': contentUrl(name) }, body: form });
  }

  return {
    upload: (name, text) => (HTML.test(name) ? uploadHtml(name, text) : uploadFile(name, text)),
    remove: (name) => content(`delete ${name}`, '/delete/all', { method: 'DELETE', headers: { 'Quant-Url': contentUrl(name) } }),
    async listContent() {
      const urls = [];
      for (let page = 1, pages = 1; page <= pages; page += 1) {
        const body = await content('list content', `/global-meta?page_size=500&published=true&deleted=false&page=${page}`, { method: 'GET', headers: {} });
        const meta = body && body.global_meta;
        if (!meta) break;
        pages = meta.total_pages || 1;
        for (const record of meta.records || []) urls.push(record.meta.url);
      }
      return urls;
    },
    deployFunction(fn) {
      const path = { function: '/functions', auth: '/functions/auth', filter: '/functions/filter' }[fn.type];
      const body = JSON.stringify({ uuid: fn.uuid, content: fn.body, published: true, desc: `edge-conformance ${fn.type}` });
      return content(`deploy ${fn.type} function ${fn.uuid}`, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    },
    patchProject: (patch) => dashboard('update project settings', '', 'PATCH', patch),
    listHeaders: async () => (await dashboard('list project-wide headers', '/custom-headers', 'GET')) || {},
    setHeaders: (headers) => dashboard('set project-wide headers', '/custom-headers', 'POST', { headers }),
    deleteHeaders: (names) => dashboard('delete project-wide headers', '/custom-headers', 'DELETE', { headers: Object.fromEntries(names.map((name) => [name, ''])) }),
    deployRules: (manifest) => dashboard('deploy rules', '/rules/deploy', 'POST', manifest),
    purgeAll: () => dashboard('purge', '/purge', 'POST', { urls: ['/*'], soft: false })
  };
}

const ACK_STATUSES = ['created', 'updated', 'unchanged', 'forced'];

/** True when a rules deploy answer acknowledges each rule of the manifest, in order. */
export function rulesAcknowledged(manifest, body) {
  const rules = body && Array.isArray(body.rules) ? body.rules : null;
  if (!rules || body.namespace !== manifest.namespace || rules.length !== manifest.rules.length) return false;
  return rules.every((rule, i) => rule.id === manifest.rules[i].id && ACK_STATUSES.includes(rule.status));
}
