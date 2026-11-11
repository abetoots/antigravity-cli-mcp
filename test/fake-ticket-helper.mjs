#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.env.FAKE_TICKET_REQUEST, input);
if (process.env.FAKE_TICKET_MODE === 'exit') process.exit(1);
if (process.env.FAKE_TICKET_MODE === 'bad') process.stdout.write('unreadable');
else if (process.env.FAKE_TICKET_MODE === 'invalid-id') process.stdout.write(JSON.stringify({ ticket_id: 'invalid' }));
else process.stdout.write(JSON.stringify({ ticket_id: '0123456789abcdef0123456789abcdef' }));
