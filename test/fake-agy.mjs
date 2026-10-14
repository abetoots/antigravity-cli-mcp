#!/usr/bin/env node
// stand-in for the agy cli: reads one stream-json turn from stdin, emits stream-json events,
// and echoes its argv, cwd and prompt back as the response
const argv = process.argv.slice(2);
const convFlag = argv.indexOf('--conversation');
const id = convFlag >= 0 ? argv[convFlag + 1] : 'conv-123';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const usage = { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 };
const result = (fields) =>
  emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', duration_seconds: 1, num_turns: 1, usage, ...fields } });

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
// mirror the real cli: a message without an "event" field ends the session
const message = JSON.parse(stdin.trim().split('\n')[0]);
if (message.event !== 'user') {
  process.stderr.write('error: missing event field\n');
  process.exit(1);
}
const prompt = message.message.content;

if (prompt === 'crash') {
  process.stderr.write('error: boom\n');
  process.exit(2);
}

emit({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: [] } });
emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' } });
emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'x' } });

if (prompt === 'slow') {
  setTimeout(() => result({ response: 'done' }), 300);
} else if (prompt === 'hang') {
  setTimeout(() => {}, 60_000);
} else if (prompt === 'timeout') {
  process.stderr.write('[agy] print timeout after 2s with turn in progress; returning partial output\n');
  result({ response: 'partial' });
} else if (prompt === 'fail') {
  result({ conversation_id: '', status: 'ERROR', error: 'invalid model selection', num_turns: 0 });
} else if (prompt === 'denied') {
  result({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
} else {
  result({ response: JSON.stringify({ argv, cwd: process.cwd(), prompt }) });
}
