import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@vanessa/shared";
import { Narrator } from "../core/narrator.js";

function verifiedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "verified-task",
    agent: "windows",
    action: "wifi.restart_adapter",
    params: {},
    dependsOn: [],
    status: "success",
    spokenSummary: "The Wi-Fi is fixed and YouTube is now playing.",
    verification: {
      verified: true,
      details: "Adapter status is Up and an external connectivity probe succeeded.",
      postconditions: ["Adapter status is Up and an external connectivity probe succeeded."],
      outcome: "succeeded",
    },
    ...overrides,
  };
}

test("verified success speech is derived from verifier details, not an agent-authored claim", () => {
  const narrator = new Narrator();
  const summary = narrator.narrateVerifiedSuccess([verifiedTask()]);

  assert.match(summary, /Adapter status is Up/);
  assert.match(summary, /external connectivity probe succeeded/);
  assert.doesNotMatch(summary, /YouTube/);
  assert.doesNotMatch(summary, /Wi-Fi is fixed/);
});

test("browser launch does not become a claim that media playback started", () => {
  const narrator = new Narrator();
  const task = verifiedTask({
    agent: "browser",
    action: "youtube.search_and_play",
    spokenSummary: "Playback started successfully.",
    verification: {
      verified: true,
      details: "Browser accepted navigation to YouTube search results; playback was not observed.",
      postconditions: ["Browser accepted navigation to YouTube search results; playback was not observed."],
      outcome: "succeeded",
    },
  });

  const summary = narrator.narrateVerifiedSuccess([task]);
  assert.match(summary, /playback was not observed/i);
  assert.doesNotMatch(summary, /Playback started/i);
});

test("success without verifier-facing details uses a neutral verified fallback", () => {
  const narrator = new Narrator();
  const summary = narrator.narrateVerifiedSuccess([
    verifiedTask({
      spokenSummary: "The email was sent.",
      verification: {
        verified: true,
        postconditions: [],
        outcome: "succeeded",
      },
    }),
  ]);

  assert.match(summary, /passed verification/i);
  assert.doesNotMatch(summary, /email was sent/i);
});

test("unverified tasks are excluded from completion narration", () => {
  const narrator = new Narrator();
  const summary = narrator.narrateVerifiedSuccess([
    verifiedTask({
      verification: {
        verified: false,
        postconditions: ["No read-back was available."],
        outcome: "partial",
      },
    }),
  ]);

  assert.match(summary, /No task has verified completion evidence/);
});

test("verified narration redacts secrets, strips URLs and normalizes multiline evidence", () => {
  const narrator = new Narrator();
  const task = verifiedTask({
    verification: {
      verified: true,
      details: "Read-back succeeded. Token: sk-test-abcdefghijklmnopqrstuvwxyz123456 and https://private.example/path",
      postconditions: [],
      outcome: "succeeded",
    },
  });

  const summary = narrator.narrateVerifiedSuccess([task]);
  assert.doesNotMatch(summary, /sk-test-abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(summary, /https:\/\//);
  assert.match(summary, /link/);
});
