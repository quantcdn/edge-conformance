// Requests to the test domain, and the answers of the runtime adapter.
// The request goes over HTTPS to the test domain, with the Host header of the
// deployment (the test domain, with the port of the case URL). Redirects are
// not followed.

import https from 'node:https';

const REQUEST_TIMEOUT_MS = 60000;

function requestHeaders(request) {
  const headers = { ...request.headers, host: request.host };
  if (request.body !== null && request.body !== undefined) headers['content-length'] = String(Buffer.byteLength(request.body));
  return headers;
}

/**
 * Send one request to the edge.
 * request: { method, path, host, headers, body }; testDomain: the host to connect to.
 * Answers { status, headers (lower-case names; set-cookie is a list), body (text) }.
 */
export function sendToEdge(testDomain, request, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: testDomain,
      servername: testDomain,
      port: 443,
      method: request.method,
      path: request.path,
      headers: requestHeaders(request),
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the edge within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', (err) => reject(new Error(`edge request ${request.method} ${request.path} failed: ${err.message}`)));
    req.end(request.body ?? undefined);
  });
}

function answerHeader(value, reverse) {
  if (!Array.isArray(value)) return reverse(String(value));
  const list = value.map((item) => reverse(String(item)));
  return list.length === 1 ? list[0] : list;
}

/**
 * The CaseResponse for an edge answer. `reverse` maps the test names in a text
 * back to the case names. A header with more than one value (set-cookie) is a
 * list; with one value it is a string.
 */
export function toCaseResponse(raw, reverse = (text) => text) {
  const headers = {};
  for (const [name, value] of Object.entries(raw.headers || {})) {
    if (value !== undefined) headers[name.toLowerCase()] = answerHeader(value, reverse);
  }
  return { status: raw.status, headers, bodyText: reverse(raw.body ?? '') };
}

/**
 * The matchRule answer for an edge answer: the rule id that an identity
 * function answered (200 for a function rule, 401 for an auth rule), or null.
 */
export function toRuleId(raw, ruleIds) {
  if (raw.status !== 200 && raw.status !== 401) return { ruleId: null };
  const body = (raw.body ?? '').trim();
  return { ruleId: ruleIds.includes(body) ? body : null };
}
