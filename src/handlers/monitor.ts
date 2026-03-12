import { updateTaskStatus, saveReport } from "../lib/db";

interface Env {
  DATABASE_URL: string;
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

  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
  await saveReport(env.DATABASE_URL, agentId, "Website Monitor", summary, metrics);

  return metrics;
}

export async function handleMonitor(env: Env, agentId: number, taskIndex: number, config: Record<string, unknown>) {
  const website = (config.website as string) || "";

  if (!website) {
    return { error: "No website URL configured" };
  }

  switch (taskIndex) {
    case 0:
      return monitorWebsite(env, agentId, website);
    default:
      return { error: `Task ${taskIndex} not yet implemented for product monitoring` };
  }
}
