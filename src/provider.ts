import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export class ProviderConfigError extends Error {
  constructor(message = "LLM provider is not configured. Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.") {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export class ProviderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly details: string,
    message = providerRequestMessage(status, details)
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export interface OpenAICompatibleConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
}

export interface ConfiguredOpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function providerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleConfig {
  return {
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL
  };
}

export function hasProviderConfig(config: OpenAICompatibleConfig): config is ConfiguredOpenAICompatibleConfig {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

export function providerStatus(config: OpenAICompatibleConfig): string {
  const baseUrl = config.baseUrl ?? "(not set)";
  const model = config.model ?? "(not set)";
  const apiKey = config.apiKey ? "(set)" : "(not set)";
  return `OpenAI-compatible provider\nbase URL: ${baseUrl}\nmodel: ${model}\nAPI key: ${apiKey}`;
}

export function providerRequestMessage(status: number, details: string): string {
  const providerMessage = extractProviderMessage(details);
  if (status === 429 && isInsufficientQuota(details)) {
    return "LLM provider quota is exhausted. Check your plan/billing or switch LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL to another provider.";
  }
  if (status === 429) {
    return "LLM provider rate limit was hit. Wait a moment and try again, or switch to another configured provider.";
  }
  return `LLM request failed with ${status}${providerMessage ? `: ${providerMessage}` : "."}`;
}

function isInsufficientQuota(details: string): boolean {
  return /insufficient_quota|exceeded your current quota/i.test(details);
}

function extractProviderMessage(details: string): string | undefined {
  try {
    const parsed = JSON.parse(details) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
  } catch {
    return details.trim() || undefined;
  }
}

export function createOpenAIChatRequest(config: ConfiguredOpenAICompatibleConfig, request: LlmRequest): {
  url: string;
  init: RequestInit;
} {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2
  };

  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }

  if (request.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    }
  };
}

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: OpenAICompatibleConfig = providerConfigFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!hasProviderConfig(this.config)) {
      throw new ProviderConfigError();
    }

    const { url, init } = createOpenAIChatRequest(this.config, request);
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderRequestError(response.status, text);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not include assistant content.");
    }

    return { content, raw: payload };
  }
}
