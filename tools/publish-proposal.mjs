#!/usr/bin/env node
/**
 * Publish one self-improvement proposal, taking the find/replace texts from
 * FILES rather than command-line arguments.
 *
 * Why: multi-line CJK snippets cannot be passed reliably through Windows shells
 * (PowerShell 5.1 mis-terminates single-quoted strings containing multi-byte
 * text). Reading from files keeps the text byte-exact.
 *
 * Usage:
 *   node publish-proposal.mjs --file README.md --find find.txt --replace new.txt \
 *        --reason "..." [--risk low|medium|high]
 *
 * Writes the proposal record into the bridge proposal store, marking it
 * `pending`. Touches no remote.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..');
const UPSTREAM = join(WORKSPACE, '.dsh', 'vendor', 'self-improving-agent', 'dist', 'index.js');
const PROPOSALS = join(HERE, 'proposals');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
for (const required of ['file', 'find', 'replace', 'reason']) {
  if (!flags[required]) {
    console.error(`error: --${required} is required`);
    process.exit(1);
  }
}

const repo = process.env.SELF_IMPROVING_AGENT_REPO;
if (!repo) {
  console.error('error: SELF_IMPROVING_AGENT_REPO is not set');
  process.exit(1);
}

if (!existsSync(UPSTREAM)) {
  console.error(`error: upstream build missing at ${UPSTREAM}`);
  process.exit(1);
}

const originalSnippet = readFileSync(flags.find, 'utf8');
const proposedSnippet = readFileSync(flags.replace, 'utf8');

// Reject the mistake the helper exists to prevent: an ambiguous or absent match.
const target = resolve(process.env.SELF_IMPROVING_AGENT_TARGET_FILE ?? '');
let occurrences = null;
if (process.env.SELF_IMPROVING_AGENT_TARGET_FILE) {
  const content = readFileSync(target, 'utf8');
  occurrences = content.split(originalSnippet).length - 1;
  console.log(`pre-check: snippet occurs ${occurrences} time(s) in ${target}`);
  if (occurrences !== 1) {
    console.error('error: snippet must occur exactly once in the target working tree file');
    process.exit(1);
  }
}

const upstream = await import(`file://${UPSTREAM.replace(/\\/gu, '/')}`);
const tools = upstream.feedbackTools({
  repo,
  proposalsDir: PROPOSALS,
  prefetch: false,
});

const result = await tools.writeImprovementProposal.execute({
  file: flags.file,
  originalSnippet,
  proposedSnippet,
  reason: flags.reason,
  risk: flags.risk ?? 'low',
});

// Mark it pending and record the target repo, as the bridge does.
const recordPath = join(PROPOSALS, `${result.proposalId}.json`);
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
record.status = 'pending';
record.target = repo;
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

console.log('');
console.log(`proposalId : ${result.proposalId}`);
console.log(`target repo: ${repo}`);
console.log(`file       : ${flags.file}`);
console.log(`risk       : ${flags.risk ?? 'low'}`);
console.log(`find bytes : ${Buffer.byteLength(originalSnippet)}`);
console.log(`new bytes  : ${Buffer.byteLength(proposedSnippet)}`);
console.log(`saved      : ${recordPath}`);
console.log('');
console.log('NOT applied. Awaiting explicit user approval, then: request -> apply.');
