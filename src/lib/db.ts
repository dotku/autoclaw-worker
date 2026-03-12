import { neon } from "@neondatabase/serverless";

export function getDb(databaseUrl: string) {
  return neon(databaseUrl);
}

export async function updateTaskStatus(
  databaseUrl: string,
  agentId: number,
  taskIndex: number,
  status: "pending" | "in_progress" | "completed",
  result?: string
) {
  const sql = getDb(databaseUrl);
  const agents = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  if (agents.length === 0) return;

  const config = agents[0].config as {
    plan?: string;
    tasks?: { name: string; status: string; result?: string }[];
    blockers?: string[];
  };
  const tasks = config.tasks || [];

  if (taskIndex >= 0 && taskIndex < tasks.length) {
    tasks[taskIndex].status = status;
    if (result) tasks[taskIndex].result = result;

    // If completing, advance next pending task to in_progress
    if (status === "completed" && taskIndex + 1 < tasks.length && tasks[taskIndex + 1].status === "pending") {
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
  metrics: Record<string, string | number>
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

  const agent = agents[0];
  await sql`
    INSERT INTO agent_reports (agent_assignment_id, project_id, agent_type, task_name, summary, metrics)
    VALUES (${agentId}, ${agent.project_id}, ${agent.agent_type}, ${taskName}, ${summary}, ${JSON.stringify(metrics)})
  `;
}
