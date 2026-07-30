/**
 * Regression for the opaque "openai-chat requires a non-empty credential" error that surfaced
 * when a stored OAuth credential had an empty/blank `access` field: getValidAccessToken returned
 * "" without throwing, describeImageRouted passed apiKey:"" into buildRequest, and the adapter
 * threw an opaque credential error instead of a clear auth one. The executor now fails closed
 * with a readable "empty access token" error before any fetch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../src/oauth";

// Empty-token credential: the exact regression shape (access field present but blank).
mock.module("../src/oauth", () => ({ ...oauthModule, getValidAccessToken: async () => "" }));

import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { describeImageRouted } from "../src/vision/routed-describe";

const originalFetch = globalThis.fetch;

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";

const oauthRoutedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://oauth-routed.test/v1",
  authMode: "oauth",
};

function oauthConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "oauth-routed",
    providers: { "oauth-routed": oauthRoutedProvider },
  } as OcxConfig;
}

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("routed vision sidecar empty OAuth token", () => {
  test("empty access token -> clear auth error, no fetch, no opaque buildRequest error", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    const out = await describeImageRouted(
      PNG_DATA_URL, undefined, "", "oauth-routed/k3", oauthConfig(),
      { model: "oauth-routed/k3", timeoutMs: 5000 },
    );
    expect(called).toBe(false);
    expect(out.text).toBe("");
    expect(out.error).toContain("routed vision sidecar auth:");
    expect(out.error).toContain("empty access token");
    // Must NOT leak the opaque downstream buildRequest message.
    expect(out.error).not.toContain("requires a non-empty credential");
  });
});