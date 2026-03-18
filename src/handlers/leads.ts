import { updateTaskStatus, saveReport, failTask, getDb, withModelMetrics, logStep, clearSteps } from "../lib/db";
import { cerebrasCompletionWithMeta } from "../lib/ai";
import { localeInstruction, t as tl } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  HUNTER_API_KEY?: string;
  SNOV_API_ID?: string;
  SNOV_API_SECRET?: string;
  APOLLO_API_KEY?: string;
  APIFY_API_TOKEN?: string;
  CEREBRAS_API_KEY?: string;
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

async function searchApollo(apiKey: string, domain: string): Promise<Lead[]> {
  const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ q_organization_domains: domain, page: 1, per_page: 25 }),
  });
  if (!res.ok) {
    if (res.status === 403) return []; // Apollo free plan — people search not available
    const text = await res.text().catch(() => "");
    throw new Error(`Apollo API error ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json() as { people?: Record<string, unknown>[] };
  return (data.people || [])
    .filter((p) => p.email)
    .map((p) => ({
      email: p.email as string,
      firstName: (p.first_name as string) || "",
      lastName: (p.last_name as string) || "",
      company: (p.organization_name as string) || domain,
      position: (p.title as string) || "",
      source: "apollo",
      confidence: (p.email_status === "verified" ? 95 : 70),
      verified: p.email_status === "verified",
    }));
}

async function searchHunter(apiKey: string, domain: string): Promise<Lead[]> {
  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${apiKey}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hunter API error ${res.status}: ${text.substring(0, 200)}`);
  }
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
  if (!tokenRes.ok) {
    throw new Error(`Snov auth error ${tokenRes.status}`);
  }
  const tokenData = await tokenRes.json() as { access_token?: string };
  const token = tokenData.access_token;
  if (!token) throw new Error("Snov: no access token returned");

  const res = await fetch(
    `https://api.snov.io/v2/domain-emails-with-info?access_token=${token}&domain=${encodeURIComponent(domain)}&type=all&limit=20`
  );
  if (!res.ok) {
    throw new Error(`Snov API error ${res.status}`);
  }
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

async function searchApify(apiToken: string, domain: string): Promise<Lead[]> {
  // Step 1: Start the actor run (async)
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/code_crafter~leads-finder/runs?token=${apiToken}&waitForFinish=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_domain: [domain],
        maxItems: 100,
      }),
    },
  );
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Apify start error ${startRes.status}: ${text.substring(0, 200)}`);
  }
  const runData = await startRes.json() as { data?: { id?: string; status?: string; defaultDatasetId?: string } };
  const run = runData.data;
  if (!run?.id) throw new Error("Apify: no run ID returned");

  // If run finished within waitForFinish, grab dataset directly
  let datasetId = run.defaultDatasetId;

  // If not finished yet, poll once more (up to 60s)
  if (run.status !== "SUCCEEDED" && run.status !== "FAILED") {
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${run.id}?token=${apiToken}&waitForFinish=60`,
    );
    if (pollRes.ok) {
      const pollData = await pollRes.json() as { data?: { status?: string; defaultDatasetId?: string } };
      if (pollData.data?.status === "FAILED" || pollData.data?.status === "ABORTED") {
        throw new Error(`Apify run ${pollData.data.status}`);
      }
      datasetId = pollData.data?.defaultDatasetId || datasetId;
    }
  } else if (run.status === "FAILED") {
    throw new Error("Apify run failed");
  }

  if (!datasetId) throw new Error("Apify: no dataset ID");

  // Step 2: Fetch dataset items
  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}&limit=200`,
  );
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => "");
    throw new Error(`Apify dataset error ${itemsRes.status}: ${text.substring(0, 200)}`);
  }
  const items = (await itemsRes.json()) as Record<string, unknown>[];
  return items
    .filter((p) => p.email)
    .map((p) => ({
      email: String(p.email),
      firstName: String(p.first_name || p.firstName || ""),
      lastName: String(p.last_name || p.lastName || ""),
      company: String(p.company_name || p.organization || domain),
      position: String(p.title || p.job_title || ""),
      source: "apify",
      confidence: 80,
      verified: false,
    }));
}

// Apify: Crawl website with JS rendering (for SPAs that return blank on basic fetch)
async function crawlWebsiteApify(apiToken: string, url: string): Promise<string> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/apify~website-content-crawler/runs?token=${apiToken}&waitForFinish=120`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlDepth: 0,
        maxCrawlPages: 3,
        crawlerType: "playwright:firefox",
      }),
    },
  );
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Apify crawler start error ${startRes.status}: ${text.substring(0, 200)}`);
  }
  const runData = await startRes.json() as { data?: { id?: string; status?: string; defaultDatasetId?: string } };
  const run = runData.data;
  if (!run?.id) throw new Error("Apify crawler: no run ID returned");

  let datasetId = run.defaultDatasetId;
  if (run.status !== "SUCCEEDED" && run.status !== "FAILED") {
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${run.id}?token=${apiToken}&waitForFinish=120`,
    );
    if (pollRes.ok) {
      const pollData = await pollRes.json() as { data?: { status?: string; defaultDatasetId?: string } };
      if (pollData.data?.status === "FAILED" || pollData.data?.status === "ABORTED") {
        throw new Error(`Apify crawler run ${pollData.data.status}`);
      }
      datasetId = pollData.data?.defaultDatasetId || datasetId;
    }
  } else if (run.status === "FAILED") {
    throw new Error("Apify crawler run failed");
  }

  if (!datasetId) throw new Error("Apify crawler: no dataset ID");

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}&limit=5`,
  );
  if (!itemsRes.ok) throw new Error(`Apify crawler dataset error ${itemsRes.status}`);
  const items = (await itemsRes.json()) as { url?: string; text?: string; metadata?: { title?: string; description?: string } }[];

  const parts: string[] = [];
  for (const item of items) {
    if (item.metadata?.title) parts.push(`Title: ${item.metadata.title}`);
    if (item.metadata?.description) parts.push(`Description: ${item.metadata.description}`);
    if (item.text) parts.push(item.text.substring(0, 1500));
  }
  return parts.join("\n").substring(0, 3000);
}

// Apify: Google Search to gather public info about a company
async function searchGoogleApify(apiToken: string, queries: string[]): Promise<string> {
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/apify~google-search-scraper/runs?token=${apiToken}&waitForFinish=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: queries.join("\n"),
        maxPagesPerQuery: 1,
        resultsPerPage: 5,
        languageCode: "",
      }),
    },
  );
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Apify Google search start error ${startRes.status}: ${text.substring(0, 200)}`);
  }
  const runData = await startRes.json() as { data?: { id?: string; status?: string; defaultDatasetId?: string } };
  const run = runData.data;
  if (!run?.id) throw new Error("Apify Google search: no run ID returned");

  let datasetId = run.defaultDatasetId;
  if (run.status !== "SUCCEEDED" && run.status !== "FAILED") {
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${run.id}?token=${apiToken}&waitForFinish=60`,
    );
    if (pollRes.ok) {
      const pollData = await pollRes.json() as { data?: { status?: string; defaultDatasetId?: string } };
      if (pollData.data?.status === "FAILED" || pollData.data?.status === "ABORTED") {
        throw new Error(`Apify Google search run ${pollData.data.status}`);
      }
      datasetId = pollData.data?.defaultDatasetId || datasetId;
    }
  } else if (run.status === "FAILED") {
    throw new Error("Apify Google search run failed");
  }

  if (!datasetId) throw new Error("Apify Google search: no dataset ID");

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}&limit=3`,
  );
  if (!itemsRes.ok) throw new Error(`Apify Google search dataset error ${itemsRes.status}`);
  const items = (await itemsRes.json()) as { searchQuery?: { term?: string }; organicResults?: { title?: string; description?: string; url?: string }[] }[];

  const parts: string[] = [];
  for (const item of items) {
    if (item.searchQuery?.term) parts.push(`\n[Search: ${item.searchQuery.term}]`);
    for (const r of (item.organicResults || []).slice(0, 5)) {
      parts.push(`- ${r.title || ""}: ${r.description || ""}`);
    }
  }
  return parts.join("\n").substring(0, 2000);
}

// Load knowledge base documents for the project
async function loadKnowledgeBase(databaseUrl: string, projectId: number, _userId: number): Promise<{ title: string; docType: string; content: string }[]> {
  const sql = getDb(databaseUrl);
  // Only load project-scoped KB docs to avoid cross-project contamination.
  // Personal docs from other projects would pollute ICP/search results.
  const rows = await sql`
    SELECT d.title, d.doc_type, c.content
    FROM kb_chunks c
    JOIN kb_documents d ON c.document_id = d.id
    WHERE d.status = 'ready'
      AND c.content IS NOT NULL
      AND d.scope = 'project'
      AND d.project_id = ${projectId}
    ORDER BY d.id, c.chunk_index
    LIMIT 50
  `;
  return rows.map((r) => ({
    title: r.title as string,
    docType: r.doc_type as string,
    content: r.content as string,
  }));
}

// Task 0: Define ICP and qualification criteria using Knowledge Base
async function defineICP(env: Env, agentId: number, projectDesc: string, website: string, projectName: string, projectId: number, userId: number, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");
  await clearSteps(env.DATABASE_URL, agentId, 0);

  const sources: string[] = [];
  // Collect per-step findings for the final report
  const stepFindings: { step: string; detail: string }[] = [];
  let kbContext = "";

  // 1. Load knowledge base documents
  await logStep(env.DATABASE_URL, agentId, 0, "load_kb", "running");
  try {
    const kbResources = await loadKnowledgeBase(env.DATABASE_URL, projectId, userId);
    if (kbResources.length > 0) {
      const docMap = new Map<string, { docType: string; chunks: string[] }>();
      for (const r of kbResources) {
        const existing = docMap.get(r.title);
        if (existing) {
          existing.chunks.push(r.content);
        } else {
          docMap.set(r.title, { docType: r.docType, chunks: [r.content] });
        }
      }
      kbContext = "\n\n--- Knowledge Base Resources ---\n";
      let charBudget = 3000;
      const kbTitles: string[] = [];
      for (const [title, doc] of docMap) {
        const fullContent = doc.chunks.join("\n");
        const truncated = fullContent.substring(0, Math.min(fullContent.length, charBudget));
        kbContext += `\n**[${doc.docType.toUpperCase()}] ${title}:**\n${truncated}\n`;
        charBudget -= truncated.length;
        sources.push(`kb: ${title} (${doc.docType})`);
        kbTitles.push(`${title} (${doc.docType})`);
        if (charBudget <= 0) break;
      }
      const kbDetail = `Loaded ${kbResources.length} docs: ${kbTitles.join(", ")}`;
      stepFindings.push({ step: "Knowledge Base", detail: kbDetail });
      await logStep(env.DATABASE_URL, agentId, 0, "load_kb", "done", kbDetail);
    } else {
      stepFindings.push({ step: "Knowledge Base", detail: "No documents found" });
      await logStep(env.DATABASE_URL, agentId, 0, "load_kb", "done", "0 docs");
    }
  } catch (e) {
    console.error("KB load error:", e);
    stepFindings.push({ step: "Knowledge Base", detail: `Error: ${e}` });
  }

  // 2. Fetch website for additional context (with Apify fallback for JS-rendered sites)
  let websiteContext = "";
  if (website) {
    await logStep(env.DATABASE_URL, agentId, 0, "fetch_website", "running", website);
    try {
      const res = await fetch(website, {
        headers: { "User-Agent": "AutoClaw-ICP-Bot/1.0" },
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/is);
        const bodyText = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 1000);

        // Check if basic fetch returned meaningful content (SPA sites often return near-empty HTML)
        if (bodyText.length > 100) {
          websiteContext = `\n\n--- Website (${website}) ---\n`;
          if (titleMatch?.[1]) websiteContext += `Title: ${titleMatch[1].trim()}\n`;
          if (metaDescMatch?.[1]) websiteContext += `Description: ${metaDescMatch[1].trim()}\n`;
          websiteContext += `Content: ${bodyText.substring(0, 600)}\n`;
          sources.push(`website: ${website}`);
          const siteTitle = titleMatch?.[1]?.trim() || "";
          const siteDesc = metaDescMatch?.[1]?.trim() || "";
          stepFindings.push({ step: "Website Fetch", detail: `Direct fetch OK (${bodyText.length} chars). Title: "${siteTitle}". Description: "${siteDesc}"` });
        } else if (env.APIFY_API_TOKEN) {
          // Basic fetch returned near-empty content — use Apify Website Content Crawler
          await logStep(env.DATABASE_URL, agentId, 0, "fetch_website", "running", "SPA detected, using Apify crawler");
          const crawledContent = await crawlWebsiteApify(env.APIFY_API_TOKEN, website);
          if (crawledContent.length > 50) {
            websiteContext = `\n\n--- Website (${website}, crawled via Apify) ---\n${crawledContent}\n`;
            sources.push(`website: ${website} (apify-crawled)`);
            stepFindings.push({ step: "Website Fetch", detail: `SPA detected (basic fetch ${bodyText.length} chars). Apify crawler extracted ${crawledContent.length} chars:\n${crawledContent.substring(0, 500)}` });
          } else {
            stepFindings.push({ step: "Website Fetch", detail: `SPA detected. Apify crawler also returned minimal content (${crawledContent.length} chars)` });
          }
        } else {
          stepFindings.push({ step: "Website Fetch", detail: `SPA detected (basic fetch ${bodyText.length} chars). No Apify token to try JS rendering.` });
        }
      }
      await logStep(env.DATABASE_URL, agentId, 0, "fetch_website", "done");
    } catch {
      // If basic fetch fails entirely and Apify is available, try crawling
      if (env.APIFY_API_TOKEN) {
        try {
          const crawledContent = await crawlWebsiteApify(env.APIFY_API_TOKEN, website);
          if (crawledContent.length > 50) {
            websiteContext = `\n\n--- Website (${website}, crawled via Apify) ---\n${crawledContent}\n`;
            sources.push(`website: ${website} (apify-crawled)`);
            stepFindings.push({ step: "Website Fetch", detail: `Direct fetch failed. Apify fallback extracted ${crawledContent.length} chars:\n${crawledContent.substring(0, 500)}` });
          } else {
            stepFindings.push({ step: "Website Fetch", detail: "Direct fetch failed. Apify fallback also returned minimal content." });
          }
        } catch (crawlErr) {
          console.error("Apify crawl fallback also failed:", crawlErr);
          stepFindings.push({ step: "Website Fetch", detail: `Direct fetch failed. Apify fallback also failed: ${crawlErr}` });
        }
      }
      if (!websiteContext) {
        await logStep(env.DATABASE_URL, agentId, 0, "fetch_website", "error", "Failed to fetch");
        if (!stepFindings.some(f => f.step === "Website Fetch")) {
          stepFindings.push({ step: "Website Fetch", detail: "Failed to fetch website content" });
        }
      }
    }
  }

  // 3. Google Search for additional company context (Apify)
  let searchContext = "";
  if (env.APIFY_API_TOKEN && projectName) {
    await logStep(env.DATABASE_URL, agentId, 0, "search_company", "running", projectName);
    try {
      const domain = website ? new URL(website).hostname.replace("www.", "") : "";
      const queries = [
        `"${projectName}" company`,
        domain ? `site:${domain} OR "${domain}" products services` : `"${projectName}" products services`,
      ];
      const searchResults = await searchGoogleApify(env.APIFY_API_TOKEN, queries);
      if (searchResults.length > 50) {
        searchContext = `\n\n--- Google Search Results ---\n${searchResults}\n`;
        sources.push("google search (apify)");
      }
      const searchDetail = searchResults.length > 50
        ? `Queries: ${queries.join(" | ")}\nResults (${searchResults.length} chars):\n${searchResults.substring(0, 800)}`
        : `Queries: ${queries.join(" | ")}\nNo meaningful results found (${searchResults.length} chars)`;
      stepFindings.push({ step: "Google Search", detail: searchDetail });
      await logStep(env.DATABASE_URL, agentId, 0, "search_company", "done", searchDetail.substring(0, 200));
    } catch (e) {
      console.error("Apify Google search failed:", e);
      stepFindings.push({ step: "Google Search", detail: `Failed: ${e}` });
      await logStep(env.DATABASE_URL, agentId, 0, "search_company", "error", `${e}`);
    }
  }

  if (projectName) sources.push(`project name: ${projectName}`);
  if (projectDesc) sources.push(`project description`);

  if (!projectDesc && !kbContext && !websiteContext && !searchContext) {
    const msg = "No data available. Please add documents to the Knowledge Base, or set a website and description in the project settings.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "ICP Definition", msg, {
      sources: "none",
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg };
  }

  const prompt = `You are a B2B sales strategist. Based on the following real business data, define a detailed Ideal Customer Profile (ICP) and lead qualification criteria:

**Business Name:** ${projectName || "N/A"}
**Business Description:** ${projectDesc || "N/A"}
${kbContext}
${websiteContext}
${searchContext}

Based on ALL the above data (especially the Knowledge Base resources and search results), provide:
1. **Target Industries** (3-5 industries with reasoning based on the actual business)
2. **Company Size** (employee count range, revenue range)
3. **Geography** (target regions/countries)
4. **Key Decision Makers** (5-8 job titles to target)
5. **Pain Points** (3-5 problems this product solves — cite KB content)
6. **Qualification Criteria**
   - Must-have signals (budget, authority, need, timeline)
   - Nice-to-have signals
   - Disqualification criteria
7. **Target Company Examples** (5 example companies that fit the ICP)

IMPORTANT: Reference the actual product/service details from the knowledge base. Do NOT generate generic advice.
Format as structured text with clear headings.
${langHint}`;

  try {
    await logStep(env.DATABASE_URL, agentId, 0, "ai_analyze", "running", preferredModel);
    const { content: icpContent, model } = await cerebrasCompletionWithMeta(env, prompt, 1500, preferredModel);
    await logStep(env.DATABASE_URL, agentId, 0, "ai_analyze", "done", model);

    // Extract search criteria (target_domains, keywords, etc.) from the ICP output — this has
    // the best context about target industries, company examples, and geography.
    await logStep(env.DATABASE_URL, agentId, 0, "extract_criteria", "running");
    const criteria = await extractSearchCriteria(env, icpContent + "\n\nProject: " + projectName + "\n" + projectDesc, kbContext, preferredModel);
    if (criteria.target_domains.length > 0 || criteria.keywords.length > 0) {
      try {
        const sql = getDb(env.DATABASE_URL);
        const agentRows = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
        if (agentRows.length > 0) {
          const currentConfig = (agentRows[0].config as Record<string, unknown>) || {};
          currentConfig.target_domains = criteria.target_domains;
          currentConfig.search_keywords = criteria.keywords;
          currentConfig.target_industries = criteria.industries;
          currentConfig.target_titles = criteria.job_titles;
          await sql`UPDATE agent_assignments SET config = ${JSON.stringify(currentConfig)} WHERE id = ${agentId}`;
        }
      } catch (e) {
        console.error("Failed to save search criteria to config:", e);
      }
    }

    await logStep(env.DATABASE_URL, agentId, 0, "extract_criteria", "done", `${criteria.target_domains.length} domains, ${criteria.keywords.length} keywords`);

    // Add criteria extraction to step findings
    stepFindings.push({
      step: "Search Criteria Extraction",
      detail: `Industries: ${criteria.industries.join(", ") || "none"}\nJob Titles: ${criteria.job_titles.join(", ") || "none"}\nKeywords: ${criteria.keywords.join(", ") || "none"}\nTarget Domains: ${criteria.target_domains.join(", ") || "none"}`,
    });

    await logStep(env.DATABASE_URL, agentId, 0, "save_result", "running");

    // Build full result with step-by-step findings appended
    const findingsSection = stepFindings.map(f => `### ${f.step}\n${f.detail}`).join("\n\n");
    let resultWithDomains = icpContent;
    if (criteria.target_domains.length > 0) {
      resultWithDomains += `\n\n---\n**Auto-configured target domains:** ${criteria.target_domains.join(", ")}\n**Search keywords:** ${criteria.keywords.join(", ")}`;
    }
    resultWithDomains += `\n\n---\n## Data Collection Details\n\n${findingsSection}`;

    const summary = `Defined ICP using ${sources.length} sources: ${sources.join(", ")}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", resultWithDomains);
    await saveReport(env.DATABASE_URL, agentId, "ICP Definition", summary, withModelMetrics({
      sources: sources.join(", "),
      kb_documents_used: sources.filter(s => s.startsWith("kb:")).length,
      website_analyzed: website || "none",
      website_method: sources.some(s => s.includes("apify-crawled")) ? "apify-crawler" : sources.some(s => s.startsWith("website:")) ? "direct-fetch" : "none",
      google_search_used: sources.includes("google search (apify)") ? "yes" : "no",
      target_domains_found: criteria.target_domains.length,
      step_findings_json: JSON.stringify(stepFindings),
    }, preferredModel, model));
    await logStep(env.DATABASE_URL, agentId, 0, "save_result", "done");

    return { icp: icpContent, target_domains: criteria.target_domains };
  } catch (e) {
    const msg = `ICP definition failed: ${e}`;
    await logStep(env.DATABASE_URL, agentId, 0, "ai_analyze", "error", msg);
    await failTask(env.DATABASE_URL, agentId, 0, "ICP Definition", msg, preferredModel);
    return { error: msg };
  }
}

// Task 1: Set up & verify data sources (Apollo, Hunter, Snov)
async function setupDataSources(env: Env, agentId: number) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sources: { name: string; configured: boolean; status: string; error?: string }[] = [];

  // Check Apollo
  if (env.APOLLO_API_KEY) {
    try {
      const res = await fetch("https://api.apollo.io/v1/auth/health", {
        method: "GET",
        headers: { "X-Api-Key": env.APOLLO_API_KEY },
      });
      const body = await res.text().catch(() => "");
      // Apollo returns {"is_logged_in": true} on success
      if (res.ok && body.includes("is_logged_in")) {
        sources.push({ name: "Apollo", configured: true, status: "verified", error: "Free plan: people search limited, enrichment works. Upgrade for full search." });
      } else {
        sources.push({ name: "Apollo", configured: true, status: "error", error: `API returned ${res.status}: ${body.substring(0, 100)}` });
      }
    } catch (e) {
      sources.push({ name: "Apollo", configured: true, status: "error", error: `${e}` });
    }
  } else {
    sources.push({ name: "Apollo", configured: false, status: "not configured" });
  }

  // Check Hunter
  if (env.HUNTER_API_KEY) {
    try {
      const res = await fetch(`https://api.hunter.io/v2/account?api_key=${env.HUNTER_API_KEY}`);
      if (res.ok) {
        const data = await res.json() as { data?: { requests?: { searches?: { available: number } } } };
        const available = data.data?.requests?.searches?.available ?? 0;
        sources.push({ name: "Hunter", configured: true, status: "verified", error: available > 0 ? undefined : "No search credits remaining" });
      } else {
        sources.push({ name: "Hunter", configured: true, status: "error", error: `API returned ${res.status}` });
      }
    } catch (e) {
      sources.push({ name: "Hunter", configured: true, status: "error", error: `${e}` });
    }
  } else {
    sources.push({ name: "Hunter", configured: false, status: "not configured" });
  }

  // Check Snov
  if (env.SNOV_API_ID && env.SNOV_API_SECRET) {
    try {
      const tokenRes = await fetch("https://api.snov.io/v1/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", client_id: env.SNOV_API_ID, client_secret: env.SNOV_API_SECRET }),
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { access_token?: string };
        sources.push({ name: "Snov", configured: true, status: tokenData.access_token ? "verified" : "error", error: tokenData.access_token ? undefined : "No access token returned" });
      } else {
        sources.push({ name: "Snov", configured: true, status: "error", error: `Auth returned ${tokenRes.status}` });
      }
    } catch (e) {
      sources.push({ name: "Snov", configured: true, status: "error", error: `${e}` });
    }
  } else {
    sources.push({ name: "Snov", configured: false, status: "not configured" });
  }

  // Check Apify
  if (env.APIFY_API_TOKEN) {
    try {
      const res = await fetch("https://api.apify.com/v2/users/me?token=" + env.APIFY_API_TOKEN);
      if (res.ok) {
        sources.push({ name: "Apify", configured: true, status: "verified" });
      } else {
        sources.push({ name: "Apify", configured: true, status: "error", error: `API returned ${res.status}` });
      }
    } catch (e) {
      sources.push({ name: "Apify", configured: true, status: "error", error: `${e}` });
    }
  } else {
    sources.push({ name: "Apify", configured: false, status: "not configured" });
  }

  const verified = sources.filter((s) => s.status === "verified");
  const errors = sources.filter((s) => s.status === "error");
  // Build a detailed markdown result for the log
  const lines: string[] = ["## Data Source Verification\n"];
  for (const s of sources) {
    const icon = s.status === "verified" ? "✅" : s.status === "error" ? "❌" : "⬜";
    const warning = s.status === "verified" && s.error ? ` ⚠️ ${s.error}` : "";
    const errMsg = s.status === "error" && s.error ? ` — ${s.error}` : "";
    lines.push(`${icon} **${s.name}**: ${s.status}${errMsg}${warning}`);
  }
  lines.push("");

  if (verified.length > 0) {
    lines.push(`**Ready to use:** ${verified.map((s) => s.name).join(", ")}`);
  }
  if (errors.length > 0) {
    lines.push(`\n> ⚠️ ${errors.map((s) => `${s.name}: ${s.error}`).join("; ")}`);
  }
  if (verified.length === 0) {
    lines.push("\n> No data sources available. Add at least one API key (Apollo, Hunter, or Snov) in Settings → BYOK.");
  }

  const detailedResult = lines.join("\n");
  const shortSummary = verified.length > 0
    ? `Using ${verified.map((s) => s.name).join(", ")} for lead prospecting`
    : "No data sources available. Add API keys in Settings → BYOK.";

  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", detailedResult);
  await saveReport(env.DATABASE_URL, agentId, "Data Sources", shortSummary, {
    verified_count: verified.length,
    error_count: errors.length,
    sources_summary: sources.map((s) => `${s.name}:${s.status}`).join(", "),
    model_used: "none",
    preferred_model: "none",
  });

  return { sources, verified: verified.length };
}

// Use AI to extract search criteria from KB + project description
async function extractSearchCriteria(
  env: Env,
  projectDesc: string,
  kbContent: string,
  preferredModel: string,
): Promise<{ industries: string[]; job_titles: string[]; keywords: string[]; target_domains: string[] }> {
  const prompt = `You are a B2B lead generation expert. Based on the following business information, extract search criteria to find potential CUSTOMERS or TARGET COMPANIES in this specific industry/market.

Business Description: ${projectDesc || "N/A"}

Knowledge Base Content:
${kbContent || "N/A"}

IMPORTANT RULES for target_domains:
- These must be REAL company websites in the TARGET INDUSTRY described above
- Do NOT include sales tools (zoominfo.com, apollo.io, linkedin.com, hunter.io, etc.)
- Do NOT include generic platforms or SaaS tools
- ONLY include actual companies that are potential customers or targets
- Example: if the business is about "European energy storage", target_domains should be real energy storage companies like "sonnen.de", "byd.com", "sungrow.com", "fluence.com", etc.

Return a JSON object with:
- "industries": array of 3-5 target industries (e.g. "renewable energy", "energy storage", "EV charging")
- "job_titles": array of 5-8 job titles of decision makers (e.g. "CTO", "Head of Procurement", "VP Engineering")
- "keywords": array of 3-5 search keywords for the target market (e.g. "battery storage manufacturer", "solar installer")
- "target_domains": array of 5-10 REAL company domains in the target industry (e.g. "sonnen.de", "fluence.com", "byd.com")

Return ONLY the JSON object, no other text.`;

  try {
    const { content } = await cerebrasCompletionWithMeta(env, prompt, 800, preferredModel);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        industries: Array.isArray(parsed.industries) ? parsed.industries : [],
        job_titles: Array.isArray(parsed.job_titles) ? parsed.job_titles : [],
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        target_domains: Array.isArray(parsed.target_domains) ? parsed.target_domains : [],
      };
    }
  } catch (e) {
    console.error("Search criteria extraction failed:", e);
  }
  return { industries: [], job_titles: [], keywords: [], target_domains: [] };
}

// Apify search with industry/keyword filters (not just domain)
async function searchApifyWithCriteria(
  apiToken: string,
  criteria: { industries: string[]; job_titles: string[]; keywords: string[] },
): Promise<Lead[]> {
  // Use company_keywords for all search terms (company_industry requires exact enum values)
  const allKeywords = [...criteria.keywords, ...criteria.industries].slice(0, 10);
  const input: Record<string, unknown> = { maxItems: 100 };
  if (criteria.job_titles.length > 0) input.person_titles = criteria.job_titles;
  if (allKeywords.length > 0) input.company_keywords = allKeywords;

  // Start async run with waitForFinish
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/code_crafter~leads-finder/runs?token=${apiToken}&waitForFinish=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => "");
    throw new Error(`Apify start error ${startRes.status}: ${text.substring(0, 200)}`);
  }
  const runData = await startRes.json() as { data?: { id?: string; status?: string; defaultDatasetId?: string } };
  const run = runData.data;
  if (!run?.id) throw new Error("Apify: no run ID returned");

  let datasetId = run.defaultDatasetId;
  if (run.status !== "SUCCEEDED" && run.status !== "FAILED") {
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${run.id}?token=${apiToken}&waitForFinish=60`,
    );
    if (pollRes.ok) {
      const pollData = await pollRes.json() as { data?: { status?: string; defaultDatasetId?: string } };
      if (pollData.data?.status === "FAILED" || pollData.data?.status === "ABORTED") {
        throw new Error(`Apify run ${pollData.data.status}`);
      }
      datasetId = pollData.data?.defaultDatasetId || datasetId;
    }
  } else if (run.status === "FAILED") {
    throw new Error("Apify run failed");
  }

  if (!datasetId) throw new Error("Apify: no dataset ID");

  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiToken}&limit=200`,
  );
  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => "");
    throw new Error(`Apify dataset error ${itemsRes.status}: ${text.substring(0, 200)}`);
  }
  const items = (await itemsRes.json()) as Record<string, unknown>[];
  return items
    .filter((p) => p.email)
    .map((p) => ({
      email: String(p.email),
      firstName: String(p.first_name || p.firstName || ""),
      lastName: String(p.last_name || p.lastName || ""),
      company: String(p.company_name || p.organization || ""),
      position: String(p.title || p.job_title || ""),
      source: "apify",
      confidence: 80,
      verified: false,
    }));
}

// Task 2: Build initial lead list using KB-driven search criteria
async function buildLeadList(env: Env, agentId: number, domains: string[], projectId: number, userId: number, projectDesc: string, preferredModel: string, locale = "en") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // 1. Load KB content + ICP result from Task 0 for context
  let kbContent = "";
  try {
    const kbResources = await loadKnowledgeBase(env.DATABASE_URL, projectId, userId);
    if (kbResources.length > 0) {
      kbContent = kbResources
        .map((r) => `[${r.title}]: ${r.content}`)
        .join("\n")
        .substring(0, 2000);
    }
  } catch { /* non-critical */ }

  // Load ICP result from Task 0 as additional context for search criteria extraction
  let icpContext = "";
  try {
    const agentRows = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
    if (agentRows.length > 0) {
      const agentConfig = agentRows[0].config as Record<string, unknown>;
      const agentTasks = (agentConfig.tasks as { result?: string }[]) || [];
      if (agentTasks[0]?.result) {
        icpContext = agentTasks[0].result.substring(0, 3000);
      }
    }
  } catch { /* non-critical */ }

  // 2. Use AI to extract search criteria — feed ICP output + KB + project desc
  const fullContext = [projectDesc, icpContext, kbContent].filter(Boolean).join("\n\n");
  const criteria = await extractSearchCriteria(env, fullContext, kbContent, preferredModel);

  // Merge AI-suggested domains with configured domains
  const allDomains = [...new Set([...domains, ...criteria.target_domains])];

  const allLeads: Lead[] = [];
  const usedSources: string[] = [];
  const errors: string[] = [];

  // 3. Search with Apify using industry/keyword criteria (best for KB-driven search)
  if (env.APIFY_API_TOKEN && (criteria.industries.length > 0 || criteria.keywords.length > 0)) {
    try {
      const apifyLeads = await searchApifyWithCriteria(env.APIFY_API_TOKEN, criteria);
      allLeads.push(...apifyLeads);
      if (apifyLeads.length > 0) usedSources.push(`apify(${apifyLeads.length})`);
    } catch (e) {
      errors.push(`Apify: ${e}`);
    }
  }

  // 4. Search by domain with Apollo/Hunter/Snov for each target domain (limit to 2 to stay within subrequest limits)
  for (const domain of allDomains.slice(0, 2)) {
    // Apollo: returns [] silently on free plan 403, works on paid plans
    if (env.APOLLO_API_KEY) {
      try {
        const apolloLeads = await searchApollo(env.APOLLO_API_KEY, domain);
        if (apolloLeads.length > 0) {
          allLeads.push(...apolloLeads);
          usedSources.push(`apollo:${domain}(${apolloLeads.length})`);
        }
      } catch (e) {
        errors.push(`Apollo[${domain}]: ${e}`);
      }
    }

    if (env.HUNTER_API_KEY) {
      try {
        const hunterLeads = await searchHunter(env.HUNTER_API_KEY, domain);
        allLeads.push(...hunterLeads);
        if (hunterLeads.length > 0) usedSources.push(`hunter:${domain}(${hunterLeads.length})`);
      } catch (e) {
        errors.push(`Hunter[${domain}]: ${e}`);
      }
    }

    if (env.SNOV_API_ID && env.SNOV_API_SECRET) {
      try {
        const snovLeads = await searchSnov(env.SNOV_API_ID, env.SNOV_API_SECRET, domain);
        allLeads.push(...snovLeads);
        if (snovLeads.length > 0) usedSources.push(`snov:${domain}(${snovLeads.length})`);
      } catch (e) {
        errors.push(`Snov[${domain}]: ${e}`);
      }
    }

    // Apify domain fallback only if criteria-based search didn't run or found very few
    if (env.APIFY_API_TOKEN && allLeads.length < 20 && !usedSources.some((s) => s.startsWith("apify("))) {
      try {
        const apifyLeads = await searchApify(env.APIFY_API_TOKEN, domain);
        allLeads.push(...apifyLeads);
        if (apifyLeads.length > 0) usedSources.push(`apify:${domain}(${apifyLeads.length})`);
      } catch (e) {
        errors.push(`Apify[${domain}]: ${e}`);
      }
    }
  }

  if (allLeads.length === 0) {
    const msg = errors.length > 0
      ? `${tl(locale, "noLeadsFound")}. ${tl(locale, "searchCriteria")}: ${tl(locale, "industries")}=[${criteria.industries.join(", ")}], ${tl(locale, "jobTitles")}=[${criteria.job_titles.join(", ")}], ${tl(locale, "domainsSearched")}=[${allDomains.join(", ")}].\n${tl(locale, "errors")}: ${errors.join("; ")}`
      : tl(locale, "noDataSources");
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", msg);
    return { error: msg, leads: 0 };
  }

  // Dedupe
  const seen = new Set<string>();
  const uniqueLeads: Lead[] = [];
  for (const lead of allLeads) {
    const key = lead.email.toLowerCase();
    if (!seen.has(key) && key) {
      seen.add(key);
      uniqueLeads.push(lead);
    }
  }

  // Batch insert leads to minimize subrequests (was 1 query per lead, now 1 per batch of 25)
  if (uniqueLeads.length > 0) {
    try {
      for (let i = 0; i < uniqueLeads.length; i += 25) {
        const batch = uniqueLeads.slice(i, i + 25);
        const params: (string | number | boolean | null)[] = [];
        const placeholders = batch.map((l, j) => {
          const base = j * 11;
          params.push(projectId, userId, l.email, l.firstName || "", l.lastName || "", l.company || "", l.position || "", l.source, l.company || "", l.confidence ?? null, l.verified ?? false);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
        }).join(", ");
        await sql(
          `INSERT INTO leads (project_id, user_id, email, first_name, last_name, company, position, source, domain, confidence, verified) VALUES ${placeholders} ON CONFLICT (project_id, email) DO NOTHING`,
          params,
        );
      }
    } catch (e) {
      console.error("Lead insert error:", e);
    }
  }

  // Sync leads to CRM contacts table (skip duplicates by email per user)
  let contactsSynced = 0;
  try {
    for (const l of uniqueLeads) {
      const existing = await sql`
        SELECT id FROM contacts WHERE user_id = ${userId} AND email = ${l.email} LIMIT 1
      `;
      if (existing.length > 0) continue;
      await sql`
        INSERT INTO contacts (user_id, project_id, email, first_name, last_name, company, position, source, source_detail)
        VALUES (${userId}, ${projectId}, ${l.email}, ${l.firstName || ""}, ${l.lastName || ""}, ${l.company || ""}, ${l.position || ""}, ${l.source}, ${"Lead Prospecting (agent #" + agentId + ")"})
      `;
      contactsSynced++;
    }
  } catch (e) {
    console.error("Contacts sync error:", e);
  }

  const lines = [
    `## ${tl(locale, "leadListBuilt")}\n`,
    `**${tl(locale, "totalLeadsFound")}:** ${uniqueLeads.length}`,
    `**Contacts synced:** ${contactsSynced}`,
    `**${tl(locale, "sourcesUsed")}:** ${usedSources.join(", ") || tl(locale, "none")}`,
    `**${tl(locale, "searchCriteria")}:**`,
    `- ${tl(locale, "industries")}: ${criteria.industries.join(", ") || "N/A"}`,
    `- ${tl(locale, "jobTitles")}: ${criteria.job_titles.join(", ") || "N/A"}`,
    `- ${tl(locale, "keywords")}: ${criteria.keywords.join(", ") || "N/A"}`,
    `- ${tl(locale, "domainsSearched")}: ${allDomains.join(", ") || "N/A"}`,
  ];
  if (errors.length > 0) {
    lines.push(`\n> ⚠️ ${tl(locale, "errors")}: ${errors.join("; ")}`);
  }

  const detailedResult = lines.join("\n");
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", detailedResult);
  const reportSummary = tl(locale, "foundLeads").replace("{count}", String(uniqueLeads.length)).replace("{sources}", String(usedSources.length));
  await saveReport(env.DATABASE_URL, agentId, tl(locale, "leadListBuilt"), reportSummary, {
    total_leads: uniqueLeads.length,
    sources: usedSources.join(", "),
    domains_searched: allDomains.join(", "),
    industries: criteria.industries.join(", "),
    error_count: errors.length,
    model_used: "none",
    preferred_model: preferredModel,
  });

  return { leads: uniqueLeads.length, sources: usedSources };
}

// Task 3: Enrich leads with company & contact data
async function enrichLeads(env: Env, agentId: number, projectId: number, _userId: number, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Fetch existing leads that haven't been enriched yet
  let leads: { id: number; email: string; company: string; first_name: string; last_name: string; position: string; domain: string }[];
  try {
    leads = await sql`
      SELECT id, email, company, first_name, last_name, position, domain
      FROM leads
      WHERE project_id = ${projectId} AND enriched = false
      ORDER BY id
      LIMIT 50
    ` as typeof leads;
  } catch {
    // enriched column may not exist — fetch all leads and skip DB-level enrichment flag
    leads = await sql`
      SELECT id, email, company, first_name, last_name, position, domain
      FROM leads
      WHERE project_id = ${projectId}
      ORDER BY id
      LIMIT 50
    ` as typeof leads;
  }

  if (leads.length === 0) {
    const msg = "No leads to enrich. Run the lead list builder first.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Lead Enrichment", msg, {
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg, enriched: 0 };
  }

  // Use AI to generate enrichment data based on available info
  const leadSummaries = leads.slice(0, 20).map((l) =>
    `${l.first_name} ${l.last_name} | ${l.position} | ${l.company} (${l.domain}) | ${l.email}`
  ).join("\n");

  const prompt = `You are a B2B sales intelligence analyst. For each contact below, provide enrichment insights:

${leadSummaries}

For each person, provide:
1. Estimated seniority level (C-level, VP, Director, Manager, Individual Contributor)
2. Department (Sales, Marketing, Engineering, Operations, Finance, HR, Other)
3. Estimated company size category (1-10, 11-50, 51-200, 201-1000, 1000+)
4. Industry vertical
5. Engagement recommendation (high priority / medium priority / low priority)

Format as JSON array with keys: email, seniority, department, company_size, industry, priority
Return ONLY the JSON array.`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const enrichments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    const summary = `Enriched ${enrichments.length} leads with company & contact data for project ${projectId}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Lead Enrichment", summary, withModelMetrics({
      leads_enriched: enrichments.length,
      total_leads: leads.length,
      high_priority: enrichments.filter((e: { priority: string }) => e.priority === "high priority").length,
    }, preferredModel, model));

    return { enriched: enrichments.length, enrichments };
  } catch (e) {
    const msg = `Lead enrichment failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 3, "Lead Enrichment", msg, preferredModel);
    return { error: msg, enriched: 0 };
  }
}

// Task 4: Score and prioritize leads
async function scoreLeads(env: Env, agentId: number, projectId: number, _userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  const leads = await sql`
    SELECT id, email, first_name, last_name, company, position, source, confidence, verified, domain
    FROM leads
    WHERE project_id = ${projectId}
    ORDER BY id
    LIMIT 100
  ` as { id: number; email: string; first_name: string; last_name: string; company: string; position: string; source: string; confidence: number | null; verified: boolean; domain: string }[];

  if (leads.length === 0) {
    const msg = "No leads to score. Build a lead list first.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Lead Scoring", msg, {
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg };
  }

  const leadSummaries = leads.slice(0, 30).map((l) =>
    `${l.first_name} ${l.last_name} | ${l.position} | ${l.company} (${l.domain}) | verified: ${l.verified} | confidence: ${l.confidence ?? "N/A"}`
  ).join("\n");

  const prompt = `You are a B2B lead scoring expert. Score and prioritize these leads based on their fit for this business:

Business: ${description}

Leads:
${leadSummaries}

Score each lead 1-100 based on:
- Title/seniority fit (decision maker = higher score)
- Company relevance to the business
- Email verification status
- Engagement potential

For each lead provide:
- email: the email
- score: 1-100
- tier: "hot" (80+), "warm" (50-79), or "cold" (below 50)
- reasoning: one-line explanation

Format as JSON array with keys: email, score, tier, reasoning
Return ONLY the JSON array.
${langHint ? langHint.replace("respond entirely", "write the reasoning field") : ""}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const scores = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    const hot = scores.filter((s: { tier: string }) => s.tier === "hot").length;
    const warm = scores.filter((s: { tier: string }) => s.tier === "warm").length;
    const cold = scores.filter((s: { tier: string }) => s.tier === "cold").length;

    const summary = `Scored ${scores.length} leads: ${hot} hot, ${warm} warm, ${cold} cold`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Lead Scoring", summary, withModelMetrics({
      leads_scored: scores.length,
      hot_leads: hot,
      warm_leads: warm,
      cold_leads: cold,
    }, preferredModel, model));

    return { scored: scores.length, hot, warm, cold, scores };
  } catch (e) {
    const msg = `Lead scoring failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Lead Scoring", msg, preferredModel);
    return { error: msg };
  }
}

// Task 5: Deliver qualified lead report
async function deliverLeadReport(env: Env, agentId: number, projectId: number, _userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  const leads = await sql`
    SELECT email, first_name, last_name, company, position, source, confidence, verified, domain
    FROM leads
    WHERE project_id = ${projectId}
    ORDER BY confidence DESC NULLS LAST, verified DESC
    LIMIT 200
  ` as { email: string; first_name: string; last_name: string; company: string; position: string; source: string; confidence: number | null; verified: boolean; domain: string }[];

  const totalLeads = leads.length;
  const verifiedCount = leads.filter((l) => l.verified).length;
  const leadSources = [...new Set(leads.map((l) => l.source))];
  const domains = [...new Set(leads.map((l) => l.domain))];

  // Load previous task results for full context
  let dataSourcesInfo = "";
  let leadListInfo = "";
  let icpInfo = "";
  try {
    const agentRows = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
    if (agentRows.length > 0) {
      const cfg = agentRows[0].config as Record<string, unknown>;
      const tasks = (cfg.tasks as { result?: string }[]) || [];
      if (tasks[0]?.result) icpInfo = tasks[0].result.substring(0, 1500);
      if (tasks[1]?.result) dataSourcesInfo = tasks[1].result.substring(0, 500);
      if (tasks[2]?.result) leadListInfo = tasks[2].result.substring(0, 500);
    }
    // Also load reports for richer metrics
    const reports = await sql`
      SELECT task_name, summary, metrics FROM agent_reports
      WHERE agent_assignment_id = ${agentId}
      ORDER BY created_at DESC LIMIT 6
    `;
    for (const r of reports) {
      const m = r.metrics as Record<string, unknown> | null;
      if (r.task_name === "Data Sources" && m) {
        dataSourcesInfo = dataSourcesInfo || `${r.summary}. ${m.sources_summary || ""}`;
      }
      if (r.task_name === "Lead List" && m) {
        leadListInfo = leadListInfo || `${r.summary}. Sources: ${m.sources || ""}`;
      }
    }
  } catch { /* non-critical */ }

  const prompt = `You are a B2B sales consultant. Create an executive summary report for a lead prospecting campaign.

Business: ${description}

${icpInfo ? `## ICP (Ideal Customer Profile) Summary:\n${icpInfo}\n` : ""}
${dataSourcesInfo ? `## Configured Data Sources:\n${dataSourcesInfo}\n` : ""}
${leadListInfo ? `## Lead List Build Results:\n${leadListInfo}\n` : ""}

Campaign Results:
- Total leads collected: ${totalLeads}
- Verified emails: ${verifiedCount}
- Lead sources in database: ${leadSources.join(", ")}
- Target domains covered: ${domains.slice(0, 10).join(", ")}

Top 10 leads by confidence:
${leads.slice(0, 10).map((l) => `- ${l.first_name} ${l.last_name}, ${l.position} at ${l.company} (${l.email}) — confidence: ${l.confidence ?? "N/A"}, verified: ${l.verified}`).join("\n")}

Provide:
1. **Executive Summary** — 2-3 sentence overview of the campaign
2. **Key Metrics Dashboard** — formatted stats (leads, sources, domains, verification rate)
3. **Data Sources Used** — list ALL configured and actually used sources (Apollo, Hunter, Snov, Apify, etc.) with status. Do NOT suggest adding sources that are already configured.
4. **Top Prospects** — brief profile of top 5 leads and why they're valuable
5. **Data Quality Assessment** — verification rate, confidence distribution
6. **Recommended Next Steps** — 3-5 actionable follow-up actions
7. **Campaign Optimization** — improvements based on actual results, NOT generic advice. Only suggest adding sources that are genuinely missing.

IMPORTANT: Base your analysis on the ACTUAL data sources and results provided above. Do not make assumptions about what tools are or aren't configured.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    const summary = `Delivered qualified lead report: ${totalLeads} leads, ${verifiedCount} verified across ${domains.length} domains`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Qualified Lead Report", summary, withModelMetrics({
      total_leads: totalLeads,
      verified_leads: verifiedCount,
      sources_used: leadSources.length,
      domains_covered: domains.length,
    }, preferredModel, model));

    return { report: content, total_leads: totalLeads, verified: verifiedCount };
  } catch (e) {
    const msg = `Lead report delivery failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 5, "Qualified Lead Report", msg, preferredModel);
    return { error: msg };
  }
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
  const description = (config.plan as string) || (config.project_description as string) || "";
  const website = (config.website as string) || "";
  const projectName = (config.project_name as string) || "";
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  switch (taskIndex) {
    case 0:
      return defineICP(env, agentId, description, website, projectName, projectId, userId, preferredModel, langHint);
    case 1:
      return setupDataSources(env, agentId);
    case 2:
      if (domains.length === 0) {
        // Try to extract domains from ICP on the fly
        try {
          const criteria = await extractSearchCriteria(env, description, "", preferredModel);
          if (criteria.target_domains.length > 0) {
            const sql = getDb(env.DATABASE_URL);
            const agentRows = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
            if (agentRows.length > 0) {
              const currentConfig = (agentRows[0].config as Record<string, unknown>) || {};
              currentConfig.target_domains = criteria.target_domains;
              await sql`UPDATE agent_assignments SET config = ${JSON.stringify(currentConfig)} WHERE id = ${agentId}`;
            }
            return buildLeadList(env, agentId, criteria.target_domains, projectId, userId, description, preferredModel, userLocale);
          }
        } catch { /* fall through */ }
        return { error: tl(userLocale, "noDomains") };
      }
      return buildLeadList(env, agentId, domains, projectId, userId, description, preferredModel, userLocale);
    case 3:
      return enrichLeads(env, agentId, projectId, userId, preferredModel, langHint);
    case 4:
      return scoreLeads(env, agentId, projectId, userId, description, preferredModel, langHint);
    case 5:
      return deliverLeadReport(env, agentId, projectId, userId, description, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not implemented for lead prospecting` };
  }
}
