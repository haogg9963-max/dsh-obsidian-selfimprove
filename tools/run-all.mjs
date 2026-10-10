#!/usr/bin/env node
/**
 * Run the whole self-improvement bring-up in ONE Node process.
 *
 * Why this exists: PowerShell is unusable on this machine for delivered
 * scripts. ExecutionPolicy blocks both direct invocation AND dot-sourcing
 * (so no .ps1 helper can work at all), `pwsh` is absent, and 5.1 mis-parses CJK
 * inside quoted strings. Node sidesteps all three.
 *
 * Entering the PAT once here also removes the token-handoff that caused earlier
 * failures: nothing has to be copied between commands, so a missing token can no
 * longer surface later as an unexplained 401.
 *
 * Steps (each prints its own output):
 *   1. apply   - apply the pending proposal as a draft PR
 *   2. close   - close superseded pull requests
 *   3. seed    - publish the tool sources into the repo
 *
 * Usage:
 *   node run-all.mjs --proposal 0f351de989ea [--close 1] [--steps apply,close,seed]
 *                    [--dry-run] [--show-diff]
 *
 * The PAT is prompted with hidden input, or taken from
 * SELF_IMPROVING_AGENT_GITHUB_TOKEN when already set. It is passed to child
 * steps through the environment only: never an argv, never a file.
 *
 * Exit codes: 0 all requested steps succeeded, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..');
const NODE = process.execPath;

function parseArgs(argv) {
  const flags = { steps: ['apply', 'close', 'seed'], close: [], dryRun: false, showDiff: false, tokenFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--proposal') flags.proposal = argv[++i];
    else if (arg === '--close') flags.close.push(argv[++i]);
    else if (arg === '--steps') flags.steps = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--show-diff') flags.showDiff = true;
    else if (arg === '--token-file') flags.tokenFile = argv[++i];
    else {
      console.error(`error: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return flags;
}

/**
 * Set when the token came from a file on disk, so the file can be removed once
 * the token is in memory instead of lingering there.
 */
let usedTokenFile = false;
let tokenFile = null;

/** Remove the token file if one was used, so a credential never lingers on disk. */
function removeTokenFile() {
  // Only delete a file we actually read the token from: never remove a
  // user-specified path that we did not use.
  if (!usedTokenFile || !tokenFile) return;
  // Clear the flag first so the redundant exit-handler call cannot log again.
  usedTokenFile = false;
  try {
    rmSync(tokenFile, { force: true });
    console.log(`token file removed: ${tokenFile}`);
  } catch (error) {
    console.log(`warning: could not remove ${tokenFile} (${error.message}); delete it manually`);
  }
}

process.on('exit', removeTokenFile);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    removeTokenFile();
    process.exit(130);
  });
}

/** Read one line from the terminal without echoing it. */
function readSecret(prompt) {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('no TTY for hidden input; set SELF_IMPROVING_AGENT_GITHUB_TOKEN instead'));
      return;
    }
    process.stdout.write(prompt);
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (result) => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolvePromise(result);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function verifyToken(token, repo) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-self-improvement-runner',
  };
  try {
    const res = await fetch('https://api.github.com/user', { headers });
    if (res.status === 401) return { ok: false, reason: 'GitHub rejected the token (401 Bad credentials)' };
    if (!res.ok) return { ok: false, reason: `token check returned HTTP ${res.status}` };
    const who = await res.json();

    const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (repoRes.status === 404) return { ok: false, reason: `token is valid as ${who.login} but cannot see ${repo} (404)` };
    if (!repoRes.ok) return { ok: false, reason: `repo check returned HTTP ${repoRes.status}` };

    return { ok: true, login: who.login };
  } catch (error) {
    return { ok: false, reason: `could not reach GitHub: ${error.message}` };
  }
}

/** Run one helper script with inherited stdio and the token in the environment. */
function runStep(label, script, args) {
  const file = join(HERE, script);
  if (!existsSync(file)) {
    console.log(`\n--- ${label}: SKIPPED (missing ${script}) ---`);
    return false;
  }
  console.log(`\n${'='.repeat(66)}`);
  console.log(`--- ${label}`);
  console.log('='.repeat(66));
  const result = spawnSync(NODE, [file, ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: WORKSPACE,
  });
  const ok = result.status === 0;
  console.log(`--- ${label}: ${ok ? 'OK' : `FAILED (exit ${result.status})`}`);
  return ok;
}

// ---------------------------------------------------------------------- main
const flags = parseArgs(process.argv.slice(2));
const repo = process.env.SELF_IMPROVING_AGENT_REPO ?? 'haogg9963-max/dsh-obsidian-selfimprove';
process.env.SELF_IMPROVING_AGENT_REPO = repo;

console.log(`repo  : ${repo}`);
console.log(`steps : ${flags.steps.join(' -> ')}`);
if (flags.dryRun) console.log('mode  : DRY RUN (nothing will be pushed)');

if (flags.steps.includes('apply') && !flags.proposal) {
  console.error('error: --proposal <proposalId> is required when the apply step runs');
  process.exit(1);
}

// A dry run pushes nothing, so it must not require (or prompt for) a token.
// Printing the resolved plan is the useful part.
if (flags.dryRun) {
  console.log('\nDRY RUN - resolved plan, nothing will be pushed:\n');
  if (flags.steps.includes('apply')) {
    console.log(`  1. apply proposal ${flags.proposal} as a draft PR`);
  }
  if (flags.steps.includes('close')) {
    for (const pr of flags.close) console.log(`  - close PR #${pr} and delete its branch`);
  }
  if (flags.steps.includes('seed')) {
    const pairs = [
      ['bridge.mjs', 'tools/bridge.mjs'],
      ['close-pr.mjs', 'tools/close-pr.mjs'],
      ['seed-repo.mjs', 'tools/seed-repo.mjs'],
      ['publish-proposal.mjs', 'tools/publish-proposal.mjs'],
      ['apply-proposal.mjs', 'tools/apply-proposal.mjs'],
      ['run-all.mjs', 'tools/run-all.mjs'],
      ['secret.mjs', 'tools/secret.mjs'],
      ['.gitignore', '.gitignore'],
    ];
    console.log('  - seed these files into the repo:');
    for (const [local, target] of pairs) {
      if (existsSync(join(HERE, local))) console.log(`      ${local}  ->  ${target}`);
    }
  }
  console.log('\nno token needed for a dry run; nothing was sent.');
  process.exit(0);
}

// ------------------------------------------------------------------- token
// Three ways in, in priority order. The hidden prompt is last because the
// Windows PowerShell console cannot paste into a raw-mode prompt at all
// (Ctrl+V and right-click both do nothing), which makes it unusable in practice.
let token = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN ?? '';
// A value that still contains the placeholder from a pasted instruction line is
// not a real token; treat it as unset rather than failing with a confusing 401.
if (/^ghp_?x*$/iu.test(token.trim()) || /^<.*>$/u.test(token.trim())) {
  console.log('note: the token variable holds a placeholder, ignoring it');
  token = '';
}

const tokenFilePath = flags.tokenFile ?? join(HERE, 'token.txt');
tokenFile = tokenFilePath;

// Preferred source: the DPAPI-encrypted store. It keeps a plaintext credential
// from ever having to sit on disk, and only this Windows account can decrypt it.
if (!token.trim()) {
  try {
    const { loadToken, credentialPath } = await import('./secret.mjs');
    const stored = loadToken();
    if (stored) {
      token = stored;
      console.log(`token loaded from encrypted store (${credentialPath()})`);
    }
  } catch (error) {
    console.log(`note: encrypted store unavailable (${error.message.split('\n')[0]})`);
  }
}

// Fallback: a plaintext file, kept for compatibility with earlier instructions.
if (!token.trim() && existsSync(tokenFilePath)) {
  const fromFile = readFileSync(tokenFilePath, 'utf8').trim();
  if (fromFile) {
    token = fromFile;
    usedTokenFile = true;
    console.log(`token loaded from ${tokenFilePath}`);
  }
}

if (!token.trim()) {
  console.log('');
  console.log('No token in the environment, and no token file at:');
  console.log(`  ${tokenFile}`);
  console.log('');
  console.log('The hidden prompt below CANNOT be pasted into on Windows PowerShell.');
  console.log('Use one of these instead, then re-run:');
  console.log('');
  console.log('  A) put the token in a file with the editor (nothing in the terminal):');
  console.log(`       notepad "${tokenFile}"`);
  console.log('     save it, then re-run this command. The file is deleted automatically.');
  console.log('');
  console.log('  B) paste it at the normal prompt (paste works there):');
  console.log('       $env:SELF_IMPROVING_AGENT_GITHUB_TOKEN = Read-Host');
  console.log('');
  try {
    token = await readSecret('Or try the hidden prompt: ');
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
token = token.trim();
if (!token) {
  console.error('error: no token entered');
  process.exit(1);
}

console.log('');
console.log('verifying the PAT ...');
const check = await verifyToken(token, repo);
if (!check.ok) {
  console.error(`error: ${check.reason}`);
  console.error('  Refusing to continue so nothing partial is pushed.');
  process.exit(1);
}
console.log(`token OK, authenticated as ${check.login} (length ${token.length}, value not shown)`);

// Child steps read the token from the environment. Note this is deliberate:
// passing it as an argument would expose it in the process list.
process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN = token;

const results = [];

if (flags.steps.includes('apply')) {
  const args = ['--id', flags.proposal];
  if (flags.showDiff) args.push('--show-diff');
  // apply has no dry-run mode: a proposal either is or is not pushed.
  if (flags.dryRun) console.log('\nDRY RUN: skipping the apply step.');
  else results.push(['apply', runStep(`apply proposal ${flags.proposal}`, 'apply-proposal.mjs', args)]);
}

if (flags.steps.includes('close')) {
  for (const pr of flags.close) {
    if (flags.dryRun) {
      console.log(`\nDRY RUN: would close PR #${pr}`);
      continue;
    }
    results.push([`close #${pr}`, runStep(`close PR #${pr}`, 'close-pr.mjs', ['--pr', String(pr), '--delete-branch'])]);
  }
}

if (flags.steps.includes('seed')) {
  const pairs = [
    ['bridge.mjs', 'tools/bridge.mjs'],
    ['close-pr.mjs', 'tools/close-pr.mjs'],
    ['seed-repo.mjs', 'tools/seed-repo.mjs'],
    ['publish-proposal.mjs', 'tools/publish-proposal.mjs'],
    ['apply-proposal.mjs', 'tools/apply-proposal.mjs'],
    ['run-all.mjs', 'tools/run-all.mjs'],
    ['secret.mjs', 'tools/secret.mjs'],
    ['.gitignore', '.gitignore'],
  ];
  const args = [];
  for (const [local, target] of pairs) {
    if (existsSync(join(HERE, local))) args.push(join(HERE, local), target);
  }
  if (flags.dryRun) args.unshift('--dry-run');
  results.push(['seed', runStep('seed tool sources into the repo', 'seed-repo.mjs', args)]);
}

// ------------------------------------------------------------------ summary
console.log(`\n${'='.repeat(66)}`);
console.log('SUMMARY');
console.log('='.repeat(66));
if (results.length === 0) console.log('nothing was executed');
for (const [label, ok] of results) console.log(`  ${ok ? 'OK    ' : 'FAILED'}  ${label}`);

// Clear the token from this process regardless of outcome.
delete process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN;

// If the token came from a file, remove it: it has served its purpose and should
// not sit on disk.
if (usedTokenFile) {
  try {
    rmSync(tokenFile, { force: true });
    console.log(`\ntoken file removed: ${tokenFile}`);
  } catch (error) {
    console.log(`\nwarning: could not remove ${tokenFile} (${error.message}); delete it manually`);
  }
}

const allOk = results.every(([, ok]) => ok);
process.exit(allOk ? 0 : 1);
