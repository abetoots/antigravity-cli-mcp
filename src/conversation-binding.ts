// the on-disk record that ties an Antigravity conversation to the project, grant and settings it
// was started with, so antigravity-reply can resume it after a restart without trusting the
// caller. knows nothing about MCP or agy -- src/server.ts owns when to save and load.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface ConversationBinding {
  schema: 1 | 2;
  ticketId?: string;
  conversationId: string;
  cwd: string;
  addDirs: string[];
  project: string | null;
  grantId: string | null;
  grantRevision: number | null;
  expiresAt: string | null;
  effectiveHash: string;
  sandbox: boolean;
  skipPermissions: boolean;
  createdAt: string;
}

// the file is missing its schema, is not json, or does not describe this conversation. never
// carries file contents in its message.
export class BindingUnreadable extends Error {
  constructor(conversationId: string, reason: string) {
    super(`binding for conversation ${conversationId} is unreadable: ${reason}`);
    this.name = 'BindingUnreadable';
  }
}

// ANTIGRAVITY_MCP_STATE_DIR, else ~/.local/state/antigravity-mcp/bindings; read per call
export function defaultBindingDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_MCP_STATE_DIR ?? join(homedir(), '.local', 'state', 'antigravity-mcp', 'bindings');
}

const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
const isIntOrNull = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isInteger(v));

function validate(conversationId: string, value: unknown): ConversationBinding {
  const b = value as Partial<Record<keyof ConversationBinding, unknown>> | null;
  if (typeof b !== 'object' || b === null || (b.schema !== 1 && b.schema !== 2)) throw new BindingUnreadable(conversationId, 'wrong schema');
  const ok =
    (b.schema === 1 ? b.ticketId === undefined : b.ticketId === undefined || (typeof b.ticketId === 'string' && /^[0-9a-f]{32}$/.test(b.ticketId))) &&
    b.conversationId === conversationId &&
    typeof b.cwd === 'string' &&
    isAbsolute(b.cwd) &&
    Array.isArray(b.addDirs) &&
    b.addDirs.every((d) => typeof d === 'string' && isAbsolute(d)) &&
    isStringOrNull(b.project) &&
    isStringOrNull(b.grantId) &&
    isIntOrNull(b.grantRevision) &&
    isStringOrNull(b.expiresAt) &&
    typeof b.effectiveHash === 'string' &&
    typeof b.sandbox === 'boolean' &&
    typeof b.skipPermissions === 'boolean' &&
    typeof b.createdAt === 'string';
  if (!ok) throw new BindingUnreadable(conversationId, 'missing or mistyped fields');
  return b as unknown as ConversationBinding;
}

function fileFor(dir: string, conversationId: string): string {
  return join(dir, `${createHash('sha256').update(conversationId).digest('hex')}.json`);
}

// temp file then rename, so a crash never leaves a half-written binding under the real name
export async function saveBinding(binding: ConversationBinding, dir = defaultBindingDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = fileFor(dir, binding.conversationId);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

export async function loadBinding(conversationId: string, dir = defaultBindingDir()): Promise<ConversationBinding | undefined> {
  let raw: string;
  try {
    raw = await readFile(fileFor(dir, conversationId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new BindingUnreadable(conversationId, 'cannot be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BindingUnreadable(conversationId, 'not valid json');
  }
  return validate(conversationId, parsed);
}
