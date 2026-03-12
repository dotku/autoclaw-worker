import { updateTaskStatus, saveReport, getDb } from "../lib/db";
import { cerebrasCompletion, claudeCompletion } from "../lib/ai";

interface Env {
  DATABASE_URL: string;
  BREVO_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

// Task 0: Research target audience & ICP
async function researchICP(env: Env, agentId: number, projectDesc: string) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const prompt = `You are a B2B marketing expert. Based on this business description, define an Ideal Customer Profile (ICP):
"${projectDesc}"

Provide:
1. Target industries (3-5)
2. Company size range
3. Key job titles to target (5-8)
4. Pain points this product solves (3-5)
5. Recommended outreach channels

Format as structured text with clear headings.`;

  try {
    const icpContent = await cerebrasCompletion(env, prompt, 1000);

    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", icpContent);
    await saveReport(env.DATABASE_URL, agentId, "ICP Research", `Completed ICP research for project`, {
      status: "completed",
    });

    return { icp: icpContent };
  } catch (e) {
    const msg = `ICP research failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", msg);
    return { error: msg };
  }
}

// Task 2: Create email templates
async function createTemplates(env: Env, agentId: number, projectDesc: string, website: string) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const prompt = `You are an expert cold email copywriter. Create 3 email templates for this business:
Website: ${website}
Description: ${projectDesc}

Create:
1. Cold outreach email (first touch)
2. Follow-up email (sent 3 days after no reply)
3. Newsletter welcome email

For each template provide:
- Subject line
- Email body (with {{firstName}} and {{company}} merge tags)

Keep each email under 150 words. Be professional but personable.`;

  try {
    const templates = await claudeCompletion(env, prompt, 2000);

    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", templates);
    await saveReport(env.DATABASE_URL, agentId, "Email Templates", "Created 3 email templates", {
      templates_created: 3,
    });

    return { templates };
  } catch (e) {
    const msg = `Template creation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
    return { error: msg };
  }
}

// Task 1: Build prospect email list from leads table
async function buildEmailList(env: Env, agentId: number, projectId: number) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const leads = await sql`SELECT COUNT(*)::int as count FROM leads WHERE project_id = ${projectId}`;
  const count = leads[0].count;

  // Import to Brevo if API key available
  let imported = 0;
  if (env.BREVO_API_KEY && count > 0) {
    const allLeads = await sql`SELECT email, first_name, last_name, company, position FROM leads WHERE project_id = ${projectId} LIMIT 500`;
    for (const lead of allLeads) {
      try {
        const res = await fetch("https://api.brevo.com/v3/contacts", {
          method: "POST",
          headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            email: lead.email,
            attributes: {
              FIRSTNAME: lead.first_name || "",
              LASTNAME: lead.last_name || "",
              COMPANY: lead.company || "",
              JOB_TITLE: lead.position || "",
            },
            listIds: [8],
            updateEnabled: true,
          }),
        });
        if (res.ok || res.status === 204) imported++;
      } catch { /* skip */ }
    }
  }

  const summary = `Email list: ${count} leads in database, ${imported} synced to Brevo`;
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "Email List", summary, {
    total_leads: count,
    imported_to_brevo: imported,
  });

  return { count, imported };
}

export async function handleEmail(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>,
  projectId: number
) {
  const description = (config.plan as string) || "";
  const website = (config.website as string) || "";

  switch (taskIndex) {
    case 0:
      return researchICP(env, agentId, description);
    case 1:
      return buildEmailList(env, agentId, projectId);
    case 2:
      return createTemplates(env, agentId, description, website);
    default:
      return { error: `Task ${taskIndex} not yet implemented for email marketing` };
  }
}
