import { existsSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgy as realRunAgy, type AgyOptions } from './agy.js';
import { loadBinding, saveBinding, type ConversationBinding } from './conversation-binding.js';
import { fromWire, type GrantClient } from './grant-client.js';
import { createServer } from './server.js';

const FAKE_AGY = resolve(import.meta.dirname, '../test/fake-agy.mjs');
const FAKE_CHECKER = resolve(import.meta.dirname, '../test/fake-grant-check.mjs');

let client: Client;
let clients: Client[];
let dir: string;
let stateDir: string;
let project: string;
let agyCalls: AgyOptions[];

function wireDecision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed: true,
    reason: 'standing-scope',
    project: 'p1',
    grant_revision: null,
    expires_at: null,
    roots: ['/r'],
    effective_hash: 'h1',
    ...over,
  };
}

function setFixture(fixture: Record<string, unknown>): void {
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture));
}

function checkerRequests(): Record<string, unknown>[] {
  const log = join(dir, 'requests.log');
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function binding(over: Partial<ConversationBinding> = {}): ConversationBinding {
  return {
    schema: 1,
    conversationId: 'conv-9',
    cwd: project,
    addDirs: [],
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

const seed = (over: Partial<ConversationBinding> = {}) => saveBinding(binding(over), stateDir);

beforeAll(() => {
  chmodSync(FAKE_AGY, 0o755);
});

beforeEach(async () => {
  // AGY_BIN is read per call, and vitest isolates env per test file
  process.env.AGY_BIN = FAKE_AGY;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agy-server-')));
  project = join(dir, 'proj');
  mkdirSync(project);
  stateDir = join(dir, 'bindings');
  copyFileSync(FAKE_CHECKER, join(dir, 'grant-check.mjs'));
  chmodSync(join(dir, 'grant-check.mjs'), 0o755);
  setFixture({ decision: wireDecision() });
  process.env.AI_GRANT_CHECK = join(dir, 'grant-check.mjs');
  process.env.ANTIGRAVITY_MCP_STATE_DIR = stateDir;
  process.env.FAKE_AGY_RELEASE = join(dir, 'release');
  agyCalls = [];
  client = await connectServer(agyCalls);
  clients = [client];
});

// a new wrapper instance over the same binding store, like a restart
async function connectServer(calls: AgyOptions[], grants?: GrantClient): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({
    keepaliveMs: 50,
    grants,
    runAgy: (opts, hooks) => {
      calls.push(opts);
      return realRunAgy(opts, hooks);
    },
  }).connect(serverTransport);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientTransport);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

interface Echo {
  argv: string[];
  cwd: string;
  prompt: string;
}

function echoed(result: CallToolResult): Echo {
  const { response } = result.structuredContent as { response: string };
  return JSON.parse(response) as Echo;
}

function echoedArgv(result: CallToolResult): string[] {
  return echoed(result).argv;
}

describe('antigravity tool', () => {
  it('defers model, effort and timeout to the cli when not provided', async () => {
    const result = await call('antigravity', { prompt: 'hello' });

    expect(result.isError).toBe(false);
    const argv = echoedArgv(result);
    expect(argv).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ]);
  });

  it('passes model, effort and timeout through when provided', async () => {
    const argv = echoedArgv(
      await call('antigravity', { prompt: 'hi', model: 'claude-opus-5-5', effort: 'high', timeout: '20m' }),
    );

    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'high', '--print-timeout', '20m']));
  });

  it('skips permissions by default and lets the caller opt out', async () => {
    const defaults = echoedArgv(await call('antigravity', { prompt: 'hi' }));
    const optedOut = echoedArgv(await call('antigravity', { prompt: 'hi', dangerously_skip_permissions: false }));

    expect(defaults).toContain('--dangerously-skip-permissions');
    expect(optedOut).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses plan mode, which blocks commands headless', async () => {
    const result = await call('antigravity', { prompt: 'hi', mode: 'plan' });

    expect(result.isError).toBe(true);
  });

  it('delivers the prompt over stdin, never as a cli flag', async () => {
    const prompt = '--model is a flag\nand "quotes" survive';
    const echo = echoed(await call('antigravity', { prompt }));

    expect(echo.prompt).toBe(prompt);
    expect(echo.argv).not.toContain('--model');
  });

  it('accepts prompts larger than the 128 KiB argv limit', async () => {
    const prompt = 'x'.repeat(256 * 1024);
    const echo = echoed(await call('antigravity', { prompt }));

    expect(echo.prompt).toHaveLength(prompt.length);
  });

  it('runs the agent in the requested cwd with extra dirs', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agy-cwd-')));
    const parsed = echoed(await call('antigravity', { prompt: 'hi', cwd: dir, add_dirs: ['/a', '/b'] }));

    expect(parsed.cwd).toBe(dir);
    expect(parsed.argv).toEqual(expect.arrayContaining(['--add-dir', '/a', '--add-dir', '/b']));
  });

  it('rejects a malformed timeout before spawning', async () => {
    const result = await call('antigravity', { prompt: 'hi', timeout: 'soon' });

    expect(result.isError).toBe(true);
  });

  it('returns the conversation id in structured and text content', async () => {
    const result = await call('antigravity', { prompt: 'hi' });

    expect(result.structuredContent).toMatchObject({ conversation_id: 'conv-123', status: 'SUCCESS' });
    expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('conversation_id: conv-123') }));
  });

  it('surfaces cli errors such as invalid model selection as tool errors', async () => {
    const result = await call('antigravity', { prompt: 'fail' });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('invalid model selection') }));
  });

  it('explains auto-denied permissions', async () => {
    const result = await call('antigravity', { prompt: 'denied' });

    expect(result.isError).toBe(false);
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('auto-denied these permissions: RunCommand') }),
    );
  });

  it('reports stderr when the cli exits without a result', async () => {
    const result = await call('antigravity', { prompt: 'crash' });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('error: boom') }));
  });

  it('reports a missing cli binary clearly', async () => {
    process.env.AGY_BIN = '/nonexistent/agy';
    const result = await call('antigravity', { prompt: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('AGY_BIN') }));
  });

  it('flags a cli print timeout as an error even though agy reports success', async () => {
    const result = await call('antigravity', { prompt: 'timeout' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'SUCCESS', timed_out_after: '2s', response: 'partial' });
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('stopped after the requested timeout (2s)') }),
    );
  });

  it('sends progress notifications while the agent works', async () => {
    const messages: (string | undefined)[] = [];
    await client.callTool({ name: 'antigravity', arguments: { prompt: 'hi' } }, undefined, {
      onprogress: (p) => messages.push(p.message),
    });

    // the grant check before spawn can outlast one keepalive tick, which reports 'working', and under
    // load a keepalive can repeat a step, so consecutive duplicates collapse before the order check
    const steps = messages.filter((m) => m !== 'working').filter((m, i, all) => m !== all[i - 1]);
    expect(steps).toEqual(['running view_file', 'responding']);
  });

  it('keeps sending progress during a silent step so idle timeouts do not fire', async () => {
    const messages: (string | undefined)[] = [];
    const result = (await client.callTool({ name: 'antigravity', arguments: { prompt: 'slow' } }, undefined, {
      onprogress: (p) => messages.push(p.message),
    })) as CallToolResult;

    expect(result.isError).toBe(false);
    // 300ms of silence at a 50ms keepalive yields several repeats of the last step
    expect(messages.filter((m) => m === 'responding').length).toBeGreaterThanOrEqual(3);
  });

  it('kills the cli run when the client cancels', async () => {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'antigravity', arguments: { prompt: 'hang' } }, undefined, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);

    await expect(pending).rejects.toThrow();
  });
});

describe('antigravity-reply tool', () => {
  it('resumes the given conversation with optional overrides', async () => {
    await seed();
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', effort: 'low' });
    const argv = echoedArgv(result);

    expect(result.structuredContent).toMatchObject({ conversation_id: 'conv-9' });
    expect(argv).toEqual(expect.arrayContaining(['--conversation', 'conv-9', '--effort', 'low']));
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--print-timeout');
  });

  it('reply to an unknown conversation is refused', async () => {
    const result = await call('antigravity-reply', { conversation_id: 'nope', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
    expect(checkerRequests()).toHaveLength(0);
  });

  it('reply with a different cwd is refused', async () => {
    await seed();
    const other = join(dir, 'other');
    mkdirSync(other);
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', cwd: other });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('reply with different add_dirs is refused', async () => {
    await seed();
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', add_dirs: ['/elsewhere'] });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('reply with omitted cwd and add_dirs uses the bound values', async () => {
    const extra = join(dir, 'extra');
    mkdirSync(extra);
    await seed({ addDirs: [extra] });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(false);
    expect(echoed(result).cwd).toBe(project);
    expect(echoedArgv(result)).toEqual(expect.arrayContaining(['--add-dir', extra]));
    expect(checkerRequests()[0]).toMatchObject({ phase: 'resume', cwd: project, add_dirs: [extra], bound_project: 'p1' });
  });

  it('reply spawns agy in the bound cwd', async () => {
    await seed();
    const echo = echoed(await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' }));

    expect(echo.cwd).toBe(project);
  });

  it('reply after revoke is refused', async () => {
    await seed({ grantId: 'g1', grantRevision: 1 });
    setFixture({ decision: wireDecision({ allowed: false, reason: 'revoked' }) });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
    expect(checkerRequests()[0]).toMatchObject({ grant_id: 'g1', revision: 1 });
  });

  it('reply after expiry is refused', async () => {
    await seed({ grantId: 'g1', grantRevision: 1, expiresAt: '2026-01-01T00:00:00Z' });
    setFixture({ decision: wireDecision({ allowed: false, reason: 'expired' }) });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('reply after the project mapping changed is refused', async () => {
    await seed({ project: null });
    setFixture({ decision: wireDecision({ allowed: false, reason: 'project-changed' }) });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
    expect(checkerRequests()[0]).toMatchObject({ bound_project: null });
  });

  it('reply after the standing scope changed is refused', async () => {
    await seed();
    setFixture({ decision: wireDecision({ effective_hash: 'h2' }) });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('refuses when the checker says allowed but exits 2', async () => {
    await seed();
    setFixture({ decision: wireDecision(), exitWith: 2 });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('refuses when the checker cannot run', async () => {
    // an empty bound hash would match a made-up fail-open decision, so only the checker failure can refuse
    await seed({ effectiveHash: '' });
    process.env.AI_GRANT_CHECK = '/nonexistent/grant-check';
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('grant checker could not run');
    expect(agyCalls).toHaveLength(0);
  });

  it('never shows checker output in the error', async () => {
    await seed({ effectiveHash: '' });
    setFixture({ rawStdout: 'garbage S3CR3T' });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('S3CR3T');
    expect(JSON.stringify(result.content)).toContain('unreadable output');
    expect(agyCalls).toHaveLength(0);
  });

  it('refuses a binding file with a mistyped field', async () => {
    await seed();
    const file = readdirSync(stateDir)[0];
    writeFileSync(join(stateDir, file), JSON.stringify({ ...binding(), sandbox: 'yes' }));
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  // holds the first turn open on the gate, queues a second reply behind it, waits three keepalive
  // ticks, optionally revokes, then releases. the second reply must be checked once, after the wait.
  // the grants are an in-process stub, so the "no check yet" window does not depend on a subprocess
  async function queueBehindHeldTurn(revoke: boolean, restart: boolean): Promise<void> {
    await seed({ grantId: 'g1', grantRevision: 1 });
    if (restart) {
      // a first instance served a reply and went away; a new one reads the same store
      expect((await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'one' })).isError).toBe(false);
      await client.close();
    }
    let revoked = false;
    const stubCalls: Record<string, unknown>[] = [];
    const grants = {
      check: async (req: Record<string, unknown>) => {
        stubCalls.push(req);
        return fromWire(wireDecision(revoked ? { allowed: false, reason: 'revoked' } : {}));
      },
    } as unknown as GrantClient;
    const calls: AgyOptions[] = [];
    const c = await connectServer(calls, grants);
    clients.push(c);

    const first = c.callTool({ name: 'antigravity-reply', arguments: { conversation_id: 'conv-9', prompt: 'hold' } });
    while (calls.length === 0) await new Promise((r) => setImmediate(r));
    const checksBeforeSecond = stubCalls.length;
    let ticks = 0;
    let waited: () => void = () => {};
    const ready = new Promise<void>((r) => (waited = r));
    const second = c.callTool(
      { name: 'antigravity-reply', arguments: { conversation_id: 'conv-9', prompt: 'more' } },
      undefined,
      {
        onprogress: () => {
          if (++ticks === 3) waited();
        },
      },
    );
    // a second reply that returns without waiting fails here, not on the test timeout
    await Promise.race([
      ready,
      second.then(() => {
        throw new Error('the second reply returned before the first turn ended');
      }),
    ]);
    // still waiting behind the held turn: no check has run for it yet
    expect(stubCalls).toHaveLength(checksBeforeSecond);
    revoked = revoke;
    writeFileSync(process.env.FAKE_AGY_RELEASE as string, '');

    expect(((await first) as CallToolResult).isError).toBe(false);
    const queued = (await second) as CallToolResult;
    expect(stubCalls).toHaveLength(checksBeforeSecond + 1);
    if (revoke) {
      expect(queued.isError).toBe(true);
      expect(JSON.stringify(queued.content)).toContain('(revoked)');
      expect(calls).toHaveLength(1);
    } else {
      expect(queued.isError).toBe(false);
      expect(calls.map((o) => o.prompt)).toEqual(['hold', 'more']);
    }
  }

  it('revalidates after queue wait', async () => {
    await queueBehindHeldTurn(true, false);
  });

  it('a queued reply runs after the turn ahead of it when nothing changed', async () => {
    await queueBehindHeldTurn(false, false);
  });

  it('revalidates after queue wait on a restarted wrapper', async () => {
    await queueBehindHeldTurn(true, true);
  });

  it('a queued reply runs after the turn ahead of it on a restarted wrapper when nothing changed', async () => {
    await queueBehindHeldTurn(false, true);
  });

  it('reply with a looser sandbox than the bound one is refused', async () => {
    await seed({ sandbox: true });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', sandbox: false });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('sandbox');
    expect(agyCalls).toHaveLength(0);
  });

  it('reply with a tighter sandbox than the bound one is refused', async () => {
    await seed({ sandbox: false });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', sandbox: true });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it('reply with looser or tighter dangerously_skip_permissions is refused', async () => {
    await seed({ skipPermissions: false });
    const looser = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', dangerously_skip_permissions: true });
    await seed({ skipPermissions: true });
    const tighter = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', dangerously_skip_permissions: false });

    expect(looser.isError).toBe(true);
    expect(JSON.stringify(looser.content)).toContain('dangerously_skip_permissions');
    expect(tighter.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });

  it.each([
    { sandbox: true, skip: false },
    { sandbox: false, skip: true },
  ])('reply with equal or omitted sandbox and permissions proceeds with the bound values %j', async ({ sandbox, skip }) => {
    await seed({ sandbox, skipPermissions: skip });
    const equal = await call('antigravity-reply', {
      conversation_id: 'conv-9',
      prompt: 'more',
      sandbox,
      dangerously_skip_permissions: skip,
    });
    const omitted = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more' });

    for (const result of [equal, omitted]) {
      expect(result.isError).toBe(false);
      expect(echoedArgv(result).includes('--sandbox')).toBe(sandbox);
      expect(echoedArgv(result).includes('--dangerously-skip-permissions')).toBe(skip);
    }
  });

  it('reply resolves a relative add_dir against the bound cwd', async () => {
    const extra = join(dir, 'extra');
    mkdirSync(extra);
    await seed({ addDirs: [extra] });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', add_dirs: ['../extra'] });

    expect(result.isError).toBe(false);
    expect(echoedArgv(result)).toEqual(expect.arrayContaining(['--add-dir', extra]));
  });

  it('reply with a relative add_dir that resolves elsewhere is refused', async () => {
    const extra = join(dir, 'extra');
    mkdirSync(extra);
    await seed({ addDirs: [extra] });
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', add_dirs: ['extra'] });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
  });
});

describe('antigravity start binding', () => {
  it.each([
    ['cannot run', () => { process.env.AI_GRANT_CHECK = join(dir, 'missing-checker'); }, 'could not run'],
    ['exits 3', () => setFixture({ exit: 3 }), 'exited 3'],
    ['prints garbage S3CR3T', () => setFixture({ rawStdout: 'garbage S3CR3T' }), 'unreadable output'],
    ['prints a decision missing fields', () => setFixture({ rawStdout: JSON.stringify({ allowed: true, reason: 'x' }) }), 'unreadable output'],
  ])('start is refused, with no spawn and no binding, when the checker %s', async (_name, arrange, why) => {
    arrange();
    const result = await call('antigravity', { prompt: 'hi', cwd: project });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(why);
    expect(JSON.stringify(result)).not.toContain('S3CR3T');
    expect(agyCalls).toHaveLength(0);
    expect(existsSync(stateDir)).toBe(false);
  });


  it('a relative add_dir resolves against the call cwd, not the launch directory', async () => {
    mkdirSync(join(project, 'sub'));
    const result = await call('antigravity', { prompt: 'hi', cwd: project, add_dirs: ['sub'] });

    expect(result.isError).toBe(false);
    expect(checkerRequests()[0]).toMatchObject({ cwd: project, add_dirs: [join(project, 'sub')] });
    expect(echoedArgv(result)).toEqual(expect.arrayContaining(['--add-dir', join(project, 'sub')]));
    expect((await loadBinding('conv-123', stateDir))?.addDirs).toEqual([join(project, 'sub')]);
  });

  it('a relative add_dir that escapes the project is checked as the absolute outside path and refused', async () => {
    setFixture({ decision: wireDecision({ allowed: false, reason: 'outside-roots' }) });
    const result = await call('antigravity', { prompt: 'hi', cwd: project, add_dirs: ['../outside'] });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
    expect(checkerRequests()[0]).toMatchObject({ add_dirs: [join(dir, 'outside')] });
  });

  it('a project cwd with an add_dir outside the project is refused', async () => {
    setFixture({ decision: wireDecision({ allowed: false, reason: 'outside-roots' }) });
    const result = await call('antigravity', { prompt: 'hi', cwd: project, add_dirs: ['/elsewhere'] });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(0);
    expect(checkerRequests()[0]).toMatchObject({ phase: 'start', harness: 'gemini', cwd: project, add_dirs: ['/elsewhere'] });
  });

  it('start saves the binding under the returned conversation id', async () => {
    setFixture({ decision: wireDecision({ reason: 'granted', grant_revision: 3, expires_at: '2099-01-01T00:00:00Z' }) });
    const result = await call('antigravity', {
      prompt: 'hi S3CR3T',
      cwd: project,
      sandbox: true,
      dangerously_skip_permissions: false,
      grant: 'g1',
    });

    expect(result.isError).toBe(false);
    expect(checkerRequests()[0]).toMatchObject({ grant_id: 'g1', revision: null });
    expect(await loadBinding('conv-123', stateDir)).toMatchObject({
      conversationId: 'conv-123',
      cwd: project,
      addDirs: [],
      project: 'p1',
      grantId: 'g1',
      grantRevision: 3,
      expiresAt: '2099-01-01T00:00:00Z',
      effectiveHash: 'h1',
      sandbox: true,
      skipPermissions: false,
    });
    const files = readdirSync(stateDir);
    expect(files.map((f) => readFileSync(join(stateDir, f), 'utf8')).join('')).not.toContain('S3CR3T');
  });

  it('start without a conversation id in the result is an error', async () => {
    const result = await call('antigravity', { prompt: 'noid', cwd: project });

    expect(result.isError).toBe(true);
    expect(agyCalls).toHaveLength(1);
  });

  it('start with a failing binding save is an error', async () => {
    // a file where the state directory should be makes the save fail
    writeFileSync(stateDir, 'not a directory');
    const result = await call('antigravity', { prompt: 'hi', cwd: project });

    expect(result.isError).toBe(true);
  });

  it('deniedActions spelling is normalized to denied_actions objects', async () => {
    const result = await call('antigravity', { prompt: 'denied-camel', cwd: project });

    expect(result.structuredContent).toMatchObject({
      denied_actions: [
        { action: 'RunCommand', display_name: 'RunCommand' },
        { action: 'read', display_name: 'ReadFile' },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('deniedActions');
  });
});
