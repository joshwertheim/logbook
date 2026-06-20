import assert from "node:assert/strict";
import test from "node:test";
import { matchDateCheck, parseCheckQuery } from "../src/check.js";

test("parses today check queries using local date", () => {
  assert.deepEqual(parseCheckQuery("what happened today", new Date("2026-06-20T15:30:00")), {
    kind: "date",
    label: "today",
    targetDate: "2026-06-20",
    relativeWord: "today",
    subjectTerms: []
  });
});

test("keeps subject terms from date check queries", () => {
  assert.deepEqual(parseCheckQuery("did i give haru his medicine today", new Date("2026-06-20T15:30:00")), {
    kind: "date",
    label: "today",
    targetDate: "2026-06-20",
    relativeWord: "today",
    subjectTerms: ["haru", "medicine"]
  });
});

test("parses explicit ISO date check queries", () => {
  assert.deepEqual(parseCheckQuery("what happened on 2026-06-19"), {
    kind: "date",
    label: "2026-06-19",
    targetDate: "2026-06-19",
    subjectTerms: []
  });
});

test("matches saved notes by created date and metadata dates", () => {
  const query = {
    kind: "date" as const,
    label: "today",
    targetDate: "2026-06-20",
    relativeWord: "today" as const,
    subjectTerms: []
  };

  assert.deepEqual(matchDateCheck({
    createdAt: "2026-06-20T12:00:00.000Z",
    updatedAt: "2026-06-20T12:00:00.000Z",
    dates: ["today"]
  }, query), {
    matched: true,
    reasons: ["saved on 2026-06-20", "mentions today"]
  });
});

test("matches slash-form metadata dates against normalized date queries", () => {
  const query = {
    kind: "date" as const,
    label: "6/20/2026",
    targetDate: "2026-06-20",
    subjectTerms: []
  };

  assert.deepEqual(matchDateCheck({
    createdAt: "2026-06-19T12:00:00.000Z",
    updatedAt: "2026-06-19T12:00:00.000Z",
    dates: ["6/20/2026"]
  }, query), {
    matched: true,
    reasons: ["mentions 6/20/2026"]
  });
});
