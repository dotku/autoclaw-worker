import { updateTaskStatus, saveReport, failTask, withModelMetrics } from "../lib/db";
import { cerebrasCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  CEREBRAS_API_KEY?: string;
}

// Task 0: Set up website monitoring (uptime, speed)
async function monitorWebsite(env: Env, agentId: number, website: string) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const startTime = Date.now();
  let statusCode = 0;
  let loadTime = 0;
  let contentLength = 0;
  let redirects = 0;
  let error = "";

  try {
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-Monitor/1.0" },
      redirect: "follow",
    });
    statusCode = res.status;
    loadTime = Date.now() - startTime;
    const body = await res.text();
    contentLength = body.length;
    redirects = res.redirected ? 1 : 0;
  } catch (e) {
    error = `${e}`;
    loadTime = Date.now() - startTime;
  }

  // Check HTTPS
  const isHttps = website.startsWith("https://");

  // Performance rating
  let performanceRating = "good";
  if (loadTime > 3000) performanceRating = "poor";
  else if (loadTime > 1500) performanceRating = "needs improvement";

  const summary = error
    ? `Website ${website} is DOWN: ${error}`
    : `Website ${website}: ${statusCode} OK, ${loadTime}ms load time, ${performanceRating} performance`;

  const metrics: Record<string, string | number> = {
    status_code: statusCode || "error",
    load_time_ms: loadTime,
    content_size_kb: Math.round(contentLength / 1024),
    https: isHttps ? "yes" : "no",
    redirects,
    performance: performanceRating,
  };

  if (error) metrics.error = error;
  metrics.model_used = "none";
  metrics.preferred_model = "none";

  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "Website Monitor", summary, metrics);

  return metrics;
}

// Task 1: Install analytics tracking (recommendations)
async function installAnalytics(env: Env, agentId: number, website: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  // Fetch the site to check existing analytics
  let html = "";
  try {
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-Monitor/1.0" },
      redirect: "follow",
    });
    html = await res.text();
  } catch {
    // proceed with analysis without HTML
  }

  const hasGA4 = html.includes("gtag") || html.includes("G-") || html.includes("googletagmanager");
  const hasGTM = html.includes("GTM-");
  const hasFBPixel = html.includes("fbq(") || html.includes("facebook.com/tr");
  const hasHotjar = html.includes("hotjar");
  const hasPlausible = html.includes("plausible");
  const hasClarity = html.includes("clarity.ms");

  const detected: string[] = [];
  if (hasGA4) detected.push("Google Analytics 4 / gtag");
  if (hasGTM) detected.push("Google Tag Manager");
  if (hasFBPixel) detected.push("Facebook Pixel");
  if (hasHotjar) detected.push("Hotjar");
  if (hasPlausible) detected.push("Plausible");
  if (hasClarity) detected.push("Microsoft Clarity");

  const prompt = `You are a web analytics expert. Based on this website analysis, provide analytics tracking recommendations:

Website: ${website}
Currently detected analytics: ${detected.length > 0 ? detected.join(", ") : "None detected"}

Provide:
1. **Current Analytics Audit** — what's installed and what's missing
2. **Recommended Analytics Stack** — essential tools to install
3. **Event Tracking Plan** — key events to track (clicks, forms, scrolls, conversions)
4. **Goal/Conversion Setup** — important conversion goals to configure
5. **Implementation Checklist** — step-by-step setup instructions
6. **Privacy Compliance** — GDPR/CCPA considerations for analytics

Format as a structured implementation guide.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    const summary = `Analytics audit for ${website}: ${detected.length} tools detected. Recommendations provided.`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Analytics Tracking", summary, withModelMetrics({
      tools_detected: detected.length,
      has_ga4: hasGA4 ? "yes" : "no",
      has_gtm: hasGTM ? "yes" : "no",
    }, preferredModel, model));

    return { detected, recommendations: content };
  } catch (e) {
    const msg = `Analytics tracking analysis failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 1, "Analytics Tracking", msg, preferredModel);
    return { error: msg };
  }
}

// Task 2: Map conversion funnels
async function mapConversionFunnels(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  // Crawl site to detect forms, CTAs, and page structure
  let html = "";
  try {
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-Monitor/1.0" },
      redirect: "follow",
    });
    html = await res.text();
  } catch {
    // proceed without HTML
  }

  const forms = (html.match(/<form[^>]*>/gis) || []).length;
  const buttons = (html.match(/<button[^>]*>/gis) || []).length;
  const links = (html.match(/<a[^>]*href/gis) || []).length;
  const inputs = (html.match(/<input[^>]*>/gis) || []).length;

  const prompt = `You are a conversion rate optimization expert. Map the conversion funnels for this website:

Website: ${website}
Description: ${description}
Page elements detected: ${forms} forms, ${buttons} buttons, ${links} links, ${inputs} input fields

Provide:
1. **Primary Conversion Funnel** — main path from visitor to customer
   - Entry points (landing pages, traffic sources)
   - Key steps (awareness → interest → decision → action)
   - Expected conversion rate at each step
   - Drop-off risk areas

2. **Secondary Funnels** — newsletter signup, free trial, content download, etc.

3. **Micro-Conversions** — small actions that indicate interest
   - Page views, scroll depth, video plays, social shares

4. **Funnel Visualization** — text-based funnel diagram

5. **Tracking Implementation** — specific events to track at each funnel stage

6. **Benchmarks** — industry-standard conversion rates to target

Format with clear funnel stages and actionable tracking recommendations.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    const summary = `Mapped conversion funnels for ${website}: ${forms} forms, ${buttons} CTAs detected`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Conversion Funnels", summary, withModelMetrics({
      forms_detected: forms,
      buttons_detected: buttons,
      links_detected: links,
    }, preferredModel, model));

    return { funnels: content };
  } catch (e) {
    const msg = `Conversion funnel mapping failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 2, "Conversion Funnels", msg, preferredModel);
    return { error: msg };
  }
}

// Task 3: Run initial UX audit
async function uxAudit(env: Env, agentId: number, website: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  let html = "";
  let loadTime = 0;
  let statusCode = 0;
  try {
    const start = Date.now();
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-Monitor/1.0" },
      redirect: "follow",
    });
    loadTime = Date.now() - start;
    statusCode = res.status;
    html = await res.text();
  } catch (e) {
    const msg = `Could not fetch ${website}: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 3, "UX Audit", msg, preferredModel);
    return { error: msg };
  }

  // Extract UX signals
  const hasViewport = html.includes('name="viewport"') || html.includes("name='viewport'");
  const hasLazyLoad = html.includes("loading=\"lazy\"") || html.includes("loading='lazy'");
  const imgCount = (html.match(/<img[^>]*>/gis) || []).length;
  const scriptCount = (html.match(/<script[^>]*>/gis) || []).length;
  const cssLinks = (html.match(/<link[^>]*stylesheet/gis) || []).length;
  const hasNav = html.includes("<nav") || html.includes("navigation");
  const hasFooter = html.includes("<footer");
  const hasBreadcrumb = html.toLowerCase().includes("breadcrumb");
  const hasSearch = html.includes('type="search"') || html.includes("search");

  const issues: string[] = [];
  if (!hasViewport) issues.push("Missing viewport meta tag — not mobile-responsive");
  if (loadTime > 3000) issues.push(`Slow load time: ${loadTime}ms`);
  if (scriptCount > 15) issues.push(`Too many scripts (${scriptCount}) — may impact performance`);
  if (imgCount > 0 && !hasLazyLoad) issues.push("No lazy loading on images");
  if (!hasNav) issues.push("No <nav> element detected — navigation may be unclear");
  if (!hasFooter) issues.push("No <footer> detected");

  const prompt = `You are a UX expert. Based on this website analysis, provide a comprehensive UX audit:

Website: ${website}
Load time: ${loadTime}ms
Status: ${statusCode}
Mobile responsive: ${hasViewport ? "Yes" : "No"}
Navigation: ${hasNav ? "Detected" : "Not detected"}
Search: ${hasSearch ? "Detected" : "Not detected"}
Breadcrumbs: ${hasBreadcrumb ? "Yes" : "No"}
Images: ${imgCount}, Lazy loading: ${hasLazyLoad ? "Yes" : "No"}
Scripts: ${scriptCount}, CSS files: ${cssLinks}
Auto-detected issues: ${issues.length > 0 ? issues.join("; ") : "None"}

Provide:
1. **Overall UX Score** (1-100)
2. **Navigation & Information Architecture** — is the site easy to navigate?
3. **Mobile Experience** — responsive design assessment
4. **Page Speed & Performance** — loading experience
5. **Visual Design** — layout, typography, whitespace
6. **Accessibility** — basic a11y assessment
7. **Content Readability** — text structure, scannability
8. **Top 10 UX Recommendations** — prioritized by impact

Format as a structured audit report.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    const summary = `UX audit for ${website}: ${issues.length} auto-detected issues, ${loadTime}ms load time`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "UX Audit", summary, withModelMetrics({
      load_time_ms: loadTime,
      issues_detected: issues.length,
      images: imgCount,
      scripts: scriptCount,
      mobile_responsive: hasViewport ? "yes" : "no",
    }, preferredModel, model));

    return { audit: content, issues };
  } catch (e) {
    const msg = `UX audit failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 3, "UX Audit", msg, preferredModel);
    return { error: msg };
  }
}

// Task 4: Identify top 5 conversion blockers
async function identifyBlockers(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  let html = "";
  let loadTime = 0;
  try {
    const start = Date.now();
    const res = await fetch(website, {
      headers: { "User-Agent": "AutoClaw-Monitor/1.0" },
      redirect: "follow",
    });
    loadTime = Date.now() - start;
    html = await res.text();
  } catch {
    // proceed without HTML
  }

  const hasSSL = website.startsWith("https://");
  const hasTrustBadges = html.toLowerCase().includes("trust") || html.toLowerCase().includes("secure") || html.toLowerCase().includes("guarantee");
  const hasTestimonials = html.toLowerCase().includes("testimonial") || html.toLowerCase().includes("review");
  const hasPricing = html.toLowerCase().includes("pricing") || html.toLowerCase().includes("price");
  const hasFAQ = html.toLowerCase().includes("faq") || html.toLowerCase().includes("frequently asked");
  const formCount = (html.match(/<form[^>]*>/gis) || []).length;

  const prompt = `You are a conversion rate optimization specialist. Identify the top 5 conversion blockers for this website:

Website: ${website}
Description: ${description}
Load time: ${loadTime}ms
SSL: ${hasSSL ? "Yes" : "No"}
Trust signals: ${hasTrustBadges ? "Detected" : "Not detected"}
Testimonials/Reviews: ${hasTestimonials ? "Detected" : "Not detected"}
Pricing page: ${hasPricing ? "Detected" : "Not detected"}
FAQ section: ${hasFAQ ? "Detected" : "Not detected"}
Forms on page: ${formCount}

Analyze and identify:

**Top 5 Conversion Blockers** (ranked by estimated revenue impact):

For each blocker provide:
1. **Blocker Name** — clear, descriptive title
2. **Impact Level** — High/Medium/Low with estimated conversion rate impact (%)
3. **Evidence** — what signals indicate this is a problem
4. **Root Cause** — why this blocks conversions
5. **Fix Recommendation** — specific, actionable solution
6. **Expected Lift** — estimated improvement after fixing
7. **Implementation Effort** — Easy/Medium/Hard

Also provide:
- **Quick Wins** — 3 fixes that can be done in under 1 hour
- **Estimated Total Conversion Lift** — if all 5 blockers are fixed
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    const summary = `Identified top 5 conversion blockers for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Conversion Blockers", summary, withModelMetrics({
      blockers_identified: 5,
      has_ssl: hasSSL ? "yes" : "no",
      has_trust_signals: hasTrustBadges ? "yes" : "no",
      has_testimonials: hasTestimonials ? "yes" : "no",
    }, preferredModel, model));

    return { blockers: content };
  } catch (e) {
    const msg = `Conversion blocker analysis failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Conversion Blockers", msg, preferredModel);
    return { error: msg };
  }
}

// Task 5: Create optimization roadmap
async function createOptimizationRoadmap(env: Env, agentId: number, website: string, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const prompt = `You are a product optimization strategist. Create a comprehensive 90-day optimization roadmap for this website:

Website: ${website}
Description: ${description}

Create a structured roadmap with:

**Phase 1: Quick Wins (Days 1-14)**
- 5-7 high-impact, low-effort optimizations
- Expected results timeline
- Resources needed

**Phase 2: Core Improvements (Days 15-45)**
- UX/UI enhancements
- Performance optimizations
- Content improvements
- A/B test plan (3-5 tests to run)

**Phase 3: Growth Experiments (Days 46-75)**
- Advanced conversion tactics
- Personalization opportunities
- New feature recommendations
- Channel optimization

**Phase 4: Scale & Iterate (Days 76-90)**
- Review metrics and results
- Double down on winners
- Plan next quarter

For each item include:
- Priority (P0/P1/P2)
- Estimated effort (hours)
- Expected impact on conversion rate
- Dependencies
- Success metrics

Also include:
- **KPI Dashboard** — metrics to track weekly
- **Team/Resource Requirements**
- **Risk Assessment** — what could go wrong and mitigation plans
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 3000, preferredModel);

    const summary = `Created 90-day optimization roadmap for ${website}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Optimization Roadmap", summary, withModelMetrics({
      phases: 4,
      duration_days: 90,
    }, preferredModel, model));

    return { roadmap: content };
  } catch (e) {
    const msg = `Optimization roadmap creation failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 5, "Optimization Roadmap", msg, preferredModel);
    return { error: msg };
  }
}

export async function handleMonitor(env: Env, agentId: number, taskIndex: number, config: Record<string, unknown>) {
  const website = (config.website as string) || "";
  const description = (config.plan as string) || "";
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  if (!website) {
    const msg = "No website URL configured for this agent. Set a website in the project knowledge base.";
    await updateTaskStatus(env.DATABASE_URL, agentId, taskIndex, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Monitor Error", msg, {
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg };
  }

  switch (taskIndex) {
    case 0:
      return monitorWebsite(env, agentId, website);
    case 1:
      return installAnalytics(env, agentId, website, preferredModel, langHint);
    case 2:
      return mapConversionFunnels(env, agentId, website, description, preferredModel, langHint);
    case 3:
      return uxAudit(env, agentId, website, preferredModel, langHint);
    case 4:
      return identifyBlockers(env, agentId, website, description, preferredModel, langHint);
    case 5:
      return createOptimizationRoadmap(env, agentId, website, description, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not implemented for product monitoring` };
  }
}
