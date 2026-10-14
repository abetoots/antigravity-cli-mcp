import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// stderr notice agy prints when --print-timeout cuts a turn short; the result event still says SUCCESS
const PRINT_TIMEOUT_NOTICE = /print timeout after (\S+) with turn in progress/;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Mode = 'accept-edits' | 'plan';

export interface AgyOptions {
  prompt: string;
  // every field below is optional on purpose: when omitted, the flag is not passed
  // and the cli's own configuration (~/.gemini/antigravity-cli/settings.json) decides
  model?: string;
  effort?: Effort;
  timeout?: string;
  conversationId?: string;
  cwd?: string;
  addDirs?: string[];
  mode?: Mode;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
}

export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface AgyResult {
  conversation_id: string;
  status: string;
  response: string;
  error?: string;
  duration_seconds: number;
  num_turns: number;
  usage?: AgyUsage;
  denied_actions?: { action: string; display_name: string }[];
  // set by this wrapper (not agy) when --print-timeout ended the turn early
  timed_out_after?: string;
}

export interface StepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
}

export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGY_BIN) return env.AGY_BIN;
  const local = join(homedir(), '.local', 'bin', 'agy');
  return existsSync(local) ? local : 'agy';
}

export function buildArgs(opts: AgyOptions): string[] {
  // the prompt goes over stdin (see stdinMessage), which avoids argv size limits and flag parsing
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.timeout) args.push('--print-timeout', opts.timeout);
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.sandbox) args.push('--sandbox');
  if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  return args;
}

// one ndjson turn for --input-format stream-json; closing stdin afterwards ends the session
export function stdinMessage(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

export interface RunHooks {
  onStep?: (step: StepUpdate) => void;
  signal?: AbortSignal;
  bin?: string;
}

export function runAgy(opts: AgyOptions, hooks: RunHooks = {}): Promise<AgyResult> {
  const args = buildArgs(opts);
  const bin = hooks.bin ?? resolveAgyBinary();

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: hooks.signal,
    });

    // epipe if agy exits before reading; the close handler reports the real failure
    child.stdin.on('error', () => {});
    child.stdin.end(stdinMessage(opts.prompt));

    let result: AgyResult | undefined;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event: { event?: string; result?: AgyResult; step_update?: StepUpdate };
      try {
        event = JSON.parse(line);
      } catch {
        // non-json noise on stdout is ignored; stderr carries diagnostics
        return;
      }
      if (event.event === 'result' && event.result) result = event.result;
      else if (event.event === 'step_update' && event.step_update) hooks.onStep?.(event.step_update);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') reject(new Error('Antigravity run was cancelled by the client.'));
      else if (err.code === 'ENOENT')
        reject(new Error(`Antigravity CLI not found at "${bin}". Install it or set AGY_BIN to its path.`));
      else reject(err);
    });

    child.on('close', (code) => {
      const timedOut = PRINT_TIMEOUT_NOTICE.exec(stderr);
      if (result && timedOut) return resolve({ ...result, timed_out_after: timedOut[1] });
      if (result) return resolve(result);
      reject(
        new Error(
          `agy exited with code ${code} without a result.` + (stderr.trim() ? `\n${stderr.trim()}` : ''),
        ),
      );
    });
  });
}
