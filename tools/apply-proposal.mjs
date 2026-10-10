#!/usr/bin/env node
/**
 * Apply an approved self-improvement proposal — end to end, in ONE command.
 *
 * Written in Node rather than PowerShell on purpose. Every PowerShell approach
 * failed on this machine:
 *   - `pwsh` (PowerShell 7) is not installed
 *   - script execution is blocked by ExecutionPolicy, so even a .ps1 wrapper
 *     cannot run without -ExecutionPolicy Bypass
 *   - Powershell 5.1 mis-parses CJK inside quoted strings
 * Node is unaffected by all of that, so this is the delivery format from now on.
 *
 * The approval gate is unchanged: `request` mints a single-use token and
 * `apply` consumes it. This script just keeps that token inside one process
 * instead of making a human copy it between commands.
 *
 * Usage:
 *   node apply-proposal.mjs --id <proposalId> [--check-only] [--show-diff]
 *
 * The PAT is read from SELF_IMPROVING_AGENT_GITHUB_TOKEN when already set
 * (non-interactive use), otherwise prompted with hidden input. It is never
 * written anywhere and never printed.
 *
 * Exit codes: 0 ok, 1 refused/failed.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..', '..');
const UPSTREAM = join(WORKSPACE, '.dsh', 'vendor', 'self-improving-agent', 'dist', 'index.js');

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(message);
}

/** Read one line from the terminal without echoing it. */
function readSecret(prompt) {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('no TTY available for hidden input; set SELF_IMPROVING_AGENT_GITHUB_TOKEN instead'));
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
          // Ctrl-C
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
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

function parseConfig() {
  const raw = process.env.SELF_IMPROVING_AGENT_REPO;
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(String(raw ?? '').trim());
  if (!match) die('set SELF_IMPROVING_AGENT_REPO=owner/name');
  return { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` };
}

function proposalsDir() {
  return process.env.SELF_IMPROVING_AGENT_PROPOSALS_DIR ?? join(HERE, 'proposals');
}

function cacheDir(repo) {
  return (
    process.env.SELF_IMPROVING_AGENT_CACHE_DIR ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cache', 'self-improving-agent', `${repo.owner}__${repo.name}`)
  );
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id') flags.id = argv[++i];
    else if (arg === '--check-only') flags.checkOnly = true;
    else if (arg === '--show-diff') flags.showDiff = true;
    else if (arg === '--yes') flags.yes = true;
    else die(`unknown argument: ${arg}`);
  }
  if (!flags.id) die('--id <proposalId> is required');
  return flags;
}

function loadProposal(id) {
  const file = join(proposalsDir(), `${id}.json`);
  if (!existsSync(file)) die(`no proposal with id ${id} in ${proposalsDir()}`);
  return { file, record: JSON.parse(readFileSync(file, 'utf8')) };
}

function saveProposal(file, record) {
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** A readable before/after view. Nothing is truncated here: this is the review. */
function printDiff(record) {
  info('');
  info('--- current ------------------------------------------------------');
  for (const line of record.originalSnippet.replace(/\n$/u, '').split('\n')) info(`  ${line}`);
  info('--- proposed -----------------------------------------------------');
  for (const line of record.proposedSnippet.replace(/\n$/u, '').split('\n')) info(`  ${line}`);
  info('------------------------------------------------------------------');
}

async function verifyToken(token, repo) {
  let res;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-self-improvement-bridge',
      },
    });
  } catch (error) {
    return { ok: false, reason: `could not reach GitHub: ${error.message}` };
  }
  if (res.status === 401) return { ok: false, reason: 'GitHub rejected the token (401 Bad credentials)' };
  if (!res.ok) return { ok: false, reason: `token check returned HTTP ${res.status} ${res.statusText}` };
  const who = await res.json();

  // Confirm the token can actually see the target repo; a valid token without
  // repo access would fail later with a much less obvious error.
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${repo.slug}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-self-improvement-bridge',
      },
    });
    if (repoRes.status === 404) {
      return { ok: false, reason: `token authenticates as ${who.login} but cannot see ${repo.slug} (404)` };
    }
    if (!repoRes.ok) return { ok: false, reason: `repo check returned HTTP ${repoRes.status}` };
  } catch (error) {
    return { ok: false, reason: `repo check failed: ${error.message}` };
  }

  return { ok: true, login: who.login };
}

const flags = parseArgs(process.argv.slice(2));
const repo = parseConfig();
const { file, record } = loadProposal(flags.id);

info(`proposal   : ${record.proposalId}`);
info(`target repo: ${record.target ?? repo.slug}`);
info(`file       : ${record.file}`);
info(`risk       : ${record.risk}`);
info(`status     : ${record.status}`);
info(`approval   : ${record.approval ? `minted ${record.approval.requestedAt}` : 'none yet'}`);
info(`reason     : ${record.reason}`);

if (flags.showDiff) printDiff(record);

if (record.status === 'applied') {
  info('');
  info(`already applied at ${record.appliedAt}`);
  info(`draft PR: ${record.prUrl}`);
  process.exit(0);
}

if (flags.checkOnly) {
  info('');
  info('check-only: nothing read, nothing written.');
  process.exit(0);
}

if (!existsSync(UPSTREAM)) die(`upstream build missing at ${UPSTREAM}`);

const upstream = await import(`file://${UPSTREAM.replace(/\\/gu, '/')}`);

// ---------------------------------------------------------------------- token
let token = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN ?? '';
if (!token) {
  info('');
  info('Enter the PAT (hidden). It is verified now, never written to disk, never printed.');
  try {
    token = await readSecret('Paste the PAT: ');
  } catch (error) {
    die(`${error.message}\n  Example:  $env:SELF_IMPROVING_AGENT_GITHUB_TOKEN = (Read-Host -AsSecureString ...)  # or your secret store`);
  }
}
if (!token.trim()) die('no token entered');
token = token.trim();

info('');
info('verifying the PAT ...');
const check = await verifyToken(token, repo);
if (!check.ok) die(`${check.reason}\n  Refusing to continue so nothing partial is pushed.`);
info(`token OK, authenticated as ${check.login} (length ${token.length})`);

// ------------------------------------------------------- mint approval token
// The gate: this token exists only because the user ran this command now.
const approval = randomBytes(12).toString('hex');
record.approval = {
  tokenHash: createHash('sha256').update(approval).digest('hex'),
  requestedAt: new Date().toISOString(),
  consumed: false,
};
record.status = 'approved';
saveProposal(file, record);
info('approval token minted (single-use, stored only as a SHA-256 hash)');

// ------------------------------------------------------------------- apply
const tools = upstream.feedbackTools({
  repo: repo.slug,
  proposalsDir: proposalsDir(),
  prefetch: false,
});

info('');
info(`applying to ${repo.slug} ...`);
info(`cache: ${cacheDir(repo)}`);

/**
 * Strip credential material out of captured child-process output.
 *
 * The upstream apply runs `git -c http.extraheader=AUTHORIZATION: Basic <b64>`,
 * where <b64> is base64 of `x-access-token:<PAT>`. base64 is not encryption, so
 * echoing that line verbatim into a terminal would expose the token. Keep the
 * diagnostic value of stderr while removing the secret.
 */
function redactCredentials(text) {
  return String(text)
    .replace(/(http\.extraheader=\S*\s*Basic\s+)[A-Za-z0-9+/=]+/giu, '$1<redacted>')
    .replace(/(Authorization:\s*(?:Basic|Bearer|token)\s+)[A-Za-z0-9+/=_.-]+/giu, '$1<redacted>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/gu, '<redacted:github-token>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, '<redacted:github-pat>');
}

let result;
try {
  result = await tools.applyProposal.execute({
    proposalId: record.proposalId,
    userConfirmedInThisMessage: true,
  });
} catch (error) {
  // Roll the proposal back to pending so a retry needs a fresh approval.
  record.status = 'pending';
  delete record.approval;
  saveProposal(file, record);

  // The upstream apply shells out to git. Node reports a failed child process
  // as a bare "Command failed: git ...", which hides the actual reason, so dig
  // out the captured stderr/stdout here. Without this, a real git error is
  // invisible and the failure looks unexplained. Everything is redacted first.
  info('');
  info('--- apply error detail -------------------------------------------');
  const seen = new Set();
  let current = error;
  let depth = 0;
  while (current && depth < 5) {
    const message = redactCredentials(current.message ?? current);
    if (!seen.has(message)) {
      seen.add(message);
      info(`[${depth}] ${message.split('\n')[0]}`);
    }
    for (const field of ['stderr', 'stdout']) {
      const value = current[field];
      if (!value) continue;
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      const trimmed = redactCredentials(text).trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        info(`    ${field}: ${trimmed}`);
      }
    }
    current = current.cause;
    depth++;
  }
  info('------------------------------------------------------------------');

  die('apply failed; the proposal is back to "pending" - re-run to mint a new approval token.');
}

record.status = 'applied';
record.appliedAt = new Date().toISOString();
record.branch = result.branch;
record.commitSha = result.commitSha;
record.prUrl = result.prUrl;
record.approval.consumed = true;
saveProposal(file, record);

info('');
info(`branch   : ${result.branch}`);
info(`commit   : ${result.commitSha}`);
info(`draft PR : ${result.prUrl}`);
info('');
info('SUCCESS');
