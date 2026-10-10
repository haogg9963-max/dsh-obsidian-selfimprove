#!/usr/bin/env node
/**
 * Credential storage for the self-improvement bridge.
 *
 * The PAT is encrypted with Windows DPAPI (CurrentUser scope) and written to a
 * file only this Windows account can decrypt. That removes the plaintext
 * `token.txt` step entirely, which was the weakest link in the earlier flow:
 * a credential sitting on disk in the clear.
 *
 * Why DPAPI and not a plain file: the goal is that reading the file is useless
 * to any other user, and to us after the credential is rotated. The key is
 * derived from the logged-in account, so no password has to be stored anywhere.
 *
 * CLI:
 *   node secret.mjs store          # prompt (hidden) and store
 *   node secret.mjs verify         # decrypt and check against GitHub
 *   node secret.mjs clear          # delete the stored credential
 *   node secret.mjs where          # print the file path
 *
 * Library:
 *   import { loadToken, storeToken, clearToken } from './secret.mjs';
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
const CREDENTIAL_FILE = join(DSH_HOME, 'self-improvement', 'credential.dat');
const POWERSHELL = 'powershell.exe';

/** Hidden-input prompt; see run-all.mjs for why the raw prompt cannot be pasted into. */
export function readSecret(prompt) {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('no TTY for hidden input'));
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

/**
 * Run a PowerShell snippet that encrypts or decrypts through DPAPI.
 *
 * The secret travels over stdin, never as a command-line argument, so it cannot
 * be read out of the Windows process list.
 */
function runPowerShell(script, stdinText) {
  const result = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      input: stdinText ?? '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (result.error) throw new Error(`powershell failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`powershell exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

/** Encrypt and persist a token with DPAPI (CurrentUser). */
export function storeToken(token) {
  const value = String(token).trim();
  if (!value) throw new Error('refusing to store an empty token');
  mkdirSync(dirname(CREDENTIAL_FILE), { recursive: true });

  const script = [
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadLine()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    `$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')`,
    `[IO.File]::WriteAllBytes(${JSON.stringify(CREDENTIAL_FILE)}, $protected)`,
    `Write-Output ([IO.File]::ReadAllBytes(${JSON.stringify(CREDENTIAL_FILE)}).Length)`,
  ].join('; ');

  const size = runPowerShell(script, `${value}\n`).trim();
  return { path: CREDENTIAL_FILE, bytes: Number(size) };
}

/** Decrypt the stored token, or return null when nothing is stored. */
export function loadToken() {
  if (!existsSync(CREDENTIAL_FILE)) return null;

  const script = [
    'Add-Type -AssemblyName System.Security',
    `$protected = [IO.File]::ReadAllBytes(${JSON.stringify(CREDENTIAL_FILE)})`,
    `$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')`,
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
  ].join('; ');

  const token = runPowerShell(script).trim();
  return token || null;
}

/** Delete the stored credential. */
export function clearToken() {
  if (!existsSync(CREDENTIAL_FILE)) return false;
  rmSync(CREDENTIAL_FILE, { force: true });
  return true;
}

export function credentialPath() {
  return CREDENTIAL_FILE;
}

/** Read a token from piped stdin, or null when stdin is a TTY. */
function readTokenFromStdin() {
  if (process.stdin.isTTY) return null;
  try {
    const text = readFileSync(0, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const command = process.argv[2] ?? 'where';
  try {
    if (command === 'where') {
      console.log(CREDENTIAL_FILE);
      console.log(existsSync(CREDENTIAL_FILE) ? 'stored: yes' : 'stored: no');
    } else if (command === 'store') {
      // Accept the token from a pipe first. That works from a normal PowerShell
      // prompt, where the secret can be read with hidden input and piped in
      // without ever touching a file or the process list.
      let token = readTokenFromStdin();
      if (!token) token = await readSecret('Paste the PAT: ');
      const result = storeToken(token);
      console.log(`stored (${result.bytes} encrypted bytes) at ${result.path}`);
    } else if (command === 'clear') {
      console.log(clearToken() ? `removed ${CREDENTIAL_FILE}` : 'nothing stored');
    } else if (command === 'verify') {
      const token = loadToken();
      if (!token) {
        console.log('nothing stored');
        process.exit(1);
      }
      const repo = process.env.SELF_IMPROVING_AGENT_REPO ?? 'haogg9963-max/dsh-obsidian-selfimprove';
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-self-improvement-secret',
      };
      const userRes = await fetch('https://api.github.com/user', { headers });
      if (userRes.status === 401) {
        console.log('stored token is REJECTED by GitHub (401)');
        process.exit(1);
      }
      const who = await userRes.json();
      const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      console.log(`decrypted OK, authenticated as ${who.login} (length ${token.length})`);
      console.log(`repo access ${repo}: ${repoRes.ok ? 'yes' : `NO (HTTP ${repoRes.status})`}`);
      if (!repoRes.ok) process.exit(1);
    } else {
      console.error(`unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
