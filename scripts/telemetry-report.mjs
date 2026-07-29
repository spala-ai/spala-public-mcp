#!/usr/bin/env node
// Aggregate public-MCP telemetry NDJSON files into a funnel report.
// Usage: node scripts/telemetry-report.mjs [--dir <state-dir>] [--since <ISO timestamp>]
// Default state dir matches the TELEMETRY_STATE_PATH default (.state/telemetry).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregateTelemetryLines } from '../dist/telemetry.js';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const directory = resolve(argValue('--dir') ?? '.state/telemetry');
const since = argValue('--since');

let files;
try {
  files = readdirSync(directory).filter(name => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
} catch {
  console.error(`No telemetry directory at ${directory}. Set --dir or TELEMETRY_STATE_PATH.`);
  process.exit(1);
}

const lines = files.flatMap(name => readFileSync(join(directory, name), 'utf8').split('\n'));
const aggregate = aggregateTelemetryLines(lines, since);

function section(title, bucket) {
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return;
  console.log(`\n${title}`);
  for (const [key, count] of entries) console.log(`  ${String(count).padStart(6)}  ${key}`);
}

console.log(`Telemetry report — ${directory}`);
console.log(`Files: ${files.length}  Events: ${aggregate.total}` + (since ? `  (since ${since})` : ''));
if (aggregate.firstTs) console.log(`Range: ${aggregate.firstTs} → ${aggregate.lastTs}`);

const FUNNEL = [
  'manifest_fetch',
  'mcp_auth_challenge',
  'oauth_register',
  'oauth_authorize_redirect',
  'oauth_approval',
  'oauth_token',
  'spala_start',
  'project_create',
  'project_connect',
];
console.log('\nFunnel');
for (const step of FUNNEL) console.log(`  ${String(aggregate.events[step] ?? 0).padStart(6)}  ${step}`);

section('Outcomes', aggregate.outcomes);
section('spala_start phases', aggregate.phases);
section('Install clients', aggregate.clients);
section('Failure codes', aggregate.failureCodes);
