#!/usr/bin/env node
/**
 * Verify that a remote Host Agent can reproduce this exact source tree.
 *
 * This check is deliberately local and read-only: it never commits, pushes,
 * tags, or contacts a Git remote. A cloud E2E must use an immutable commit,
 * not the developer's untracked working directory.
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  try {
    return { ok: true, value: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (error) {
    return { ok: false, detail: String(error.stderr || error.message || '').trim().slice(0, 300) };
  }
}

const topLevel = git(['rev-parse', '--show-toplevel']);
const head = git(['rev-parse', 'HEAD']);
const origin = git(['remote', 'get-url', 'origin']);
const status = git(['status', '--porcelain=v1']);
const clean = status.ok && status.value === '';
const report = {
  mode: 'read-only-release-gate',
  repository: topLevel.ok ? topLevel.value : null,
  commit: head.ok ? head.value : null,
  origin: origin.ok ? origin.value : null,
  clean,
  uncommittedEntries: status.ok && status.value ? status.value.split(/\r?\n/).filter(Boolean).length : 0,
  executionGates: [],
};

if (!topLevel.ok) report.executionGates.push('Run this command from a Git working tree.');
if (!head.ok) report.executionGates.push('Create a source commit before remote clone E2E.');
if (!origin.ok) report.executionGates.push('Configure an origin remote reachable by the target host.');
if (!clean) report.executionGates.push('Commit or explicitly package all source changes; remote clone cannot reproduce an uncommitted tree.');
if (report.commit && report.origin && clean) {
  report.cloneCommand = `git clone ${report.origin} agentworks && cd agentworks && git checkout ${report.commit}`;
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.executionGates.length ? 2 : 0);
