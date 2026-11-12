import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve(import.meta.dirname, '../test/fake-ticket-helper.mjs');
const request = {
  parent_harness: 'gemini', dispatch_id: 'dispatch', cwd: '/project', add_dirs: ['/project/sub'],
  project: 'p1', grant_id: null, revision: null, effective_hash: 'hash', expires_at: '2026-11-12T12:00:00Z',
};

function invoke(input: unknown, log: string) {
  return spawnSync(process.execPath, [helper, 'issue'], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, FAKE_TICKET_LOG: log, FAKE_TICKET_MODE: '' },
  });
}

function logPath() {
  return join(mkdtempSync(join(tmpdir(), 'ticket-fake-')), 'requests.log');
}

describe('fake ticket helper', () => {
  it('logs each request and issues a different 32-hex ticket', () => {
    const log = logPath();
    const first = invoke(request, log);
    const second = invoke(request, log);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstId = JSON.parse(first.stdout).ticket_id;
    const secondId = JSON.parse(second.stdout).ticket_id;
    expect(firstId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondId).not.toBe(firstId);
    expect(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([request, request]);
  });

  it.each([
    ['missing field', (({ project: _project, ...rest }) => rest)(request)],
    ['extra field', { ...request, extra: true }],
    ['relative cwd', { ...request, cwd: 'project' }],
    ['relative add_dir', { ...request, add_dirs: ['/project', 'relative'] }],
    ['non-array add_dirs', { ...request, add_dirs: '/project' }],
    ['fractional expiry', { ...request, expires_at: '2026-11-12T12:00:00.000Z' }],
    ['invalid expiry date', { ...request, expires_at: '2026-02-30T12:00:00Z' }],
  ])('refuses %s with the real helper response', (_name, input) => {
    const result = invoke(input, logPath());
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ allowed: false, reason: 'bad-request' });
  });
});
