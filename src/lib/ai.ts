// AI helpers — Claude for email writing, Cerebras for everything else

interface CerebrasEnv {
  CEREBRAS_API_KEY?: string;
}

interface ClaudeEnv {
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

// Fast & cheap — for SEO keyword research, ICP analysis, etc.
export async function cerebrasCompletion(
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

// High quality — for writing emails, marketing copy
export async function claudeCompletion(
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
