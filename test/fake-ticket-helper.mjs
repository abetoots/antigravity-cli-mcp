#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.env.FAKE_TICKET_LOG, JSON.stringify(request) + '\n');
const fields = ['parent_harness', 'dispatch_id', 'cwd', 'add_dirs', 'project', 'grant_id', 'revision', 'effective_hash', 'expires_at'];
const expiry = request?.expires_at;
const validTime = typeof expiry === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(expiry)
  && expiry.slice(0, 4) !== '0000' && !Number.isNaN(Date.parse(expiry))
  && new Date(expiry).toISOString() === expiry.replace('Z', '.000Z');
if (!request || typeof request !== 'object' || Array.isArray(request)
  || Object.keys(request).length !== fields.length || !fields.every((field) => Object.hasOwn(request, field))
  || !Array.isArray(request.add_dirs) || ![request.cwd, ...request.add_dirs].every((path) => typeof path === 'string' && isAbsolute(path))
  || !validTime) {
  process.stdout.write(JSON.stringify({ allowed: false, reason: 'bad-request' }));
  process.exit(2);
}
if (process.env.FAKE_TICKET_MODE === 'exit') process.exit(1);
if (process.env.FAKE_TICKET_MODE === 'bad') process.stdout.write('unreadable');
else if (process.env.FAKE_TICKET_MODE === 'invalid-id') process.stdout.write(JSON.stringify({ ticket_id: 'invalid' }));
else process.stdout.write(JSON.stringify({ ticket_id: randomBytes(16).toString('hex') }));
