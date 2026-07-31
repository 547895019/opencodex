import { afterEach, describe, expect, test } from "bun:test";
import {
  capturePromptInbound,
  clearPromptCapture,
  getPromptCaptureEntries,
  getPromptCaptureOptions,
  loadPromptCaptureConfig,
  redactPromptBody,
  setPromptCaptureOptions,
  type PromptCaptureRedaction,
} from "../src/lib/prompt-capture";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";
import type { OcxConfig } from "../src/types";

afterEach(() => {
  resetDebugSettingsForTests();
  clearPromptCapture();
  setPromptCaptureOptions({ redaction: "secrets", maxEntries: 20 });
});

const body = {
  model: "claude-opus-4-8-ncb",
  system: "You are Claude.",
  output_config: { effort: "max" },
  metadata: { user_id: "device-abc:session-123", email: "tester@example.com" },
  authorization: "Bearer sk-secret-1234567890",
  messages: [{ role: "user", content: "top secret prompt text" }],
};

describe("prompt capture (full body)", () => {
  test("OFF (default): captures nothing", () => {
    capturePromptInbound("claude-messages", body);
    expect(getPromptCaptureEntries()).toHaveLength(0);
  });

  test("ON: records full redacted body", () => {
    setDebugSettings({ promptCapture: true });
    capturePromptInbound("claude-messages", body, { resolvedModel: "cursor/gpt-5.6-luna" });
    const entries = getPromptCaptureEntries();
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e!.surface).toBe("claude-messages");
    expect(e!.model).toBe("claude-opus-4-8-ncb");
    expect(e!.resolvedModel).toBe("cursor/gpt-5.6-luna");
    expect(e!.redaction).toBe("secrets");
    expect(e!.bodySize).toBeGreaterThan(0);
    // secrets redaction masks the bearer token / api key field
    const serialized = JSON.stringify(e!.body);
    expect(serialized).not.toContain("sk-secret-1234567890");
    expect(serialized).toContain("[REDACTED]");
    // secrets level does NOT mask prompt text or user_id (that is secrets-pii)
    expect(serialized).toContain("top secret prompt text");
    expect(serialized).toContain("device-abc:session-123");
  });

  test("secrets-pii masks user_id, email, and prompt paths but keeps prompt text", () => {
    setDebugSettings({ promptCapture: true });
    setPromptCaptureOptions({ redaction: "secrets-pii" });
    capturePromptInbound("claude-messages", body);
    const [e] = getPromptCaptureEntries();
    const serialized = JSON.stringify(e!.body);
    expect(serialized).not.toContain("device-abc:session-123");
    expect(serialized).not.toContain("tester@example.com");
    expect(serialized).not.toContain("sk-secret-1234567890");
    // PII walk masks identity fields, not message content
    expect(serialized).toContain("top secret prompt text");
  });

  test("none redaction keeps the body verbatim (no masking)", () => {
    setDebugSettings({ promptCapture: true });
    setPromptCaptureOptions({ redaction: "none" });
    capturePromptInbound("claude-messages", body);
    const [e] = getPromptCaptureEntries();
    const serialized = JSON.stringify(e!.body);
    expect(serialized).toContain("sk-secret-1234567890");
    expect(serialized).toContain("device-abc:session-123");
  });

  test("ring trims to maxEntries", () => {
    setDebugSettings({ promptCapture: true });
    setPromptCaptureOptions({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) capturePromptInbound("codex-responses", { model: `m-${i}` });
    const entries = getPromptCaptureEntries();
    expect(entries).toHaveLength(3);
    // newest first → m-4, m-3, m-2
    expect(entries[0]!.model).toBe("m-4");
    expect(entries[2]!.model).toBe("m-2");
  });

  test("changing redaction level clears the ring", () => {
    setDebugSettings({ promptCapture: true });
    capturePromptInbound("claude-messages", body);
    expect(getPromptCaptureEntries()).toHaveLength(1);
    setPromptCaptureOptions({ redaction: "none" });
    expect(getPromptCaptureEntries()).toHaveLength(0);
  });

  test("turning the flag off flushes the ring on the next capture attempt", () => {
    setDebugSettings({ promptCapture: true });
    capturePromptInbound("claude-messages", body);
    expect(getPromptCaptureEntries()).toHaveLength(1);
    setDebugSettings({ promptCapture: false });
    capturePromptInbound("claude-messages", body);
    expect(getPromptCaptureEntries()).toHaveLength(0);
  });

  test("headers are redacted", () => {
    setDebugSettings({ promptCapture: true });
    const headers = new Headers({ authorization: "Bearer sk-secret-1234567890", "x-api-key": "abc" });
    capturePromptInbound("claude-messages", body, { headers });
    const [e] = getPromptCaptureEntries();
    expect(e!.headers!.authorization).toBe("[REDACTED]");
    expect(e!.headers!["x-api-key"]).toBe("[REDACTED]");
  });

  test("loadPromptCaptureConfig applies persisted options", () => {
    const config = {
      debug: { promptCapture: { redaction: "secrets-pii", maxEntries: 7 } },
    } as unknown as OcxConfig;
    loadPromptCaptureConfig(config);
    expect(getPromptCaptureOptions()).toEqual({ redaction: "secrets-pii", maxEntries: 7 });
  });

  test("redactPromptBody: none clones, secrets mutates a copy not the original", () => {
    const original = { authorization: "Bearer sk-secret-1234567890", x: 1 };
    const out = redactPromptBody(original, "secrets") as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(original.authorization).toBe("Bearer sk-secret-1234567890");
  });

  test("redactPromptBody accepts all three levels without throwing", () => {
    const levels: PromptCaptureRedaction[] = ["none", "secrets", "secrets-pii"];
    for (const level of levels) {
      expect(() => redactPromptBody(body, level)).not.toThrow();
    }
  });
});