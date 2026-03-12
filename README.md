# Autoclaw Worker Template

This repository is a template Cloudflare Worker for running batched marketing/automation agents.

## Endpoints

- `GET /health`: health check (public)
- `POST /execute`: run one specific task for one agent
- `POST /run-all`: run next pending task for one agent
- `POST /cron`: run next pending task for active agents in batches

All `POST` endpoints require:

`Authorization: Bearer <WORKER_AUTH_SECRET>`

## Required Environment Variables

- `DATABASE_URL`: primary database for agent/task/report data
- `WORKER_AUTH_SECRET`: shared secret for all protected worker endpoints

## Optional Environment Variables

- `CONTENT_DATABASE_URL`: external content DB used by `content_gen` agent
- `CONTENT_DEFAULT_BRAND_NAME`
- `CONTENT_DEFAULT_BRAND_DOMAIN`
- `CONTENT_DEFAULT_CONTACT_PHONE`
- `CONTENT_DEFAULT_AUDIENCE`
- `CONTENT_DEFAULT_MARKET_REGION`
- `DEV_AGENT_DEFAULT_REPO`
- `DEV_AGENT_DEFAULT_PRODUCT_NAME`
- `DEV_AGENT_DEFAULT_PRODUCT_DESCRIPTION`
- `DEV_AGENT_DEFAULT_WEBSITE`
- `DEV_AGENT_DEFAULT_TECH_STACK`
- `HUNTER_API_KEY`
- `SNOV_API_ID`
- `SNOV_API_SECRET`
- `BREVO_API_KEY`
- `AI_GATEWAY_API_KEY`
- `ANTHROPIC_API_KEY`
- `CEREBRAS_API_KEY`
- `GITHUB_TOKEN`

Use `.dev.vars.example` as a local template.

## Database Expectations

The worker expects these tables to exist in `DATABASE_URL`:

- `projects(id, user_id, name, website, ...)`
- `agent_assignments(id, project_id, agent_type, status, config, ...)`
- `agent_reports(id, agent_assignment_id, project_id, agent_type, task_name, summary, metrics, created_at, ...)`

`agent_assignments.config` must include a `tasks` array:

```json
{
  "tasks": [
    { "name": "task name", "status": "pending" }
  ]
}
```

## Agent Config Template

### `content_gen`

```json
{
  "content_db_url": "postgres://...",
  "brand_name": "Your Brand",
  "brand_domain": "example.com",
  "contact_phone": "+1-000-000-0000",
  "audience": "目标用户",
  "market_region": "目标城市"
}
```

You can also put shared defaults in worker env vars and only override per project when needed.

### `dev_agent`

```json
{
  "repo": "owner/repository",
  "product_name": "Your Product",
  "product_description": "Short product summary",
  "website": "https://example.com",
  "tech_stack": "Next.js, TypeScript, PostgreSQL",
  "current_features": ["feature 1", "feature 2"],
  "missing_features": ["gap 1", "gap 2"]
}
```

`repo` can come from:
1. `config.profile.repo`
2. `config.repo`
3. `DEV_AGENT_DEFAULT_REPO`

This makes it easy to keep an existing project setup as defaults while still overriding per project.

## Case Study: GPULaw

Use this as an example project profile while keeping the template generic.

Live dev-agent issue output example:
- https://github.com/dotku/gpulaw-attorney-services/issues

Example worker-level defaults:

```env
DEV_AGENT_DEFAULT_REPO=your-org/gpulaw-attorney-services
DEV_AGENT_DEFAULT_PRODUCT_NAME=GPULaw
DEV_AGENT_DEFAULT_PRODUCT_DESCRIPTION=AI-powered legal workflow platform for law firms and legal teams.
DEV_AGENT_DEFAULT_WEBSITE=https://gpulaw.com/
DEV_AGENT_DEFAULT_TECH_STACK=Next.js, TypeScript, PostgreSQL, Auth0
```

Example `dev_agent` config:

```json
{
  "profile": {
    "repo": "your-org/gpulaw-attorney-services",
    "product_name": "GPULaw",
    "product_description": "AI-powered legal workflow platform.",
    "website": "https://gpulaw.com/"
  },
  "competitors": [
    "clio.com",
    "legalzoom.com",
    "rocketlawyer.com"
  ],
  "focus_areas": [
    "onboarding",
    "pricing",
    "document workflow",
    "notifications"
  ]
}
```

## Deploy

### Local deploy

```bash
npm ci
npx wrangler deploy
```

### GitHub Actions deploy

This repo includes `.github/workflows/deploy-worker.yml`.

Set these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Push to `main` to auto-deploy.

## Scheduling

By default this template does not define Cloudflare native cron in `wrangler.toml`.

You can:

1. Call `POST /cron` from external scheduler (Vercel cron, GitHub Actions cron, etc.)
2. Add native Cloudflare `[triggers]` cron expressions in `wrangler.toml`

## Free Tier Notes

- Keep `/cron` batch sizes low (`max_agents` 1-5)
- Use pagination (`start_after_id`) for large account runs
- Prefer per-customer deployment if each customer should use separate free-tier quotas
