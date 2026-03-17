import { updateTaskStatus, saveReport, getDb, withModelMetrics, failTask } from "../lib/db";
import { cerebrasCompletionWithMeta, claudeCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  BREVO_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

interface KBResource {
  title: string;
  docType: string;
  content: string;
}

// Load knowledge base documents for the project (direct DB query, no embedding needed)
async function loadKnowledgeBase(databaseUrl: string, projectId: number, userId: number): Promise<KBResource[]> {
  const sql = getDb(databaseUrl);
  const rows = await sql`
    SELECT d.title, d.doc_type, c.content
    FROM kb_chunks c
    JOIN kb_documents d ON c.document_id = d.id
    WHERE d.status = 'ready'
      AND c.content IS NOT NULL
      AND (
        (d.scope = 'project' AND d.project_id = ${projectId})
        OR (d.scope = 'personal' AND d.user_id = ${userId})
      )
    ORDER BY d.id, c.chunk_index
    LIMIT 50
  `;
  return rows.map((r) => ({
    title: r.title as string,
    docType: r.doc_type as string,
    content: r.content as string,
  }));
}

// Task 0: Research target audience & ICP
async function researchICP(env: Env, agentId: number, projectDesc: string, website: string, projectName: string, projectId: number, userId: number, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const sources: string[] = [];
  let websiteContext = "";
  let kbContext = "";

  // 1. Load knowledge base documents for the project
  try {
    const kbResources = await loadKnowledgeBase(env.DATABASE_URL, projectId, userId);
    if (kbResources.length > 0) {
      // Group by document title, concatenate chunks
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
      for (const [title, doc] of docMap) {
        const fullContent = doc.chunks.join("\n");
        const truncated = fullContent.substring(0, Math.min(fullContent.length, charBudget));
        kbContext += `\n**[${doc.docType.toUpperCase()}] ${title}:**\n${truncated}\n`;
        charBudget -= truncated.length;
        sources.push(`kb: ${title} (${doc.docType})`);
        if (charBudget <= 0) break;
      }
    }
  } catch (e) {
    console.error("KB load error:", e);
  }

  // 2. Fetch website content for additional context
  if (website) {
    try {
      const res = await fetch(website, {
        headers: { "User-Agent": "AutoClaw-ICP-Bot/1.0" },
        redirect: "follow",
      });
      if (res.ok) {
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const metaDescMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/is);
        const h1s = (html.match(/<h1[^>]*>(.*?)<\/h1>/gis) || []).map(h => h.replace(/<[^>]*>/g, "").trim()).filter(Boolean);
        const h2s = (html.match(/<h2[^>]*>(.*?)<\/h2>/gis) || []).map(h => h.replace(/<[^>]*>/g, "").trim()).filter(Boolean);
        const bodyText = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 1500);

        websiteContext = `\n\n--- Website Analysis (${website}) ---\n`;
        if (titleMatch?.[1]) websiteContext += `Title: ${titleMatch[1].trim()}\n`;
        if (metaDescMatch?.[1]) websiteContext += `Meta Description: ${metaDescMatch[1].trim()}\n`;
        if (h1s.length > 0) websiteContext += `H1 Headlines: ${h1s.join("; ")}\n`;
        if (h2s.length > 0) websiteContext += `H2 Headlines: ${h2s.slice(0, 10).join("; ")}\n`;
        websiteContext += `Page Content Preview: ${bodyText.substring(0, 800)}\n`;
        sources.push(`website: ${website}`);
      }
    } catch { /* website fetch failed, continue without it */ }
  }

  if (projectName) sources.push(`project name: ${projectName}`);
  if (projectDesc) sources.push(`project description`);

  if (!projectDesc && !websiteContext && !kbContext) {
    const msg = "No data available. Please add documents to the Knowledge Base, or set a website and description in the project settings.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "ICP Research", msg, {
      sources: "none",
      model_used: "none",
      preferred_model: "none",
    });
    return { error: msg };
  }

  const prompt = `You are a B2B marketing expert. Research and define an Ideal Customer Profile (ICP) based on the following real business data:

**Business Name:** ${projectName || "N/A"}
**Business Description:** ${projectDesc || "N/A"}
${kbContext}
${websiteContext}

Based on ALL the above information (especially the Knowledge Base resources), provide:
1. **Target Industries** (3-5 with reasoning referencing the actual business data above)
2. **Company Size Range** (employee count + revenue estimate)
3. **Key Job Titles to Target** (5-8 decision makers)
4. **Pain Points This Product Solves** (3-5 specific problems, cite the KB/website content)
5. **Recommended Outreach Channels** (ranked by expected ROI)
6. **Buyer Persona Summary** (1-2 paragraph description of ideal buyer)

IMPORTANT: Be specific and reference the actual product/service details from the knowledge base and website above. Do NOT generate generic advice.
Format as structured text with clear headings.
${langHint}`;

  try {
    const { content: icpContent, model } = await cerebrasCompletionWithMeta(env, prompt, 1500, preferredModel);

    const summary = `Completed ICP research using ${sources.length} sources: ${sources.join(", ")}`;
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", icpContent);
    await saveReport(env.DATABASE_URL, agentId, "ICP Research", summary, withModelMetrics({
      sources: sources.join(", "),
      website_analyzed: website || "none",
      project_name: projectName || "N/A",
      kb_documents_used: sources.filter(s => s.startsWith("kb:")).length,
    }, preferredModel, model));

    return { icp: icpContent };
  } catch (e) {
    const msg = `ICP research failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 0, "ICP Research", msg, preferredModel);
    return { error: msg };
  }
}

// Task 2: Create email templates
async function createTemplates(env: Env, agentId: number, projectDesc: string, website: string, preferredModel = "auto", langHint = "") {
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

Keep each email under 150 words. Be professional but personable.
${langHint}`;

  try {
    const { content: templates, model } = await claudeCompletionWithMeta(env, prompt, 2000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", templates);
    await saveReport(env.DATABASE_URL, agentId, "Email Templates", "Created 3 email templates", withModelMetrics({
      templates_created: 3,
    }, preferredModel, model));

    return { templates };
  } catch (e) {
    const msg = `Template creation failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 2, "Email Templates", msg, preferredModel);
    return { error: msg };
  }
}

// Task 1: Build prospect email list from leads table
async function buildEmailList(env: Env, agentId: number, projectId: number, userId: number) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const leads = await sql`SELECT COUNT(*)::int as count FROM leads WHERE project_id = ${projectId}`;
  const count = leads[0].count;

  let imported = 0;
  let provider = "none";

  if (count === 0) {
    const msg = "No leads found in database for this project. Please run the Lead Prospecting agent first to build your lead list, or manually import leads.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Email List", msg, {
      total_leads: 0,
      imported: 0,
      provider: "none",
      model_used: "none",
      preferred_model: "none",
    });
    return { count: 0, imported: 0, provider: "none", error: msg };
  }

  if (count > 0) {
    const allLeads = await sql`SELECT email, first_name, last_name, company, position FROM leads WHERE project_id = ${projectId} LIMIT 500`;

    if (env.SENDGRID_API_KEY) {
      // Batch import to SendGrid (supports bulk PUT)
      provider = "sendgrid";
      const contacts = allLeads.map((lead) => ({
        email: lead.email,
        first_name: lead.first_name || "",
        last_name: lead.last_name || "",
        company: lead.company || "",
        job_title: lead.position || "",
      }));
      // SendGrid accepts up to 30k contacts per PUT
      try {
        const res = await fetch("https://api.sendgrid.com/v3/marketing/contacts", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contacts }),
        });
        if (res.ok || res.status === 202) imported = contacts.length;
      } catch { /* skip */ }
    } else if (env.BREVO_API_KEY) {
      // Import to Brevo one by one
      provider = "brevo";
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
  }

  // Mark synced contacts in the contacts table
  if (imported > 0 && provider !== "none") {
    try {
      await sql`
        UPDATE contacts SET
          source = ${provider},
          source_detail = ${"Email List Sync (agent #" + agentId + ")"},
          updated_at = NOW()
        WHERE user_id = ${userId}
          AND project_id = ${projectId}
          AND source NOT IN ('brevo', 'sendgrid')
      `;
    } catch { /* non-critical */ }
  }

  const providerLabel = provider === "none" ? "no provider configured" : provider;
  const summary = `Email list: ${count} leads in database, ${imported} synced to ${providerLabel}`;
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "Email List", summary, {
    total_leads: count,
    imported: imported,
    provider,
    model_used: "none",
    preferred_model: "none",
  });

  return { count, imported, provider };
}

// Task 3: Configure sending schedule & limits
async function configureSendingSchedule(env: Env, agentId: number, projectDesc: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const provider = env.SENDGRID_API_KEY ? "SendGrid" : env.BREVO_API_KEY ? "Brevo" : "no provider";

  const prompt = `You are an email deliverability expert. Create a sending schedule and limits configuration for a cold outreach campaign.

Business context: ${projectDesc}
Email provider: ${provider}

Provide a detailed plan covering:

1. **Daily sending limits**
   - Day 1-3 (warm-up): X emails/day
   - Day 4-7: X emails/day
   - Week 2+: X emails/day
   - Maximum daily cap

2. **Optimal send times**
   - Best hours by timezone (focus on US business hours)
   - Best days of the week
   - Times to avoid

3. **Sending intervals**
   - Minimum gap between emails (seconds)
   - Randomization strategy to appear natural

4. **Follow-up schedule**
   - Follow-up 1: X days after initial email
   - Follow-up 2: X days after follow-up 1
   - Maximum follow-ups per prospect

5. **Deliverability best practices**
   - SPF/DKIM/DMARC setup checklist
   - Domain warm-up strategy
   - Bounce handling rules
   - Unsubscribe compliance

6. **Rate limits by provider**
   - ${provider} specific limits and recommendations

Format as an actionable configuration document.
${langHint}`;

  try {
    const { content: schedule, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", schedule);
    await saveReport(env.DATABASE_URL, agentId, "Sending Schedule", "Configured sending schedule & limits", withModelMetrics({
      provider,
    }, preferredModel, model));

    return { schedule, provider };
  } catch (e) {
    const msg = `Sending schedule configuration failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 3, "Sending Schedule", msg, preferredModel);
    return { error: msg };
  }
}

// Task 4: Set up tracking (opens, clicks, replies)
async function setupTracking(env: Env, agentId: number, projectDesc: string, website: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const provider = env.SENDGRID_API_KEY ? "SendGrid" : env.BREVO_API_KEY ? "Brevo" : "no provider";

  const prompt = `You are an email marketing analytics expert. Create a tracking setup guide for email campaigns.

Business: ${projectDesc}
Website: ${website || "not specified"}
Email provider: ${provider}

Provide a complete tracking setup guide:

1. **Open tracking**
   - How to enable in ${provider}
   - Tracking pixel configuration
   - Expected open rates by industry

2. **Click tracking**
   - UTM parameter strategy for all links
   - Custom tracking domains setup
   - Link shortening best practices

3. **Reply tracking**
   - Auto-detection of positive/negative replies
   - Reply categorization (interested, not interested, OOO, bounce)
   - CRM integration for reply logging

4. **Analytics dashboard setup**
   - Key metrics to track daily
   - Weekly reporting template
   - A/B test tracking framework

5. **Conversion tracking**
   - Website visitor tracking from email clicks
   - Goal/event setup in Google Analytics
   - Attribution model recommendation

6. **Alerting**
   - Bounce rate alert threshold (>5%)
   - Spam complaint alert threshold (>0.1%)
   - Deliverability drop alert

Format as a step-by-step implementation guide.
${langHint}`;

  try {
    const { content: trackingGuide, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", trackingGuide);
    await saveReport(env.DATABASE_URL, agentId, "Email Tracking", "Set up email tracking configuration", withModelMetrics({
      provider,
      website: website || "N/A",
    }, preferredModel, model));

    return { trackingGuide, provider };
  } catch (e) {
    const msg = `Tracking setup failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Email Tracking", msg, preferredModel);
    return { error: msg };
  }
}

// Sync engagement stats from Brevo back to contacts table
async function syncBrevoStats(env: Env, userId: number): Promise<{ synced: number; errors: number }> {
  if (!env.BREVO_API_KEY) return { synced: 0, errors: 0 };

  const sql = getDb(env.DATABASE_URL);
  const contactsToSync = await sql`
    SELECT id, email FROM contacts
    WHERE user_id = ${userId}
      AND (brevo_id IS NOT NULL OR source = 'brevo')
    ORDER BY stats_synced_at ASC NULLS FIRST
    LIMIT 30
  `;

  let synced = 0;
  let errors = 0;
  for (const contact of contactsToSync) {
    try {
      const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(contact.email as string)}`, {
        headers: { "api-key": env.BREVO_API_KEY },
      });
      if (!res.ok) { errors++; continue; }

      const data = await res.json() as { statistics?: { messagesSent?: { eventTime?: string; events?: { event: string; eventTime?: string }[] }[] } };
      const stats = data.statistics?.messagesSent || [];
      let sent = 0, opened = 0, clicked = 0, hardBounce = 0, softBounce = 0;
      let lastOpened: string | null = null;

      for (const s of stats) {
        if (s.eventTime) {
          sent++;
          if (s.events) {
            for (const evt of s.events) {
              if (evt.event === "opened") {
                opened++;
                if (!lastOpened || (evt.eventTime && evt.eventTime > lastOpened)) lastOpened = evt.eventTime || null;
              }
              if (evt.event === "clicked") clicked++;
              if (evt.event === "hardBounce") hardBounce++;
              if (evt.event === "softBounce") softBounce++;
            }
          }
        }
      }

      await sql`
        UPDATE contacts SET
          emails_sent = ${sent},
          emails_opened = ${opened},
          emails_clicked = ${clicked},
          hard_bounces = ${hardBounce},
          soft_bounces = ${softBounce},
          last_opened_at = ${lastOpened},
          stats_synced_at = NOW()
        WHERE id = ${contact.id}
      `;
      synced++;
    } catch { errors++; }
  }
  return { synced, errors };
}

// Parse the first email template (cold outreach) from Task 2 result
function parseFirstTemplate(templateResult: string): { subject: string; body: string } | null {
  if (!templateResult) return null;
  // Try to extract subject line — common patterns: "Subject:", "**Subject:**", "Subject Line:"
  const subjectMatch = templateResult.match(/\*{0,2}Subject(?:\s*Line)?\*{0,2}[:\s]+(.+?)(?:\n|$)/i);
  // Try to extract email body — everything after "Body:" or "Email Body:" until next template
  const bodyMatch = templateResult.match(/\*{0,2}(?:Email\s+)?Body\*{0,2}[:\s]+([\s\S]+?)(?=\n\s*(?:#{1,3}\s|(?:\d+\.|\*{2})\s*(?:Follow|Newsletter|Template\s*[23]))|\n---|\n\*{3}|$)/i);
  if (!subjectMatch) return null;
  const subject = subjectMatch[1].replace(/\*+/g, "").trim();
  const body = bodyMatch ? bodyMatch[1].trim() : "";
  if (!subject || !body) return null;
  return { subject, body };
}

// Apply merge tags to email content
function applyMergeTags(content: string, lead: { first_name: string; last_name: string; company: string; email: string }): string {
  return content
    .replace(/\{\{firstName\}\}/gi, lead.first_name || "there")
    .replace(/\{\{lastName\}\}/gi, lead.last_name || "")
    .replace(/\{\{company\}\}/gi, lead.company || "your company")
    .replace(/\{\{email\}\}/gi, lead.email || "");
}

const BATCH_SIZE_FIRST_CAMPAIGN = 25;

// Task 5: Launch outreach campaign — actually sends emails via Brevo/SendGrid
async function launchOutreach(env: Env, agentId: number, projectId: number, userId: number, projectDesc: string, website: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const provider = env.SENDGRID_API_KEY ? "SendGrid" : env.BREVO_API_KEY ? "Brevo" : "none";

  // 1. Get sender info — prefer agent config, then project owner
  const agentConfig = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  const agentCfg = (agentConfig[0]?.config as Record<string, unknown>) || {};
  const projectInfo = await sql`
    SELECT p.name as project_name, p.domain, u.email as owner_email, u.name as owner_name
    FROM projects p JOIN users u ON u.id = p.user_id
    WHERE p.id = ${projectId} LIMIT 1
  `;
  const senderEmail = (agentCfg.sender_email as string) || (projectInfo[0]?.owner_email as string) || "";
  const senderName = (agentCfg.sender_name as string) || (projectInfo[0]?.owner_name as string) || "Marketing Team";
  const projectDomain = (projectInfo[0]?.domain as string) || "";

  // 2. Retrieve email template from Task 2 result
  const agents = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  const config = agents[0]?.config as { tasks?: { result?: string }[] } | undefined;
  const templateResult = config?.tasks?.[2]?.result || "";
  const template = parseFirstTemplate(templateResult);

  if (!template) {
    const msg = "Could not parse email template from Task 2. Please re-run the Email Templates task first.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Campaign Launch", msg, {
      model_used: "none", preferred_model: preferredModel, error: "no_template",
    });
    return { error: msg };
  }

  if (provider === "none") {
    const msg = "No email provider configured (Brevo or SendGrid). Add API keys in Settings → BYOK or at the organization level.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Campaign Launch", msg, {
      model_used: "none", preferred_model: preferredModel, error: "no_provider",
    });
    return { error: msg };
  }

  // 3. Get unsent leads (first batch)
  const leads = await sql`
    SELECT id, email, first_name, last_name, company
    FROM leads
    WHERE project_id = ${projectId} AND email_sent = false
    ORDER BY id
    LIMIT ${BATCH_SIZE_FIRST_CAMPAIGN}
  `;

  if (leads.length === 0) {
    const msg = "No unsent leads found. All leads have already been emailed, or no leads exist for this project.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Campaign Launch", msg, {
      model_used: "none", preferred_model: preferredModel, leads_available: 0,
    });
    return { error: msg };
  }

  // 4. Send emails
  let sent = 0;
  let failed = 0;
  const sentDetails: { email: string; name: string; company: string; subject: string; status: string; messageId?: string }[] = [];

  for (const lead of leads) {
    const leadData = {
      first_name: (lead.first_name as string) || "",
      last_name: (lead.last_name as string) || "",
      company: (lead.company as string) || "",
      email: lead.email as string,
    };
    const subject = applyMergeTags(template.subject, leadData);
    const body = applyMergeTags(template.body, leadData);
    const htmlBody = body.replace(/\n/g, "<br>");

    let messageId: string | undefined;
    let sendOk = false;

    try {
      if (env.BREVO_API_KEY && provider === "Brevo") {
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: leadData.email, name: `${leadData.first_name} ${leadData.last_name}`.trim() || undefined }],
            subject,
            htmlContent: htmlBody,
            tags: [`campaign-${agentId}`, projectDomain].filter(Boolean),
          }),
        });
        if (res.ok) {
          const data = await res.json() as { messageId?: string };
          messageId = data.messageId;
          sendOk = true;
        }
      } else if (env.SENDGRID_API_KEY && provider === "SendGrid") {
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: leadData.email, name: `${leadData.first_name} ${leadData.last_name}`.trim() || undefined }] }],
            from: { email: senderEmail, name: senderName },
            subject,
            content: [{ type: "text/html", value: htmlBody }],
          }),
        });
        if (res.ok || res.status === 202) {
          messageId = res.headers.get("x-message-id") || undefined;
          sendOk = true;
        }
      }
    } catch { /* send failed */ }

    if (sendOk) {
      sent++;
      // Mark lead as sent
      await sql`UPDATE leads SET email_sent = true WHERE id = ${lead.id}`;
      // Log to email_logs
      await sql`
        INSERT INTO email_logs (lead_id, email, subject, template, status, brevo_message_id)
        VALUES (${lead.id}, ${leadData.email}, ${subject}, ${"cold_outreach"}, ${"sent"}, ${messageId || null})
      `;
      sentDetails.push({
        email: leadData.email,
        name: `${leadData.first_name} ${leadData.last_name}`.trim(),
        company: leadData.company,
        subject,
        status: "sent",
        messageId,
      });
    } else {
      failed++;
      await sql`
        INSERT INTO email_logs (lead_id, email, subject, template, status)
        VALUES (${lead.id}, ${leadData.email}, ${subject}, ${"cold_outreach"}, ${"failed"})
      `;
      sentDetails.push({
        email: leadData.email,
        name: `${leadData.first_name} ${leadData.last_name}`.trim(),
        company: leadData.company,
        subject,
        status: "failed",
      });
    }
  }

  // 5. Sync engagement stats
  let statsInfo = "";
  try {
    const stats = await syncBrevoStats(env, userId);
    if (stats.synced > 0) {
      statsInfo = `\n\n---\n**Email Stats Synced:** ${stats.synced} contacts updated with delivery/open/click metrics`;
    }
  } catch { /* non-critical */ }

  // 6. Build detailed report
  let report = `## Campaign Launch Report\n\n`;
  report += `**Provider:** ${provider}\n`;
  report += `**Sender:** ${senderName} <${senderEmail}>\n`;
  report += `**Template:** Cold Outreach\n`;
  report += `**Subject:** ${template.subject}\n\n`;
  report += `### Results\n`;
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Batch Size | ${leads.length} |\n`;
  report += `| Sent | ${sent} |\n`;
  report += `| Failed | ${failed} |\n`;
  report += `| Success Rate | ${leads.length > 0 ? ((sent / leads.length) * 100).toFixed(0) : 0}% |\n\n`;

  if (sentDetails.length > 0) {
    report += `### Sent Emails\n`;
    report += `| # | Recipient | Company | Subject | Status |\n`;
    report += `|---|-----------|---------|---------|--------|\n`;
    sentDetails.forEach((d, i) => {
      report += `| ${i + 1} | ${d.name || d.email} | ${d.company || "-"} | ${d.subject} | ${d.status} |\n`;
    });
  }

  report += statsInfo;

  const totalUnsent = await sql`SELECT COUNT(*)::int as count FROM leads WHERE project_id = ${projectId} AND email_sent = false`;
  const remaining = (totalUnsent[0]?.count as number) || 0;
  if (remaining > 0) {
    report += `\n\n**Remaining unsent leads:** ${remaining} — run this task again to send the next batch.`;
  }

  const summary = `Campaign launched: ${sent} emails sent via ${provider}, ${failed} failed (batch of ${leads.length})`;
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", report);
  await saveReport(env.DATABASE_URL, agentId, "Campaign Launch", summary, withModelMetrics({
    leads_available: leads.length,
    emails_sent: sent,
    emails_failed: failed,
    remaining_unsent: remaining,
    provider,
  }, preferredModel, "none"));

  return { sent, failed, provider, remaining };
}

export async function handleEmail(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>,
  projectId: number,
  userId: number
) {
  const description = (config.plan as string) || (config.project_description as string) || "";
  const website = (config.website as string) || "";
  const projectName = (config.project_name as string) || "";
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  switch (taskIndex) {
    case 0:
      return researchICP(env, agentId, description, website, projectName, projectId, userId, preferredModel, langHint);
    case 1:
      return buildEmailList(env, agentId, projectId, userId);
    case 2:
      return createTemplates(env, agentId, description, website, preferredModel, langHint);
    case 3:
      return configureSendingSchedule(env, agentId, description, preferredModel, langHint);
    case 4:
      return setupTracking(env, agentId, description, website, preferredModel, langHint);
    case 5:
      return launchOutreach(env, agentId, projectId, userId, description, website, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not yet implemented for email marketing` };
  }
}
