import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIChatRequest, OpenAICompatibleProvider, ProviderConfigError } from "../src/provider.js";

test("constructs OpenAI-compatible chat request", () => {
  const request = createOpenAIChatRequest({
    baseUrl: "http://localhost:11434/v1/",
    apiKey: "test-key",
    model: "local-model"
  }, {
    responseFormat: "json",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(request.init.method, "POST");
  assert.equal((request.init.headers as Record<string, string>).authorization, "Bearer test-key");
  const body = JSON.parse(request.init.body as string) as Record<string, unknown>;
  assert.equal(body.model, "local-model");
  assert.equal(body.max_tokens, 1200);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("explicit maxTokens overrides provider default", () => {
  const request = createOpenAIChatRequest({
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "test-key",
    model: "model"
  }, {
    maxTokens: 42,
    messages: [{ role: "user", content: "hello" }]
  });

  const body = JSON.parse(request.init.body as string) as Record<string, unknown>;
  assert.equal(body.max_tokens, 42);
});

test("allows HTTPS provider URLs", () => {
  const request = createOpenAIChatRequest({
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "test-key",
    model: "model"
  }, {
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.url, "https://api.openai.com/v1/chat/completions");
});

test("allows loopback HTTP provider URLs", () => {
  const localhosts = [
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:11434/v1"
  ];

  for (const baseUrl of localhosts) {
    const request = createOpenAIChatRequest({
      baseUrl,
      apiKey: "test-key",
      model: "model"
    }, {
      messages: [{ role: "user", content: "hello" }]
    });

    assert.match(request.url, /\/chat\/completions$/);
  }
});

test("rejects remote HTTP provider URLs", () => {
  assert.throws(() => createOpenAIChatRequest({
    baseUrl: "http://api.openai.com/v1",
    apiKey: "test-key",
    model: "model"
  }, {
    messages: [{ role: "user", content: "hello" }]
  }), ProviderConfigError);
});

test("rejects malformed base URLs before fetch is called", async () => {
  let fetchCalled = false;
  const fetchImpl: typeof fetch = async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  };

  const provider = new OpenAICompatibleProvider({
    baseUrl: "not a url",
    apiKey: "key",
    model: "model"
  }, fetchImpl);

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "organize" }] }),
    ProviderConfigError
  );
  assert.equal(fetchCalled, false);
});

test("provider returns assistant content from mocked fetch", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "organized note" } }]
  }), { status: 200 });

  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "model"
  }, fetchImpl);

  const response = await provider.complete({
    messages: [{ role: "user", content: "organize" }]
  });

  assert.equal(response.content, "organized note");
});

test("provider reports insufficient quota with a concise message", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota",
      code: "insufficient_quota"
    }
  }), { status: 429 });

  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "model"
  }, fetchImpl);

  await assert.rejects(
    provider.complete({ messages: [{ role: "user", content: "organize" }] }),
    /LLM provider quota is exhausted/
  );
});

test("provider aborts timed out requests with concise timeout error", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "model"
  }, fetchImpl);

  await assert.rejects(
    provider.complete({ timeoutMs: 1, messages: [{ role: "user", content: "organize" }] }),
    /LLM request timed out after 1ms\./
  );
});
