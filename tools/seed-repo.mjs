#!/usr/bin/env node
/**
 * Seed the self-improvement target repository with local tool files.
 *
 * Why this exists: the upstream `applyProposal` can only REPLACE a snippet in a
 * file that already exists in the repo. It cannot create files. So before the
 * self-improvement loop can improve its own tooling, that tooling must exist in
 * the repo — and that first step has to happen outside the loop.
 *
 * This script commits files straight to a branch using the GitHub Git Data API
 * (blobs -> tree -> commit -> ref update). No local git required for the push,
 * and the work is committed in ONE commit rather than one per file.
 *
 * Run in YOUR OWN terminal so the PAT never enters a DSH conversation:
 *   $env:SELF_IMPROVING_AGENT_REPO = 'owner/name'
 *   $env:SELF_IMPROVING_AGENT_GITHUB_TOKEN = (secure input)
 *   node seed-repo.mjs [--branch main] [--message "..."] [--dry-run] <src> <dest> ...
 *
 * Each pair maps a local file to a repo-relative path, e.g.
 *   node seed-repo.mjs ./bridge.mjs tools/bridge.mjs
 *
 * Exit codes: 0 ok, 1 failure.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const API = 'https://api.github.com';

function parseArgs(argv) {
  const files = [];
  const flags = { branch: 'main', message: null, dryRun: false, delete: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--branch') flags.branch = argv[++i];
    else if (arg === '--message') flags.message = argv[++i];
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--delete') flags.delete.push(argv[++i]);
    else files.push(arg);
  }
  return { files, flags };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { files, flags } = parseArgs(process.argv.slice(2));

/**
 * Paths to remove from the branch in the same commit.
 *
 * Needed because seeding can create a file by mistake (for example a dotfile
 * whose leading dot was stripped) and the loop can only REPLACE existing
 * content, so it cannot clean up after itself here.
 */
const deletions = Array.isArray(flags.delete) ? flags.delete : [];

const repo = process.env.SELF_IMPROVING_AGENT_REPO;

/**
 * Resolve the PAT from the environment first, then the DPAPI-encrypted store.
 *
 * Every tool routes through this so a credential never has to be exported by
 * hand: the encrypted store exists precisely to remove that step.
 */
let token = process.env.SELF_IMPROVING_AGENT_GITHUB_TOKEN ?? '';
if (!token.trim() && !flags.dryRun) {
  try {
    const { loadToken } = await import('./secret.mjs');
    token = loadToken() ?? '';
    if (token) console.log('token loaded from encrypted store');
  } catch (error) {
    console.log(`note: encrypted store unavailable (${error.message.split('\n')[0]})`);
  }
}

if (!repo || !/^[^/\s]+\/[^/\s]+$/u.test(repo)) fail('set SELF_IMPROVING_AGENT_REPO=owner/name');
// --dry-run only previews local files, so it must not require the token.
if (!token.trim() && !flags.dryRun) {
  fail(
    'no credential available.\n' +
      '  Store one once with:  node secret.mjs store\n' +
      '  or export SELF_IMPROVING_AGENT_GITHUB_TOKEN for this shell.',
  );
}
if ((files.length === 0 || files.length % 2 !== 0) && deletions.length === 0) {
  fail('provide pairs: <local-file> <repo-path> [...], and/or --delete <repo-path>');
}
if (files.length % 2 !== 0) fail('file arguments must come in <local-file> <repo-path> pairs');

const [owner, name] = repo.split('/');
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'dsh-self-improvement-seed',
};

async function api(method, path, body) {
  const res = await fetch(`${API}/repos/${owner}/${name}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------------------------------------------------------- read inputs
const uploads = [];
for (let i = 0; i < files.length; i += 2) {
  const local = resolve(files[i]);
  // Strip only a leading "./" or ".\" prefix. A blanket /^[./\\]+/ would also eat
  // the dot of a dotfile name, silently turning ".gitignore" into "gitignore".
  const repoPath = files[i + 1].replace(/^\.\.[\\/]/u, '').replace(/^\.[\\/]/u, '').replace(/\\/gu, '/');
  if (!existsSync(local)) fail(`local file not found: ${local}`);
  if (statSync(local).isDirectory()) fail(`local path is a directory, not a file: ${local}`);
  if (!repoPath || repoPath.includes('..')) fail(`invalid repo path: ${files[i + 1]}`);
  uploads.push({ local, repoPath, content: readFileSync(local) });
}

console.log(`repo        : ${owner}/${name}`);
console.log(`branch      : ${flags.branch}`);
console.log(`files       : ${uploads.length}`);
for (const u of uploads) console.log(`  ${relative(process.cwd(), u.local)}  ->  ${u.repoPath}  (${u.content.length} bytes)`);

if (flags.dryRun) {
  console.log('\ndry run: nothing was sent.');
  process.exit(0);
}

// --------------------------------------------------------- resolve base state
let baseCommitSha;
try {
  const ref = await api('GET', `/git/ref/heads/${encodeURIComponent(flags.branch)}`);
  baseCommitSha = ref.object.sha;
} catch (error) {
  fail(`could not read branch "${flags.branch}": ${error.message}`);
}
const baseCommit = await api('GET', `/git/commits/${baseCommitSha}`);
const baseTreeSha = baseCommit.tree.sha;
console.log(`base commit : ${baseCommitSha.slice(0, 12)}`);

// ------------------------------------------------------- create blobs + tree
const treeEntries = [];
for (const u of uploads) {
  // UTF-8 text: sending content as a string makes GitHub store exactly these bytes.
  const blob = await api('POST', '/git/blobs', {
    content: u.content.toString('utf8'),
    encoding: 'utf-8',
  });
  treeEntries.push({ path: u.repoPath, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`blob        : ${u.repoPath} -> ${blob.sha.slice(0, 12)}`);
}

// A tree entry with sha: null removes that path. This is how a mistaken file
// gets cleaned up, since the self-improvement loop itself can only replace.
for (const path of deletions) {
  const clean = path.replace(/^\.\.[\\/]/u, '').replace(/^\.[\\/]/u, '').replace(/\\/gu, '/');
  treeEntries.push({ path: clean, mode: '100644', type: 'blob', sha: null });
  console.log(`delete      : ${clean}`);
}

const tree = await api('POST', '/git/trees', {
  base_tree: baseTreeSha,
  tree: treeEntries,
});
console.log(`tree        : ${tree.sha.slice(0, 12)}`);

// ------------------------------------------------------------ commit and push
const message =
  flags.message ??
  `chore: seed self-improvement tooling\n\n${treeEntries.map((e) => `- ${e.path}`).join('\n')}`;

const commit = await api('POST', '/git/commits', {
  message,
  tree: tree.sha,
  parents: [baseCommitSha],
});
console.log(`commit      : ${commit.sha.slice(0, 12)}`);

await api('PATCH', `/git/refs/heads/${encodeURIComponent(flags.branch)}`, {
  sha: commit.sha,
  force: false,
});
console.log('');
console.log(`PUSHED to ${owner}/${name}@${flags.branch}`);
console.log(`commit      : ${commit.sha}`);
console.log(`url         : ${commit.html_url ?? `https://github.com/${owner}/${name}/commit/${commit.sha}`}`);
