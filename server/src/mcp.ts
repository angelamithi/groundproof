import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Account } from './accounts.ts';
import * as svc from './service.ts';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

async function guarded(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (e) {
    return { ...json({ error: (e as Error).message }), isError: true };
  }
}

/**
 * MCP tools an AI agent uses to get things checked on the ground in Africa.
 * One server instance per request, bound to the caller's API key.
 */
export function buildMcpServer(acc: Account, baseUrl: string): McpServer {
  const server = new McpServer({ name: 'groundproof', version: '0.1.0' });

  server.registerTool(
    'post_task',
    {
      title: 'Post a ground-truth task',
      description:
        'Pay verified local people in Africa to check something in the real world and return GPS-stamped photo proof. ' +
        'Kinds: business_check (does a business exist and operate at a place), price_photo (photograph and transcribe prices), ' +
        'language (translate, transcribe or record in a local language). The reward is held in escrow and only paid for approved work. ' +
        'Results usually arrive within hours; poll get_task_status or wait for the webhook.',
      inputSchema: {
        kind: z.enum(['business_check', 'price_photo', 'language']),
        location: z.string().describe('"lat, lng", a Google Maps link, or a geohash. For language tasks, the region of the speakers.'),
        instructions: z
          .string()
          .describe('Exactly what the worker should do and capture. Public on-chain: no personal data.'),
        reward_usdc: z.string().describe('Reward per worker in USDC, e.g. "2.00". Typical: 1–3 for a shop check.'),
        workers: z.number().int().min(1).max(50).optional().describe('Independent workers (2–3 lets you cross-check). Default 1.'),
        hours: z.number().min(1).max(2160).optional().describe('Deadline in hours. Default 48.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => guarded(() => svc.postTask(acc, args)),
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Task status',
      description: 'Status of a task and each worker submission, including the automated fraud check (risk 0–100, verdict, flags).',
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ task_id }) => guarded(() => svc.getTaskStatus(acc, task_id)),
  );

  server.registerTool(
    'get_result',
    {
      title: 'Get results',
      description:
        "Decrypted answers and photo details for each submission, with integrity and fraud-check results. Photo URLs require the same API key.",
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ task_id }) => guarded(() => svc.getResults(acc, task_id, baseUrl)),
  );

  server.registerTool(
    'approve_submission',
    {
      title: 'Approve and pay',
      description: 'Approve a submission: the worker is paid from escrow. Check fraud_check first; approve when verdict is "ok" and the answers are useful.',
      inputSchema: { task_id: z.string(), worker: z.string() },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ task_id, worker }) => guarded(() => svc.approve(acc, task_id, worker)),
  );

  server.registerTool(
    'reject_submission',
    {
      title: 'Reject a submission',
      description:
        'Reject unusable work. Set fraud=true only for fake or dishonest proof (adds a strike to the worker if it stands). ' +
        'The worker can dispute within 24 hours; a human verifier decides.',
      inputSchema: { task_id: z.string(), worker: z.string(), fraud: z.boolean().optional() },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ task_id, worker, fraud }) => guarded(() => svc.reject(acc, task_id, worker, fraud ?? false)),
  );

  server.registerTool(
    'close_task',
    {
      title: 'Close task and refund',
      description: 'Stop accepting workers and refund unused escrow to the account wallet.',
      inputSchema: { task_id: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ task_id }) => guarded(() => svc.closeTask(acc, task_id)),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List my tasks',
      description: 'Tasks posted with this API key, newest first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded(() => svc.listTasks(acc)),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Account and balance',
      description: 'Wallet address to top up, USDC balance, spending limits and today\'s spend.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded(() => svc.accountInfo(acc)),
  );

  return server;
}
