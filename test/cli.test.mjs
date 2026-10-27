import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const ORACLE = path.join(HERE, 'oracle-adapter.mjs');

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

describe('cli', () => {
  test('exits 0 and prints a summary when every case passes', () => {
    const result = cli('--adapter', ORACLE, '--tags', 'static');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed \d+, failed 0, skipped 0/);
  });

  test('prints the JSON result with --json', () => {
    const result = cli('--adapter', ORACLE, '--tags', 'rules', '--json');
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.failed, 0);
    assert.ok(parsed.cases.every((c) => c.tags.includes('rules')));
  });

  test('exits 1 and names the failed case when an answer is wrong', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-conformance-'));
    const file = path.join(dir, 'wrong.mjs');
    fs.writeFileSync(file, [
      'export function createAdapter() {',
      "  return { capabilities: { ops: ['matchRule'] }, matchRule: async () => ({ ruleId: 'wrong' }) };",
      '}',
      ''
    ].join('\n'));
    try {
      const result = cli('--adapter', file, '--tags', 'rules');
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FAIL rules-wildcard-matches-segment/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exits 2 with usage when --adapter is missing', () => {
    const result = cli();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: edge-conformance --adapter/);
  });
});
