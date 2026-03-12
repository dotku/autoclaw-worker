import { updateTaskStatus, saveReport, getDb } from "../lib/db";
import { cerebrasCompletion } from "../lib/ai";

interface Env {
  DATABASE_URL: string;
  CEREBRAS_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

interface DevAgentConfig {
  repo: string; // e.g. "dotku/gpulaw-attorney-services"
  website?: string;
  competitors?: string[];
  focus_areas?: string[];
  tech_stack?: string;
  [key: string]: unknown;
}

// Task 0: Competitor Research — analyze legal tech competitors
async function competitorResearch(env: Env, agentId: number, config: DevAgentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const competitors = config.competitors || [
    "Clio (clio.com) — practice management, billing, client intake",
    "LegalZoom (legalzoom.com) — document filing, business formation, attorney matching",
    "Rocket Lawyer (rocketlawyer.com) — document automation, legal plans, attorney consultations",
    "DoNotPay (donotpay.com) — AI legal assistant, consumer rights automation",
    "Harvey AI (harvey.ai) — AI legal research, document drafting for law firms",
    "CaseMark (casemark.ai) — AI document summarization, deposition analysis",
    "Ironclad (ironcladapp.com) — contract lifecycle management, AI review",
    "Luminance (luminance.com) — AI contract analysis, due diligence",
  ];

  const focusAreas = config.focus_areas || [
    "user registration & onboarding flow",
    "subscription/payment tiers & pricing",
    "AI-powered legal tools",
    "lawyer marketplace & matching",
    "document management & collaboration",
    "client portal & case tracking",
    "mobile experience",
    "multilingual support",
  ];

  const prompt = `You are a senior product analyst specializing in legal tech. Conduct a detailed competitive analysis for GPULaw Attorney Services (${config.website || "gpulaw.jytech.us"}).

COMPETITORS TO ANALYZE:
${competitors.map((c) => `- ${c}`).join("\n")}

FOCUS AREAS:
${focusAreas.map((f) => `- ${f}`).join("\n")}

CURRENT GPULAW FEATURES:
- AI Document Analyzer (contract analysis, fact extraction)
- AI Legal Researcher (jurisdiction-specific research)
- AI Document Drafter (contracts, motions, briefs)
- AI Document Reviewer (issue detection, scoring)
- Auth0 authentication (basic)
- Prisma + PostgreSQL database
- 3 language support (en, zh-CN, zh-TW)
- Dashboard with case management

MISSING/INCOMPLETE:
- Stripe payment integration (stub only)
- User profile completion pages
- Lawyer verification workflow UI
- Email notification system
- Document storage (S3)

For each competitor, provide:
1. **Key Features** we're missing
2. **Pricing Model** (free tier, plans, pricing)
3. **User Experience** highlights
4. **Technical Approach** (if known)

Then provide a **Priority Feature Matrix** ranked by:
- Impact on user acquisition
- Implementation complexity (low/medium/high)
- Revenue potential

Format as structured markdown. Be specific and actionable.`;

  try {
    const analysis = await cerebrasCompletion(env, prompt, 4000);

    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", analysis);
    await saveReport(env.DATABASE_URL, agentId, "Competitor Research", analysis, {
      competitors_analyzed: competitors.length,
      focus_areas: focusAreas.length,
    });

    return { success: true, competitors_analyzed: competitors.length };
  } catch (e) {
    const msg = `Competitor research failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", msg);
    return { error: msg };
  }
}

// Task 1: Feature Gap Analysis — compare and prioritize
async function featureGapAnalysis(env: Env, agentId: number, config: DevAgentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Get the latest competitor research report
  const latestResearch = await sql`
    SELECT summary FROM agent_reports
    WHERE agent_assignment_id = ${agentId}
    AND task_name = 'Competitor Research'
    ORDER BY created_at DESC LIMIT 1
  `;

  const researchContext = latestResearch.length > 0
    ? (latestResearch[0].summary as string)
    : "No prior competitor research available.";

  const prompt = `You are a technical product manager for GPULaw Attorney Services, an AI-powered legal tech platform.

COMPETITOR RESEARCH:
${researchContext.substring(0, 3000)}

CURRENT TECH STACK:
${config.tech_stack || "Next.js 16, React 19, TypeScript, Prisma 7, PostgreSQL (Neon), Auth0, OpenAI GPT-4, next-intl (en/zh-CN/zh-TW), Tailwind CSS v4"}

Based on the competitor analysis, create a detailed feature gap analysis with implementation plans:

## For each gap, provide:
1. **Feature Name**
2. **Priority**: P0 (critical), P1 (high), P2 (medium), P3 (nice-to-have)
3. **Complexity**: Story points (1-13)
4. **Dependencies**: What needs to exist first
5. **Implementation Plan**: High-level technical approach
6. **Files to Create/Modify**: Specific file paths based on Next.js App Router convention
7. **Acceptance Criteria**: What "done" looks like

## Focus especially on:
1. **User System Enhancement**: Profile pages, onboarding flow, role-based dashboards
2. **Payment Integration**: Stripe checkout, subscription plans, billing management
3. **Lawyer Marketplace**: Matching algorithm, availability calendar, booking flow
4. **Document Management**: Upload/storage, version history, sharing
5. **Notifications**: Email, in-app, webhooks

Produce a structured sprint plan with 2-week sprints. Format as markdown with clear sections.`;

  try {
    const analysis = await cerebrasCompletion(env, prompt, 4000);

    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", analysis);
    await saveReport(env.DATABASE_URL, agentId, "Feature Gap Analysis", analysis, {
      based_on_research: latestResearch.length > 0 ? "yes" : "no",
    });

    return { success: true };
  } catch (e) {
    const msg = `Feature gap analysis failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", msg);
    return { error: msg };
  }
}

// Task 2: Create GitHub Issues — auto-create issues from gap analysis
async function createGitHubIssues(env: Env, agentId: number, config: DevAgentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  if (!env.GITHUB_TOKEN) {
    const msg = "GITHUB_TOKEN not configured — cannot create issues";
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
    return { error: msg };
  }

  const sql = getDb(env.DATABASE_URL);

  // Get the latest gap analysis
  const latestGap = await sql`
    SELECT summary FROM agent_reports
    WHERE agent_assignment_id = ${agentId}
    AND task_name = 'Feature Gap Analysis'
    ORDER BY created_at DESC LIMIT 1
  `;

  if (latestGap.length === 0) {
    const msg = "No gap analysis found — run feature gap analysis first";
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
    return { error: msg };
  }

  const gapAnalysis = latestGap[0].summary as string;

  // Use AI to extract structured issues from the gap analysis
  const prompt = `Extract exactly 5 highest-priority feature issues from this gap analysis. For each, produce a JSON object.

GAP ANALYSIS:
${gapAnalysis.substring(0, 3000)}

Return a JSON array (no markdown, pure JSON) with exactly 5 items:
[
  {
    "title": "Short descriptive title (max 80 chars)",
    "body": "Detailed markdown body with: ## Description, ## Technical Approach, ## Acceptance Criteria, ## Files to Modify",
    "labels": ["enhancement", "priority-p0"],
    "milestone": "Sprint 1"
  }
]

Priority labels: priority-p0, priority-p1, priority-p2
Category labels: user-system, payment, marketplace, documents, notifications
Always include "auto-generated" label.`;

  try {
    const issuesJson = await cerebrasCompletion(env, prompt, 3000);

    // Parse the JSON response
    const jsonMatch = issuesJson.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      const msg = "Failed to parse issues JSON from AI response";
      await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
      return { error: msg };
    }

    const issues = JSON.parse(jsonMatch[0]) as {
      title: string;
      body: string;
      labels: string[];
    }[];

    const repo = config.repo || "dotku/gpulaw-attorney-services";
    const createdIssues: { number: number; title: string; url: string }[] = [];

    for (const issue of issues.slice(0, 5)) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "OpenClaw-DevAgent",
          },
          body: JSON.stringify({
            title: `[AutoDev] ${issue.title}`,
            body: `${issue.body}\n\n---\n_Auto-generated by OpenClaw Dev Agent based on competitor analysis_`,
            labels: [...(issue.labels || []), "auto-generated"],
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { number: number; html_url: string };
          createdIssues.push({ number: data.number, title: issue.title, url: data.html_url });
        } else {
          const err = await res.text();
          createdIssues.push({ number: 0, title: issue.title, url: `Error: ${res.status} ${err}` });
        }
      } catch (e) {
        createdIssues.push({ number: 0, title: issue.title, url: `Error: ${e}` });
      }
    }

    const summary = `Created ${createdIssues.filter((i) => i.number > 0).length}/${issues.length} GitHub issues:\n${createdIssues.map((i) => `- #${i.number}: ${i.title} (${i.url})`).join("\n")}`;

    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "GitHub Issues Created", summary, {
      issues_created: createdIssues.filter((i) => i.number > 0).length,
      issues_failed: createdIssues.filter((i) => i.number === 0).length,
    });

    return { success: true, issues: createdIssues };
  } catch (e) {
    const msg = `GitHub issue creation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
    return { error: msg };
  }
}

// Task 3: Generate Implementation Code — produce code for top priority issue
async function generateImplementation(env: Env, agentId: number, config: DevAgentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  if (!env.GITHUB_TOKEN) {
    const msg = "GITHUB_TOKEN not configured — cannot create PRs";
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", msg);
    return { error: msg };
  }

  const repo = config.repo || "dotku/gpulaw-attorney-services";

  // Get the latest gap analysis for context
  const sql = getDb(env.DATABASE_URL);
  const latestGap = await sql`
    SELECT summary FROM agent_reports
    WHERE agent_assignment_id = ${agentId}
    AND task_name = 'Feature Gap Analysis'
    ORDER BY created_at DESC LIMIT 1
  `;

  // Get open auto-generated issues to pick the top one
  try {
    const issuesRes = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=auto-generated&state=open&sort=created&direction=asc&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "OpenClaw-DevAgent",
        },
      }
    );

    if (!issuesRes.ok) {
      const msg = `Failed to fetch issues: ${issuesRes.status}`;
      await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", msg);
      return { error: msg };
    }

    const openIssues = (await issuesRes.json()) as { number: number; title: string; body: string }[];

    if (openIssues.length === 0) {
      const msg = "No open auto-generated issues to implement";
      await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", msg);
      return { message: msg };
    }

    const issue = openIssues[0];

    // Generate a detailed implementation plan as markdown (more reliable than JSON code)
    const prompt = `You are a senior Next.js/TypeScript developer. Create a detailed implementation plan for this feature.

ISSUE: ${issue.title}
DESCRIPTION:
${issue.body?.substring(0, 2000)}

TECH STACK: Next.js 16 (App Router), React 19, TypeScript 5, Prisma 7, PostgreSQL, Auth0, Tailwind CSS v4, next-intl

PROJECT STRUCTURE:
- app/[locale]/ — pages with i18n
- app/api/ — API routes
- components/ — React components
- lib/ — utilities (auth0.ts, prisma.ts, openai.ts)
- prisma/schema.prisma — database schema
- messages/{en,zh-CN,zh-TW}.json — i18n translations

EXISTING GAP ANALYSIS CONTEXT:
${latestGap.length > 0 ? (latestGap[0].summary as string).substring(0, 1500) : "None"}

Provide a detailed implementation plan in markdown format:

1. **Summary** — What this feature does (2-3 sentences)
2. **Files to Create** — List each new file with its path and a brief description of its purpose
3. **Files to Modify** — List each existing file to modify and what changes are needed
4. **Database Changes** — Any Prisma schema or SQL migration needed (include the actual SQL/Prisma code)
5. **API Endpoints** — Any new API routes with request/response format
6. **Key Code Snippets** — The most critical code snippets (React components, API handlers, etc.)
7. **i18n Keys** — New translation keys needed for en, zh-CN, zh-TW
8. **Testing Checklist** — How to verify the feature works

Be specific with file paths and code. Use TypeScript, Auth0 for auth, Prisma for DB, Tailwind for styling.`;

    const planResponse = await cerebrasCompletion(env, prompt, 4000);

    // Post the implementation plan as a comment on the issue
    await fetch(`https://api.github.com/repos/${repo}/issues/${issue.number}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw-DevAgent",
      },
      body: JSON.stringify({
        body: `## Auto-Generated Implementation Plan\n\n${planResponse}\n\n---\n_Generated by OpenClaw Dev Agent. Review and implement via PR._`,
      }),
    });

    const summary = `Generated implementation plan for issue #${issue.number}: ${issue.title}\n\nPlan posted as comment on the issue.`;

    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Implementation Plan", summary, {
      issue_number: issue.number,
    });

    return { success: true, issue: issue.number };
  } catch (e) {
    const msg = `Code generation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", msg);
    return { error: msg };
  }
}

// Task 4: Sprint Progress Report
async function sprintReport(env: Env, agentId: number, config: DevAgentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const repo = config.repo || "dotku/gpulaw-attorney-services";

  // Get all dev agent reports
  const reports = await sql`
    SELECT task_name, summary, metrics, created_at
    FROM agent_reports
    WHERE agent_assignment_id = ${agentId}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  // Get GitHub issues status if token available
  let issuesSummary = "GitHub token not available";
  if (env.GITHUB_TOKEN) {
    try {
      const openRes = await fetch(
        `https://api.github.com/repos/${repo}/issues?labels=auto-generated&state=open&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "OpenClaw-DevAgent",
          },
        }
      );
      const closedRes = await fetch(
        `https://api.github.com/repos/${repo}/issues?labels=auto-generated&state=closed&per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "OpenClaw-DevAgent",
          },
        }
      );

      if (openRes.ok && closedRes.ok) {
        const open = (await openRes.json()) as { number: number; title: string }[];
        const closed = (await closedRes.json()) as { number: number; title: string }[];
        issuesSummary = `Open: ${open.length}, Closed: ${closed.length}\nOpen issues:\n${open.map((i) => `- #${i.number}: ${i.title}`).join("\n")}`;
      }
    } catch {
      issuesSummary = "Failed to fetch GitHub issues";
    }
  }

  const reportContext = reports.map((r) =>
    `- [${r.task_name}] ${(r.summary as string)?.substring(0, 150)} (${r.created_at})`
  ).join("\n");

  const prompt = `Generate a sprint progress report for GPULaw Attorney Services development automation.

DEV AGENT ACTIVITY:
${reportContext || "No prior activity"}

GITHUB ISSUES STATUS:
${issuesSummary}

PROJECT: ${repo}
WEBSITE: ${config.website || "gpulaw.jytech.us"}

Generate a concise sprint report with:
1. **Sprint Summary** — what was accomplished
2. **Competitor Insights** — key takeaways from research
3. **Development Progress** — issues created, code generated
4. **Blockers** — anything stalled or needing attention
5. **Next Sprint Priorities** — top 3 items for next cycle
6. **Velocity Metrics** — issues opened vs closed, code generation success rate

Format as markdown. Keep it actionable and concise.`;

  try {
    const report = await cerebrasCompletion(env, prompt, 1500);

    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", report);
    await saveReport(env.DATABASE_URL, agentId, "Sprint Progress Report", report, {
      total_reports: reports.length,
    });

    return { success: true };
  } catch (e) {
    const msg = `Sprint report failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", msg);
    return { error: msg };
  }
}

export async function handleDevAgent(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>
) {
  const devConfig = config as unknown as DevAgentConfig;

  switch (taskIndex) {
    case 0:
      return competitorResearch(env, agentId, devConfig);
    case 1:
      return featureGapAnalysis(env, agentId, devConfig);
    case 2:
      return createGitHubIssues(env, agentId, devConfig);
    case 3:
      return generateImplementation(env, agentId, devConfig);
    case 4:
      return sprintReport(env, agentId, devConfig);
    default:
      return { error: `Task ${taskIndex} not implemented for dev_agent` };
  }
}
