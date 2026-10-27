# Runtime adapter

The runtime adapter runs the vectors against the production Quant edge. It is not written yet. This file states what it must do, so that its author and its reviewer have the same contract.

The adapter follows the interface in [`src/adapter.d.ts`](../../src/adapter.d.ts) and the README. It must use only public interfaces: a Quant project made for the test, the public deploy path for files, functions and the code-managed rules manifest (`quant/edge-functions.json` and `quant/edge-rules.json`), and ordinary HTTPS requests to the project's domain. It must not use private endpoints, private headers or knowledge of how the edge is built, and it must contain no credentials. Credentials come from the environment of the person who runs it and are never printed.

## Operations

The adapter must implement all four operations and list them in `capabilities.ops`.

### `serveSite({ files, functions, rules, request })`

1. Deploy `files` as the site content (each key is a path relative to the site root).
2. Deploy `functions` with the given `uuid`, `type` and `body`, and `rules` as the code-managed rules manifest.
3. Send `request` to the project's domain: the method, the path and query of `request.url`, the headers and the body. Do not follow redirects.
4. Answer `{ status, headers, bodyText }`. Give `set-cookie` as a list when the response has more than one.

The request host in a vector is `www.example.com` (or another `example.com` name). The adapter maps it to the test domain. A case that matches on the domain needs that domain to be attached to the test project, or the adapter must list the case as skipped and say why.

### `serveStatic(files, request)`

The same as `serveSite` with no functions and no rules.

### `runFunction({ uuid, type, body, request, response })`

Deploy one function and one rule of its `type` with the URL patterns `/` and `/*`, then send the request.

- `function` and `auth`: the answer is the response to the request.
- `filter`: also deploy a function rule on `/` and `/*` whose function returns `response` (its status, headers and body). The filter rule then runs over that response.

### `matchRule(rules, functions, request)`

Deploy each function or auth rule with a function that identifies the rule:

- A function rule answers 200 with the rule id as the body.
- An auth rule answers 401 with the rule id as the body.

Filter rules are deployed as given, with a filter that does not change the response. Send the request and answer `{ ruleId }`: the body of a 200 or 401 answer from one of these functions, or `null` when the request reached static content or the 404 page.

## Speed and isolation

A deploy for each case is slow. The adapter can group cases that use the same files, functions and rules, and it must purge or version the content so that one case never sees the content of another case.

## Review

The runtime owner reviews this adapter and the result of its first run. For each failed case, the result says whether the documentation, the case or the implementation is wrong. Each case tagged `unverified` that passes in production loses the tag.
