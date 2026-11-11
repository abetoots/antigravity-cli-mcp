import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { env: { AI_DELEGATION_TICKET_HELPER: join(mkdtempSync(join(tmpdir(), 'agy-no-ticket-')), 'missing') } },
});
