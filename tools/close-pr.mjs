#!/usr/bin/env node
/**
 * Close a pull request (and optionally delete its head branch).
 *
 * Run this in YOUR OWN terminal so the PAT never enters a DSH conversation or
 * the session log. The token is read from the environment only; it is never
 * written to disk and never printed.
 *
 * Usage (Node sets nothing; you supply the token in the environment):
 *   $env:SELF_IMPROVING_AGENT_GITHUB_TOKEN = (Read-Host -AsSecureString ...)   # or your secret store
 *   node close-pr.mjs --pr 1 [--delete-branch]
 *
 * Env:
 *   SELF_IMPROVING_AGENT_REPO           "owner/name" (required)
 *   SELF_IMPROVING_AGENT_GITHUB_TOKEN   PAT with Pull requests:rw (+ Contents:rw to delete a branch)
 *
 * Exit codes: 0 ok, 1 failure.
 */

import { resolve } from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[argv[i].slice(2)] = true;
      else flags[argv[i].slice(2)] = (i++, next);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const repo = process.env.SELF_IMPROVING_AGENT_REPO;
const token = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN;
const pr = flags.pr;

if (!repo || !/^[^/\s]+\/[^/\s]+$/u.test(repo)) {
  console.error('error: set SELF_IMPROVING_AGENT_REPO=owner/name');
  process.exit(1);
}
if (!token) {
  console.error('error: SELF_IMPROVING_AGENT_GITHUB_TOKEN is not set');
  process.exit(1);
}
if (!pr || pr === true) {
  console.error('error: --pr <number> is required');
  process.exit(1);
}

const api = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'dsh-self-improvement-bridge',
};

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// 1. Read the PR so we can report its state and learn the head branch.
let pull;
try {
  const res = await fetch(`${api}/repos/${repo}/pulls/${pr}`, { headers });
  if (res.status === 404) fail(`pull request #${pr} not found in ${repo}`);
  if (!res.ok) fail(`GET pull failed: ${res.status} ${res.statusText}`);
  pull = await res.json();
} catch (error) {
  fail(`could not reach GitHub: ${error.message}`);
}

console.log(`PR #${pull.number}: ${pull.title}`);
console.log(`  state        : ${pull.state}`);
console.log(`  draft        : ${pull.draft}`);
console.log(`  merged       : ${pull.merged}`);
console.log(`  head branch  : ${pull.head?.ref}`);
console.log(`  url          : ${pull.html_url}`);

if (pull.state === 'closed') {
  console.log('');
  console.log('already closed; nothing to do');
} else if (pull.merged) {
  console.log('');
  console.log('already merged; refusing to close (would be misleading)');
} else {
  // 2. Close it by setting state=closed.
  const res = await fetch(`${api}/repos/${repo}/pulls/${pr}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!res.ok) fail(`PATCH close failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  const closed = await res.json();
  console.log('');
  console.log(`CLOSED: state is now "${closed.state}"`);
}

// 3. Optionally delete the head branch. Only for branches inside this repo.
if (flags['delete-branch']) {
  const headRef = pull.head?.ref;
  const headRepo = pull.head?.repo?.full_name;
  if (!headRef) {
    console.log('branch not deleted: the PR does not report a head branch');
  } else if (headRepo !== repo) {
    // Forked head, or an unexpected shape: do not touch a branch we do not own.
    console.log(`branch not deleted: head branch lives in "${headRepo ?? 'unknown'}", not in ${repo}`);
  } else {
    const res = await fetch(`${api}/repos/${repo}/git/refs/heads/${encodeURIComponent(headRef)}`, {
      method: 'DELETE',
      headers,
    });
    if (res.status === 204) console.log(`branch deleted: ${headRef}`);
    else if (res.status === 422 || res.status === 404) console.log(`branch not deleted (already gone or protected): ${headRef}`);
    else console.log(`branch delete returned ${res.status}; leaving ${headRef} in place`);
  }
}
