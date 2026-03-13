import { getDb } from "./lib/db";
import { handleSEO } from "./handlers/seo";
import { handleLeads } from "./handlers/leads";
import { handleEmail } from "./handlers/email";
import { handleMonitor } from "./handlers/monitor";
import { handleContent } from "./handlers/content";
import { handleOrchestrator } from "./handlers/orchestrator";
import { handleDevAgent } from "./handlers/dev-agent";
import { handleSocial } from "./handlers/social";
import { decryptApiKey } from "./lib/crypto";

export interface Env {
  DATABASE_URL: string;
  WORKER_AUTH_SECRET: string;
  HUNTER_API_KEY?: string;
  SNOV_API_ID?: string;
  SNOV_API_SECRET?: string;
  BREVO_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  ALIBABA_API_KEY?: string;
  ALIBABA_AI_BASE_URL?: string;
  ENCRYPTION_KEY?: string;
  CONTENT_DATABASE_URL?: string;
  CONTENT_DEFAULT_BRAND_NAME?: string;
  CONTENT_DEFAULT_BRAND_DOMAIN?: string;
  CONTENT_DEFAULT_CONTACT_PHONE?: string;
  CONTENT_DEFAULT_AUDIENCE?: string;
  CONTENT_DEFAULT_MARKET_REGION?: string;
  DEV_AGENT_DEFAULT_REPO?: string;
  DEV_AGENT_DEFAULT_PRODUCT_NAME?: string;
  DEV_AGENT_DEFAULT_PRODUCT_DESCRIPTION?: string;
  DEV_AGENT_DEFAULT_WEBSITE?: string;
  DEV_AGENT_DEFAULT_TECH_STACK?: string;
  GITHUB_TOKEN?: string;
}

interface TaskRequest {
  agent_id: number;
  task_index: number;
  // These are passed from the Vercel API for context
  project_id?: number;
  user_id?: number;
}

type CronBody = {
  start_after_id?: number;
  max_agents?: number;
};

type CronResult = {
  success: true;
  agents_processed: number;
  batch_size: number;
  start_after_id: number;
  has_more: boolean;
  next_start_after: number | null;
  results: { agent_id: number; type: string; task: string; status: string }[];
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

async function resolveRuntimeEnv(
  env: Env,
  sql: ReturnType<typeof getDb>,
  userId: number,
  config: Record<string, unknown>
): Promise<Env> {
  const runtimeEnv: Env = { ...env };
  const preferredModel = String(config.model || "auto");
  const needsAlibaba = preferredModel === "alibaba/qwen-plus" || preferredModel === "alibaba/qwen-turbo";

  if (!needsAlibaba) {
    return runtimeEnv;
  }

  // Qwen models are strict BYOK. Do not fall back to a system-level Alibaba key.
  delete runtimeEnv.ALIBABA_API_KEY;

  if (!runtimeEnv.ENCRYPTION_KEY) {
    return runtimeEnv;
  }

  const rows = await sql`
    SELECT api_key
    FROM user_api_keys
    WHERE user_id = ${userId} AND service = 'alibaba'
    LIMIT 1
  `;

  if (rows.length === 0) {
    return runtimeEnv;
  }

  try {
    runtimeEnv.ALIBABA_API_KEY = await decryptApiKey(String(rows[0].api_key), runtimeEnv.ENCRYPTION_KEY);
  } catch {
    // Keep runtime env without Alibaba credentials if BYOK decryption fails.
  }

  return runtimeEnv;
}

async function runCronBatch(env: Env, body: CronBody = {}): Promise<CronResult> {
  const sql = getDb(env.DATABASE_URL);
  const startAfterId = Number(body.start_after_id || 0);
  // Keep batch size conservative to avoid Cloudflare Worker subrequest limits.
  const maxAgents = Math.max(1, Math.min(10, Number(body.max_agents || 1)));

  const agents = await sql`
    SELECT aa.id, aa.agent_type, aa.config, aa.project_id, p.user_id
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.status = 'active'
      AND aa.id > ${startAfterId}
    ORDER BY aa.id
    LIMIT ${maxAgents + 1}
  `;

  const results: { agent_id: number; type: string; task: string; status: string }[] = [];
  const hasMore = agents.length > maxAgents;
  const pageAgents = hasMore ? agents.slice(0, maxAgents) : agents;
  const nextStartAfter =
    pageAgents.length > 0 ? (pageAgents[pageAgents.length - 1].id as number) : startAfterId;

  for (const agent of pageAgents) {
    const config = (agent.config as Record<string, unknown>) || {};
    const tasks = (config.tasks as { name: string; status: string }[]) || [];

    const nextIdx = tasks.findIndex((t) => t.status === "in_progress" || t.status === "pending");

    if (nextIdx === -1) {
      results.push({
        agent_id: agent.id as number,
        type: agent.agent_type as string,
        task: "all tasks completed",
        status: "skipped",
      });
      continue;
    }

    const agentId = agent.id as number;
    const agentType = agent.agent_type as string;
    const projectId = agent.project_id as number;
    const userId = agent.user_id as number;
    const runtimeEnv = await resolveRuntimeEnv(env, sql, userId, config);

    try {
      switch (agentType) {
        case "seo_content":
          await handleSEO(runtimeEnv, agentId, nextIdx, config);
          break;
        case "lead_prospecting":
          await handleLeads(runtimeEnv, agentId, nextIdx, config, projectId, userId);
          break;
        case "email_marketing":
          await handleEmail(runtimeEnv, agentId, nextIdx, config, projectId);
          break;
        case "product_manager":
          await handleMonitor(runtimeEnv, agentId, nextIdx, config);
          break;
        case "content_gen":
          await handleContent(runtimeEnv, agentId, nextIdx, config);
          break;
        case "orchestrator":
          await handleOrchestrator(runtimeEnv, agentId, nextIdx, config);
          break;
        case "dev_agent":
          await handleDevAgent(runtimeEnv, agentId, nextIdx, config);
          break;
        case "social_media":
          await handleSocial(runtimeEnv, agentId, nextIdx, config);
          break;
        default:
          throw new Error(`${agentType} is not supported yet`);
      }
      results.push({ agent_id: agentId, type: agentType, task: tasks[nextIdx].name, status: "completed" });
    } catch (e) {
      results.push({ agent_id: agentId, type: agentType, task: tasks[nextIdx].name, status: `error: ${e}` });
    }
  }

  return {
    success: true,
    agents_processed: results.length,
    batch_size: maxAgents,
    start_after_id: startAfterId,
    has_more: hasMore,
    next_start_after: hasMore ? nextStartAfter : null,
    results,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    const url = new URL(request.url);

    // GET /health — public health check
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Auth check for all other endpoints
    const authHeader = request.headers.get("Authorization");
    if (authHeader !== `Bearer ${env.WORKER_AUTH_SECRET}`) {
      return json({ error: "Unauthorized" }, 401);
    }

    // POST /execute — run a specific agent task
    if (request.method === "POST" && url.pathname === "/execute") {
      try {
        const body = (await request.json()) as TaskRequest;
        const { agent_id, task_index, project_id, user_id } = body;

        if (!agent_id || task_index === undefined) {
          return json({ error: "agent_id and task_index required" }, 400);
        }

        // Load agent config from DB
        const sql = getDb(env.DATABASE_URL);
        const agents = await sql`
          SELECT aa.id, aa.agent_type, aa.config, aa.project_id, p.user_id
          FROM agent_assignments aa
          JOIN projects p ON aa.project_id = p.id
          WHERE aa.id = ${agent_id}
        `;

        if (agents.length === 0) {
          return json({ error: "Agent not found" }, 404);
        }

        const agent = agents[0];
        const config = (agent.config as Record<string, unknown>) || {};
        const agentProjectId = project_id || (agent.project_id as number);
        const agentUserId = user_id || (agent.user_id as number);
        const runtimeEnv = await resolveRuntimeEnv(env, sql, agentUserId, config);

        let result: unknown;

        switch (agent.agent_type) {
          case "seo_content":
            result = await handleSEO(runtimeEnv, agent_id, task_index, config);
            break;
          case "lead_prospecting":
            result = await handleLeads(runtimeEnv, agent_id, task_index, config, agentProjectId, agentUserId);
            break;
          case "email_marketing":
            result = await handleEmail(runtimeEnv, agent_id, task_index, config, agentProjectId);
            break;
          case "product_manager":
            result = await handleMonitor(runtimeEnv, agent_id, task_index, config);
            break;
          case "content_gen":
            result = await handleContent(runtimeEnv, agent_id, task_index, config);
            break;
          case "orchestrator":
            result = await handleOrchestrator(runtimeEnv, agent_id, task_index, config);
            break;
          case "dev_agent":
            result = await handleDevAgent(runtimeEnv, agent_id, task_index, config);
            break;
          case "social_media":
            result = await handleSocial(runtimeEnv, agent_id, task_index, config);
            break;
          default:
            result = { error: `Agent type "${agent.agent_type}" not yet supported` };
        }

        return json({ success: true, result });
      } catch (e) {
        return json({ error: `Execution error: ${e}` }, 500);
      }
    }

    // POST /run-all — run all pending tasks for an agent
    if (request.method === "POST" && url.pathname === "/run-all") {
      try {
        const body = (await request.json()) as { agent_id: number };
        const { agent_id } = body;

        const sql = getDb(env.DATABASE_URL);
        const agents = await sql`
          SELECT aa.id, aa.agent_type, aa.config, aa.project_id, p.user_id
          FROM agent_assignments aa
          JOIN projects p ON aa.project_id = p.id
          WHERE aa.id = ${agent_id}
        `;

        if (agents.length === 0) {
          return json({ error: "Agent not found" }, 404);
        }

        const agent = agents[0];
        const results: { task_index: number; task_name: string; ok: boolean; data?: unknown; error?: string }[] = [];

        for (let i = 0; i < 25; i += 1) {
          const refreshed = await sql`
            SELECT aa.config, aa.project_id, p.user_id
            FROM agent_assignments aa
            JOIN projects p ON aa.project_id = p.id
            WHERE aa.id = ${agent_id}
          `;

          if (refreshed.length === 0) {
            return json({ error: "Agent not found" }, 404);
          }

          const config = (refreshed[0].config as Record<string, unknown>) || {};
          const tasks = (config.tasks as { name: string; status: string }[]) || [];
          const nextTaskIndex = tasks.findIndex((t) => t.status === "in_progress" || t.status === "pending");

          if (nextTaskIndex === -1) {
            return json({
              message: results.length > 0 ? "All remaining tasks completed" : "All tasks completed",
              tasks_run: results.length,
              results,
            });
          }

          const taskRequest = new Request(new URL("/execute", request.url), {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify({
              agent_id,
              task_index: nextTaskIndex,
              project_id: refreshed[0].project_id,
              user_id: refreshed[0].user_id,
            }),
          });

          const executionResponse = await this.fetch(taskRequest, env);
          const executionData = (await executionResponse.json()) as { error?: string; result?: unknown; message?: string };

          if (!executionResponse.ok) {
            results.push({
              task_index: nextTaskIndex,
              task_name: tasks[nextTaskIndex]?.name || `Task ${nextTaskIndex}`,
              ok: false,
              error: typeof executionData?.error === "string" ? executionData.error : "Task failed",
            });
            return json({
              error: "Run-all stopped on task failure",
              tasks_run: results.length,
              results,
            }, executionResponse.status);
          }

          results.push({
            task_index: nextTaskIndex,
            task_name: tasks[nextTaskIndex]?.name || `Task ${nextTaskIndex}`,
            ok: true,
            data: executionData,
          });
        }

        return json({
          error: "Run-all safety limit reached",
          tasks_run: results.length,
          results,
        }, 409);
      } catch (e) {
        return json({ error: `Run-all error: ${e}` }, 500);
      }
    }



    // POST /cron — batched run: execute next task for active agents in pages
    // Called by existing cron worker or manually
    if (request.method === "POST" && url.pathname === "/cron") {
      try {
        let body: CronBody = {};
        try {
          body = (await request.json()) as CronBody;
        } catch {
          body = {};
        }
        return json(await runCronBatch(env, body));
      } catch (e) {
        return json({ error: `Cron error: ${e}` }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCronBatch(env, { max_agents: 1 }));
  },
};
