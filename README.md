# antigravity-mcp

Local stdio MCP server that runs the Google Antigravity CLI (`agy`) in headless mode.

It is a thin wrapper: **model, reasoning effort, time limit, and permissions come from the CLI's own
configuration unless a call overrides them.** Nothing is pinned by the server.

| Setting | Default when not passed | Override |
|---|---|---|
| Model | `"model"` in `~/.gemini/antigravity-cli/settings.json` (what `/model` sets) | `model` |
| Effort | the selected model's default | `effort` (`low`…`max`, validated by the CLI per model) |
| Time limit | none: `--print-timeout` defaults to `0s` ("waits until the turn completes") in agy ≥1.3 | `timeout` (e.g. `"20m"`) |
| Permissions | CLI settings (`toolPermission`, `permissions.allow`); anything else is auto-denied headless | `dangerously_skip_permissions` |

## Tools

- `antigravity`: start a session. Params: `prompt` plus optional `model`, `effort`, `timeout`, `cwd`, `add_dirs`, `mode`, `sandbox`, `dangerously_skip_permissions`.
- `antigravity-reply`: continue a session by `conversation_id`, with the same optional overrides.

Both return the final response as text plus `structuredContent` (`conversation_id`, `status`, `usage`, `denied_actions`, …).
They send MCP progress notifications on each tool step (plus a 10s keepalive), and cancelling the call kills the `agy` process.

Prompts are sent over stdin (`--input-format stream-json`), so there is no argv size limit.

### Timeouts

When `timeout` is set and hit, `agy` still reports `status: SUCCESS` with partial output and only notes the cutoff on
stderr. This server detects that notice and returns a tool error with `timed_out_after`, so a cutoff never looks like a
finished answer.

### Model and effort

`agy models` lists ids with the effort baked in (`claude-opus-5-5-high`). To pass `effort` separately, use the base id
(`claude-opus-5-5`) or omit `model` to apply the effort to the CLI's selected model. Combining a suffixed id with `effort`
is rejected by the CLI and returned as a tool error.

## Install

```sh
npm install && npm run build
claude mcp remove antigravity -s user
claude mcp add antigravity -s user -- node /home/anon/antigravity-mcp/dist/index.js
```

Set `AGY_BIN` if `agy` is not at `~/.local/bin/agy` or on `PATH`.

### Client-side timeout

The server imposes no limit, but the MCP *client* may. In Claude Code, set `MCP_TOOL_TIMEOUT` (milliseconds) high enough
for long agent runs.

## Development

```sh
npm test        # vitest, uses test/fake-agy.mjs instead of the real cli
npm run build
```
