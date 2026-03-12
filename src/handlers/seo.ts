import { updateTaskStatus, saveReport } from "../lib/db";
import { cerebrasCompletion } from "../lib/ai";

interface Env {
  DATABASE_URL: string;
  CEREBRAS_API_KEY?: string;
}

// Task 0: Crawl website & audit current SEO health
async function auditSEO(env: Env, agentId: number, website: string) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  // Fetch the website and analyze basic SEO elements
  let html = "";
  try {
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-SEO-Bot/1.0" },
      redirect: "follow",
    });
    html = await res.text();
  } catch (e) {
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", `Could not fetch ${website}: ${e}`);
    return { error: `Could not fetch ${website}` };
  }

  // Extract basic SEO signals
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/is);
  const h1Matches = html.match(/<h1[^>]*>(.*?)<\/h1>/gis) || [];
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gis) || [];
  const imgTags = html.match(/<img[^>]*>/gis) || [];
  const imgsWithoutAlt = imgTags.filter((img) => !img.includes("alt=") || img.match(/alt=["']\s*["']/));
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["'](.*?)["']/is);
  const hasRobotsMeta = html.includes('name="robots"') || html.includes("name='robots'");
  const hasViewport = html.includes('name="viewport"') || html.includes("name='viewport'");
  const wordCount = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().split(" ").length;

  const issues: string[] = [];
  if (!titleMatch) issues.push("Missing <title> tag");
  else if (titleMatch[1].length > 60) issues.push(`Title too long (${titleMatch[1].length} chars, max 60)`);
  if (!metaDescMatch) issues.push("Missing meta description");
  else if (metaDescMatch[1].length > 160) issues.push(`Meta description too long (${metaDescMatch[1].length} chars)`);
  if (h1Matches.length === 0) issues.push("Missing H1 tag");
  if (h1Matches.length > 1) issues.push(`Multiple H1 tags (${h1Matches.length})`);
  if (imgsWithoutAlt.length > 0) issues.push(`${imgsWithoutAlt.length} images missing alt text`);
  if (!canonicalMatch) issues.push("Missing canonical URL");
  if (!hasViewport) issues.push("Missing viewport meta tag (not mobile-friendly)");
  if (wordCount < 300) issues.push(`Low word count (${wordCount} words)`);

  const score = Math.max(0, 100 - issues.length * 12);
  const summary = `SEO Audit for ${website}: Score ${score}/100. ${issues.length} issues found: ${issues.join("; ")}`;

  const metrics = {
    seo_score: score,
    title: titleMatch?.[1]?.substring(0, 60) || "missing",
    h1_count: h1Matches.length,
    h2_count: h2Matches.length,
    images_missing_alt: imgsWithoutAlt.length,
    word_count: wordCount,
    has_canonical: canonicalMatch ? "yes" : "no",
    has_robots_meta: hasRobotsMeta ? "yes" : "no",
    issues_count: issues.length,
  };

  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "SEO Audit", summary, metrics);

  return { score, issues, metrics };
}

// Task 1: Keyword research using AI
async function keywordResearch(env: Env, agentId: number, website: string, description: string) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const prompt = `You are an SEO expert. Given this website: ${website}
Description: ${description}

Generate a list of 20 high-value keywords for this business. For each keyword, provide:
- keyword
- monthly search volume estimate (low/medium/high)
- competition level (low/medium/high)
- intent (informational/transactional/navigational)

Format as a JSON array of objects with keys: keyword, volume, competition, intent.
Return ONLY the JSON array, no other text.`;

  try {
    const content = await cerebrasCompletion(env, prompt, 1500);

    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    const summary = `Generated ${keywords.length} target keywords for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Keyword Research", summary, {
      keywords_found: keywords.length,
      high_volume: keywords.filter((k: { volume: string }) => k.volume === "high").length,
      low_competition: keywords.filter((k: { competition: string }) => k.competition === "low").length,
    });

    return { keywords };
  } catch (e) {
    const msg = `Keyword research failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", msg);
    return { keywords: [], error: msg };
  }
}

export async function handleSEO(env: Env, agentId: number, taskIndex: number, config: Record<string, unknown>) {
  const website = (config.website as string) || "";
  const description = (config.plan as string) || "";

  if (!website) {
    return { error: "No website URL configured for this agent" };
  }

  switch (taskIndex) {
    case 0:
      return auditSEO(env, agentId, website);
    case 1:
      return keywordResearch(env, agentId, website, description);
    default:
      return { error: `Task ${taskIndex} not yet implemented` };
  }
}
