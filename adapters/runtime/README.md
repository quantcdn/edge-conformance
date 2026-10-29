# Runtime adapter

The runtime adapter runs the vectors against the production Quant edge. The first part of this file states what it must do, so that its author and its reviewer have the same contract. The second part, [Use the adapter](#use-the-adapter), tells how to run it.

The adapter follows the interface in [`src/adapter.d.ts`](../../src/adapter.d.ts) and the README. It must use only public interfaces: a Quant project made for the test, the public deploy path for files, functions and the code-managed rules manifest (`quant/edge-functions.json` and `quant/edge-rules.json`), and ordinary HTTPS requests to the project's domain. It must not use private endpoints, private headers or knowledge of how the edge is built, and it must contain no credentials. Credentials come from the environment of the person who runs it and are never printed.

## Operations

The adapter must implement all four operations and list them in `capabilities.ops`.

### `serveSite({ files, functions, rules, meta, project, request })`

1. Deploy `files` as the site content (each key is a path relative to the site root).
2. Deploy `functions` with the given `uuid`, `type` and `body`, and `rules` as the code-managed rules manifest.
3. Set the project settings of the test project through the public dashboard API: "Enable Inline Functions" when `meta.project_settings.enable_inline_fn` is `true`, and the custom headers, basic authentication and trailing-slash behaviour from `project`. Reset each setting that the case does not give to its default (off, no headers, no redirect).
4. Send `request` to the project's domain: the method, the path and query of `request.url`, the headers and the body. Do not follow redirects.
5. Answer `{ status, headers, bodyText }`. Give `set-cookie` as a list when the response has more than one.

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

## Use the adapter

The adapter is [`index.mjs`](index.mjs). It changes the content, the settings and the rules of the project that you give it. Use a project that you make for this test only.

### What you need

1. A Quant project made for the test, with no content. The adapter refuses to start when the project has content at a path that is not a vector file.
2. A domain of that project: its preview domain, or a domain that you attached to it. The rule cases that match on a domain need the domain to reach this project.
3. The project write token (the `QUANT_TOKEN` of `quant deploy`).
4. A dashboard API token with the scopes `projects:read`, `projects:write`, `rules:read` and `rules:write` (the `QUANT_API_TOKEN` of `quant rules`).

### Environment variables

The adapter reads its target and its credentials from these variables only. It never prints a token: an error names the step and the HTTP status.

| Variable | Value |
|---|---|
| `EDGE_CONFORMANCE_DOMAIN` | The host name of the test project, for example `conformance.example.net`. No scheme, port or path |
| `EDGE_CONFORMANCE_ORGANIZATION` | The organisation machine name |
| `EDGE_CONFORMANCE_PROJECT` | The project machine name |
| `EDGE_CONFORMANCE_CONFIRM_PROJECT` | The project machine name again. It confirms that the adapter can replace the content, settings and rules of that project |
| `EDGE_CONFORMANCE_CONTENT_API` | The content API, for example `https://api.quantcdn.io/v1` (QuantGov: `https://api.quantgov.cloud/v1`) |
| `EDGE_CONFORMANCE_CONTENT_TOKEN` | The project write token |
| `EDGE_CONFORMANCE_DASHBOARD_API` | The dashboard API, ending in `/api/v2`, for example `https://dashboard.quantcdn.io/api/v2` (QuantGov: `https://dash.quantgov.cloud/api/v2`) |
| `EDGE_CONFORMANCE_DASHBOARD_TOKEN` | The dashboard API token |
| `EDGE_CONFORMANCE_NAMESPACE` | Optional. The rules manifest namespace. Default `edge-conformance` |
| `EDGE_CONFORMANCE_READY_TIMEOUT_MS` | Optional. The longest wait for the edge to show a deployment. Default `600000` |
| `EDGE_CONFORMANCE_POLL_MS` | Optional. The time between two probe rounds. Default `5000` |
| `EDGE_CONFORMANCE_SETTLE_MS` | Optional. The wait after the probes pass, for the purge to finish. Default `5000` |
| `EDGE_CONFORMANCE_BLIND_WAIT_MS` | Optional. The wait for a change that no probe can show (see below). Default `120000` |

### Dry run

The dry run sends no request and needs no variable. It prints, for each case, the operations, the probes and the request of a live run:

```sh
node adapters/runtime/dry-run.mjs --tags unverified --verbose
```

### Live run

1. Set the variables.
2. Run the cases:

   ```sh
   npx edge-conformance --adapter adapters/runtime/index.mjs --tags unverified
   npx edge-conformance --adapter adapters/runtime/index.mjs --json > runtime-result.json
   ```

3. Read the progress lines on standard error (`deploy N: ...`, `ready after N s`).

A full run makes about 115 deploys for 153 cases. Each deploy waits until the edge shows it, so a full run can take some hours.

### What a live run does

At the start, the adapter:

1. Lists the published content of the project. If a path is not a vector file or a probe page, the adapter stops and every case fails with that message.
2. Reads the project-wide headers.

For each case, the adapter:

1. Builds the site of the case. `runFunction` and `matchRule` get the functions and rules that this contract gives above.
2. Maps the names to the test project:
   - Each UUID in a case (function, rule, inline token) becomes a version 5 UUID made from the organisation, the project and the case UUID. A run never writes a function with a UUID that another project can own, and the same case UUID always gives the same function.
   - The request host becomes the test domain. The request goes to the test domain over HTTPS. The `Host` header keeps the port of the case URL.
   - A rule domain that is the request host becomes the test domain, in capitals if the case domain has a capital. A parent domain of the request host becomes the parent domain of the test domain. Another host becomes a name under `.invalid`, which no request has.
   - Rule ids become slot ids (`function-0` to `filter-2`), because the manifest keeps each rule id. A disabled slot points at a placeholder function of its type.
3. Writes only what changed since the case before, in this order:
   1. Functions: `POST {content API}/functions`, `/functions/auth` or `/functions/filter` (as `quant functions`).
   2. The canary function, with a new version, when a function or the rules changed.
   3. Files: an HTML file as `quant deploy` sends it (`POST {content API}` with a JSON body), another file as multipart with `Quant-File-Url`. A file of the case before that this case does not have: `DELETE {content API}/delete/all`.
   4. Project settings: `PATCH {dashboard API}/organizations/{org}/projects/{project}` with `enable_inline_fn`, `trailing_slash_redirect`, `basic_auth_username` and `basic_auth_password` (empty values turn basic authentication off).
   5. Project-wide headers: `POST` or `DELETE {dashboard API}/.../custom-headers`.
   6. The rules manifest: `POST {dashboard API}/.../rules/deploy` (as `quant rules`). The manifest has the canary rule (`/__edge-conformance/ready`, weight -100000) and every slot.
   7. A purge of the project: `POST {dashboard API}/.../purge` with `{"urls": ["/*"], "soft": false}`.
4. Sends probe requests until the edge shows the deployment. Each probe path is under `/__edge-conformance/` and has a new query string:
   - `canary`: the canary function answers the new version, with each project-wide header and without the removed ones.
   - `basic-auth`: the canary answers 401 without credentials only when basic authentication is on.
   - `inline`: the probe page has its token replaced only when inline functions are on.
   - `trailing-slash`: `/__edge-conformance/slash/` gets a 301 only when the redirect is on.

   When a case rule can answer a probe path (for example a function rule on `/*`), the adapter does not send that probe. If the case changed what that probe shows, the adapter waits `EDGE_CONFORMANCE_BLIND_WAIT_MS` instead.
5. Waits `EDGE_CONFORMANCE_SETTLE_MS`, sends the case request (redirects are not followed) and maps the test domain and the derived UUIDs in the answer back to the case names.

When an operation fails, the case fails with the step and the HTTP status, and the next case writes everything again.

At the end (`dispose()`), the adapter deletes the files that it wrote, turns off inline functions, basic authentication and the trailing-slash redirect, deletes the project-wide headers, deploys the manifest with every rule disabled, and purges the project. If a cleanup step fails, the adapter prints the step and continues.

### What stays after a run

- The functions. The public API has no call that deletes a function. They are about 25 functions with derived UUIDs, and the next run on the same project updates the same functions.
- The disabled rules of the namespace. A manifest deploy does not delete a rule.

### Limits

- A case whose request host has a port (`rules-domain-ignores-the-port`) is sent to port 443 with the port in the `Host` header only.
- Every request uses HTTPS, also for a case URL with `http:`.
- The adapter uses only rules of its own namespace. A rule that another tool made on the test project can change the answers. Use a project without other rules.
