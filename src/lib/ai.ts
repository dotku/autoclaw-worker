// AI helpers — Claude for email writing, Cerebras for everything else

interface CerebrasEnv {
  CEREBRAS_API_KEY?: string;
  ALIBABA_API_KEY?: string;
  ALIBABA_AI_BASE_URL?: string;
}

interface ClaudeEnv {
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

type SupportedModel =
  | "auto"
  | "cerebras/gpt-oss-120b"
  | "anthropic/claude-sonnet-4.5"
  | "alibaba/qwen-plus"
  | "alibaba/qwen-turbo";

async function runCerebras(
  env: CerebrasEnv,
  prompt: string,
  maxTokens = 1500
): Promise<string> {
  if (!env.CEREBRAS_API_KEY) {
    throw new Error("CEREBRAS_API_KEY not configured");
  }

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) throw new Error(`Cerebras API error: ${res.status}`);
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0].message.content;
}

async function runClaude(
  env: ClaudeEnv,
  prompt: string,
  maxTokens = 2000
): Promise<string> {
  // Prefer Vercel AI Gateway
  if (env.AI_GATEWAY_API_KEY) {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.AI_GATEWAY_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.5",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Vercel AI Gateway error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content[0].text;
  }

  // Direct Anthropic
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content[0].text;
  }

  throw new Error("No Claude API key configured (AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY)");
}

async function runAlibaba(
  env: CerebrasEnv,
  prompt: string,
  model: "qwen-plus" | "qwen-turbo",
  maxTokens = 2000
): Promise<string> {
  if (!env.ALIBABA_API_KEY) {
    throw new Error("Alibaba API key is invalid or missing. Add a valid Alibaba key in Settings > Market before using Qwen models.");
  }

  const baseUrl = env.ALIBABA_AI_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.ALIBABA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alibaba API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0]?.message?.content || "";
}

// Fast & cheap by default — for SEO keyword research, ICP analysis, etc.
export async function cerebrasCompletion(
  env: CerebrasEnv & ClaudeEnv,
  prompt: string,
  maxTokens = 1500,
  preferredModel = "auto"
): Promise<string> {
  const model = preferredModel as SupportedModel;

  if (model === "anthropic/claude-sonnet-4.5") {
    try {
      return await runClaude(env, prompt, maxTokens);
    } catch {
      // Fall through to the default analysis model.
    }
  }

  if (model === "alibaba/qwen-plus" || model === "alibaba/qwen-turbo") {
    try {
      return await runAlibaba(env, prompt, model === "alibaba/qwen-plus" ? "qwen-plus" : "qwen-turbo", maxTokens);
    } catch {
      // Fall through to the default analysis model.
    }
  }

  try {
    return await runCerebras(env, prompt, maxTokens);
  } catch {
    if (model !== "cerebras/gpt-oss-120b") {
      return await runClaude(env, prompt, maxTokens);
    }
    throw new Error("Preferred model unavailable: cerebras/gpt-oss-120b");
  }
}

// High quality by default — for writing emails, marketing copy
export async function claudeCompletion(
  env: ClaudeEnv & CerebrasEnv,
  prompt: string,
  maxTokens = 2000,
  preferredModel = "auto"
): Promise<string> {
  const model = preferredModel as SupportedModel;

  if (model === "cerebras/gpt-oss-120b") {
    try {
      return await runCerebras(env, prompt, maxTokens);
    } catch {
      // Fall through to the default writing model.
    }
  }

  if (model === "alibaba/qwen-plus" || model === "alibaba/qwen-turbo") {
    try {
      return await runAlibaba(env, prompt, model === "alibaba/qwen-plus" ? "qwen-plus" : "qwen-turbo", maxTokens);
    } catch {
      // Fall through to the default writing model.
    }
  }

  try {
    return await runClaude(env, prompt, maxTokens);
  } catch {
    if (model !== "anthropic/claude-sonnet-4.5") {
      return await runCerebras(env, prompt, maxTokens);
    }
    throw new Error("Preferred model unavailable: anthropic/claude-sonnet-4.5");
  }
}
