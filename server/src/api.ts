import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { authenticate, createApiKey, listApiKeys, setWebhook, type Account } from './accounts.ts';
import { safeEqual } from './crypto.ts';
import { db } from './db.ts';
import { env } from './env.ts';
import { buildMcpServer } from './mcp.ts';
import * as svc from './service.ts';

type Vars = { Variables: { acc: Account } };
export const app = new Hono<Vars>();

app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'mcp-session-id', 'mcp-protocol-version'] }));

app.get('/', (c) =>
  c.json({
    name: 'Groundproof API',
    docs: 'See README: REST under /v1, MCP at /mcp (Authorization: Bearer <api key>)',
  }),
);
app.get('/health', (c) => c.json({ ok: true }));

// Fraud-check results for the business dashboard. Contains only scores and
// short reasons, never answers or photos.
app.get('/v1/checks/:taskId', (c) => {
  const rows = db.prepare('SELECT worker, risk, verdict, flags, checked_at FROM checks WHERE task_id = ?').all(
    c.req.param('taskId'),
  ) as { worker: string; risk: number; verdict: string; flags: string; checked_at: number }[];
  return c.json(rows.map((r) => ({ ...r, flags: JSON.parse(r.flags) })));
});

const requireKey = async (c: Context<Vars>, next: () => Promise<void>) => {
  const acc = authenticate(c.req.header('authorization'));
  if (!acc) return c.json({ error: 'missing or invalid API key' }, 401);
  c.set('acc', acc);
  await next();
};

const handle = (fn: (c: Context<Vars>) => Promise<unknown>) => async (c: Context<Vars>) => {
  try {
    return c.json(await fn(c));
  } catch (e) {
    const status = e instanceof svc.ApiError ? e.status : 500;
    return c.json({ error: (e as Error).message }, status as 400);
  }
};

const v1 = new Hono<Vars>();
v1.use('*', requireKey);
v1.get('/account', handle((c) => svc.accountInfo(c.get('acc'))));
v1.get('/tasks', handle((c) => svc.listTasks(c.get('acc'))));
v1.post('/tasks', handle(async (c) => svc.postTask(c.get('acc'), await c.req.json())));
v1.get('/tasks/:id', handle((c) => svc.getTaskStatus(c.get('acc'), c.req.param('id')!)));
v1.get('/tasks/:id/results', handle((c) => svc.getResults(c.get('acc'), c.req.param('id')!, env.publicUrl)));
v1.post(
  '/tasks/:id/approve',
  handle(async (c) => svc.approve(c.get('acc'), c.req.param('id')!, (await c.req.json()).worker)),
);
v1.post(
  '/tasks/:id/reject',
  handle(async (c) => {
    const body = await c.req.json();
    return svc.reject(c.get('acc'), c.req.param('id')!, body.worker, !!body.fraud);
  }),
);
v1.post('/tasks/:id/close', handle((c) => svc.closeTask(c.get('acc'), c.req.param('id')!)));
v1.get('/tasks/:id/submissions/:worker/photos/:i', async (c) => {
  try {
    const bytes = await svc.getPhoto(c.get('acc'), c.req.param('id')!, c.req.param('worker')!, Number(c.req.param('i')!));
    return new Response(bytes as BodyInit, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
  } catch (e) {
    const status = e instanceof svc.ApiError ? e.status : 500;
    return c.json({ error: (e as Error).message }, status as 404);
  }
});
app.route('/v1', v1);

// Admin: create and list API keys from your laptop (Authorization: Bearer ADMIN_TOKEN).
const admin = new Hono();
admin.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!env.adminToken || env.adminToken.length < 24 || !safeEqual(token, env.adminToken)) {
    return c.json({ error: 'admin token missing or invalid' }, 401);
  }
  await next();
});
admin.get('/keys', (c) => c.json(listApiKeys()));
admin.post('/keys', async (c) => {
  const body = (await c.req.json()) as {
    name?: string;
    max_reward_usdc?: string;
    daily_limit_usdc?: string;
    webhook_url?: string;
  };
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  try {
    const key = createApiKey({
      name: body.name,
      maxRewardUsdc: body.max_reward_usdc,
      dailyLimitUsdc: body.daily_limit_usdc,
      webhookUrl: body.webhook_url,
    });
    return c.json({ ...key, note: 'Store apiKey and webhookSecret now; the API key cannot be shown again.' });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
admin.post('/keys/:id/webhook', async (c) => {
  const { url } = (await c.req.json()) as { url?: string | null };
  setWebhook(c.req.param('id'), url ?? null);
  return c.json({ ok: true });
});
app.route('/admin', admin);

// MCP over Streamable HTTP (stateless: a fresh server per request, bound to the API key).
app.all('/mcp', requireKey, async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildMcpServer(c.get('acc'), env.publicUrl);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
