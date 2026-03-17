import { updateTaskStatus, saveReport, failTask, withModelMetrics } from "../lib/db";
import { cerebrasCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

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
    const msg = `Could not fetch ${website}: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 0, "SEO Audit", msg);
    return { error: msg };
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
  await saveReport(env.DATABASE_URL, agentId, "SEO Audit", summary, {
    ...metrics,
    model_used: "none",
    preferred_model: "none",
  });

  return { score, issues, metrics };
}

// Task 1: Keyword research using AI
async function keywordResearch(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const prompt = `You are an SEO expert. Given this website: ${website}
Description: ${description}

Generate a list of 20 high-value keywords for this business. For each keyword, provide:
- keyword
- monthly search volume estimate (low/medium/high)
- competition level (low/medium/high)
- intent (informational/transactional/navigational)

Format as a JSON array of objects with keys: keyword, volume, competition, intent.
Return ONLY the JSON array, no other text.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 1500, preferredModel);

    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    const summary = `Generated ${keywords.length} target keywords for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Keyword Research", summary, withModelMetrics({
      keywords_found: keywords.length,
      high_volume: keywords.filter((k: { volume: string }) => k.volume === "high").length,
      low_competition: keywords.filter((k: { competition: string }) => k.competition === "low").length,
    }, preferredModel, model));

    return { keywords };
  } catch (e) {
    const msg = `Keyword research failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 1, "Keyword Research", msg, preferredModel);
    return { keywords: [], error: msg };
  }
}

// Task 2: Competitor content analysis
async function competitorAnalysis(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const prompt = `You are an SEO competitor analyst. Analyze the competitive landscape for this website:
Website: ${website}
Description: ${description}

Provide a detailed competitor content analysis:
1. **Top 5 Likely Competitors** — identify competitor websites in this niche
2. **Content Gap Analysis** — topics competitors cover that this site doesn't
3. **Keyword Overlap** — keywords competitors rank for that represent opportunities
4. **Content Format Analysis** — what content types competitors use (blogs, guides, videos, tools)
5. **Backlink Opportunities** — types of sites linking to competitors
6. **Strengths & Weaknesses** — where this site can outperform competitors

Format as structured text with clear headings and actionable insights.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    const summary = `Competitor content analysis completed for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Competitor Analysis", summary, withModelMetrics({
      competitors_analyzed: 5,
    }, preferredModel, model));

    return { analysis: content };
  } catch (e) {
    const msg = `Competitor analysis failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 2, "Competitor Analysis", msg, preferredModel);
    return { error: msg };
  }
}

// Task 3: Create monthly content calendar
async function contentCalendar(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const prompt = `You are an SEO content strategist. Create a detailed monthly content calendar for this website:
Website: ${website}
Description: ${description}

Create a 4-week content calendar with:
- **Week 1-4**: 3 content pieces per week (12 total)
- For each piece include:
  - Title (SEO-optimized)
  - Target keyword
  - Content type (blog post, guide, listicle, case study, how-to)
  - Word count target
  - Brief outline (3-5 bullet points)
  - Internal linking opportunities
  - CTA suggestion

Also include:
- Publishing schedule (best days/times)
- Content pillar strategy
- Seasonal/trending topic opportunities

Format as a structured calendar with clear weekly sections.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 3000, preferredModel);

    const summary = `Created monthly content calendar with 12 content pieces for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Content Calendar", summary, withModelMetrics({
      content_pieces: 12,
      weeks_planned: 4,
    }, preferredModel, model));

    return { calendar: content };
  } catch (e) {
    const msg = `Content calendar creation failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 3, "Content Calendar", msg, preferredModel);
    return { error: msg };
  }
}

// Task 4: Write first 3 SEO-optimized blog posts
async function writeBlogPosts(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const prompt = `You are an expert SEO content writer. Write 3 SEO-optimized blog post drafts for this website:
Website: ${website}
Description: ${description}

For each blog post, provide:
1. **Title** (under 60 characters, keyword-rich)
2. **Meta Description** (under 160 characters)
3. **Target Keyword**
4. **Full Article** (500-800 words each) with:
   - Engaging introduction with hook
   - H2 and H3 subheadings (keyword-optimized)
   - Naturally integrated keywords (2-3% density)
   - Internal linking suggestions [marked like this]
   - Conclusion with clear CTA
5. **Schema Markup Suggestion** (FAQ, HowTo, or Article)

Write in a professional but approachable tone. Make the content actionable and valuable.
Separate each post with "---POST BREAK---"
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 4000, preferredModel);

    const postCount = (content.match(/---POST BREAK---/g) || []).length + 1;
    const summary = `Written ${Math.min(postCount, 3)} SEO-optimized blog post drafts for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Blog Posts", summary, withModelMetrics({
      posts_written: Math.min(postCount, 3),
    }, preferredModel, model));

    return { posts: content, count: Math.min(postCount, 3) };
  } catch (e) {
    const msg = `Blog post writing failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Blog Posts", msg, preferredModel);
    return { error: msg };
  }
}

// Task 5: Set up rank tracking & analytics recommendations
async function setupRankTracking(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const prompt = `You are an SEO analytics expert. Create a comprehensive rank tracking and analytics setup guide for this website:
Website: ${website}
Description: ${description}

Provide:
1. **Key Metrics to Track**
   - Organic traffic, bounce rate, time on page, conversion rate
   - Keyword rankings (top 20 priority keywords to monitor)
   - Backlink growth metrics
   - Core Web Vitals targets

2. **Recommended Tools Setup**
   - Google Search Console configuration steps
   - Google Analytics 4 setup checklist
   - Rank tracking tool recommendations (free & paid)

3. **Reporting Dashboard Template**
   - Weekly metrics to review
   - Monthly KPIs and benchmarks
   - Quarterly goals framework

4. **Alerting Rules**
   - Traffic drop thresholds
   - Ranking change alerts
   - Technical SEO issue alerts

5. **First 90-Day SEO Targets**
   - Month 1, 2, 3 specific goals
   - Expected traffic growth trajectory
   - Keyword ranking targets

Format as a structured implementation guide.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    const summary = `Set up rank tracking and analytics framework for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Rank Tracking Setup", summary, withModelMetrics({
      keywords_to_track: 20,
    }, preferredModel, model));

    return { tracking: content };
  } catch (e) {
    const msg = `Rank tracking setup failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 5, "Rank Tracking Setup", msg, preferredModel);
    return { error: msg };
  }
}

export async function handleSEO(env: Env, agentId: number, taskIndex: number, config: Record<string, unknown>) {
  const website = (config.website as string) || "";
  const description = (config.plan as string) || "";
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  if (!website) {
    const msg = "No website URL configured for this agent. Set a website in the project knowledge base.";
    await updateTaskStatus(env.DATABASE_URL, agentId, taskIndex, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "SEO Error", msg, {
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg };
  }

  switch (taskIndex) {
    case 0:
      return auditSEO(env, agentId, website);
    case 1:
      return keywordResearch(env, agentId, website, description, preferredModel, langHint);
    case 2:
      return competitorAnalysis(env, agentId, website, description, preferredModel, langHint);
    case 3:
      return contentCalendar(env, agentId, website, description, preferredModel, langHint);
    case 4:
      return writeBlogPosts(env, agentId, website, description, preferredModel, langHint);
    case 5:
      return setupRankTracking(env, agentId, website, description, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not implemented for SEO agent` };
  }
}
