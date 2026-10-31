// asks the hub's grant checker (bin/grant-check) whether an Antigravity session may start or continue.
// the wire format is the checker's snake_case json; toWire/fromWire are the one place it meets
// this package's camelCase. the checker is spawned without a shell and never takes a grant from
// anywhere but this request.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GrantRequest {
  phase: 'start' | 'resume';
  harness: 'codex' | 'gemini';
  cwd: string;
  addDirs: string[];
  grantId: string | null;
  revision: number | null;
  // read only on resume: null means the thread is bound to no project
  boundProject: string | null;
}

export interface GrantDecision {
  allowed: boolean;
  reason: string;
  project: string | null;
  grantRevision: number | null;
  expiresAt: string | null;
  roots: string[];
  effectiveHash: string;
}

export function toWire(req: GrantRequest): Record<string, unknown> {
  return {
    phase: req.phase,
    harness: req.harness,
    cwd: req.cwd,
    add_dirs: req.addDirs,
    grant_id: req.grantId,
    revision: req.revision,
    bound_project: req.boundProject,
  };
}

export function fromWire(wire: unknown): GrantDecision {
  const w = wire as Record<string, unknown> | null;
  const ok =
    typeof w === 'object' &&
    w !== null &&
    typeof w.allowed === 'boolean' &&
    typeof w.reason === 'string' &&
    (w.project === null || typeof w.project === 'string') &&
    (w.grant_revision === null || typeof w.grant_revision === 'number') &&
    (w.expires_at === null || typeof w.expires_at === 'string') &&
    Array.isArray(w.roots) &&
    typeof w.effective_hash === 'string';
  if (!ok) throw new Error('grant checker returned a malformed decision');
  return {
    allowed: w.allowed as boolean,
    reason: w.reason as string,
    project: w.project as string | null,
    grantRevision: w.grant_revision as number | null,
    expiresAt: w.expires_at as string | null,
    roots: w.roots as string[],
    effectiveHash: w.effective_hash as string,
  };
}

// AI_GRANT_CHECK, else $HOME/ai-cli-sync/bin/grant-check
export function defaultCheckerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_GRANT_CHECK ?? join(homedir(), 'ai-cli-sync', 'bin', 'grant-check');
}

const CHECK_TIMEOUT_MS = 10_000;

export class GrantClient {
  constructor(private readonly checkerPath: string) {}

  // exit 0 and 2 carry a decision; anything else -- a missing checker, exit 3 (unreadable
  // registry), a timeout, bad output -- rejects, so callers fail closed. a decision is allowed
  // only when the exit is 0 AND its json says so.
  check(req: GrantRequest): Promise<GrantDecision> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.checkerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { err += chunk; });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('grant checker timed out'));
      }, CHECK_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`grant checker could not run: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== 2) {
          reject(new Error(`grant checker exited ${code}${code === 3 ? `: ${err.trim()} — run bin/plan to see why` : ''}`));
          return;
        }
        let decision: GrantDecision;
        try {
          decision = fromWire(JSON.parse(out));
        } catch {
          reject(new Error('grant checker returned unreadable output'));
          return;
        }
        if (code !== 0 && decision.allowed) {
          decision = { ...decision, allowed: false, reason: 'checker-exit-mismatch' };
        }
        resolve(decision);
      });
      child.stdin.on('error', () => {
        // the close handler reports the failure
      });
      child.stdin.end(JSON.stringify(toWire(req)));
    });
  }
}
