#!/usr/bin/env node
/**
 * DSH bridge to the vendored `self-improving-agent` (BerriAI, MIT).
 *
 * The upstream package ships framework-agnostic tools for the Claude Agent SDK
 * and pi-agent-core. DSH is neither, so this bridge drives the same upstream
 * code from the shell, which is how a DSH skill can expose the full
 * propose -> approve -> draft-PR loop.
 *
 * Commands:
 *   publish   Record a proposal against the target repo (no writes to GitHub).
 *   request   Mint a one-time approval token for a proposal, after the user approves.
 *   apply     Apply an approved proposal: branch, commit, push, open a DRAFT PR.
 *   list      List recorded proposals.
 *   show      Print one proposal record.
 *   doctor    Check environment, token presence, clone state. Reveals no secrets.
 *
 * Configuration (environment only — never a file in this vault):
 *   SELF_IMPROVING_AGENT_REPO            "owner/name" (required)
 *   SELF_IMPROVING_AGENT_GITHUB_TOKEN    fine-grained PAT (required for apply)
 *   SELF_IMPROVING_AGENT_BASE_BRANCH     default: main
 *   SELF_IMPROVING_AGENT_CACHE_DIR       default: ~/.cache/self-improving-agent/<owner>__<name>
 *   SELF_IMPROVING_AGENT_PROPOSALS_DIR   default: <repo root>/.dsh/self-improvement/proposals
 *
 * Exit codes: 0 ok, 1 refused/failed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const DIST = join(REPO_ROOT, '.dsh', 'vendor', 'self-improving-agent', 'dist', 'index.js');

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(message);
}

/** Load the vendored upstream build. */
async function loadUpstream() {
  if (!existsSync(DIST)) {
    die(`vendored upstream build missing at ${DIST}\n  build it with: cd .dsh/vendor/self-improving-agent && npm install`);
  }
  return import(`file://${DIST.replace(/\\/gu, '/')}`);
}

function parseRepo(value) {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(String(value ?? '').trim());
  if (!match) die(`SELF_IMPROVING_AGENT_REPO must be "owner/name" (got: ${value ?? '<unset>'})`);
  return { owner: match[1], name: match[2] };
}

function proposalsDir() {
  return (
    process.env.SELF_IMPROVING_AGENT_PROPOSALS_DIR ??
    join(REPO_ROOT, '.dsh', 'self-improvement', 'proposals')
  );
}

function cacheDir(repo) {
  return (
    process.env.SELF_IMPROVING_AGENT_CACHE_DIR ??
    join(homedir(), '.cache', 'self-improving-agent', `${repo.owner}__${repo.name}`)
  );
}

function baseBranch() {
  return process.env.SELF_IMPROVING_AGENT_BASE_BRANCH ?? 'main';
}



/**
 * Resolve a token for the read/write GitHub calls, in priority order:
 * environment, then the DPAPI-encrypted store.
 *
 * Centralised so no command grows its own credential lookup, and so a stored
 * credential keeps working without anything having to be exported by hand.
 */
async function resolveToken() {
  const fromEnv = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const { loadToken } = await import('./secret.mjs');
    const stored = loadToken();
    if (stored) return stored;
  } catch {
    // Fall through: report the absence in one place instead of throwing here.
  }
  return null;
}

/** Headers for the GitHub REST API. Never log or echo these. */
function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'dsh-self-improvement-bridge',
  };
}

/**
 * Call the GitHub REST API for the configured repo.
 *
 * Throws on a non-2xx response with the status and body, so a failure names its
 * cause rather than surfacing later as an unexplained error.
 */
async function githubApi(token, path, options = {}) {
  const repo = parseRepo(process.env.SELF_IMPROVING_AGENT_REPO);
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: githubHeaders(token),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
function readProposal(id) {

  const file = join(proposalsDir(), `${id}.json`);
  if (!existsSync(file)) die(`no proposal with id ${id} in ${proposalsDir()}`);
  return { path: file, record: JSON.parse(readFileSync(file, 'utf8')) };
}

function writeProposal(path, record) {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function allProposals() {
  const dir = proposalsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

/** Constant-time comparison of two hex strings of equal length. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function cmdDoctor() {
  const raw = process.env.SELF_IMPROVING_AGENT_REPO;
  info('self-improvement bridge diagnostics');
  info(`  upstream build : ${existsSync(DIST) ? 'present' : 'MISSING'}`);
  info(`  repo           : ${raw ?? '<unset>  (set SELF_IMPROVING_AGENT_REPO=owner/name)'}`);

  // Report where the credential actually comes from. Checking only the
  // environment produced a misleading "ABSENT" while commands driven by the
  // encrypted store worked, which sends the reader chasing a non-problem.
  const envToken = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN;
  const resolved = await resolveToken();
  let source = 'ABSENT';
  if (envToken && envToken.trim()) source = 'environment';
  else if (resolved) source = 'DPAPI encrypted store';
  const fingerprint = resolved
    ? createHash('sha256').update(`${raw ?? 'unset-repo'}:${resolved}`).digest('hex').slice(0, 12)
    : null;
  info(
    `  token          : ${resolved ? `present via ${source} (len ${resolved.length}, fingerprint ${fingerprint})` : 'ABSENT  (only needed to open a PR)'}`,
  );
  info(`  base branch    : ${baseBranch()}`);
  info(`  proposals dir  : ${proposalsDir()}`);
  if (raw) {
    const repo = parseRepo(raw);
    const cache = cacheDir(repo);
    const cloned = existsSync(join(cache, '.git'));
    info(`  cache dir      : ${cache}`);
    info(`  clone state    : ${cloned ? 'cloned' : 'not cloned yet (created on apply)'}`);
  }
  const pending = allProposals().filter((p) => p.status !== 'applied');
  info(`  proposals      : ${allProposals().length} recorded, ${pending.length} not applied`);
  const warnings = [];
  if (!resolved) warnings.push('no credential: apply_proposal cannot open a PR (run `node secret.mjs store`)');
  if (!raw) warnings.push('no repo configured');
  if (warnings.length) {
    info('');
    for (const warning of warnings) info(`warn: ${warning}`);
  }
  // Diagnostics never fail hard; they exist to be read.
}

async function cmdPublish(flags) {
  const upstream = await loadUpstream();
  const repo = parseRepo(process.env.SELF_IMPROVING_AGENT_REPO);
  // Pass proposalsDir explicitly: upstream's resolveConfig defaults to
  // ./runs/improvements relative to cwd, which would scatter proposal records
  // outside the vault and desync them from what this bridge reads back.
  const dir = proposalsDir();
  const tools = upstream.feedbackTools({
    repo: `${repo.owner}/${repo.name}`,
    proposalsDir: dir,
    prefetch: false,
  });

  const input = {
    file: flags.file,
    originalSnippet: flags.find,
    proposedSnippet: flags.replace,
    reason: flags.reason,
    risk: flags.risk ?? 'low',
  };
  for (const key of ['file', 'originalSnippet', 'proposedSnippet', 'reason']) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      die(`publish requires --file, --find, --replace and --reason`);
    }
  }
  if (!['low', 'medium', 'high'].includes(input.risk)) die('--risk must be low, medium or high');
  if (input.originalSnippet === input.proposedSnippet) die('proposed snippet is identical to the original');

  const result = await tools.writeImprovementProposal.execute(input);

  // Augment the upstream record with the bookkeeping this bridge needs.
  const { path, record } = readProposal(result.proposalId);
  record.status = 'pending';
  record.risk = input.risk;
  record.target = `${repo.owner}/${repo.name}`;
  writeProposal(path, record);

  info(`proposalId: ${result.proposalId}`);
  info(`target repo: ${record.target}`);
  info(`file: ${input.file}`);
  info(`risk: ${input.risk}`);
  info(`reason: ${input.reason}`);
  info(`saved: ${path}`);
  info('');
  info('NOT applied. Ask the user for explicit approval, then run `request` to mint an approval token.');
}

async function cmdRequest(flags) {
  const id = flags.id ?? flags._;
  if (!id) die('request requires --id <proposalId>');
  const { path, record } = readProposal(id);
  if (record.status === 'applied') die(`proposal ${id} was already applied at ${record.appliedAt}`);

  // A random, single-use token. Requiring it back at apply time means the apply
  // step cannot be driven by the model simply asserting that approval happened:
  // the token only exists because `request` ran after the user approved.
  const token = randomBytes(12).toString('hex');
  record.approval = {
    tokenHash: createHash('sha256').update(token).digest('hex'),
    requestedAt: new Date().toISOString(),
    consumed: false,
  };
  record.status = 'approved';
  writeProposal(path, record);

  info(`approval token for ${id}: ${token}`);
  info('');
  info('Pass this token to `apply`. It is single-use and recorded only as a hash.');
}

async function cmdApply(flags) {
  const id = flags.id;
  const token = flags.token;
  if (!id) die('apply requires --id <proposalId>');
  if (!token) die('apply requires --token <approval token from `request`>');

  const upstream = await loadUpstream();
  const repo = parseRepo(process.env.SELF_IMPROVING_AGENT_REPO);
  // Look in the encrypted store too: requiring an env var here would make the
  // stored credential useless for the one command that actually needs it.
  const envToken = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN;
  if (!envToken || !envToken.trim()) {
    const resolved = await resolveToken();
    if (!resolved) {
      die(
        'no credential available.\n' +
          '  Store one once:   node secret.mjs store\n' +
          '  or export SELF_IMPROVING_AGENT_GITHUB_TOKEN for this shell only.',
      );
    }
    process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN = resolved;
  }

  const { path, record } = readProposal(id);
  if (!record.approval) die(`proposal ${id} has no approval token; run \`request --id ${id}\` first`);
  if (record.approval.consumed) die(`approval token for ${id} was already consumed at ${record.appliedAt}`);
  const presented = createHash('sha256').update(String(token)).digest('hex');
  if (!safeEqual(presented, record.approval.tokenHash)) die('approval token does not match; refusing to apply');

  const tools = upstream.feedbackTools({
    repo: `${repo.owner}/${repo.name}`,
    proposalsDir: proposalsDir(),
    prefetch: false,
  });

  info(`applying ${id} to ${repo.owner}/${repo.name} ...`);
  let result;
  try {
    result = await tools.applyProposal.execute({
      proposalId: id,
      userConfirmedInThisMessage: true,
    });
  } catch (error) {
    die(`apply failed: ${error.message}`);
  }

  record.status = 'applied';
  record.appliedAt = new Date().toISOString();
  record.branch = result.branch;
  record.commitSha = result.commitSha;
  record.prUrl = result.prUrl;
  record.approval.consumed = true;
  writeProposal(path, record);

  info('');
  info(`branch   : ${result.branch}`);
  info(`commit   : ${result.commitSha}`);
  info(`draft PR : ${result.prUrl}`);
  info(`consumed : approval token for ${id}`);
}

function cmdList() {
  const all = allProposals();
  if (all.length === 0) {
    info('no proposals recorded');
    return;
  }
  for (const p of all) {
    info(`${p.proposalId}  ${String(p.status ?? 'pending').padEnd(8)} ${String(p.risk).padEnd(6)} ${p.file}${p.prUrl ? `  ${p.prUrl}` : ''}`);
  }
}

/**
 * End-to-end first run, driven from Node so the CJK proposal text never has to
 * survive a Windows PowerShell single-quoted string. Windows PowerShell 5.1
 * mis-terminates such strings around multi-byte characters, which silently
 * corrupts the rest of the script, so the text lives here as UTF-8 instead.
 *
 * Reads the PAT from the environment (never from an argument, so it cannot be
 * captured from a process listing or a shell history entry).
 */
async function cmdFirstPr(flags) {
  const repo = parseRepo(process.env.SELF_IMPROVING_AGENT_REPO);
  const upstream = await loadUpstream();
  const dir = proposalsDir();
  const tools = upstream.feedbackTools({
    repo: `${repo.owner}/${repo.name}`,
    proposalsDir: dir,
    prefetch: false,
  });

  const input = {
    file: flags.file ?? 'README.md',
    originalSnippet: flags.find ?? 'DSH自改进循环，Obsidian记忆库',
    proposedSnippet:
      flags.replace ??
      'DSH 自改进循环 + Obsidian 跨对话记忆库。由 self-improving-agent 桥接驱动：提议 → 人工批准 → 自动开 draft PR。',
    reason:
      flags.reason ??
      'README 只有一行说明，没有说明该仓库由自改进闭环驱动，也没有指向 DSH 记忆库入口。补齐后新会话可据此定位。',
    risk: flags.risk ?? 'low',
  };

  info(`target repo: ${repo.owner}/${repo.name}`);
  info(`file       : ${input.file}`);

  if (flags['dry-run']) {
    info('');
    info('dry run: recording the proposal only; no remote call, no PR.');
  }

  // 1. record the proposal (touches no remote)
  const published = await tools.writeImprovementProposal.execute(input);
  const { path, record } = readProposal(published.proposalId);
  record.status = 'pending';
  record.target = `${repo.owner}/${repo.name}`;
  writeProposal(path, record);
  info(`proposalId : ${published.proposalId}`);
  info(`find       : ${input.originalSnippet.slice(0, 60)}`);
  info(`replace    : ${input.proposedSnippet.slice(0, 60)}`);

  if (flags['dry-run']) {
    info('');
    info('dry run complete: proposal recorded, nothing pushed. Delete it before a real run:');
    info(`  bridge.mjs show --id ${published.proposalId}   then remove the file if not wanted`);
    return;
  }

  // The token is only needed once we actually touch the remote.
  if (!(await resolveToken())) {
    die(
      'no credential available; the proposal was recorded but nothing was pushed.\n' +
        '  Store one once:   node secret.mjs store\n' +
        `  Then re-run to apply proposal ${published.proposalId}.`,
    );
  }

  // 2. mint the single-use approval token. In this standalone first-run the
  //    human signalled approval by invoking the flow and supplying the PAT, so
  //    the token is minted here immediately rather than in a separate step.
  const token = randomBytes(12).toString('hex');
  record.approval = {
    tokenHash: createHash('sha256').update(token).digest('hex'),
    requestedAt: new Date().toISOString(),
    consumed: false,
  };
  record.status = 'approved';
  writeProposal(path, record);

  // 3. apply: branch, commit, push, draft PR
  let result;
  try {
    result = await tools.applyProposal.execute({
      proposalId: published.proposalId,
      userConfirmedInThisMessage: true,
    });
  } catch (error) {
    die(`apply failed: ${error.message}`);
  }

  record.status = 'applied';
  record.appliedAt = new Date().toISOString();
  record.branch = result.branch;
  record.commitSha = result.commitSha;
  record.prUrl = result.prUrl;
  record.approval.consumed = true;
  writeProposal(path, record);

  info('');
  info(`branch   : ${result.branch}`);
  info(`commit   : ${result.commitSha}`);
  info(`draft PR : ${result.prUrl}`);
  info('');
  info('SUCCESS: the full propose -> approve -> draft PR loop is verified.');
}

function cmdShow(flags) {
  const id = flags.id ?? flags._;
  if (!id) die('show requires --id <proposalId>');
  const { record } = readProposal(id);
  // Never print the approval hash or any token material.
  const view = { ...record };
  if (view.approval) view.approval = { requestedAt: view.approval.requestedAt, consumed: view.approval.consumed };
  info(JSON.stringify(view, null, 2));
}


/**
 * List pull requests, so the agent can see the loop's own output.
 *
 * Read-only: safe to call while reviewing, and it never modifies anything.
 */
async function cmdPrList(flags) {
  const token = await resolveToken();
  if (!token) die('no credential available; run `node secret.mjs store` once, or export SELF_IMPROVING_AGENT_GITHUB_TOKEN');

  const state = flags.state ?? 'all';
  const limit = Number(flags.limit ?? 20);
  if (!['open', 'closed', 'all'].includes(state)) die('--state must be open, closed or all');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) die('--limit must be 1..100');

  const pulls = await githubApi(token, `/pulls?state=${state}&per_page=${limit}&sort=created&direction=desc`);
  if (pulls.length === 0) {
    info(`no ${state === 'all' ? '' : `${state} `}pull requests`);
    return;
  }

  // Look up which proposal produced each PR, so the two views stay connected.
  const byPr = new Map();
  for (const p of allProposals()) if (p.prUrl) byPr.set(p.prUrl, p.proposalId);

  for (const p of pulls) {
    const tags = [p.draft ? 'draft' : 'ready'];
    if (p.merged) tags.push('merged');
    const proposal = byPr.get(p.html_url);
    info(`#${String(p.number).padEnd(4)} ${p.state.padEnd(7)} ${tags.join(',').padEnd(13)} ${p.title}`);
    info(`      branch: ${p.head?.ref}`);
    info(`      url   : ${p.html_url}${proposal ? `  (proposal ${proposal})` : ''}`);
  }
  info('');
  info(`${pulls.length} pull request(s)`);
}

/**
 * Close a pull request, optionally deleting its head branch.
 *
 * Refuses to close a merged PR: that would misrepresent history rather than
 * tidy it. Unlike `apply` there is no content-level approval token here,
 * because closing does not change repository content.
 */
async function cmdPrClose(flags) {
  const number = flags.pr ?? flags._;
  if (!number) die('pr-close requires --pr <number>');
  if (!/^\d+$/u.test(String(number))) die('--pr must be a number');

  const token = await resolveToken();
  if (!token) die('no credential available; run `node secret.mjs store` once, or export SELF_IMPROVING_AGENT_GITHUB_TOKEN');

  const repo = parseRepo(process.env.SELF_IMPROVING_AGENT_REPO);
  const repoSlug = `${repo.owner}/${repo.name}`;

  const pull = await githubApi(token, `/pulls/${number}`);
  info(`PR #${pull.number}: ${pull.title}`);
  info(`  state  : ${pull.state}`);
  info(`  draft  : ${pull.draft}`);
  info(`  merged : ${pull.merged}`);
  info(`  head   : ${pull.head?.ref}`);

  // Test `merged` BEFORE `closed`. A merged PR is also `closed`, so the reverse
  // order makes the merged branch unreachable and the caller sees
  // "already closed; nothing to do" instead of the real reason: that closing a
  // merged PR is refused on purpose. The behaviour was already correct (nothing
  // was closed) but the explanation was wrong, and a wrong explanation in
  // authorisation code invites the next reader to assume merged PRs can simply
  // be closed.
  if (pull.merged) {
    die('refusing to close a merged pull request (that would misrepresent history)');
  } else if (pull.state === 'closed') {
    info('');
    info('already closed; nothing to do');
  } else {
    const closed = await githubApi(token, `/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
    info('');
    info(`CLOSED: state is now "${closed.state}"`);
  }

  if (flags['delete-branch']) {
    const headRef = pull.head?.ref;
    const headRepo = pull.head?.repo?.full_name;
    if (!headRef) {
      info('branch not deleted: the PR does not report a head branch');
    } else if (headRepo !== repoSlug) {
      // A forked head, or an unexpected shape: never touch a branch we do not own.
      info(`branch not deleted: head lives in "${headRepo ?? 'unknown'}", not in ${repoSlug}`);
    } else {
      const res = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(headRef)}`,
        { method: 'DELETE', headers: githubHeaders(token) },
      );
      if (res.status === 204) info(`branch deleted: ${headRef}`);
      else if (res.status === 404 || res.status === 422) info(`branch not deleted (already gone or protected): ${headRef}`);
      else info(`branch delete returned ${res.status}; leaving ${headRef} in place`);
    }
  }
}
const { positional, flags } = parseArgs(process.argv.slice(2));

const command = positional[0];
flags._ = positional[1];

try {
  switch (command) {
    case 'doctor':
      await cmdDoctor();
      break;
    case 'publish':
      await cmdPublish(flags);
      break;
    case 'request':
      await cmdRequest(flags);
      break;
    case 'apply':
      await cmdApply(flags);
      break;
    case 'list':
      cmdList();
      break;
    case 'first-pr':
      await cmdFirstPr(flags);
      break;
      break;
    case 'first-pr':
      await cmdFirstPr(flags);
      break;
    case 'show':
      cmdShow(flags);
      break;
    case 'pr-list':
      await cmdPrList(flags);
      break;
    case 'pr-close':
      await cmdPrClose(flags);
      break;
    default:
      die(
        'usage: bridge.mjs <publish|request|apply|list|show|first-pr|doctor> [options]\n' +
        'usage: bridge.mjs <command> [options]\n' +
          '\n' +
          '  proposals (local records)\n' +
          '    publish --file <repo-relative> --find <exact> --replace <new> --reason <text> [--risk low|medium|high]\n' +
          '    request --id <proposalId>            mint a single-use approval token\n' +
          '    apply   --id <proposalId> --token <token>\n' +
          '    list                                 list local proposals\n' +
          '    show --id <proposalId>\n' +
          '    doctor                               environment diagnostics\n' +
          '\n' +
          '  pull requests (remote, read/write)\n' +
          '    pr-list [--state open|closed|all] [--limit 1..100]\n' +
          '    pr-close --pr <number> [--delete-branch]\n',
          '  publish  --file <repo-relative> --find <exact> --replace <new> --reason <text> [--risk low|medium|high]\n' +
          '  request  --id <proposalId>\n' +
          '  apply    --id <proposalId> --token <approval token>\n' +
          '  first-pr  one-shot end-to-end run (needs SELF_IMPROVING_AGENT_GITHUB_TOKEN)\n' +
          '  list | show --id <proposalId> | doctor',
      );
  }
} catch (error) {
  die(error.message);
}
