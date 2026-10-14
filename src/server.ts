import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runAgy, type AgyOptions, type AgyResult, type StepUpdate } from './agy.js';

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
  add_dirs: z.array(z.string()).optional().describe('Extra directories to add to the agent workspace.'),
  // "plan" is deliberately not offered: headless plan mode blocks commands and url reads even
  // with permissions skipped, so reviewers picking it as "read-only" got empty responses
  mode: z
    .enum(['accept-edits'])
    .optional()
    .describe('Agent execution mode. Omit to use the CLI default.'),
  sandbox: z.boolean().optional().describe('Run with terminal restrictions enabled.'),
  dangerously_skip_permissions: z
    .boolean()
    .default(true)
    .describe(
      'Auto-approve every tool permission (default true), so the agent can run commands and read files. ' +
        'Set false to follow the CLI permission settings instead; headless runs then auto-deny anything ' +
        'not allowed there (reported in denied_actions). Combine with sandbox for terminal restrictions.',
    ),
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

export function createServer({ keepaliveMs = KEEPALIVE_MS }: { keepaliveMs?: number } = {}): McpServer {
  const server = new McpServer({ name: 'antigravity', version: '0.1.0' });

  const run = async (opts: AgyOptions, extra: ToolExtra): Promise<CallToolResult> => {
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
    try {
      const result = await runAgy(opts, {
        signal: extra.signal,
        onStep: (step) => {
          const message = describeStep(step);
          if (!message) return;
          lastMessage = message;
          notify(message);
        },
      });
      return formatResult(result);
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    } finally {
      clearInterval(keepalive);
    }
  };

  server.registerTool(
    'antigravity',
    {
      title: 'Run Antigravity agent',
      description:
        'Start a new Google Antigravity (agy) agent session in headless mode and return its final response. ' +
        'Model, reasoning effort and time limit come from the Antigravity CLI configuration unless overridden. ' +
        'Returns a conversation_id that can be continued with antigravity-reply.',
      inputSchema: sharedInput,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args, extra) => run(toAgyOptions(args), extra),
  );

  server.registerTool(
    'antigravity-reply',
    {
      title: 'Continue Antigravity conversation',
      description:
        'Send a follow-up prompt to an existing Antigravity conversation, using the conversation_id returned by antigravity.',
      inputSchema: { conversation_id: z.string().min(1).describe('conversation_id from a previous call.'), ...sharedInput },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ conversation_id, ...args }, extra) => run(toAgyOptions(args, conversation_id), extra),
  );

  return server;
}
