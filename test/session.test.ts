import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NoteSession } from "../src/session.js";
import { NoteStore } from "../src/storage.js";
import type { LlmProvider, LlmRequest } from "../src/types.js";

class MockProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Extract lightweight metadata")) {
      return {
        content: JSON.stringify({
          title: "Garden Plan",
          tags: ["garden", "ideas"],
          dates: ["tomorrow"],
          summary: "Ideas for the garden plan.",
          type: "idea"
        })
      };
    }
    if (prompt.includes("Lightly organize")) {
      return { content: "## Garden Plan\n\n- Buy soil\n- Sketch beds" };
    }
    return { content: "ok" };
  }
}

test("captures, extracts metadata, processes, saves, and searches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MockProvider());

  try {
    await session.append("Garden plan tomorrow: buy soil and sketch beds.");
    const processed = await session.process();
    const saved = session.save();
    const results = session.search("soil");

    assert.match(processed, /Garden Plan/);
    assert.equal(saved.title, "Garden Plan");
    assert.equal(fs.existsSync(saved.markdownPath), true);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Garden Plan");
  } finally {
    store.close();
  }
});
