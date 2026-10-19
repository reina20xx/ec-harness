import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as path from 'node:path';
import * as fs from 'node:fs';
import app from './index';
import { createLocalD1 } from './db/local-d1';
import { Env } from './types';

const PORT = 8788;
const schemaFile = path.resolve(__dirname, '../schema.sql');
const dbFile = path.resolve(__dirname, '../local.db');

console.log('⚡ Initializing local SQLite database for EC Harness...');
const localD1 = createLocalD1(dbFile, schemaFile);

const localEnv: Env = {
  DB: localD1,
  STORE_NAME: 'Harness D2C Store',
  RECOVERY_DISCOUNT_CODE: 'COMEBACK10',
  RECOVERY_DISCOUNT_PERCENT: '10',
  ABANDON_THRESHOLD_MINUTES: '60',
  AGENT_API_KEY: 'test-agent-key'
};

app.use('/*', serveStatic({ root: './public' }));
app.get('/', (c) => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf-8');
  return c.html(html);
});

console.log(`
=====================================================
🚀 EC Harness Local Dev Server Running!
   URL: http://localhost:${PORT}
   Dashboard API: http://localhost:${PORT}/api/dashboard
   Agent Tools: http://localhost:${PORT}/api/agent/tools
=====================================================
`);

serve({
  fetch: (req) => app.fetch(req, localEnv),
  port: PORT
});
