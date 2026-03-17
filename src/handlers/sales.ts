import { updateTaskStatus, saveReport, getDb, withModelMetrics, failTask } from "../lib/db";
import { cerebrasCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  BREVO_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

// Task 0: Connect to CRM — audit available integrations & contacts data
async function connectCRM(env: Env, agentId: number, projectId: number, userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Check what data we have: contacts, leads, existing reports
  const contactCount = await sql`SELECT COUNT(*)::int as count FROM contacts WHERE user_id = ${userId}`;
  const leadCount = await sql`
    SELECT COUNT(*)::int as count FROM leads WHERE project_id = ${projectId}
  `.catch(() => [{ count: 0 }]);

  const hasBrevo = !!env.BREVO_API_KEY;
  const hasSendgrid = !!env.SENDGRID_API_KEY;

  // Check for existing agent reports (from lead prospecting, email marketing)
  const existingReports = await sql`
    SELECT DISTINCT agent_type FROM agent_assignments
    WHERE project_id = ${projectId} AND status = 'active'
  `;
  const activeAgents = existingReports.map((r) => r.agent_type as string);

  const prompt = `You are a sales operations expert. Assess the current CRM and sales infrastructure for this business and create a connection plan.

Business: ${description}

Current State:
- Contacts in database: ${contactCount[0].count}
- Leads in database: ${leadCount[0].count}
- Email provider: ${hasBrevo ? "Brevo (configured)" : hasSendgrid ? "SendGrid (configured)" : "None configured"}
- Active marketing agents: ${activeAgents.join(", ") || "None"}

Provide:
1. **CRM Status Assessment** — What data sources are already connected and what's missing
2. **Data Quality Check** — Based on contacts/leads count, what's the state of the pipeline
3. **Integration Recommendations** — Which CRM tools would best serve this business (HubSpot Free, Salesforce, Pipedrive, or use the built-in system)
4. **Quick Wins** — Immediate actions to improve sales follow-up using existing data
5. **Setup Checklist** — Step-by-step plan to get a functional sales follow-up system running

Format as a structured report with clear sections.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "CRM Connection", `Assessed CRM status: ${contactCount[0].count} contacts, ${leadCount[0].count} leads`, withModelMetrics({
      contacts: contactCount[0].count,
      leads: leadCount[0].count,
      email_provider: hasBrevo ? "brevo" : hasSendgrid ? "sendgrid" : "none",
      active_agents: activeAgents.length,
    }, preferredModel, model));

    return { contacts: contactCount[0].count, leads: leadCount[0].count };
  } catch (e) {
    const msg = `CRM connection assessment failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 0, "CRM Connection", msg, preferredModel);
    return { error: msg };
  }
}

// Task 1: Import existing leads & deals — consolidate from all sources
async function importLeadsAndDeals(env: Env, agentId: number, projectId: number, userId: number, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Sync leads → contacts if not already done
  let synced = 0;
  try {
    const unsynced = await sql`
      SELECT l.email, l.first_name, l.last_name, l.company, l.position, l.source
      FROM leads l
      LEFT JOIN contacts c ON c.user_id = ${userId} AND c.email = l.email
      WHERE l.project_id = ${projectId} AND c.id IS NULL
      LIMIT 200
    `;
    for (const l of unsynced) {
      await sql`
        INSERT INTO contacts (user_id, project_id, email, first_name, last_name, company, position, source, source_detail)
        VALUES (${userId}, ${projectId}, ${l.email}, ${l.first_name || ""}, ${l.last_name || ""}, ${l.company || ""}, ${l.position || ""}, ${l.source || "lead_import"}, ${"Sales Follow-up Import (agent #" + agentId + ")"})
        ON CONFLICT (user_id, email) DO NOTHING
      `;
      synced++;
    }
  } catch (e) {
    console.error("Lead sync error:", e);
  }

  // Get pipeline stats
  const stats = await sql`
    SELECT
      COUNT(*)::int as total,
      COUNT(CASE WHEN emails_sent > 0 THEN 1 END)::int as contacted,
      COUNT(CASE WHEN emails_opened > 0 THEN 1 END)::int as engaged,
      COUNT(CASE WHEN hard_bounces > 0 THEN 1 END)::int as bounced
    FROM contacts
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  const s = stats[0];

  const prompt = `You are a sales pipeline analyst. Based on the imported data, create a pipeline assessment.

Import Results:
- New contacts synced from leads: ${synced}
- Total contacts in pipeline: ${s.total}
- Already contacted (emails sent): ${s.contacted}
- Engaged (opened emails): ${s.engaged}
- Bounced: ${s.bounced}
- Not yet contacted: ${(s.total as number) - (s.contacted as number)}

Provide:
1. **Import Summary** — What was imported and from where
2. **Pipeline Health Score** — Rate the pipeline 1-10 with justification
3. **Segmentation** — How to segment these contacts for follow-up (hot/warm/cold)
4. **Data Gaps** — What information is missing that would improve follow-up effectiveness
5. **Priority Contacts** — Which segment should be followed up first and why

${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 1500, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Lead Import", `Imported ${synced} new contacts. Pipeline: ${s.total} total, ${s.engaged} engaged`, withModelMetrics({
      synced,
      total_contacts: s.total,
      contacted: s.contacted,
      engaged: s.engaged,
      bounced: s.bounced,
    }, preferredModel, model));

    return { synced, total: s.total, engaged: s.engaged };
  } catch (e) {
    const msg = `Lead import failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 1, "Lead Import", msg, preferredModel);
    return { error: msg };
  }
}

// Task 2: Create follow-up email sequences
async function createFollowUpSequences(env: Env, agentId: number, projectId: number, userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 2, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Load existing email templates from email_marketing agent if available
  let existingTemplates = "";
  try {
    const templateReport = await sql`
      SELECT summary, metrics FROM agent_reports
      WHERE project_id = ${projectId} AND task_name = 'Email Templates'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (templateReport.length > 0) {
      existingTemplates = `\nExisting email templates: ${templateReport[0].summary}`;
    }
  } catch { /* non-critical */ }

  // Get contact engagement breakdown
  const engagement = await sql`
    SELECT
      COUNT(CASE WHEN emails_sent = 0 THEN 1 END)::int as never_contacted,
      COUNT(CASE WHEN emails_sent > 0 AND emails_opened = 0 THEN 1 END)::int as no_opens,
      COUNT(CASE WHEN emails_opened > 0 AND emails_clicked = 0 THEN 1 END)::int as opened_no_click,
      COUNT(CASE WHEN emails_clicked > 0 THEN 1 END)::int as clicked
    FROM contacts
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  const e = engagement[0];

  const prompt = `You are a sales email sequence expert. Create targeted follow-up email sequences for different pipeline segments.

Business: ${description}
${existingTemplates}

Contact Segments:
- Never contacted: ${e.never_contacted}
- Sent but no opens: ${e.no_opens}
- Opened but no clicks: ${e.opened_no_click}
- Clicked (most engaged): ${e.clicked}

Create 4 email sequences:

**Sequence 1: Cold Outreach** (for never-contacted leads)
- 4 emails, spaced 3-5 days apart
- Goal: Get first engagement

**Sequence 2: Re-engagement** (for no-opens segment)
- 3 emails with different subject lines
- Goal: Get them to open

**Sequence 3: Nurture** (for opened-no-click segment)
- 3 emails with value-add content
- Goal: Drive action/click

**Sequence 4: Conversion** (for clicked/engaged segment)
- 3 emails focused on closing
- Goal: Book a call or make a purchase

For each email provide:
- Subject line
- Email body (with {{firstName}}, {{company}} merge tags)
- Send timing (days after trigger)
- Goal metric

Keep emails under 100 words each. Be direct and professional.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 3000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 2, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Follow-up Sequences", "Created 4 email sequences for pipeline segments", withModelMetrics({
      sequences_created: 4,
      never_contacted: e.never_contacted,
      no_opens: e.no_opens,
      opened_no_click: e.opened_no_click,
      clicked: e.clicked,
    }, preferredModel, model));

    return { sequences: 4 };
  } catch (err) {
    const msg = `Follow-up sequence creation failed: ${err}`;
    await failTask(env.DATABASE_URL, agentId, 2, "Follow-up Sequences", msg, preferredModel);
    return { error: msg };
  }
}

// Task 3: Set up automated reminders
async function setupReminders(env: Env, agentId: number, projectId: number, userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 3, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Get contacts that need follow-up attention
  const staleContacts = await sql`
    SELECT COUNT(*)::int as count FROM contacts
    WHERE user_id = ${userId} AND project_id = ${projectId}
      AND emails_sent > 0 AND emails_opened > 0
      AND (last_opened_at IS NULL OR last_opened_at < NOW() - INTERVAL '7 days')
  `.catch(() => [{ count: 0 }]);

  const prompt = `You are a sales automation expert. Create a follow-up reminder system and timing strategy.

Business: ${description}
Contacts needing follow-up (engaged but stale >7 days): ${staleContacts[0].count}

Design:
1. **Reminder Rules** — When to trigger follow-up reminders based on:
   - Days since last email sent
   - Days since last email opened
   - Days since last click
   - No response after X emails

2. **Escalation Ladder**
   - Level 1: Automated email follow-up (1-3 days)
   - Level 2: Different channel (social, phone) reminder (5-7 days)
   - Level 3: Manager notification (10+ days no response)
   - Level 4: Archive/nurture list (30+ days)

3. **Timing Optimization**
   - Best times to send follow-ups by industry
   - Minimum/maximum follow-up frequency
   - Weekend/holiday handling

4. **Templates for Each Stage**
   - Gentle reminder template
   - Value-add follow-up template
   - Last chance template
   - Break-up email template

5. **Metrics to Track**
   - Response rate by follow-up number
   - Optimal follow-up count before giving up
   - Best performing time slots

Format as an actionable playbook.
${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2000, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 3, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Automated Reminders", `Reminder system configured. ${staleContacts[0].count} contacts need immediate follow-up`, withModelMetrics({
      stale_contacts: staleContacts[0].count,
    }, preferredModel, model));

    return { staleContacts: staleContacts[0].count };
  } catch (err) {
    const msg = `Reminder setup failed: ${err}`;
    await failTask(env.DATABASE_URL, agentId, 3, "Automated Reminders", msg, preferredModel);
    return { error: msg };
  }
}

// Task 4: Configure deal stage tracking
async function configureDealTracking(env: Env, agentId: number, projectId: number, userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 4, "in_progress");

  const sql = getDb(env.DATABASE_URL);

  // Get full pipeline stats for analysis
  const pipeline = await sql`
    SELECT
      COUNT(*)::int as total,
      COUNT(CASE WHEN emails_sent = 0 THEN 1 END)::int as new_leads,
      COUNT(CASE WHEN emails_sent > 0 AND emails_opened = 0 THEN 1 END)::int as contacted,
      COUNT(CASE WHEN emails_opened > 0 AND emails_clicked = 0 THEN 1 END)::int as interested,
      COUNT(CASE WHEN emails_clicked > 0 THEN 1 END)::int as qualified,
      SUM(emails_sent)::int as total_emails_sent,
      SUM(emails_opened)::int as total_opens,
      SUM(emails_clicked)::int as total_clicks
    FROM contacts
    WHERE user_id = ${userId} AND project_id = ${projectId}
  `;
  const p = pipeline[0];

  const prompt = `You are a sales pipeline management expert. Design a deal stage tracking framework.

Business: ${description}

Current Pipeline Data:
- Total contacts: ${p.total}
- New leads (never contacted): ${p.new_leads}
- Contacted (sent, no opens): ${p.contacted}
- Interested (opened emails): ${p.interested}
- Qualified (clicked/engaged): ${p.qualified}
- Total emails sent: ${p.total_emails_sent}
- Total opens: ${p.total_opens}
- Total clicks: ${p.total_clicks}
- Open rate: ${(p.total_emails_sent as number) > 0 ? (((p.total_opens as number) / (p.total_emails_sent as number)) * 100).toFixed(1) : 0}%
- Click rate: ${(p.total_emails_sent as number) > 0 ? (((p.total_clicks as number) / (p.total_emails_sent as number)) * 100).toFixed(1) : 0}%

Design:
1. **Deal Stages** — Define 6-8 pipeline stages with clear entry/exit criteria
   (e.g., New Lead → Contacted → Engaged → Qualified → Proposal → Negotiation → Won/Lost)

2. **Stage Assignment Rules** — Automatic rules based on:
   - Email engagement (opens, clicks)
   - Website visits
   - Response patterns
   - Time in stage

3. **Pipeline Metrics Dashboard**
   - Conversion rates between stages
   - Average time in each stage
   - Stage velocity
   - Bottleneck identification

4. **Current Pipeline Analysis** — Based on the data above:
   - Map existing contacts to proposed stages
   - Identify conversion bottlenecks
   - Revenue potential estimate

5. **Actions per Stage** — What follow-up action to take at each stage

6. **Pipeline Health Scorecard** — Key metrics and thresholds
   - Stage-by-stage conversion benchmarks
   - Red flags to watch for

${langHint}`;

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 2500, preferredModel);

    await updateTaskStatus(env.DATABASE_URL, agentId, 4, "completed", content);
    await saveReport(env.DATABASE_URL, agentId, "Deal Stage Tracking", `Pipeline: ${p.total} contacts across ${4} stages`, withModelMetrics({
      total_contacts: p.total,
      new_leads: p.new_leads,
      contacted: p.contacted,
      interested: p.interested,
      qualified: p.qualified,
      open_rate: (p.total_emails_sent as number) > 0 ? (((p.total_opens as number) / (p.total_emails_sent as number)) * 100).toFixed(1) : "0",
      click_rate: (p.total_emails_sent as number) > 0 ? (((p.total_clicks as number) / (p.total_emails_sent as number)) * 100).toFixed(1) : "0",
    }, preferredModel, model));

    return { pipeline: p };
  } catch (err) {
    const msg = `Deal tracking configuration failed: ${err}`;
    await failTask(env.DATABASE_URL, agentId, 4, "Deal Stage Tracking", msg, preferredModel);
    return { error: msg };
  }
}

const NURTURE_BATCH_SIZE = 25;

// Apply merge tags to email content
function applyMergeTags(content: string, contact: { first_name: string; last_name: string; company: string; email: string }): string {
  return content
    .replace(/\{\{firstName\}\}/gi, contact.first_name || "there")
    .replace(/\{\{lastName\}\}/gi, contact.last_name || "")
    .replace(/\{\{company\}\}/gi, contact.company || "your company")
    .replace(/\{\{email\}\}/gi, contact.email || "");
}

// Task 5: Launch nurture campaign — generates personalized emails and sends them
async function launchNurtureCampaign(env: Env, agentId: number, projectId: number, userId: number, description: string, preferredModel = "auto", langHint = "") {
  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "in_progress");

  const sql = getDb(env.DATABASE_URL);
  const provider = env.SENDGRID_API_KEY ? "SendGrid" : env.BREVO_API_KEY ? "Brevo" : "none";

  if (provider === "none") {
    const msg = "No email provider configured (Brevo or SendGrid). Add API keys in Settings → BYOK.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Nurture Campaign", msg, { model_used: "none", preferred_model: preferredModel, error: "no_provider" });
    return { error: msg };
  }

  // 1. Get sender info — prefer agent config, then project owner
  const agentRows = await sql`SELECT config FROM agent_assignments WHERE id = ${agentId}`;
  const agentCfg = (agentRows[0]?.config as Record<string, unknown>) || {};
  const projectInfo = await sql`
    SELECT p.name as project_name, p.domain, u.email as owner_email, u.name as owner_name
    FROM projects p JOIN users u ON u.id = p.user_id
    WHERE p.id = ${projectId} LIMIT 1
  `;
  const senderEmail = (agentCfg.sender_email as string) || (projectInfo[0]?.owner_email as string) || "";
  const senderName = (agentCfg.sender_name as string) || (projectInfo[0]?.owner_name as string) || "Sales Team";
  const projectName = (projectInfo[0]?.project_name as string) || "";

  if (!senderEmail) {
    const msg = "No sender email configured. Set sender_email in agent config or ensure project has an owner.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Nurture Campaign", msg, { model_used: "none", preferred_model: preferredModel, error: "no_sender" });
    return { error: msg };
  }

  // 2. Load follow-up sequence from Task 2 result
  let sequenceContext = "";
  const tasks = (agentCfg.tasks as { result?: string }[]) || [];
  if (tasks[2]?.result) {
    sequenceContext = tasks[2].result.substring(0, 2000);
  }

  // 3. Get contacts to nurture — prioritize by engagement level
  // Hot (clicked) → Engaged (opened) → Contacted (sent, no open) → New (never contacted)
  const contacts = await sql`
    SELECT id, email, first_name, last_name, company, position,
           emails_sent, emails_opened, emails_clicked, last_opened_at
    FROM contacts
    WHERE user_id = ${userId} AND project_id = ${projectId}
      AND hard_bounces = 0
      AND email IS NOT NULL AND email != ''
    ORDER BY
      CASE
        WHEN emails_clicked > 0 THEN 1
        WHEN emails_opened > 0 THEN 2
        WHEN emails_sent > 0 THEN 3
        ELSE 4
      END,
      last_opened_at ASC NULLS LAST
    LIMIT ${NURTURE_BATCH_SIZE}
  `;

  if (contacts.length === 0) {
    const msg = "No contacts available for nurture campaign. Import leads first (Task 1).";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Nurture Campaign", msg, { model_used: "none", preferred_model: preferredModel });
    return { error: msg };
  }

  // 4. Use AI to generate a nurture email based on sequence + business context
  const segmentBreakdown = {
    hot: contacts.filter((c) => (c.emails_clicked as number) > 0).length,
    engaged: contacts.filter((c) => (c.emails_opened as number) > 0 && (c.emails_clicked as number) === 0).length,
    contacted: contacts.filter((c) => (c.emails_sent as number) > 0 && (c.emails_opened as number) === 0).length,
    fresh: contacts.filter((c) => (c.emails_sent as number) === 0).length,
  };

  const prompt = `You are a sales email copywriter. Generate a nurture email for a B2B outreach campaign.

Business: ${description}
Project: ${projectName}
Sender: ${senderName}

Target batch: ${contacts.length} contacts
- Hot (previously clicked): ${segmentBreakdown.hot}
- Engaged (opened but no click): ${segmentBreakdown.engaged}
- Contacted (sent, no opens): ${segmentBreakdown.contacted}
- Fresh (never contacted): ${segmentBreakdown.fresh}

${sequenceContext ? `Follow-up sequence reference:\n${sequenceContext}\n` : ""}

Write ONE email that works across segments. Use merge tags: {{firstName}}, {{company}}.

Return ONLY a JSON object:
{
  "subject": "compelling subject line",
  "body": "email body text with merge tags. Keep under 120 words. Use line breaks (\\n) for paragraphs. Professional but warm."
}

Return ONLY the JSON, no other text.
${langHint}`;

  let emailSubject = "";
  let emailBody = "";
  let modelUsed = "none";

  try {
    const { content, model } = await cerebrasCompletionWithMeta(env, prompt, 800, preferredModel);
    modelUsed = model;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      emailSubject = parsed.subject || "";
      emailBody = parsed.body || "";
    }
  } catch (e) {
    const msg = `Failed to generate nurture email: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 5, "Nurture Campaign", msg, preferredModel);
    return { error: msg };
  }

  if (!emailSubject || !emailBody) {
    const msg = "AI failed to generate a valid email template. Please retry.";
    await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", msg);
    await saveReport(env.DATABASE_URL, agentId, "Nurture Campaign", msg, { model_used: modelUsed, preferred_model: preferredModel });
    return { error: msg };
  }

  // 5. Send emails
  let sent = 0;
  let failed = 0;
  const sentDetails: { email: string; name: string; status: string }[] = [];

  for (const contact of contacts) {
    const contactData = {
      first_name: (contact.first_name as string) || "",
      last_name: (contact.last_name as string) || "",
      company: (contact.company as string) || "",
      email: contact.email as string,
    };
    const subject = applyMergeTags(emailSubject, contactData);
    const body = applyMergeTags(emailBody, contactData);
    const htmlBody = body.replace(/\n/g, "<br>");

    let sendOk = false;
    try {
      if (env.BREVO_API_KEY && provider === "Brevo") {
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: contactData.email, name: `${contactData.first_name} ${contactData.last_name}`.trim() || undefined }],
            subject,
            htmlContent: htmlBody,
            tags: [`nurture-${agentId}`, projectName].filter(Boolean),
          }),
        });
        if (res.ok) sendOk = true;
      } else if (env.SENDGRID_API_KEY && provider === "SendGrid") {
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: contactData.email, name: `${contactData.first_name} ${contactData.last_name}`.trim() || undefined }] }],
            from: { email: senderEmail, name: senderName },
            subject,
            content: [{ type: "text/html", value: htmlBody }],
          }),
        });
        if (res.ok || res.status === 202) sendOk = true;
      }
    } catch { /* send failed */ }

    if (sendOk) {
      sent++;
      // Update contact stats
      await sql`
        UPDATE contacts SET
          emails_sent = emails_sent + 1,
          updated_at = NOW()
        WHERE id = ${contact.id}
      `;
      sentDetails.push({ email: contactData.email, name: `${contactData.first_name} ${contactData.last_name}`.trim(), status: "sent" });
    } else {
      failed++;
      sentDetails.push({ email: contactData.email, name: `${contactData.first_name} ${contactData.last_name}`.trim(), status: "failed" });
    }
  }

  // 6. Build report
  const lines = [
    `## Nurture Campaign Report\n`,
    `**Sender:** ${senderName} <${senderEmail}>`,
    `**Provider:** ${provider}`,
    `**Subject:** ${emailSubject}`,
    `**Batch:** ${contacts.length} contacts (${segmentBreakdown.hot} hot, ${segmentBreakdown.engaged} engaged, ${segmentBreakdown.contacted} contacted, ${segmentBreakdown.fresh} fresh)`,
    `**Results:** ${sent} sent, ${failed} failed`,
    ``,
    `### Email Preview`,
    `> **Subject:** ${emailSubject}`,
    `> ${emailBody.substring(0, 300)}${emailBody.length > 300 ? "..." : ""}`,
  ];
  if (sentDetails.length > 0) {
    lines.push(``, `### Recipients`);
    for (const d of sentDetails.slice(0, 15)) {
      lines.push(`- ${d.status === "sent" ? "✅" : "❌"} ${d.name || d.email} (${d.email})`);
    }
    if (sentDetails.length > 15) lines.push(`- ... and ${sentDetails.length - 15} more`);
  }

  const report = lines.join("\n");
  const summary = `Nurture campaign: ${sent} sent, ${failed} failed out of ${contacts.length} contacts`;

  await updateTaskStatus(env.DATABASE_URL, agentId, 5, "completed", report);
  await saveReport(env.DATABASE_URL, agentId, "Nurture Campaign", summary, withModelMetrics({
    total_contacts: contacts.length,
    sent,
    failed,
    hot: segmentBreakdown.hot,
    engaged: segmentBreakdown.engaged,
    contacted: segmentBreakdown.contacted,
    fresh: segmentBreakdown.fresh,
    provider,
    subject: emailSubject,
  }, preferredModel, modelUsed));

  return { sent, failed, total: contacts.length };
}

export async function handleSales(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>,
  projectId: number,
  userId: number,
) {
  const description = (config.plan as string) || (config.project_description as string) || "";
  const preferredModel = String(config.model || "auto");
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  switch (taskIndex) {
    case 0:
      return connectCRM(env, agentId, projectId, userId, description, preferredModel, langHint);
    case 1:
      return importLeadsAndDeals(env, agentId, projectId, userId, preferredModel, langHint);
    case 2:
      return createFollowUpSequences(env, agentId, projectId, userId, description, preferredModel, langHint);
    case 3:
      return setupReminders(env, agentId, projectId, userId, description, preferredModel, langHint);
    case 4:
      return configureDealTracking(env, agentId, projectId, userId, description, preferredModel, langHint);
    case 5:
      return launchNurtureCampaign(env, agentId, projectId, userId, description, preferredModel, langHint);
    default:
      return { error: `Task ${taskIndex} not implemented for sales follow-up` };
  }
}
