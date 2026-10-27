import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, selectCases, checkResult, run, OPS, SUITE_TAGS, TAGS } from '../src/index.js';
import { createAdapter as createOracle } from './oracle-adapter.mjs';

const cases = await loadCases();

describe('vectors', () => {
  test('every case has a unique id', () => {
    const ids = cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every case has a known op, input and expect', () => {
    for (const c of cases) {
      assert.ok(Object.keys(OPS).includes(c.op), `${c.id}: op ${c.op}`);
      assert.equal(typeof c.input, 'object', `${c.id}: input`);
      assert.equal(typeof c.expect, 'object', `${c.id}: expect`);
      assert.equal(typeof c.description, 'string', `${c.id}: description`);
    }
  });

  test('every case has one suite tag that matches its directory, and only known tags', () => {
    for (const c of cases) {
      const suites = c.tags.filter((tag) => SUITE_TAGS.includes(tag));
      assert.deepEqual(suites, [c.suite], `${c.id}: suite tags`);
      for (const tag of c.tags) assert.ok(TAGS.includes(tag), `${c.id}: tag ${tag}`);
    }
  });

  test('each suite has at least 15 cases', () => {
    for (const suite of SUITE_TAGS) {
      const count = cases.filter((c) => c.tags.includes(suite)).length;
      assert.ok(count >= 15, `${suite}: ${count} cases`);
    }
  });

  test('a matchRule case expects only a rule id', () => {
    for (const c of cases.filter((item) => item.op === 'matchRule')) {
      assert.deepEqual(Object.keys(c.expect), ['ruleId'], c.id);
    }
  });

  test('a response case expects a status', () => {
    for (const c of cases.filter((item) => item.op !== 'matchRule')) {
      assert.equal(typeof c.expect.status, 'number', c.id);
    }
  });
});

describe('selectCases', () => {
  test('keeps the cases that have any of the tags', () => {
    const picked = selectCases(cases, ['static']);
    assert.ok(picked.length > 0);
    assert.ok(picked.every((c) => c.tags.includes('static')));
  });

  test('keeps every case when no tags are given', () => {
    assert.equal(selectCases(cases).length, cases.length);
  });
});

describe('checkResult', () => {
  const response = {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'set-cookie': ['a=1', 'b=2'], 'x-one': '1' },
    bodyText: '{"a":1,"b":{"c":2,"d":3}}'
  };

  test('passes a matching rule id, including null', () => {
    assert.deepEqual(checkResult({ ruleId: 'api' }, { ruleId: 'api' }), []);
    assert.deepEqual(checkResult({ ruleId: null }, { ruleId: null }), []);
  });

  test('fails a different rule id', () => {
    assert.equal(checkResult({ ruleId: 'api' }, { ruleId: null }).length, 1);
  });

  test('compares status, header names without case, and exact header values', () => {
    assert.deepEqual(checkResult({ status: 200, headers: { 'x-one': '1' } }, response), []);
    assert.equal(checkResult({ status: 404 }, response).length, 1);
    assert.equal(checkResult({ status: 200, headers: { 'x-one': '2' } }, response).length, 1);
  });

  test('supports absent, present, startsWith and includes header matchers', () => {
    assert.deepEqual(checkResult({ status: 200, headers: {
      'x-missing': null,
      'x-one': { present: true },
      'content-type': { startsWith: 'text/html' }
    } }, response), []);
    assert.deepEqual(checkResult({ status: 200, headers: { 'content-type': { includes: 'charset' } } }, response), []);
    assert.equal(checkResult({ status: 200, headers: { 'x-one': null } }, response).length, 1);
    assert.equal(checkResult({ status: 200, headers: { 'x-missing': { present: true } } }, response).length, 1);
    assert.equal(checkResult({ status: 200, headers: { 'content-type': { startsWith: 'text/css' } } }, response).length, 1);
  });

  test('compares a list of header values in order', () => {
    assert.deepEqual(checkResult({ status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] } }, response), []);
    assert.equal(checkResult({ status: 200, headers: { 'set-cookie': ['b=2'] } }, response).length, 1);
    const single = { ...response, headers: { 'set-cookie': 'a=1' } };
    assert.deepEqual(checkResult({ status: 200, headers: { 'set-cookie': ['a=1'] } }, single), []);
  });

  test('compares the body as text, as substrings and as a JSON subset', () => {
    assert.deepEqual(checkResult({ status: 200, bodyText: response.bodyText }, response), []);
    assert.equal(checkResult({ status: 200, bodyText: 'x' }, response).length, 1);
    assert.deepEqual(checkResult({ status: 200, bodyIncludes: ['"a":1'], bodyExcludes: ['zzz'] }, response), []);
    assert.equal(checkResult({ status: 200, bodyIncludes: ['zzz'] }, response).length, 1);
    assert.equal(checkResult({ status: 200, bodyExcludes: ['"a"'] }, response).length, 1);
    assert.deepEqual(checkResult({ status: 200, bodyJson: { b: { c: 2 } } }, response), []);
    assert.equal(checkResult({ status: 200, bodyJson: { b: { c: 9 } } }, response).length, 1);
    assert.equal(checkResult({ status: 200, bodyJson: { a: 1 } }, { status: 200, bodyText: 'not json' }).length, 1);
  });

  test('treats a missing body as empty text', () => {
    assert.deepEqual(checkResult({ status: 500, bodyText: '' }, { status: 500 }), []);
  });
});

describe('run', () => {
  test('passes every case against an adapter that answers the expected values', async () => {
    const result = await run({ adapter: createOracle() });
    const failures = result.cases.filter((c) => c.status === 'failed');
    assert.deepEqual(failures, []);
    assert.equal(result.passed, cases.length);
    assert.equal(result.skipped, 0);
  });

  test('runs only the selected tags', async () => {
    const result = await run({ adapter: createOracle(), tags: ['rules'] });
    assert.equal(result.cases.length, cases.filter((c) => c.tags.includes('rules')).length);
  });

  test('skips the ops that the adapter does not declare', async () => {
    const oracle = createOracle();
    const adapter = { ...oracle, capabilities: { ops: ['matchRule'] } };
    const result = await run({ adapter });
    const ruleCases = cases.filter((c) => c.op === 'matchRule').length;
    assert.equal(result.passed, ruleCases);
    assert.equal(result.skipped, cases.length - ruleCases);
    assert.equal(result.failed, 0);
  });

  test('skips the tags that the adapter excludes', async () => {
    const oracle = createOracle();
    const adapter = { ...oracle, capabilities: { ...oracle.capabilities, excludeTags: ['unverified'] } };
    const result = await run({ adapter });
    const unverified = cases.filter((c) => c.tags.includes('unverified')).length;
    assert.equal(result.skipped, unverified);
  });

  test('reports a wrong answer and a thrown error as failures, and calls dispose', async () => {
    let disposed = false;
    const adapter = {
      capabilities: { ops: ['matchRule', 'serveStatic'] },
      matchRule: async () => ({ ruleId: 'not-a-rule' }),
      serveStatic: async () => { throw new Error('boom'); },
      dispose: async () => { disposed = true; }
    };
    const result = await run({ adapter, tags: ['rules', 'static'] });
    assert.equal(result.passed, 0);
    assert.ok(result.failed > 0);
    const thrown = result.cases.find((c) => c.op === 'serveStatic');
    assert.match(thrown.failures[0], /boom/);
    assert.equal(disposed, true);
  });

  test('passes each case a copy of its input', async () => {
    const selected = structuredClone(selectCases(cases, ['static']));
    const before = structuredClone(selected);
    const adapter = {
      capabilities: { ops: ['serveStatic'] },
      serveStatic: async (files, request) => {
        for (const key of Object.keys(files)) delete files[key];
        request.url = 'changed';
        return { status: 0, headers: {}, bodyText: '' };
      }
    };
    const result = await run({ adapter, cases: selected });
    assert.equal(result.cases.length, selected.length);
    assert.ok(selected.length > 0);
    assert.deepEqual(selected, before);
  });
});
