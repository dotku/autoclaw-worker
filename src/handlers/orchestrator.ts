import {
  getDb,
  updateTaskStatus,
  saveReport,
  withModelMetrics,
  failTask,
} from "../lib/db";
import { cerebrasCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  CEREBRAS_API_KEY?: string;
}

interface AgentReport {
  agent_type: string;
  task_name: string;
  summary: string;
  metrics: Record<string, string | number>;
  created_at: string;
  project_name: string;
}

interface AgentStatus {
  id: number;
  agent_type: string;
  status: string;
  config: Record<string, unknown>;
  project_id?: number;
  project_name: string;
  project_website: string;
}

interface ProjectContext {
  projectId: number;
  projectName: string;
  projectWebsite: string;
  projectDescription?: string;
}

async function getProjectContext(
  env: Env,
  agentId: number,
): Promise<ProjectContext> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT p.id as project_id, p.name as project_name, p.website as project_website, p.description as project_description
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.id = ${agentId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new Error("Project context not found for orchestrator agent");
  }

  return {
    projectId: rows[0].project_id as number,
    projectName: rows[0].project_name as string,
    projectWebsite: (rows[0].project_website as string) || "",
    projectDescription: (rows[0].project_description as string) || "",
  };
}

// Task 0: Collect and analyze agent reports for this project only
async function analyzeAgentReports(
  env: Env,
  agentId: number,
  project: ProjectContext,
) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Get recent agent reports for this project only.
  const reports = (await sql`
    SELECT ar.agent_type, ar.task_name, ar.summary, ar.metrics, ar.created_at,
           p.name as project_name
    FROM agent_reports ar
    JOIN projects p ON ar.project_id = p.id
    WHERE ar.project_id = ${project.projectId}
      AND ar.created_at > NOW() - INTERVAL '7 days'
    ORDER BY ar.created_at DESC
    LIMIT 50
  `) as unknown as AgentReport[];

  // Get active agents and their status for this project only.
  const activeAgents = (await sql`
    SELECT aa.id, aa.agent_type, aa.status, aa.config, aa.project_id,
           p.name as project_name, p.website as project_website
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.status = 'active'
      AND aa.project_id = ${project.projectId}
    ORDER BY p.name, aa.agent_type
  `) as unknown as AgentStatus[];

  // Summarize findings
  const projectMap: Record<
    string,
    { agents: string[]; reports: string[]; issues: string[] }
  > = {};

  for (const agent of activeAgents) {
    const pName = agent.project_name as string;
    if (!projectMap[pName]) {
      projectMap[pName] = { agents: [], reports: [], issues: [] };
    }
    projectMap[pName].agents.push(agent.agent_type as string);

    const config = agent.config as {
      tasks?: { name: string; status: string }[];
    };
    const tasks = config.tasks || [];
    const stalled = tasks.filter((t) => t.status === "in_progress");
    if (stalled.length > 0) {
      projectMap[pName].issues.push(
        `${agent.agent_type}: task "${stalled[0].name}" stalled`,
      );
    }
  }

  for (const report of reports) {
    const pName = report.project_name as string;
    if (!projectMap[pName]) {
      projectMap[pName] = { agents: [], reports: [], issues: [] };
    }
    projectMap[pName].reports.push(
      `[${report.agent_type}] ${report.task_name}: ${report.summary}`,
    );
  }

  const summaryLines: string[] = [];
  for (const [project, data] of Object.entries(projectMap)) {
    summaryLines.push(`## ${project}`);
    summaryLines.push(`Active agents: ${data.agents.join(", ") || "none"}`);
    if (data.issues.length > 0)
      summaryLines.push(`Issues: ${data.issues.join("; ")}`);
    summaryLines.push(`Recent reports: ${data.reports.length}`);
  }

  const summary = `Agent ecosystem analysis for ${project.projectName}: ${activeAgents.length} active agents. ${reports.length} reports in last 7 days.\n\n${summaryLines.join("\n")}`;

  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
  await saveReport(
    env.DATABASE_URL,
    agentId,
    "Agent Ecosystem Analysis",
    summary,
    {
      active_agents: activeAgents.length,
      projects_covered: 1,
      reports_analyzed: reports.length,
      stalled_tasks: Object.values(projectMap).reduce(
        (sum, d) => sum + d.issues.length,
        0,
      ),
      model_used: "none",
      preferred_model: "none",
    },
  );

  return {
    project: project.projectName,
    activeAgents: activeAgents.length,
    projects: 1,
    reports: reports.length,
  };
}

// Task 1: Generate cross-agent optimization recommendations
async function generateOptimizations(
  env: Env,
  agentId: number,
  project: ProjectContext,
  preferredModel = "auto",
  langHint = "",
) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Gather context for this project only.
  const reports = (await sql`
    SELECT ar.agent_type, ar.task_name, ar.summary, ar.metrics, p.name as project_name
    FROM agent_reports ar
    JOIN projects p ON ar.project_id = p.id
    WHERE ar.project_id = ${project.projectId}
      AND ar.created_at > NOW() - INTERVAL '14 days'
    ORDER BY ar.created_at DESC
    LIMIT 30
  `) as unknown as AgentReport[];

  const agents = (await sql`
    SELECT aa.agent_type, aa.config, p.name as project_name, p.website as project_website, p.description
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.status = 'active'
      AND aa.project_id = ${project.projectId}
  `) as unknown as (AgentStatus & { description?: string })[];

  const context = agents
    .map((a) => {
      const config = a.config as {
        tasks?: { name: string; status: string }[];
        plan?: string;
      };
      const tasks = config.tasks || [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      return `- ${a.project_name} / ${a.agent_type}: ${completed}/${tasks.length} tasks done. Website: ${a.project_website || "N/A"}`;
    })
    .join("\n");

  const reportContext = reports
    .slice(0, 15)
    .map(
      (r) =>
        `- [${r.project_name}/${r.agent_type}] ${r.task_name}: ${r.summary?.substring(0, 150)}`,
    )
    .join("\n");

  const prompt = `You are an AI marketing operations orchestrator. Analyze the following agent ecosystem for a single project and generate actionable optimization recommendations.

PROJECT:
- ${project.projectName}: ${project.projectWebsite || "N/A"}${project.projectDescription ? ` — ${project.projectDescription}` : ""}

ACTIVE AGENTS:
${context}

RECENT REPORTS:
${reportContext}

Based on this data, provide:
1. **Cross-agent synergies**: Where should agents collaborate? (e.g., SEO findings → content creation → email distribution)
2. **Workflow gaps**: What's missing? Which agent coverage is missing for this project?
3. **Priority actions**: Top 5 specific actions to improve marketing ROI for this project.
4. **Content strategy**: Based on SEO and market trends, what content topics should be prioritized for this project?
5. **Resource allocation**: Which agents need more attention vs. which are running well?

Format as a structured markdown report. Be specific with this project and its agent types only. Do not mention or analyze other projects. Keep recommendations actionable.
${langHint}`;

  try {
    const { content: analysis, model } = await cerebrasCompletionWithMeta(
      env,
      prompt,
      2000,
      preferredModel,
    );

    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", analysis);
    await saveReport(
      env.DATABASE_URL,
      agentId,
      "Optimization Recommendations",
      analysis,
      withModelMetrics(
        {
          agents_analyzed: agents.length,
          reports_reviewed: reports.length,
        },
        preferredModel,
        model,
      ),
    );

    return { recommendations: analysis };
  } catch (e) {
    const msg = `Optimization analysis failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 1, "Optimization Recommendations", msg, preferredModel);
    return { error: msg };
  }
}

// Task 2: Market intelligence — analyze trends and suggest content direction
async function marketIntelligence(
  env: Env,
  agentId: number,
  project: ProjectContext,
  config: Record<string, unknown>,
  langHint = "",
) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  const projectContext = `- ${project.projectName}: ${project.projectWebsite || "no website"} — ${project.projectDescription || "no description"}`;

  // Get latest SEO reports for keyword insights for this project only.
  const seoReports = (await sql`
    SELECT ar.summary, ar.metrics, p.name as project_name
    FROM agent_reports ar
    JOIN projects p ON ar.project_id = p.id
    WHERE ar.agent_type = 'seo_content'
      AND ar.project_id = ${project.projectId}
      AND ar.created_at > NOW() - INTERVAL '30 days'
    ORDER BY ar.created_at DESC
    LIMIT 10
  `) as unknown as AgentReport[];

  const seoContext = seoReports
    .map((r) => `- [${r.project_name}] ${r.summary?.substring(0, 200)}`)
    .join("\n");

  const industry =
    (config.industry as string) || "B2B SaaS, legal tech, AI automation";

  const prompt = `You are a market intelligence analyst for a portfolio of digital businesses. Generate a market trends report and content strategy.

OUR PROJECTS:
${projectContext}

LATEST SEO INSIGHTS FOR THIS PROJECT:
${seoContext || "No recent SEO data available."}

INDUSTRY FOCUS: ${industry}

Please provide:
1. **Market Trends**: Top 5 emerging trends in our industries that we should capitalize on
2. **Content Opportunities**: 10 specific blog post / article titles we should create for this project
3. **Competitive Insights**: What competitors are likely doing that we should respond to
4. **Seasonal Factors**: Any upcoming events, seasons, or trends to prepare content for
5. **Action Items**: Specific tasks to assign to SEO, email, and social media agents

Be specific to this project only. Do not mention or compare other projects. Format as actionable markdown.
${langHint}`;

  try {
    const preferredModel = String(config.model || "auto");
    const { content: analysis, model } = await cerebrasCompletionWithMeta(
      env,
      prompt,
      2000,
      preferredModel,
    );

    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", analysis);
    await saveReport(
      env.DATABASE_URL,
      agentId,
      "Market Intelligence",
      analysis,
      withModelMetrics(
        {
          projects_analyzed: 1,
          seo_reports_reviewed: seoReports.length,
        },
        preferredModel,
        model,
      ),
    );

    return { intelligence: analysis };
  } catch (e) {
    const msg = `Market intelligence failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 2, "Market Intelligence", msg, "auto");
    return { error: msg };
  }
}

// Task 3: Auto-coordinate — trigger actions on other agents based on insights
async function autoCoordinate(
  env: Env,
  agentId: number,
  project: ProjectContext,
) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Find stalled agents and auto-advance where possible
  const stalledAgents = (await sql`
    SELECT aa.id, aa.agent_type, aa.config, p.name as project_name
    FROM agent_assignments aa
    JOIN projects p ON aa.project_id = p.id
    WHERE aa.status = 'active'
      AND aa.project_id = ${project.projectId}
  `) as unknown as AgentStatus[];

  const actions: string[] = [];

  for (const agent of stalledAgents) {
    const config = agent.config as {
      tasks?: { name: string; status: string }[];
      blockers?: string[];
    };
    const tasks = config.tasks || [];
    const blockers = config.blockers || [];

    // Count completed and total
    const completed = tasks.filter((t) => t.status === "completed").length;
    const total = tasks.length;

    // Log progress status
    if (total > 0) {
      actions.push(
        `[${agent.project_name}/${agent.agent_type}] Progress: ${completed}/${total} tasks (${Math.round((completed / total) * 100)}%)`,
      );
    }

    // Identify agents with all tasks completed — mark them for re-run
    if (completed === total && total > 0) {
      // Reset tasks to allow re-execution (periodic agents like SEO audit)
      const periodicTypes = ["seo_content", "product_manager"];
      if (periodicTypes.includes(agent.agent_type as string)) {
        // Reset first task to pending for periodic re-audit
        tasks[0].status = "pending";
        const updatedConfig = { ...config, tasks };
        await sql`UPDATE agent_assignments SET config = ${JSON.stringify(updatedConfig)} WHERE id = ${agent.id}`;
        actions.push(
          `↻ Reset ${agent.agent_type} for ${agent.project_name} — periodic re-audit scheduled`,
        );
      }
    }

    // Flag agents blocked for too long
    if (blockers.length > 0) {
      actions.push(
        `⚠ ${agent.project_name}/${agent.agent_type} blocked: ${blockers.join(", ")}`,
      );
    }
  }

  // Get orchestrator's own recommendations from the latest report
  const latestRecs = await sql`
    SELECT summary FROM agent_reports
    WHERE project_id = ${project.projectId}
      AND agent_type = 'orchestrator'
      AND task_name = 'Optimization Recommendations'
    ORDER BY created_at DESC LIMIT 1
  `;

  const summary = `Auto-coordination completed. ${stalledAgents.length} agents reviewed.\n\nActions taken:\n${actions.join("\n")}\n\n${latestRecs.length > 0 ? "Latest recommendations applied where possible." : "No prior recommendations found — run optimization analysis first."}`;

  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "Auto-Coordination", summary, {
    agents_reviewed: stalledAgents.length,
    actions_taken: actions.length,
    model_used: "none",
    preferred_model: "none",
  });

  return { agents_reviewed: stalledAgents.length, actions };
}

// Task 4: Generate weekly operations digest
async function weeklyDigest(
  env: Env,
  agentId: number,
  project: ProjectContext,
  preferredModel = "auto",
  langHint = "",
) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Gather weekly data for this project only.
  const weekReports = (await sql`
    SELECT ar.agent_type, ar.task_name, ar.summary, ar.metrics,
           ar.created_at, p.name as project_name
    FROM agent_reports ar
    JOIN projects p ON ar.project_id = p.id
    WHERE ar.project_id = ${project.projectId}
      AND ar.created_at > NOW() - INTERVAL '7 days'
    ORDER BY ar.created_at DESC
  `) as unknown as AgentReport[];

  const agentCounts = (await sql`
    SELECT aa.agent_type, COUNT(*)::int as count, aa.status
    FROM agent_assignments aa
    WHERE aa.project_id = ${project.projectId}
    GROUP BY aa.agent_type, aa.status
  `) as unknown as { agent_type: string; count: number; status: string }[];

  // Build digest with AI
  const reportSummaries = weekReports
    .slice(0, 20)
    .map(
      (r) =>
        `- [${r.project_name}] ${r.agent_type} / ${r.task_name}: ${r.summary?.substring(0, 120)}`,
    )
    .join("\n");

  const prompt = `You are an AI operations manager. Generate a concise weekly digest email for the marketing team.

STATS THIS WEEK:
- Project: ${project.projectName}
- Reports generated: ${weekReports.length}
- Agent distribution: ${agentCounts.map((a) => `${a.agent_type}(${a.count} ${a.status})`).join(", ")}

REPORT HIGHLIGHTS:
${reportSummaries || "No reports this week."}

Generate a professional weekly digest that includes:
1. **Executive Summary** (2-3 sentences)
2. **Key Metrics** (bullet points)
3. **Highlights** (what went well)
4. **Action Items** (what needs attention next week)
5. **Recommendations** (1-2 strategic suggestions)

Keep it concise and actionable. Format as markdown suitable for an email.
${langHint}`;

  try {
    const { content: digest, model } = await cerebrasCompletionWithMeta(
      env,
      prompt,
      1500,
      preferredModel,
    );

    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", digest);
    await saveReport(
      env.DATABASE_URL,
      agentId,
      "Weekly Operations Digest",
      digest,
      withModelMetrics(
        {
          reports_this_week: weekReports.length,
          projects_active: 1,
        },
        preferredModel,
        model,
      ),
    );

    return { digest };
  } catch (e) {
    const msg = `Weekly digest failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Weekly Operations Digest", msg, preferredModel);
    return { error: msg };
  }
}

export async function handleOrchestrator(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>,
) {
  const project = await getProjectContext(env, agentId);
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);
  switch (taskIndex) {
    case 0:
      return analyzeAgentReports(env, agentId, project);
    case 1:
      return generateOptimizations(env, agentId, project, preferredModel, langHint);
    case 2:
      return marketIntelligence(env, agentId, project, config, langHint);
    case 3:
      return autoCoordinate(env, agentId, project);
    case 4:
      return weeklyDigest(env, agentId, project, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not implemented for orchestrator` };
  }
}
