import { updateTaskStatus, saveReport, getDb } from "../lib/db";

interface Env {
  DATABASE_URL: string;
  HUNTER_API_KEY?: string;
  SNOV_API_ID?: string;
  SNOV_API_SECRET?: string;
}

interface Lead {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  position: string;
  source: string;
  confidence?: number;
  verified?: boolean;
}

async function searchHunter(apiKey: string, domain: string): Promise<Lead[]> {
  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=20&api_key=${apiKey}`
  );
  if (!res.ok) return [];
  const data = await res.json() as { data?: { emails?: Record<string, unknown>[]; organization?: string } };
  const emails = data.data?.emails || [];
  return emails.map((e) => ({
    email: e.value as string,
    firstName: (e.first_name as string) || "",
    lastName: (e.last_name as string) || "",
    company: (data.data?.organization as string) || domain,
    position: (e.position as string) || "",
    source: "hunter",
    confidence: e.confidence as number,
  }));
}

async function searchSnov(apiId: string, apiSecret: string, domain: string): Promise<Lead[]> {
  // Get token
  const tokenRes = await fetch("https://api.snov.io/v1/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: apiId, client_secret: apiSecret }),
  });
  if (!tokenRes.ok) return [];
  const tokenData = await tokenRes.json() as { access_token?: string };
  const token = tokenData.access_token;
  if (!token) return [];

  const res = await fetch(
    `https://api.snov.io/v2/domain-emails-with-info?access_token=${token}&domain=${encodeURIComponent(domain)}&type=all&limit=20`
  );
  if (!res.ok) return [];
  const data = await res.json() as { data?: Record<string, unknown>[] };
  const emails = data.data || [];
  return emails.map((e) => ({
    email: (e.email as string) || "",
    firstName: "",
    lastName: "",
    company: domain,
    position: "",
    source: "snov",
    verified: e.status === "verified",
  }));
}

// Task 2: Build initial lead list (one domain at a time to stay within subrequest limits)
async function buildLeadList(env: Env, agentId: number, domains: string[], projectId: number, userId: number) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const allLeads: Lead[] = [];

  // Process only first domain to stay within CF Worker subrequest limit
  // Next cron run will pick up the next domain
  const domain = domains[0];
  if (!domain) {
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", "没有目标域名");
    return { leads: 0, domains: 0 };
  }

  // Search Hunter only (fewer subrequests) or Snov only — not both
  let leads: Lead[] = [];
  if (env.HUNTER_API_KEY) {
    leads = await searchHunter(env.HUNTER_API_KEY, domain);
  } else if (env.SNOV_API_ID && env.SNOV_API_SECRET) {
    leads = await searchSnov(env.SNOV_API_ID, env.SNOV_API_SECRET, domain);
  }

  // Dedupe
  const seen = new Set<string>();
  const uniqueLeads: Lead[] = [];
  for (const lead of leads) {
    const key = lead.email.toLowerCase();
    if (!seen.has(key) && key) {
      seen.add(key);
      uniqueLeads.push(lead);
    }
  }

  // Batch insert using a single SQL statement with VALUES list
  if (uniqueLeads.length > 0) {
    const values = uniqueLeads.map((l) =>
      `(${projectId}, ${userId}, '${l.email.replace(/'/g, "''")}', '${l.firstName.replace(/'/g, "''")}', '${l.lastName.replace(/'/g, "''")}', '${l.company.replace(/'/g, "''")}', '${l.position.replace(/'/g, "''")}', '${l.source}', '${domain}', ${l.confidence || 'NULL'}, ${l.verified || false})`
    ).join(",\n");

    try {
      await sql`INSERT INTO leads (project_id, user_id, email, first_name, last_name, company, position, source, domain, confidence, verified)
        VALUES ${sql.unsafe(values)}
        ON CONFLICT (project_id, email) DO NOTHING`;
    } catch (e) {
      console.error("Batch insert error:", e);
    }
  }

  allLeads.push(...uniqueLeads);

  const summary = `找到 ${uniqueLeads.length} 个联系人 (${domain})，共 ${domains.length} 个目标域名`;
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "客户名单构建", summary, {
    total_leads: uniqueLeads.length,
    domain_searched: domain,
    domains_remaining: domains.length - 1,
    source: env.HUNTER_API_KEY ? "hunter" : "snov",
  });

  return { leads: uniqueLeads.length, domain };
}

export async function handleLeads(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>,
  projectId: number,
  userId: number
) {
  const domains = (config.target_domains as string[]) || [];

  switch (taskIndex) {
    case 2:
      if (domains.length === 0) {
        return { error: "No target domains configured. Resolve the blocker first by providing target domains." };
      }
      return buildLeadList(env, agentId, domains, projectId, userId);
    default:
      return { error: `Task ${taskIndex} not yet implemented for lead prospecting` };
  }
}
