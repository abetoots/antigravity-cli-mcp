import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function issueTicket(request: Record<string, unknown>): Promise<string> {
  const helper = process.env.AI_DELEGATION_TICKET_HELPER ?? join(homedir(), 'ai-cli-sync', 'bin', 'delegation-ticket');
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['issue'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('ticket helper timed out')); }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('ticket helper could not run')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const ticketId: unknown = JSON.parse(output).ticket_id;
        if (code !== 0 || typeof ticketId !== 'string' || !/^[0-9a-f]{32}$/.test(ticketId)) throw new Error();
        resolve(ticketId);
      } catch { reject(new Error('ticket helper failed')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
