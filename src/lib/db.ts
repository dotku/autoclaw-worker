import { neon } from "@neondatabase/serverless";

export function getDb(databaseUrl: string) {
  return neon(databaseUrl);
}

/**
 * Log a real-time execution step so the frontend can display "thinking" progress.
 * status: "running" | "done" | "error"
 */
export async function logStep(
  databaseUrl: string,
  agentId: number,
  taskIndex: number,
  stepKey: string,
  status: "running" | "done" | "error" = "running",
  detail?: string,
) {
  const sql = getDb(databaseUrl);
  try {
    if (status === "running") {
      await sql`
        INSERT INTO agent_steps (agent_id, task_index, step_key, status, detail)
        VALUES (${agentId}, ${taskIndex}, ${stepKey}, ${status}, ${detail || null})
      `;
    } else {
      // Update existing running step to done/error
      const updated = await sql`
        UPDATE agent_steps SET status = ${status}, detail = COALESCE(${detail || null}, detail)
        WHERE agent_id = ${agentId} AND task_index = ${taskIndex} AND step_key = ${stepKey} AND status = 'running'
        RETURNING id
      `;
      if (updated.length === 0) {
        // No running step found — insert directly
        await sql`
          INSERT INTO agent_steps (agent_id, task_index, step_key, status, detail)
          VALUES (${agentId}, ${taskIndex}, ${stepKey}, ${status}, ${detail || null})
        `;
      }
    }
  } catch { /* non-critical — don't block task execution */ }
}

/**
 * Clear old steps for a task before re-running it.
 */
export async function clearSteps(databaseUrl: string, agentId: number, taskIndex: number) {
  const sql = getDb(databaseUrl);
  try {
    await sql`DELETE FROM agent_steps WHERE agent_id = ${agentId} AND task_index = ${taskIndex}`;
  } catch { /* non-critical */ }
}

export async function updateTaskStatus(
  databaseUrl: string,
  agentId: number,
  taskIndex: number,
  status: "pending" | "in_progress" | "completed",
  result?: string,
  modelInfo?: { model_used: string; use_mode: string },
) {
  const sql = getDb(databaseUrl);
  const agents =
    await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  if (agents.length === 0) return;

  const config = agents[0].config as {
    plan?: string;
    tasks?: { name: string; status: string; result?: string; model_used?: string; use_mode?: string }[];
    blockers?: string[];
  };
  const tasks = config.tasks || [];

  if (taskIndex >= 0 && taskIndex < tasks.length) {
    tasks[taskIndex].status = status;
    if (result) tasks[taskIndex].result = result;
    if (modelInfo) {
      tasks[taskIndex].model_used = modelInfo.model_used;
      tasks[taskIndex].use_mode = modelInfo.use_mode;
    }

    // If completing, advance next pending task to in_progress
    if (
      status === "completed" &&
      taskIndex + 1 < tasks.length &&
      tasks[taskIndex + 1].status === "pending"
    ) {
      tasks[taskIndex + 1].status = "in_progress";
    }
  }

  const updatedConfig = { ...config, tasks };
  await sql`UPDATE agent_assignments SET config = ${JSON.stringify(updatedConfig)} WHERE id = ${agentId}`;
}

export async function saveReport(
  databaseUrl: string,
  agentId: number,
  taskName: string,
  summary: string,
  metrics: Record<string, string | number>,
  taskIndex?: number,
) {
  const sql = getDb(databaseUrl);
  // Get agent info for the report
  const agents = await sql`
    SELECT aa.agent_type, aa.project_id, p.name as project_name
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.id = ${agentId}
  `;
  if (agents.length === 0) return;

  // Infer task_index if not provided: find the last completed task
  let resolvedIndex = taskIndex;
  if (resolvedIndex === undefined) {
    try {
      const agentConfig = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
      if (agentConfig.length > 0) {
        const cfg = agentConfig[0].config as { tasks?: { status: string }[] };
        const tasks = cfg.tasks || [];
        // Find last task that was just completed (most recently changed)
        for (let idx = tasks.length - 1; idx >= 0; idx--) {
          if (tasks[idx].status === "completed") {
            resolvedIndex = idx;
            break;
          }
        }
      }
    } catch { /* non-critical */ }
  }
  const enrichedMetrics = resolvedIndex !== undefined ? { ...metrics, task_index: resolvedIndex } : metrics;

  const agent = agents[0];
  await sql`
    INSERT INTO agent_reports (agent_assignment_id, project_id, agent_type, task_name, summary, metrics)
    VALUES (${agentId}, ${agent.project_id}, ${agent.agent_type}, ${taskName}, ${summary}, ${JSON.stringify(enrichedMetrics)})
  `;
}

/**
 * Convenience helper that marks a task as completed-with-error AND writes a
 * visible report so the failure shows up in the dashboard / agent-reports API.
 */
export async function failTask(
  databaseUrl: string,
  agentId: number,
  taskIndex: number,
  taskName: string,
  errorMsg: string,
  preferredModel = "auto",
) {
  await updateTaskStatus(databaseUrl, agentId, taskIndex, "completed", errorMsg);
  await saveReport(databaseUrl, agentId, taskName, errorMsg, {
    status: "error",
    preferred_model: preferredModel,
    model_used: "none",
  }, taskIndex);
}

/**
 * Reset a single completed task back to "pending" so the cron picks it up again.
 * Used for recurring tasks like email_marketing Task 5 (batch outreach).
 */
export async function resetTaskForRecurring(
  databaseUrl: string,
  agentId: number,
  taskIndex: number,
) {
  const sql = getDb(databaseUrl);
  const agents = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  if (agents.length === 0) return;

  const config = agents[0].config as {
    tasks?: { name: string; status: string; result?: string }[];
  };
  const tasks = config.tasks || [];

  if (taskIndex >= 0 && taskIndex < tasks.length && tasks[taskIndex].status === "completed") {
    tasks[taskIndex].status = "pending";
    const updatedConfig = { ...config, tasks };
    await sql`UPDATE agent_assignments SET config = ${JSON.stringify(updatedConfig)} WHERE id = ${agentId}`;
  }
}

export function withModelMetrics(
  metrics: Record<string, string | number>,
  preferredModel: string,
  usedModel?: string,
) {
  return {
    ...metrics,
    preferred_model: preferredModel,
    model_used: usedModel || preferredModel,
  };
}
