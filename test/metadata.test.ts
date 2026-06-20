import assert from "node:assert/strict";
import test from "node:test";
import { extractMetadata, fallbackMetadata } from "../src/metadata.js";
import type { LlmProvider, LlmRequest } from "../src/types.js";

class MetadataProvider implements LlmProvider {
  async complete(_request: LlmRequest): Promise<{ content: string }> {
    return {
      content: JSON.stringify({
        title: "Brokerage Plan",
        tags: ["Finance", "#Investing", ""],
        topics: ["Investing", "Cash management", "investing"],
        entities: [
          { name: "Fidelity", type: "organization" },
          { name: "VTI", type: "security" },
          { name: "House purchase", type: "goal" },
          { name: "Unknown Type", type: "nonsense" },
          { name: "", type: "person" }
        ],
        dates: ["2026-06-20"],
        summary: "Plan brokerage cash and investments.",
        type: "research"
      })
    };
  }
}

test("normalizes metadata topics and typed entities from provider output", async () => {
  const metadata = await extractMetadata("Move VTI from Fidelity for house purchase.", new MetadataProvider());

  assert.deepEqual(metadata.tags, ["finance", "investing"]);
  assert.deepEqual(metadata.topics, ["Investing", "Cash management"]);
  assert.deepEqual(metadata.entities, [
    { name: "Fidelity", type: "organization" },
    { name: "VTI", type: "security" },
    { name: "House purchase", type: "goal" },
    { name: "Unknown Type", type: "other" }
  ]);
});

test("fallback metadata keeps the canonical metadata shape", () => {
  const metadata = fallbackMetadata("Research note today.");

  assert.deepEqual(metadata.topics, []);
  assert.deepEqual(metadata.entities, []);
  assert.deepEqual(metadata.tags, []);
  assert.equal(metadata.summary, "Research note today.");
});
