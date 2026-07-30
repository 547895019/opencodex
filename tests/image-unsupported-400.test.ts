/**
 * Unit tests for the image-unsupported 400 matcher (src/server/image-unsupported-400.ts).
 * The matcher is the reactive trigger for auto-marking a text-only model into
 * `provider.noVisionModels`. It must fire on ollama/OpenAI/Anthropic phrasings but NOT on
 * unrelated 400s or bodies that merely mention an image.
 */
import { describe, expect, test } from "bun:test";
import { isImageUnsupported400, isImageUnsupported400Body } from "../src/server/image-unsupported-400";

describe("isImageUnsupported400Body (pure predicate)", () => {
  test("ollama: top-level error string", () => {
    expect(isImageUnsupported400Body(400, `{"error":"this model does not support image input (ref: foo)"}`)).toBe(true);
  });

  test("OpenAI-style nested error.message", () => {
    expect(isImageUnsupported400Body(400, `{"error":{"message":"This model does not support image input.","type":"invalid_request_error"}}`)).toBe(true);
  });

  test("Anthropic-style error.message", () => {
    expect(isImageUnsupported400Body(400, `{"type":"error","error":{"message":"image input is not supported for this model"}}`)).toBe(true);
  });

  test("detail field", () => {
    expect(isImageUnsupported400Body(400, `{"detail":"model does not support images"}`)).toBe(true);
  });

  test("error_message field", () => {
    expect(isImageUnsupported400Body(400, `{"error_message":"image input unsupported"}`)).toBe(true);
  });

  test("plain text body (no JSON) falls back to raw text", () => {
    expect(isImageUnsupported400Body(400, "this model does not support image input")).toBe(true);
  });

  test("non-400 status is false even with a matching body", () => {
    expect(isImageUnsupported400Body(413, `{"error":"this model does not support image input"}`)).toBe(false);
    expect(isImageUnsupported400Body(500, `{"error":"does not support image input"}`)).toBe(false);
  });

  test("unrelated 400 is false", () => {
    expect(isImageUnsupported400Body(400, `{"error":"invalid model id"}`)).toBe(false);
    expect(isImageUnsupported400Body(400, `{"error":"bad request"}`)).toBe(false);
  });

  test("body that mentions image but not unsupported is false (false-positive guard)", () => {
    expect(isImageUnsupported400Body(400, `{"error":"image url malformed"}`)).toBe(false);
    expect(isImageUnsupported400Body(400, `{"error":"image generation is not enabled"}`)).toBe(false);
    expect(isImageUnsupported400Body(400, `{"error":"too many images in request"}`)).toBe(false);
  });

  test("empty / whitespace body is false", () => {
    expect(isImageUnsupported400Body(400, "")).toBe(false);
    expect(isImageUnsupported400Body(400, "   ")).toBe(false);
  });
});

describe("isImageUnsupported400 (Response reader)", () => {
  async function check(status: number, body: string): Promise<boolean> {
    return isImageUnsupported400(new Response(body, { status }));
  }

  test("ollama 400 body -> true", async () => {
    expect(await check(400, `{"error":"this model does not support image input (ref: x)"}`)).toBe(true);
  });

  test("200 ok -> false (status gate)", async () => {
    expect(await check(200, `{"error":"this model does not support image input"}`)).toBe(false);
  });

  test("unrelated 400 -> false", async () => {
    expect(await check(400, `{"error":"invalid model id"}`)).toBe(false);
  });

  test("empty 400 body -> false", async () => {
    expect(await check(400, "")).toBe(false);
  });

  test("truncated (oversized) body -> false", async () => {
    // A body far beyond BOUNDED_BODY_MAX_BYTES (64 KiB) is not displaySafe; it must not drive a
    // persistent config mutation from a partial fragment.
    const huge = `{"error":"this model does not support image input ` + "x".repeat(200_000) + `"}`;
    expect(await check(400, huge)).toBe(false);
  });
});