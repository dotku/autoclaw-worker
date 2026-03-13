import { updateTaskStatus, saveReport } from "../lib/db";
import { claudeCompletion } from "../lib/ai";

interface Env {
  DATABASE_URL: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

// Task 0: Audit existing social presence
async function auditSocialPresence(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const projectName = (config.project_name as string) || "the brand";
  const industry = (config.industry as string) || "technology";

  const prompt = `You are a social media strategist. Perform a comprehensive social media presence audit for ${projectName} in the ${industry} industry.

Provide a structured audit report covering:

1. **Platform Assessment**
   - Which platforms are most relevant for this industry (X/Twitter, LinkedIn, Instagram, TikTok, Facebook, YouTube, etc.)
   - Recommended priority platforms with justification

2. **Competitor Landscape**
   - What top competitors in ${industry} typically do on social media
   - Common content formats, posting frequency, engagement patterns

3. **Content Gap Analysis**
   - Types of content that perform well in this industry
   - Underserved content opportunities
   - Trending topics and hashtags

4. **Audience Insights**
   - Target audience demographics and behavior on social platforms
   - Peak engagement times
   - Content preferences and formats

5. **Recommendations**
   - Quick wins (can implement immediately)
   - Medium-term strategy (1-3 months)
   - Long-term goals (3-6 months)

Format the report in clear sections with actionable insights.`;

  try {
    const report = await claudeCompletion(env, prompt, 3000, String(config.model || "auto"));

    const summary = `Social presence audit completed for ${projectName}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Social Media Audit", summary, {
      project: projectName,
      industry,
      report,
    });

    return { report, project: projectName };
  } catch (e) {
    const msg = `Social audit failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress", msg);
    return { error: msg };
  }
}

// Task 1: Create brand voice & content guidelines
async function createBrandGuidelines(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const projectName = (config.project_name as string) || "the brand";
  const industry = (config.industry as string) || "technology";

  const prompt = `You are a brand strategist specializing in social media. Create comprehensive brand voice and content guidelines for ${projectName} in the ${industry} industry.

Generate a complete brand guide covering:

1. **Brand Voice Definition**
   - Tone attributes (e.g., professional yet approachable, authoritative but friendly)
   - Voice do's and don'ts with examples
   - Language style guide (formal vs casual, jargon usage, etc.)

2. **Content Pillars** (4-5 pillars)
   - For each pillar: name, description, example topics, content ratio percentage
   - E.g., Educational (40%), Behind-the-scenes (20%), User stories (20%), Promotional (10%), Community (10%)

3. **Platform-Specific Guidelines**
   - X/Twitter: character limits, thread strategies, hashtag usage
   - LinkedIn: professional tone adjustments, article vs post
   - Instagram: visual style, caption length, story vs feed
   - Other relevant platforms

4. **Visual Style Guide**
   - Color palette recommendations
   - Image style (photography vs illustration, filters, etc.)
   - Typography preferences
   - Template suggestions

5. **Engagement Guidelines**
   - Response tone and timing
   - How to handle negative comments
   - Community management best practices

6. **Hashtag Strategy**
   - Branded hashtags
   - Industry hashtags
   - Campaign-specific hashtag format

Format as a professional brand guide document.`;

  try {
    const guidelines = await claudeCompletion(env, prompt, 4000, String(config.model || "auto"));

    const summary = `Brand voice & content guidelines created for ${projectName}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Brand Guidelines", summary, {
      project: projectName,
      guidelines,
    });

    return { guidelines, project: projectName };
  } catch (e) {
    const msg = `Brand guidelines creation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress", msg);
    return { error: msg };
  }
}

// Task 2: Build 2-week content queue (posts, threads)
async function buildContentQueue(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const projectName = (config.project_name as string) || "the brand";
  const industry = (config.industry as string) || "technology";

  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are a social media content manager for ${projectName} in the ${industry} industry. Create a detailed 2-week content calendar starting from ${today}.

Generate a complete content queue with:

**For each day (14 days total), provide:**
- Date
- Platform(s)
- Content type (post, thread, story, reel idea, etc.)
- Full draft copy (ready to post)
- Suggested hashtags
- Best posting time
- Visual/media suggestion

**Content mix should include:**
- Educational/value posts (40%)
- Engagement posts (questions, polls, discussions) (20%)
- Behind-the-scenes / brand personality (15%)
- User-generated content prompts (10%)
- Promotional / CTA posts (10%)
- Trending/timely content (5%)

**Thread ideas (at least 3 threads in the 2 weeks):**
- Each thread should have 4-8 tweets/posts
- Include hooks, value points, and CTA

**Requirements:**
- All copy should be platform-appropriate length
- Include relevant emojis where appropriate
- Each post should be ready to copy-paste and publish
- Vary content formats throughout the 2 weeks

Format as a day-by-day calendar with clear sections.`;

  try {
    const contentQueue = await claudeCompletion(env, prompt, 6000, String(config.model || "auto"));

    const summary = `2-week content queue built for ${projectName} starting ${today}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Content Queue", summary, {
      project: projectName,
      start_date: today,
      content_queue: contentQueue,
    });

    return { contentQueue, project: projectName, startDate: today };
  } catch (e) {
    const msg = `Content queue creation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress", msg);
    return { error: msg };
  }
}

// Task 3: Set up scheduling tool integration
async function setupSchedulingIntegration(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const projectName = (config.project_name as string) || "the brand";

  const prompt = `You are a social media operations specialist for ${projectName}. Create a comprehensive scheduling tool integration plan.

Provide a detailed guide covering:

1. **Tool Comparison & Recommendation**
   - Compare top scheduling tools: Buffer, Hootsuite, Later, Sprout Social, TweetDeck, native platform schedulers
   - Pros/cons, pricing tiers, best for which use case
   - Final recommendation with justification

2. **Setup Guide**
   - Step-by-step setup instructions for the recommended tool
   - How to connect each social platform (X/Twitter, LinkedIn, Instagram, etc.)
   - Team permissions and roles setup

3. **Workflow Design**
   - Content approval workflow
   - Scheduling cadence (best times by platform)
   - Content recycling / evergreen post rotation strategy
   - How to handle time-sensitive / trending content

4. **Automation Rules**
   - Auto-repost top-performing content
   - RSS-to-social automation for blog posts
   - Cross-platform posting rules (what to share where)

5. **Integration with Content Queue**
   - How to import the 2-week content calendar
   - Bulk scheduling tips
   - Template setup for recurring content types

Format as an actionable implementation guide.`;

  try {
    const guide = await claudeCompletion(env, prompt, 3000, String(config.model || "auto"));

    const summary = `Scheduling tool integration guide created for ${projectName}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Scheduling Integration", summary, {
      project: projectName,
      guide,
    });

    return { guide, project: projectName };
  } catch (e) {
    const msg = `Scheduling integration setup failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress", msg);
    return { error: msg };
  }
}

// Task 4: Launch engagement campaign (likes, replies, follows)
async function launchEngagementCampaign(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const projectName = (config.project_name as string) || "the brand";
  const industry = (config.industry as string) || "technology";

  const prompt = `You are a social media growth strategist for ${projectName} in the ${industry} industry. Create a detailed engagement campaign plan.

Design a comprehensive engagement campaign covering:

1. **Target Audience Mapping**
   - Key accounts to follow and engage with (types, not specific handles)
   - Industry influencers and thought leaders to interact with
   - Competitor followers to attract
   - Relevant hashtag communities

2. **Daily Engagement Playbook**
   - Morning routine (15 min): what to do first
   - Midday engagement (10 min): targeted interactions
   - Evening wrap-up (10 min): responses and follow-ups
   - Specific actions: number of likes, replies, follows per day

3. **Reply Templates & Strategies**
   - Value-add reply templates for different scenarios
   - How to join trending conversations authentically
   - Tone guidelines for replies (helpful, not salesy)
   - When to DM vs public reply

4. **Follow Strategy**
   - Who to follow (criteria)
   - Follow/unfollow ratios and timing
   - List curation strategy

5. **Engagement Metrics & KPIs**
   - Daily/weekly targets
   - Engagement rate goals
   - Response time targets
   - Growth milestones (30/60/90 day)

6. **Campaign Calendar**
   - Week 1-2: Foundation (follow, engage, build presence)
   - Week 3-4: Acceleration (increase volume, start conversations)
   - Month 2+: Optimization (double down on what works)

Format as a ready-to-execute campaign plan.`;

  try {
    const campaign = await claudeCompletion(env, prompt, 4000, String(config.model || "auto"));

    const summary = `Engagement campaign plan created for ${projectName}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Engagement Campaign", summary, {
      project: projectName,
      campaign,
    });

    return { campaign, project: projectName };
  } catch (e) {
    const msg = `Engagement campaign creation failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress", msg);
    return { error: msg };
  }
}

// Task 5: Track follower growth & engagement metrics
async function trackMetrics(env: Env, agentId: number, config: Record<string, unknown>) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const projectName = (config.project_name as string) || "the brand";

  const prompt = `You are a social media analytics specialist for ${projectName}. Create a comprehensive metrics tracking framework.

Build a complete analytics and reporting system covering:

1. **Key Metrics Dashboard Design**
   - Follower growth (daily/weekly/monthly)
   - Engagement rate by platform
   - Impressions and reach
   - Click-through rates
   - Top performing content
   - Audience demographics shifts

2. **Tracking Setup Guide**
   - Native analytics (Twitter Analytics, LinkedIn Analytics, etc.)
   - Third-party tools (Google Analytics UTM tracking, Bitly, etc.)
   - Spreadsheet/dashboard template for manual tracking

3. **Reporting Templates**
   - Weekly report format (key metrics, top posts, insights)
   - Monthly report format (trends, growth, ROI)
   - Quarterly review format (strategy assessment, pivots needed)

4. **Benchmarks & Goals**
   - Industry-standard benchmarks for each metric
   - 30-day targets
   - 90-day targets
   - 6-month targets

5. **Analysis Framework**
   - What to look for in the data
   - How to identify winning content patterns
   - When to pivot strategy based on metrics
   - A/B testing framework for content

6. **Automated Alerts**
   - Set up alerts for: viral content, negative sentiment, unusual engagement drops
   - Competitor monitoring triggers

Format as a practical analytics playbook with templates.`;

  try {
    const framework = await claudeCompletion(env, prompt, 4000, String(config.model || "auto"));

    const summary = `Metrics tracking framework created for ${projectName}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Metrics Tracking", summary, {
      project: projectName,
      framework,
    });

    return { framework, project: projectName };
  } catch (e) {
    const msg = `Metrics tracking setup failed: ${e}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress", msg);
    return { error: msg };
  }
}

export async function handleSocial(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>
) {
  switch (taskIndex) {
    case 0:
      return auditSocialPresence(env, agentId, config);
    case 1:
      return createBrandGuidelines(env, agentId, config);
    case 2:
      return buildContentQueue(env, agentId, config);
    case 3:
      return setupSchedulingIntegration(env, agentId, config);
    case 4:
      return launchEngagementCampaign(env, agentId, config);
    case 5:
      return trackMetrics(env, agentId, config);
    default:
      return { error: `Task ${taskIndex} not implemented` };
  }
}
