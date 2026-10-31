import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GrantClient, fromWire, toWire } from './grant-client.js';
import { loadBinding, saveBinding, BindingUnreadable, type ConversationBinding } from './conversation-binding.js';

const CHECKER_SRC = resolve(import.meta.dirname, '../test/fake-grant-check.mjs');
const SENTINEL = 'S3CR3T';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agy-binding-'));
}

function binding(over: Partial<ConversationBinding> = {}): ConversationBinding {
  return {
    schema: 1,
    conversationId: 'conv-1',
    cwd: '/work/p1',
    addDirs: ['/work/p1/sub'],
    project: 'p1',
    grantId: null,
    grantRevision: null,
    expiresAt: null,
    effectiveHash: 'h1',
    sandbox: false,
    skipPermissions: true,
    createdAt: '2026-10-28T00:00:00Z',
    ...over,
  };
}

function makeChecker(fixture: Record<string, unknown>): { grants: GrantClient; dir: string } {
  const dir = tempDir();
  const checker = join(dir, 'grant-check.mjs');
  copyFileSync(CHECKER_SRC, checker);
  chmodSync(checker, 0o755);
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture));
  return { grants: new GrantClient(checker), dir };
}

const allowed = {
  allowed: true,
  reason: 'standing-scope',
  project: 'p1',
  grant_revision: null,
  expires_at: null,
  roots: ['/r'],
  effective_hash: 'h1',
};

const request = {
  phase: 'start' as const,
  harness: 'gemini' as const,
  cwd: '/work/p1',
  addDirs: [],
  grantId: null,
  revision: null,
  boundProject: null,
};

describe('binding store', () => {
  it('round-trips a binding with a private directory and file', async () => {
    const dir = join(tempDir(), 'state');
    await saveBinding(binding(), dir);

    expect(await loadBinding('conv-1', dir)).toEqual(binding());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(dir);
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  });

  it('returns undefined for an unknown conversation', async () => {
    expect(await loadBinding('nope', tempDir())).toBeUndefined();
  });

  it('keeps two conversations apart', async () => {
    const dir = tempDir();
    await saveBinding(binding({ conversationId: 'a', cwd: '/a' }), dir);
    await saveBinding(binding({ conversationId: 'b', cwd: '/b' }), dir);

    expect((await loadBinding('a', dir))?.cwd).toBe('/a');
    expect((await loadBinding('b', dir))?.cwd).toBe('/b');
  });

  const bad: [string, Record<string, unknown>][] = [
    ['wrong schema', { schema: 2 }],
    ['id mismatch', { conversationId: 'other' }],
    ['relative cwd', { cwd: 'rel/path' }],
    ['non-string cwd', { cwd: 5 }],
    ['addDirs not an array', { addDirs: 'x' }],
    ['addDirs with a non-string', { addDirs: [1] }],
    ['relative addDirs entry', { addDirs: ['rel'] }],
    ['project mistyped', { project: 3 }],
    ['grantRevision fractional', { grantRevision: 1.5 }],
    ['expiresAt mistyped', { expiresAt: 5 }],
    ['effectiveHash missing', { effectiveHash: undefined }],
    ['sandbox not boolean', { sandbox: 'yes' }],
    ['skipPermissions not boolean', { skipPermissions: 1 }],
    ['createdAt missing', { createdAt: undefined }],
  ];
  for (const [name, over] of bad) {
    it(`refuses a binding file with ${name}`, async () => {
      const dir = tempDir();
      await saveBinding(binding(), dir);
      const [file] = readdirSync(dir);
      const path = join(dir, file);
      writeFileSync(path, JSON.stringify({ ...binding(), ...over }));

      await expect(loadBinding('conv-1', dir)).rejects.toBeInstanceOf(BindingUnreadable);
    });
  }

  it('refuses a corrupt file without echoing its contents', async () => {
    const dir = tempDir();
    await saveBinding(binding(), dir);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file), `{${SENTINEL}`);

    const err = await loadBinding('conv-1', dir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BindingUnreadable);
    expect((err as Error).message).not.toContain(SENTINEL);
  });

  it('stores nothing but the binding fields', async () => {
    const dir = tempDir();
    await saveBinding(binding(), dir);
    const [file] = readdirSync(dir);

    expect(Object.keys(JSON.parse(readFileSync(join(dir, file), 'utf8'))).sort()).toEqual(Object.keys(binding()).sort());
  });
});

describe('grant client', () => {
  it('maps the request to the checker wire format', () => {
    expect(toWire({ ...request, grantId: 'g1', revision: 2, boundProject: 'p1' })).toEqual({
      phase: 'start',
      harness: 'gemini',
      cwd: '/work/p1',
      add_dirs: [],
      grant_id: 'g1',
      revision: 2,
      bound_project: 'p1',
    });
  });

  it('rejects a malformed decision', () => {
    expect(() => fromWire({ allowed: true })).toThrow('malformed');
  });

  it('allows when the checker exits 0 and says allowed', async () => {
    const { grants } = makeChecker({ decision: allowed });

    expect(await grants.check(request)).toMatchObject({ allowed: true, effectiveHash: 'h1', project: 'p1' });
  });

  it('denies a decision with allowed true but exit code 2', async () => {
    const { grants } = makeChecker({ decision: allowed, exitWith: 2 });

    expect(await grants.check(request)).toMatchObject({ allowed: false, reason: 'checker-exit-mismatch' });
  });

  it('rejects when the checker cannot run', async () => {
    const grants = new GrantClient('/nonexistent/grant-check');

    await expect(grants.check(request)).rejects.toThrow('could not run');
  });

  it('rejects an exit code that carries no decision', async () => {
    const { grants } = makeChecker({ exit: 3 });

    await expect(grants.check(request)).rejects.toThrow(/exited 3.*unscoped test server.*run bin\/plan to see why/);
  });

  it('rejects unparseable output without echoing it', async () => {
    const { grants } = makeChecker({ rawStdout: `not json ${SENTINEL}` });

    const err = await grants.check(request).catch((e: Error) => e);
    expect((err as Error).message).toContain('unreadable');
    expect((err as Error).message).not.toContain(SENTINEL);
  });
});
