import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIChatRequest, OpenAICompatibleProvider } from "../src/provider.js";

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
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("provider returns assistant content from mocked fetch", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "organized note" } }]
  }), { status: 200 });

  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://example.test/v1",
    apiKey: "key",
    model: "model"
  }, fetchImpl);

  const response = await provider.complete({
    messages: [{ role: "user", content: "organize" }]
  });

  assert.equal(response.content, "organized note");
});
