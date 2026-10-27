#!/usr/bin/env node
/**
 * edge-conformance --adapter <module> [--tags rules,static,functions] [--json]
 * The adapter module exports createAdapter() (named or default).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from './index.js';

const USAGE = 'Usage: edge-conformance --adapter <module> [--tags rules,static,functions] [--json]';

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      adapter: { type: 'string' },
      tags: { type: 'string' },
      json: { type: 'boolean', default: false }
    }
  });
  return values;
}

async function loadAdapter(file) {
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const create = mod.createAdapter || mod.default;
  if (typeof create !== 'function') throw new Error(`${file} does not export createAdapter()`);
  return create();
}

function printText(result) {
  for (const item of result.cases) {
    if (item.status === 'failed') {
      console.log(`FAIL ${item.id} (${item.file})`);
      for (const failure of item.failures) console.log(`  ${failure}`);
    } else if (item.status === 'skipped') {
      console.log(`SKIP ${item.id}: ${item.reason}`);
    }
  }
  console.log(`passed ${result.passed}, failed ${result.failed}, skipped ${result.skipped}`);
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (!options.adapter) {
    console.error(USAGE);
    return 2;
  }
  const tags = options.tags ? options.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined;
  const result = await run({ adapter: await loadAdapter(options.adapter), tags });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  return result.failed > 0 ? 1 : 0;
}

process.exitCode = await main();
