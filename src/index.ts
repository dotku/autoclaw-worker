import { getDb, updateTaskStatus, resetTaskForRecurring } from "./lib/db";
import { handleSEO } from "./handlers/seo";
import { handleLeads } from "./handlers/leads";
import { handleEmail } from "./handlers/email";
import { handleMonitor } from "./handlers/monitor";
import { handleContent } from "./handlers/content";
import { handleOrchestrator } from "./handlers/orchestrator";
import { handleDevAgent } from "./handlers/dev-agent";
import { handleSocial } from "./handlers/social";
import { handleSales } from "./handlers/sales";
import { decryptApiKey } from "./lib/crypto";

export interface Env {
  DATABASE_URL: string;
  WORKER_AUTH_SECRET: string;
  HUNTER_API_KEY?: string;
  SNOV_API_ID?: string;
  SNOV_API_SECRET?: string;
  APOLLO_API_KEY?: string;
  APIFY_API_TOKEN?: string;
  BREVO_API_KEY?: string;
  SENDGRID_API_KEY?: string;
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
  // Self service binding — used by /run-all to chain tasks across invocations
  SELF?: Fetcher;
}

interface TaskRequest {
  agent_id: number;
  task_index: number;
  // These are passed from the Vercel API for context
  project_id?: number;
  user_id?: number;
  caller_id?: number; // The user who triggered execution (may differ from agent owner)
  locale?: string;
}

// Re-export for any direct consumers
export { localeInstruction } from "./lib/locale";

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
  ownerId: number,
  config: Record<string, unknown>,
  callerId?: number,
): Promise<Env> {
  const runtimeEnv: Env = { ...env };
  const preferredModel = String(config.model || "auto");
  const needsAlibaba = preferredModel === "alibaba/qwen-plus" || preferredModel === "alibaba/qwen-turbo";

  if (!runtimeEnv.ENCRYPTION_KEY) {
    return runtimeEnv;
  }

  const BYOK_SERVICES = "('sendgrid', 'brevo', 'apollo', 'apify', 'hunter', 'snov_api_id', 'snov_api_secret', 'cerebras', 'anthropic', 'openai', 'google', 'vercel')";

  // Helper: apply a set of decrypted keys to runtimeEnv (only fill missing slots)
  const applyKeys = async (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      try {
        const decrypted = await decryptApiKey(String(row.api_key), runtimeEnv.ENCRYPTION_KEY!);
        const svc = row.service as string;
        if (svc === "sendgrid" && !runtimeEnv.SENDGRID_API_KEY) runtimeEnv.SENDGRID_API_KEY = decrypted;
        if (svc === "brevo" && !runtimeEnv.BREVO_API_KEY) runtimeEnv.BREVO_API_KEY = decrypted;
        if (svc === "apollo" && !runtimeEnv.APOLLO_API_KEY) runtimeEnv.APOLLO_API_KEY = decrypted;
        if (svc === "apify" && !runtimeEnv.APIFY_API_TOKEN) runtimeEnv.APIFY_API_TOKEN = decrypted;
        if (svc === "hunter" && !runtimeEnv.HUNTER_API_KEY) runtimeEnv.HUNTER_API_KEY = decrypted;
        if (svc === "snov_api_id" && !runtimeEnv.SNOV_API_ID) runtimeEnv.SNOV_API_ID = decrypted;
        if (svc === "snov_api_secret" && !runtimeEnv.SNOV_API_SECRET) runtimeEnv.SNOV_API_SECRET = decrypted;
        if (svc === "cerebras" && !runtimeEnv.CEREBRAS_API_KEY) runtimeEnv.CEREBRAS_API_KEY = decrypted;
        if (svc === "anthropic" && !runtimeEnv.ANTHROPIC_API_KEY) runtimeEnv.ANTHROPIC_API_KEY = decrypted;
        if (svc === "vercel" && !runtimeEnv.AI_GATEWAY_API_KEY) runtimeEnv.AI_GATEWAY_API_KEY = decrypted;
      } catch {
        // Skip if decryption fails
      }
    }
  };

  // Key resolution order:
  // 1. Caller's personal keys (the user who triggered execution)
  // 2. Owner's personal keys (the agent/project owner)
  // 3. Caller's org keys
  // 4. Owner's org keys
  // 5. Environment variables (already in runtimeEnv from spread)

  const userIds = callerId && callerId !== ownerId ? [callerId, ownerId] : [ownerId];

  for (const uid of userIds) {
    const userKeys = await sql`
      SELECT service, api_key FROM user_api_keys
      WHERE user_id = ${uid} AND service IN ('sendgrid', 'brevo', 'apollo', 'apify', 'hunter', 'snov_api_id', 'snov_api_secret', 'cerebras', 'anthropic', 'openai', 'google', 'vercel')
    `;
    await applyKeys(userKeys);
  }

  for (const uid of userIds) {
    const orgKeys = await sql`
      SELECT ok.service, ok.api_key
      FROM org_api_keys ok
      JOIN organization_members om ON ok.org_id = om.org_id
      WHERE om.user_id = ${uid}
        AND ok.service IN ('sendgrid', 'brevo', 'apollo', 'apify', 'hunter', 'snov_api_id', 'snov_api_secret', 'cerebras', 'anthropic', 'openai', 'google', 'vercel')
    `;
    await applyKeys(orgKeys);
  }

  if (!needsAlibaba) {
    return runtimeEnv;
  }

  // Qwen models are strict BYOK. Do not fall back to a system-level Alibaba key.
  delete runtimeEnv.ALIBABA_API_KEY;

  // Check caller + owner keys for Alibaba
  for (const uid of userIds) {
    const alibabaRows = await sql`
      SELECT api_key FROM user_api_keys WHERE user_id = ${uid} AND service = 'alibaba' LIMIT 1
    `;
    if (alibabaRows.length > 0) {
      try {
        runtimeEnv.ALIBABA_API_KEY = await decryptApiKey(String(alibabaRows[0].api_key), runtimeEnv.ENCRYPTION_KEY);
        break;
      } catch { /* skip */ }
    }
    const orgAlibabaRows = await sql`
      SELECT ok.api_key FROM org_api_keys ok
      JOIN organization_members om ON ok.org_id = om.org_id
      WHERE om.user_id = ${uid} AND ok.service = 'alibaba' LIMIT 1
    `;
    if (orgAlibabaRows.length > 0) {
      try {
        runtimeEnv.ALIBABA_API_KEY = await decryptApiKey(String(orgAlibabaRows[0].api_key), runtimeEnv.ENCRYPTION_KEY);
        break;
      } catch { /* skip */ }
    }
  }

  return runtimeEnv;
}

// Inject project metadata (website, description, name) into agent config at runtime
async function enrichConfigWithProject(
  sql: ReturnType<typeof getDb>,
  config: Record<string, unknown>,
  projectId: number,
): Promise<Record<string, unknown>> {
  try {
    const rows = await sql`SELECT website, description, name FROM projects WHERE id = ${projectId}`;
    if (rows.length > 0) {
      if (rows[0].website && !config.website) config.website = rows[0].website;
      if (rows[0].description && !config.project_description) config.project_description = rows[0].description;
      if (rows[0].name && !config.project_name) config.project_name = rows[0].name;

      // Auto-populate target_domains for lead prospecting from project website
      if (!config.target_domains && rows[0].website) {
        try {
          const url = new URL(rows[0].website as string);
          config.target_domains = [url.hostname.replace(/^www\./, "")];
        } catch { /* invalid URL, skip */ }
      }
    }
  } catch { /* non-critical */ }
  return config;
}

async function runCronBatch(env: Env, body: CronBody = {}): Promise<CronResult> {
  const sql = getDb(env.DATABASE_URL);
  const startAfterId = Number(body.start_after_id || 0);
  // Keep batch size conservative to avoid Cloudflare Worker subrequest limits.
  const maxAgents = Math.max(1, Math.min(10, Number(body.max_agents || 1)));

  const agents = await sql`
    SELECT aa.id, aa.agent_type, aa.config, aa.project_id, p.user_id, u.locale as user_locale
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    LEFT JOIN users u ON p.user_id = u.id
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
    const agentId = agent.id as number;
    const agentType = agent.agent_type as string;
    const projectId = agent.project_id as number;
    const userId = agent.user_id as number;
    const config = await enrichConfigWithProject(sql, (agent.config as Record<string, unknown>) || {}, projectId);
    // Inject user locale for cron-triggered runs (frontend passes locale directly)
    if (!config.locale && agent.user_locale) config.locale = agent.user_locale;
    const tasks = (config.tasks as { name: string; status: string }[]) || [];

    const nextIdx = tasks.findIndex((t) => t.status === "in_progress" || t.status === "pending");

    if (nextIdx === -1) {
      results.push({
        agent_id: agentId,
        type: agentType,
        task: "all tasks completed",
        status: "skipped",
      });
      continue;
    }

    const runtimeEnv = await resolveRuntimeEnv(env, sql, userId, config);

    try {
      switch (agentType) {
        case "seo_content":
          await handleSEO(runtimeEnv, agentId, nextIdx, config);
          break;
        case "lead_prospecting":
          await handleLeads(runtimeEnv, agentId, nextIdx, config, projectId, userId);
          break;
        case "email_marketing": {
          const emailResult = await handleEmail(runtimeEnv, agentId, nextIdx, config, projectId, userId);
          // Auto-reset Task 5 if there are remaining unsent leads for next cron cycle
          if (nextIdx === 5 && emailResult && typeof emailResult === "object" && "remaining" in emailResult) {
            const remaining = (emailResult as { remaining?: number }).remaining || 0;
            if (remaining > 0) {
              await resetTaskForRecurring(env.DATABASE_URL, agentId, 5);
            }
          }
          break;
        }
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
        case "sales_followup":
          await handleSales(runtimeEnv, agentId, nextIdx, config, projectId, userId);
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
    // If called externally, delegate to SELF binding for a fresh subrequest budget.
    // The _internal flag means we're already in a SELF invocation — execute directly.
    if (request.method === "POST" && url.pathname === "/execute") {
      try {
        const body = (await request.json()) as TaskRequest & { _internal?: boolean };
        const { agent_id, task_index, project_id, user_id, caller_id, locale } = body;

        if (!agent_id || task_index === undefined) {
          return json({ error: "agent_id and task_index required" }, 400);
        }

        // Delegate to SELF for a fresh subrequest budget (avoids 50-subrequest limit)
        if (!body._internal && env.SELF) {
          const selfRes = await env.SELF.fetch(new Request(request.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WORKER_AUTH_SECRET}` },
            body: JSON.stringify({ ...body, _internal: true }),
          }));
          return new Response(selfRes.body, { status: selfRes.status, headers: selfRes.headers });
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
        const config = await enrichConfigWithProject(sql, (agent.config as Record<string, unknown>) || {}, project_id || (agent.project_id as number));
        if (locale) config.locale = locale;
        const agentProjectId = project_id || (agent.project_id as number);
        const agentOwnerId = agent.user_id as number;
        const agentCallerId = caller_id || user_id;
        const runtimeEnv = await resolveRuntimeEnv(env, sql, agentOwnerId, config, agentCallerId);

        let result: unknown;
        const useMode = String(config.model || "auto");
        const agentUserId = user_id || agentOwnerId;

        switch (agent.agent_type) {
          case "seo_content":
            result = await handleSEO(runtimeEnv, agent_id, task_index, config);
            break;
          case "lead_prospecting":
            result = await handleLeads(runtimeEnv, agent_id, task_index, config, agentProjectId, agentUserId);
            break;
          case "email_marketing":
            result = await handleEmail(runtimeEnv, agent_id, task_index, config, agentProjectId, agentUserId);
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
          case "sales_followup":
            result = await handleSales(runtimeEnv, agent_id, task_index, config, agentProjectId, agentUserId);
            break;
          default:
            result = { error: `Agent type "${agent.agent_type}" not yet supported` };
        }

        // If handler returned an error, ensure it's saved to the task status so Log shows it
        if (result && typeof result === "object" && "error" in result) {
          const errResult = result as { error: string };
          try {
            // Check if the task was already marked completed by the handler
            const check = await sql`SELECT config FROM agent_assignments WHERE id = ${agent_id}`;
            if (check.length > 0) {
              const checkConfig = (check[0].config as { tasks?: { status: string; result?: string }[] }) || {};
              const t = checkConfig.tasks?.[task_index];
              if (t && t.status !== "completed") {
                await updateTaskStatus(env.DATABASE_URL, agent_id, task_index, "completed", errResult.error);
              } else if (t && !t.result) {
                // Task marked completed but no result saved — save the error
                await updateTaskStatus(env.DATABASE_URL, agent_id, task_index, "completed", errResult.error);
              }
            }
          } catch { /* non-critical */ }
        }

        // Auto-reset email_marketing Task 5 if unsent leads remain
        if (agent.agent_type === "email_marketing" && task_index === 5 && result && typeof result === "object" && "remaining" in result) {
          const remaining = (result as { remaining?: number }).remaining || 0;
          if (remaining > 0) {
            await resetTaskForRecurring(env.DATABASE_URL, agent_id, 5);
          }
        }

        // Stamp model_used and use_mode onto the completed task config
        try {
          // Find the report just created by this task (within last 30s)
          const latestReport = await sql`
            SELECT metrics FROM agent_reports
            WHERE agent_assignment_id = ${agent_id}
              AND created_at > NOW() - INTERVAL '30 seconds'
            ORDER BY created_at DESC LIMIT 1
          `;
          // Extract model_used: prefer report metrics, fall back to use_mode setting
          let modelUsed = "none";
          if (latestReport.length > 0) {
            const metrics = latestReport[0].metrics as Record<string, unknown> | null;
            if (metrics?.model_used) {
              modelUsed = String(metrics.model_used);
            } else if (useMode !== "auto") {
              modelUsed = useMode;
            }
          }

          const freshAgent = await sql`SELECT config FROM agent_assignments WHERE id = ${agent_id}`;
          if (freshAgent.length > 0) {
            const freshConfig = (freshAgent[0].config as { tasks?: { name: string; status: string; model_used?: string; use_mode?: string }[] }) || {};
            const tasks = freshConfig.tasks || [];
            if (task_index >= 0 && task_index < tasks.length) {
              tasks[task_index].model_used = modelUsed;
              tasks[task_index].use_mode = useMode;
              await sql`UPDATE agent_assignments SET config = ${JSON.stringify({ ...freshConfig, tasks })} WHERE id = ${agent_id}`;
            }
          }
        } catch {
          // Non-critical — don't fail the task if model stamping fails
        }

        return json({ success: true, result });
      } catch (e) {
        return json({ error: `Execution error: ${e}` }, 500);
      }
    }

    // POST /run-all — run all pending tasks for an agent via chained self-invocations.
    // Each invocation executes ONE task, then chains to itself via the SELF service
    // binding so each task gets a fresh 50-subrequest budget.
    // Accepts _chain_results / _depth internally for chaining; callers don't need them.
    if (request.method === "POST" && url.pathname === "/run-all") {
      try {
        const body = (await request.json()) as {
          agent_id: number;
          mode?: "continue" | "restart";
          locale?: string;
          _chain_results?: { task_index: number; task_name: string; ok: boolean; data?: unknown; error?: string }[];
          _depth?: number;
        };
        const { agent_id, mode, locale: runLocale } = body;
        const chainResults = body._chain_results || [];
        const depth = body._depth || 0;
        const MAX_CHAIN_DEPTH = 15; // CF service binding limit is 16

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

        // Restart mode: reset all tasks to pending, first to in_progress (only on first call)
        if (mode === "restart" && depth === 0) {
          const resetConfig = (agents[0].config as Record<string, unknown>) || {};
          const resetTasks = (resetConfig.tasks as { name: string; status: string; result?: string; model_used?: string; use_mode?: string }[]) || [];
          for (let j = 0; j < resetTasks.length; j++) {
            resetTasks[j].status = j === 0 ? "in_progress" : "pending";
            delete resetTasks[j].result;
            delete resetTasks[j].model_used;
            delete resetTasks[j].use_mode;
          }
          await sql`UPDATE agent_assignments SET config = ${JSON.stringify({ ...resetConfig, tasks: resetTasks })} WHERE id = ${agent_id}`;
        }

        const agentType = agents[0].agent_type as string;
        const agentProjectId = agents[0].project_id as number;
        const agentUserId = agents[0].user_id as number;
        const config = await enrichConfigWithProject(sql, (agents[0].config as Record<string, unknown>) || {}, agentProjectId);
        if (runLocale) config.locale = runLocale;
        const tasks = (config.tasks as { name: string; status: string }[]) || [];
        const nextTaskIndex = tasks.findIndex((t) => t.status === "in_progress" || t.status === "pending");

        // No more tasks — return accumulated results
        if (nextTaskIndex === -1) {
          return json({
            message: chainResults.length > 0 ? "All remaining tasks completed" : "All tasks completed",
            tasks_run: chainResults.length,
            results: chainResults,
          });
        }

        const runtimeEnv = await resolveRuntimeEnv(env, sql, agentUserId, config);
        const useMode = String(config.model || "auto");

        // Execute ONE task in this invocation
        try {
          let result: unknown;
          switch (agentType) {
            case "seo_content":
              result = await handleSEO(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "lead_prospecting":
              result = await handleLeads(runtimeEnv, agent_id, nextTaskIndex, config, agentProjectId, agentUserId);
              break;
            case "email_marketing":
              result = await handleEmail(runtimeEnv, agent_id, nextTaskIndex, config, agentProjectId, agentUserId);
              break;
            case "product_manager":
              result = await handleMonitor(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "content_gen":
              result = await handleContent(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "orchestrator":
              result = await handleOrchestrator(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "dev_agent":
              result = await handleDevAgent(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "social_media":
              result = await handleSocial(runtimeEnv, agent_id, nextTaskIndex, config);
              break;
            case "sales_followup":
              result = await handleSales(runtimeEnv, agent_id, nextTaskIndex, config, agentProjectId, agentUserId);
              break;
            default:
              result = { error: `Agent type "${agentType}" not yet supported` };
          }

          // Auto-reset email_marketing Task 5 if unsent leads remain
          if (agentType === "email_marketing" && nextTaskIndex === 5 && result && typeof result === "object" && "remaining" in result) {
            const remaining = (result as { remaining?: number }).remaining || 0;
            if (remaining > 0) {
              await resetTaskForRecurring(env.DATABASE_URL, agent_id, 5);
            }
          }

          // Stamp model_used onto task config
          try {
            const latestReport = await sql`
              SELECT metrics FROM agent_reports
              WHERE agent_assignment_id = ${agent_id}
                AND created_at > NOW() - INTERVAL '30 seconds'
              ORDER BY created_at DESC LIMIT 1
            `;
            let modelUsed = "none";
            if (latestReport.length > 0) {
              const metrics = latestReport[0].metrics as Record<string, unknown> | null;
              if (metrics?.model_used) {
                modelUsed = String(metrics.model_used);
              } else if (useMode !== "auto") {
                modelUsed = useMode;
              }
            }
            const freshAgent = await sql`SELECT config FROM agent_assignments WHERE id = ${agent_id}`;
            if (freshAgent.length > 0) {
              const freshConfig = (freshAgent[0].config as { tasks?: { name: string; status: string; model_used?: string; use_mode?: string }[] }) || {};
              const freshTasks = freshConfig.tasks || [];
              if (nextTaskIndex >= 0 && nextTaskIndex < freshTasks.length) {
                freshTasks[nextTaskIndex].model_used = modelUsed;
                freshTasks[nextTaskIndex].use_mode = useMode;
                await sql`UPDATE agent_assignments SET config = ${JSON.stringify({ ...freshConfig, tasks: freshTasks })} WHERE id = ${agent_id}`;
              }
            }
          } catch {
            // Non-critical
          }

          chainResults.push({
            task_index: nextTaskIndex,
            task_name: tasks[nextTaskIndex]?.name || `Task ${nextTaskIndex}`,
            ok: true,
            data: result,
          });
        } catch (e) {
          chainResults.push({
            task_index: nextTaskIndex,
            task_name: tasks[nextTaskIndex]?.name || `Task ${nextTaskIndex}`,
            ok: false,
            error: `${e}`,
          });
          return json({
            error: "Run-all stopped on task failure",
            tasks_run: chainResults.length,
            results: chainResults,
          }, 500);
        }

        // Chain to self for the next task (new invocation = fresh subrequest budget)
        if (env.SELF && depth < MAX_CHAIN_DEPTH) {
          try {
            const chainRes = await env.SELF.fetch(new Request("https://self/run-all", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${env.WORKER_AUTH_SECRET}`,
              },
              body: JSON.stringify({
                agent_id,
                mode: "continue",
                locale: runLocale,
                _chain_results: chainResults,
                _depth: depth + 1,
              }),
            }));
            // Return the chained response directly (it has the final aggregated results)
            return new Response(chainRes.body, {
              status: chainRes.status,
              headers: chainRes.headers,
            });
          } catch (chainErr) {
            // If chaining fails, return what we have so far
            return json({
              error: `Chain error at depth ${depth}: ${chainErr}`,
              tasks_run: chainResults.length,
              results: chainResults,
            }, 500);
          }
        }

        // No SELF binding or depth limit reached — return what we have
        return json({
          message: depth >= MAX_CHAIN_DEPTH ? "Chain depth limit reached" : "All tasks in this invocation completed",
          tasks_run: chainResults.length,
          results: chainResults,
        });
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
