// The name mapping of the runtime adapter.
// A case uses example.com hosts and made-up function UUIDs. On the edge the
// adapter uses the test domain and UUIDs derived from the test project, so a
// run never writes a function that another project could own. Answers are
// mapped back, so that a case sees its own names.

import crypto from 'node:crypto';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const hasUpper = (text) => text !== text.toLowerCase();
// A UUID in capitals stays in capitals. A domain with any capital becomes
// capitals, so that a case about letter case still tests letter case.
const sameCase = (model, text) => (hasUpper(model) && !/[a-z]/.test(model) ? text.toUpperCase() : text);
const domainCase = (model, text) => (hasUpper(model) ? text.toUpperCase() : text);

/**
 * An RFC 4122 version 5 style UUID from a seed and a name (SHA-1, version and
 * variant bits set). The same seed and name always give the same UUID.
 */
export function deriveUuid(seed, name) {
  const bytes = crypto.createHash('sha1').update(`${seed}\u0000${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text, from, to) {
  return text.replace(new RegExp(escapeRegExp(from), 'gi'), to);
}

/**
 * The UUID map of one run. forward() puts derived UUIDs in place of the case
 * UUIDs in a text; reverse() puts the case UUIDs back.
 */
export function createUuidMap(seed) {
  const pairs = new Map();
  const derived = (uuid) => {
    const key = uuid.toLowerCase();
    if (!pairs.has(key)) pairs.set(key, deriveUuid(seed, key));
    return pairs.get(key);
  };
  return {
    uuid: (uuid) => sameCase(uuid, derived(uuid)),
    forward: (text) => text.replace(UUID, (match) => sameCase(match, derived(match))),
    reverse: (text) => [...pairs].reduce((out, [original, mapped]) => replaceAll(out, mapped, original), text)
  };
}

const labels = (host) => host.split('.');

// The parent domain of the test domain with as many labels as `domain`, when
// the test domain has more labels than that.
function parentOf(testDomain, count) {
  const parts = labels(testDomain);
  return parts.length > count ? parts.slice(parts.length - count).join('.') : null;
}

function unmatched(domain) {
  return `${domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')}.unmatched.invalid`;
}

/**
 * The rule domain to deploy for a case rule domain.
 * - `any` stays.
 * - The request host becomes the test domain (letter case kept, so a rule
 *   with capitals still has capitals).
 * - A parent domain of the request host becomes the parent of the test domain
 *   with the same number of labels.
 * - Any other host becomes a name under `.invalid` that no request has.
 */
export function mapRuleDomain(domain, requestHost, testDomain) {
  if (domain.toLowerCase() === 'any') return domain;
  const lower = domain.toLowerCase();
  const host = requestHost.toLowerCase();
  if (lower === host) return domainCase(domain, testDomain);
  const parent = host.endsWith(`.${lower}`) ? parentOf(testDomain, labels(lower).length) : null;
  return parent ? domainCase(domain, parent) : unmatched(domain);
}

/** The Host header for a case request: the test domain, with the port of the case URL. */
export function mapRequestHost(url, testDomain) {
  return url.port ? `${testDomain}:${url.port}` : testDomain;
}

/** A function that maps an answer text back to the names of the case. */
export function reverser(uuids, testDomain, requestHost) {
  return (text) => replaceAll(uuids.reverse(text), testDomain, requestHost);
}
