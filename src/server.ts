import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { runAgy as defaultRunAgy, type AgyOptions, type AgyResult, type StepUpdate } from './agy.js';
import { BindingUnreadable, loadBinding, saveBinding } from './conversation-binding.js';
import { GrantClient, defaultCheckerPath, type GrantDecision } from './grant-client.js';
import { issueTicket } from './ticket-client.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const KEEPALIVE_MS = 10_000;

const sharedInput = {
  prompt: z.string().min(1).describe('The task or question for the Antigravity agent.'),
  model: z
    .string()
    .optional()
    .describe(
      'Model override. Omit to use the model selected in the Antigravity CLI. ' +
        'Accepts an id or display name from `agy models` (e.g. "claude-opus-5-5-high", "Gemini 3.8 Flash (High)"), ' +
        'or a base id such as "claude-opus-5-5" when combined with `effort`.',
    ),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe(
      'Reasoning effort override. Omit to use the CLI default. Applies to `model` if given, otherwise to the CLI-selected model. ' +
        'Do not combine with a model id that already ends in an effort suffix (e.g. "-high"); the CLI rejects that.',
    ),
  timeout: z
    .string()
    .regex(/^\d+(ms|s|m|h)$/)
    .optional()
    .describe('Optional time limit such as "10m" or "1h". Omit to wait until the turn completes (no limit).'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the agent. Defaults to the directory this MCP server was launched from.'),
  add_dirs: z.array(z.string()).optional().describe('Extra directories to add to the agent workspace. Relative paths resolve against `cwd`.'),
  // "plan" is deliberately not offered: headless plan mode blocks commands and url reads even
  // with permissions skipped, so reviewers picking it as "read-only" got empty responses
  mode: z
    .enum(['accept-edits'])
    .optional()
    .describe('Agent execution mode. Omit to use the CLI default.'),
};

const startOnlyInput = {
  sandbox: z.boolean().optional().describe('Run with terminal restrictions enabled. Fixed for the conversation when it starts.'),
  dangerously_skip_permissions: z
    .boolean()
    .default(true)
    .describe(
      'Auto-approve every tool permission (default true), so the agent can run commands and read files. ' +
        'Set false to follow the CLI permission settings instead; headless runs then auto-deny anything ' +
        'not allowed there (reported in denied_actions). Combine with sandbox for terminal restrictions. ' +
        'Fixed for the conversation when it starts.',
    ),
  grant: z
    .string()
    .min(1)
    .optional()
    .describe('Optional session grant id issued by the hub (bin/grant). Binds the conversation to the grant\'s project, task and expiry.'),
};

// reply cannot change what the conversation was started with: a differing value is refused,
// an equal or omitted one uses the bound value
const replyOnlyInput = {
  sandbox: z.boolean().optional().describe('Must equal the value the conversation started with, or be omitted; a different value is refused.'),
  dangerously_skip_permissions: z
    .boolean()
    .optional()
    .describe('Must equal the value the conversation started with, or be omitted; a different value is refused.'),
};

const outputSchema = {
  conversation_id: z.string(),
  status: z.string(),
  response: z.string(),
  error: z.string().optional(),
  duration_seconds: z.number(),
  num_turns: z.number(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      thinking_tokens: z.number(),
      cache_read_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  denied_actions: z.array(z.object({ action: z.string(), display_name: z.string() })).optional(),
  timed_out_after: z.string().optional(),
};

type SharedArgs = {
  prompt: string;
  model?: string;
  effort?: AgyOptions['effort'];
  timeout?: string;
  cwd?: string;
  add_dirs?: string[];
  mode?: AgyOptions['mode'];
  sandbox?: boolean;
  dangerously_skip_permissions?: boolean;
};

export function toAgyOptions(args: SharedArgs, conversationId?: string): AgyOptions {
  return {
    prompt: args.prompt,
    model: args.model,
    effort: args.effort,
    timeout: args.timeout,
    conversationId,
    cwd: args.cwd,
    addDirs: args.add_dirs,
    mode: args.mode,
    sandbox: args.sandbox,
    dangerouslySkipPermissions: args.dangerously_skip_permissions,
  };
}

export function formatResult(result: AgyResult): CallToolResult {
  const ok = result.status === 'SUCCESS' && !result.timed_out_after;
  const parts: string[] = [];
  if (result.response) parts.push(result.response.trimEnd());
  if (result.timed_out_after) {
    parts.push(
      `Antigravity stopped after the requested timeout (${result.timed_out_after}) with the turn still in progress; ` +
        'the response above, if any, is partial. Retry without `timeout` to wait for completion, ' +
        'or continue with antigravity-reply.',
    );
  } else if (!ok) parts.push(`Antigravity run failed (${result.status}): ${result.error ?? 'no error message'}`);
  if (result.denied_actions?.length) {
    const names = result.denied_actions.map((a) => a.display_name || a.action).join(', ');
    parts.push(
      `Note: headless mode auto-denied these permissions: ${names}. ` +
        'Allow them in the CLI settings or retry without dangerously_skip_permissions: false.',
    );
  }
  if (result.conversation_id) parts.push(`conversation_id: ${result.conversation_id}`);
  return {
    content: [{ type: 'text', text: parts.join('\n\n') || '(empty response)' }],
    structuredContent: { ...result },
    isError: !ok,
  };
}

function describeStep(step: StepUpdate): string | undefined {
  if (step.step_type === 'tool' && step.state === 'ACTIVE' && step.tool_name) return `running ${step.tool_name}`;
  if (step.step_type === 'agent_response' && step.state === 'ACTIVE') return 'responding';
  return undefined;
}

// the real path when the directory exists, else the plain absolute path
function resolvePath(p: string, base?: string): string {
  const abs = base === undefined ? resolve(p) : resolve(base, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

const sameSet = (a: string[], b: string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const refusal = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

// what the handler decided before spawning agy: either a refusal, or the options to run with and
// what to do with the result
type Prepared = CallToolResult | { opts: AgyOptions; finish: (result: AgyResult) => Promise<CallToolResult>; delegationUnavailable?: boolean };

export interface ServerDeps {
  keepaliveMs?: number;
  runAgy?: typeof defaultRunAgy;
  grants?: GrantClient;
}

export function createServer({ keepaliveMs = KEEPALIVE_MS, runAgy = defaultRunAgy, grants }: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: 'antigravity', version: '0.1.0' });
  // the checker path is read per call, like AGY_BIN
  const checker = (): GrantClient => grants ?? new GrantClient(defaultCheckerPath());

  // one promise chain per conversation: a reply waits for the one before it, and everything it
  // checks is checked after that wait
  const chains = new Map<string, Promise<unknown>>();
  const enqueue = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const next = (chains.get(id) ?? Promise.resolve()).then(task, task);
    const tail = next.catch(() => undefined);
    chains.set(id, tail);
    void tail.then(() => {
      if (chains.get(id) === tail) chains.delete(id);
    });
    return next;
  };

  const checkGrant = async (req: Parameters<GrantClient['check']>[0]): Promise<GrantDecision | CallToolResult> => {
    try {
      const decision = await checker().check(req);
      return decision.allowed
        ? decision
        : refusal(`refused by the grant check (${decision.reason}). Nothing was sent to Antigravity.`);
    } catch (err) {
      // the client's messages never carry checker output
      return refusal(`refused: ${(err as Error).message}. Nothing was sent to Antigravity.`);
    }
  };

  const run = async (extra: ToolExtra, prepare: () => Promise<Prepared>, chainKey?: string): Promise<CallToolResult> => {
    const progressToken = extra._meta?.progressToken;
    let progress = 0;
    let lastMessage = 'working';
    const notify = (message: string) => {
      if (progressToken === undefined) return;
      // progress must strictly increase; there is no known total for an agent run
      void extra
        .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress, message } })
        .catch(() => {
          // best effort: a closed connection shouldn't fail the run
        });
    };
    // keepalive so a long silent step doesn't trip the client's idle timeout
    // (claude code aborts stdio tool calls after 30 min without a response or progress)
    const keepalive = progressToken === undefined ? undefined : setInterval(() => notify(lastMessage), keepaliveMs);
    const go = async (): Promise<CallToolResult> => {
      const prepared = await prepare();
      if ('content' in prepared) return prepared;
      let result: CallToolResult;
      try {
        const agyResult = await runAgy(prepared.opts, {
          signal: extra.signal,
          onStep: (step) => {
            const message = describeStep(step);
            if (!message) return;
            lastMessage = message;
            notify(message);
          },
        });
        result = await prepared.finish(agyResult);
      } catch (err) {
        result = refusal((err as Error).message);
      }
      if (prepared.delegationUnavailable && result.content[0]?.type === 'text') {
        result.content[0].text = `Delegation is unavailable for this conversation.\n\n${result.content[0].text}`;
      }
      return result;
    };
    try {
      return await (chainKey === undefined ? go() : enqueue(chainKey, go));
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    } finally {
      clearInterval(keepalive);
    }
  };

  const start = async (args: SharedArgs & { grant?: string }): Promise<Prepared> => {
    const dispatchId = randomUUID();
    const cwd = resolvePath(args.cwd ?? process.cwd());
    const addDirs = (args.add_dirs ?? []).map((d) => resolvePath(d, cwd));
    const sandbox = args.sandbox === true;
    const skipPermissions = args.dangerously_skip_permissions ?? true;
    const decision = await checkGrant({
      phase: 'start',
      harness: 'gemini',
      cwd,
      addDirs,
      grantId: args.grant ?? null,
      revision: null,
      boundProject: null,
    });
    if ('content' in decision) return decision;
    let ticketId: string | undefined;
    try {
      const deadline = Date.now() + 8 * 60 * 60 * 1000;
      const expiry = decision.expiresAt === null ? deadline : Math.min(deadline, Date.parse(decision.expiresAt));
      ticketId = await issueTicket({
        parent_harness: 'gemini', dispatch_id: dispatchId, cwd, add_dirs: addDirs,
        project: decision.project, grant_id: args.grant ?? null, revision: decision.grantRevision,
        effective_hash: decision.effectiveHash, expires_at: new Date(expiry).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      });
    } catch {
      // A failed ticket leaves the conversation usable but without delegation.
    }
    return {
      delegationUnavailable: ticketId === undefined,
      opts: { ...toAgyOptions(args), cwd, addDirs, sandbox, dangerouslySkipPermissions: skipPermissions, ticketId },
      finish: async (result) => {
        if (!result.conversation_id) {
          // nothing to bind: a failed run is reported as such, a successful one cannot be continued safely
          if (result.status !== 'SUCCESS') return formatResult(result);
          return refusal('Antigravity returned no conversation_id, so the conversation cannot be bound to its project.');
        }
        try {
          await saveBinding({
            schema: 2,
            ...(ticketId === undefined ? {} : { ticketId }),
            conversationId: result.conversation_id,
            cwd,
            addDirs,
            project: decision.project,
            grantId: args.grant ?? null,
            grantRevision: decision.grantRevision,
            expiresAt: decision.expiresAt,
            effectiveHash: decision.effectiveHash,
            sandbox,
            skipPermissions,
            createdAt: new Date().toISOString(),
          });
        } catch {
          return refusal('could not save the conversation binding; the conversation_id was not released.');
        }
        return formatResult(result);
      },
    };
  };

  // runs inside the conversation's chain, after any queue wait, right before agy is spawned
  const reply = async (conversationId: string, args: SharedArgs): Promise<Prepared> => {
    let bound;
    try {
      bound = await loadBinding(conversationId);
    } catch (err) {
      if (err instanceof BindingUnreadable) return refusal(`refused: ${err.message}.`);
      return refusal('refused: the conversation binding could not be read.');
    }
    if (!bound) {
      return refusal('refused: no binding for this conversation (it was not started through this wrapper, or its state was lost).');
    }
    if (args.cwd !== undefined && resolvePath(args.cwd) !== bound.cwd) {
      return refusal('refused: cwd differs from the directory the conversation was started in.');
    }
    if (args.add_dirs !== undefined && !sameSet(args.add_dirs.map((d) => resolvePath(d, bound.cwd)), bound.addDirs)) {
      return refusal('refused: add_dirs differ from the directories the conversation was started with.');
    }
    if (args.sandbox !== undefined && args.sandbox !== bound.sandbox) {
      return refusal('refused: sandbox differs from the value the conversation was started with; start a new conversation to change it.');
    }
    if (args.dangerously_skip_permissions !== undefined && args.dangerously_skip_permissions !== bound.skipPermissions) {
      return refusal(
        'refused: dangerously_skip_permissions differs from the value the conversation was started with; start a new conversation to change it.',
      );
    }
    const decision = await checkGrant({
      phase: 'resume',
      harness: 'gemini',
      cwd: bound.cwd,
      addDirs: bound.addDirs,
      grantId: bound.grantId,
      revision: bound.grantRevision,
      boundProject: bound.project,
    });
    if ('content' in decision) return decision;
    if (decision.effectiveHash !== bound.effectiveHash) {
      return refusal('refused: the project\'s standing scope changed since this conversation started; start a new one.');
    }
    return {
      // the bound settings win over anything the caller passed
      opts: {
        ...toAgyOptions(args, conversationId),
        cwd: bound.cwd,
        addDirs: bound.addDirs,
        sandbox: bound.sandbox,
        dangerouslySkipPermissions: bound.skipPermissions,
        ticketId: bound.ticketId,
      },
      finish: async (result) => formatResult(result),
    };
  };

  server.registerTool(
    'antigravity',
    {
      title: 'Run Antigravity agent',
      description:
        'Start a new Google Antigravity (agy) agent session in headless mode and return its final response. ' +
        'Model, reasoning effort and time limit come from the Antigravity CLI configuration unless overridden. ' +
        'Returns a conversation_id that can be continued with antigravity-reply.',
      inputSchema: { ...sharedInput, ...startOnlyInput },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args, extra) => run(extra, () => start(args)),
  );

  server.registerTool(
    'antigravity-reply',
    {
      title: 'Continue Antigravity conversation',
      description:
        'Send a follow-up prompt to an existing Antigravity conversation, using the conversation_id returned by antigravity. ' +
        'The conversation keeps the cwd, add_dirs, sandbox and dangerously_skip_permissions it started with: ' +
        'a different value for any of them is refused (relative add_dirs resolve against the conversation\'s cwd); ' +
        'start a new conversation to change them.',
      inputSchema: {
        conversation_id: z.string().min(1).describe('conversation_id from a previous call.'),
        ...sharedInput,
        ...replyOnlyInput,
      },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ conversation_id, ...args }, extra) => run(extra, () => reply(conversation_id, args), conversation_id),
  );

  return server;
}
