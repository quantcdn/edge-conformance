# @quantcdn/edge-conformance

Conformance vectors for the Quant edge: rule matching, static serving, edge functions, inline functions and project settings. Any implementation of that behaviour can run them through an adapter. Two implementations use them:

- `quant serve` (in [`@quantcdn/quant-cli`](https://www.npmjs.com/package/@quantcdn/quant-cli)), the local edge, through an in-process adapter.
- The Quant edge itself, through the runtime adapter in [`adapters/runtime/`](adapters/runtime/README.md). It deploys each case to a Quant project made for the test through the public API, and sends the request to that project's domain.

When both pass the same cases, a site behaves the same on a developer's machine and in production.

The vectors hold behaviour that a client can observe in a response. Each case comes from the [Quant documentation](https://docs.quantcdn.io) (page rules, auth middleware, content filters, edge functions, inline functions, custom headers and basic authentication), the code-managed rules manifest (`quant/edge-rules.json`) or the behaviour that a client observes on the production edge. A case that the runtime run has not checked has the `unverified` tag. KV and ledger behaviour is in a separate suite, [`@quantcdn/kv-ledger-conformance`](https://github.com/quantcdn/kv-ledger-conformance).

## Run the suite

Node.js 20 or later. The package has no dependencies.

```sh
npm install --save-dev @quantcdn/edge-conformance
npx edge-conformance --adapter ./my-adapter.mjs
npx edge-conformance --adapter ./my-adapter.mjs --tags rules,static
npx edge-conformance --adapter ./my-adapter.mjs --json
```

The command exits `0` when no case fails, `1` when a case fails and `2` for a usage error.

From code:

```js
import { run } from '@quantcdn/edge-conformance';
import { createAdapter } from './my-adapter.mjs';

const result = await run({ adapter: createAdapter(), tags: ['functions'] });
// { passed, failed, skipped, cases: [{ id, op, tags, file, status, failures }] }
```

`loadCases()`, `selectCases()` and `checkResult()` are exported too, so a test framework can give each case its own test.

## Adapters

An adapter module exports `createAdapter()` (named or default). The adapter implements some or all of four operations and lists them in `capabilities.ops`. The runner skips the cases for an operation that the adapter does not list. The types are in [`src/adapter.d.ts`](src/adapter.d.ts).

| Operation | Arguments | Answer |
|---|---|---|
| `matchRule` | `(rules, functions, request)` | `{ ruleId }`: the id of the first enabled function or auth rule that matches, or `null` |
| `serveStatic` | `(files, request)` | `{ status, headers, bodyText }` from the static files only |
| `runFunction` | `({ uuid, type, body, request, response? })` | `{ status, headers, bodyText }` for one function on every path |
| `serveSite` | `({ files, functions, rules, meta, project, request })` | `{ status, headers, bodyText }` for a whole site |

- `rules` is a manifest in the `quant/edge-rules.json` format (`version`, `namespace`, `rules`).
- `functions` is a list of `{ uuid, id, type, body }`. `type` is `function`, `auth` or `filter`, and `body` is the function source.
- `files` maps a path relative to the site root (for example `about/index.html`) to its content.
- `meta` (optional) is the `quant/meta.json` document of the site. The vectors use `project_settings.enable_inline_fn`: `true` turns inline functions on.
- `project` (optional) holds the project settings that are set in the dashboard, not in the site files. An adapter for a local implementation writes them to its local settings file.
- `request` is `{ method, url, headers?, body? }`. The `url` is absolute, and its host is the request host.
- For a `filter`, `response` is the response that the filter gets: `{ status, headers, body }`.
- `headers` in an answer is an object. A header with more than one value (`set-cookie`) can be a list.

The `project` input has these fields. Each one is optional.

| Field | Value | Default |
|---|---|---|
| `globalHeaders` | Project-wide response headers: `{ "header-name": "value" }` | No headers |
| `basicAuth` | `{ "username": "...", "password": "..." }`, both non-empty: basic authentication for every path | Off |
| `trailingSlash` | `"redirect"`: a path that ends with `/` gets a 301 to the path without it. `"none"`: no redirect | `"none"` |

The runner checks each case input against its operation. A case with an unknown input field, or a `meta` or `project` input with the wrong shape, fails without a call to the adapter.

An adapter can set `capabilities.excludeTags` to skip the cases with those tags. An adapter without inline functions or project settings sets `capabilities.excludeTags: ['inline', 'project']`. `dispose()`, when present, runs after the last case.

## Vectors

The cases are JSON files in `vectors/<suite>/`. Each file holds `{ "cases": [...] }`, and each case has this shape:

```json
{
  "id": "rules-wildcard-needs-a-character",
  "description": "A * matches one or more characters, so /blog/* does not match /blog/.",
  "tags": ["rules"],
  "op": "matchRule",
  "input": { "rules": { "version": 1, "namespace": "conformance", "rules": [] }, "functions": [], "request": { "method": "GET", "url": "https://www.example.com/blog/" } },
  "expect": { "ruleId": null }
}
```

A response expectation can have:

- `status`: the exact status.
- `headers`: for each header, the exact text, `null` (the header is absent), a list (the values in order), or one of `{ "present": true }`, `{ "startsWith": "..." }` and `{ "includes": "..." }`.
- `bodyText` (exact), `bodyIncludes` and `bodyExcludes` (substrings), `bodyJson` (the body is JSON that contains these values).

A case checks only what it states. The cases do not check the headers that only one implementation adds, for example the local `cache-control: no-store` on static files in `quant serve`.

### Tags

| Tag | Meaning |
|---|---|
| `rules` | Rule matching and the request pipeline: patterns, domains, methods, weight, auth middleware |
| `static` | Static paths, index files, the `/_quant404` page, content types, HEAD and byte ranges |
| `functions` | The edge function contract: the `event` object, globals, responses, errors and content filters |
| `inline` | Inline functions: `{{QUANT_FN:uuid}}` tokens in static HTML pages, the function request, and the page headers |
| `project` | Project settings: project-wide headers, basic authentication and the trailing-slash redirect |
| `unverified` | The runtime run has not checked the expected value yet |

Each case has exactly one suite tag. The runtime adapter run checks each `unverified` case. If the case passes, the tag is removed. If the case fails, the case, the documentation or the implementation is fixed so that all three agree.

A case is never weakened only to make an implementation pass.

### What is not in the vectors

The suite does not cover production security protections or time, memory and capacity limits. A site does not depend on them, and a local implementation does not copy them.

## Contribute a case

1. Find the behaviour in the public documentation, or confirm it against the production edge.
2. Add the case to the file for its suite in `vectors/`. Use `www.example.com` for hosts and documentation addresses (for example `203.0.113.9`) for IP addresses.
3. Add the `unverified` tag when the runtime run has not checked the expected value yet.
4. Run `npm test`. The tests check the case shape, the tags and the case counts.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
