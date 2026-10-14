import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';

const FAKE_AGY = resolve(import.meta.dirname, '../test/fake-agy.mjs');

let client: Client;

beforeAll(() => {
  chmodSync(FAKE_AGY, 0o755);
});

beforeEach(async () => {
  // AGY_BIN is read per call, and vitest isolates env per test file
  process.env.AGY_BIN = FAKE_AGY;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ keepaliveMs: 50 }).connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
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
    expect(argv).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json']);
  });

  it('passes model, effort and timeout through when provided', async () => {
    const argv = echoedArgv(
      await call('antigravity', { prompt: 'hi', model: 'claude-opus-5-5', effort: 'high', timeout: '20m' }),
    );

    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'high', '--print-timeout', '20m']));
  });

  it('does not skip permissions unless explicitly asked', async () => {
    const defaults = echoedArgv(await call('antigravity', { prompt: 'hi' }));
    const opted = echoedArgv(await call('antigravity', { prompt: 'hi', dangerously_skip_permissions: true }));

    expect(defaults).not.toContain('--dangerously-skip-permissions');
    expect(opted).toContain('--dangerously-skip-permissions');
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

    expect(messages).toEqual(['running view_file', 'responding']);
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
    const result = await call('antigravity-reply', { conversation_id: 'conv-9', prompt: 'more', effort: 'low' });
    const argv = echoedArgv(result);

    expect(result.structuredContent).toMatchObject({ conversation_id: 'conv-9' });
    expect(argv).toEqual(expect.arrayContaining(['--conversation', 'conv-9', '--effort', 'low']));
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--print-timeout');
  });
});
