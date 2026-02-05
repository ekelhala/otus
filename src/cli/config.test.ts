/**
 * Config Command Integration Tests
 * 
 * Tests for the otus config CLI commands
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

let tempHome: string;
let originalHome: string | undefined;

describe("otus config command", () => {
  beforeEach(() => {
    // Create a temporary home directory for testing
    tempHome = mkdtempSync(join(tmpdir(), "otus-config-test-"));
    
    // Set test home directory
    originalHome = process.env.OTUS_TEST_HOME;
    process.env.OTUS_TEST_HOME = tempHome;
  });

  afterEach(() => {
    // Restore environment
    if (originalHome) {
      process.env.OTUS_TEST_HOME = originalHome;
    } else {
      delete process.env.OTUS_TEST_HOME;
    }
    
    // Clean up temp directory
    if (tempHome && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("config set with direct value", async () => {
    const result = await $`bun run src/cli/otus.ts config set anthropic_api_key test-key-123`.text();
    expect(result).toContain("✓ Set anthropic_api_key");
    
    // Verify file was created with correct permissions
    const credPath = join(tempHome, ".otus", "credentials.json");
    expect(existsSync(credPath)).toBe(true);
    
    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("config get shows configured status", async () => {
    await $`bun run src/cli/otus.ts config set anthropic_api_key test-key-123`.quiet();
    
    const result = await $`bun run src/cli/otus.ts config get anthropic_api_key`.text();
    expect(result).toContain("***configured***");
    expect(result).not.toContain("test-key-123"); // Never reveals actual value
  });

  test("config get shows not set for unconfigured key", async () => {
    const result = await $`bun run src/cli/otus.ts config get voyage_api_key`.text();
    expect(result).toContain("not set");
  });

  test("config list shows all keys", async () => {
    await $`bun run src/cli/otus.ts config set anthropic_api_key test-key-123`.quiet();
    
    const result = await $`bun run src/cli/otus.ts config list`.text();
    expect(result).toContain("anthropic_api_key");
    expect(result).toContain("voyage_api_key");
    expect(result).toContain("✓ configured");
    expect(result).toContain("✗ not set");
  });

  test("config unset removes key", async () => {
    await $`bun run src/cli/otus.ts config set anthropic_api_key test-key-123`.quiet();
    
    const setResult = await $`bun run src/cli/otus.ts config get anthropic_api_key`.text();
    expect(setResult).toContain("***configured***");
    
    await $`bun run src/cli/otus.ts config unset anthropic_api_key`.quiet();
    
    const unsetResult = await $`bun run src/cli/otus.ts config get anthropic_api_key`.text();
    expect(unsetResult).toContain("not set");
  });

  test("config path shows credentials file path", async () => {
    const result = await $`bun run src/cli/otus.ts config path`.text();
    expect(result.trim()).toBe(join(tempHome, ".otus", "credentials.json"));
  });

  test("config set validates key names", async () => {
    const result = await $`bun run src/cli/otus.ts config set invalid_key test`.nothrow();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid key");
  });

  test("config set with piped value", async () => {
    const result = await $`echo "piped-password" | bun run src/cli/otus.ts config set voyage_api_key`.text();
    expect(result).toContain("✓ Set voyage_api_key");
    
    const getResult = await $`bun run src/cli/otus.ts config get voyage_api_key`.text();
    expect(getResult).toContain("***configured***");
  });

  test("multiple keys can be set and preserved", async () => {
    await $`bun run src/cli/otus.ts config set anthropic_api_key key1`.quiet();
    await $`bun run src/cli/otus.ts config set voyage_api_key key2`.quiet();
    
    const list = await $`bun run src/cli/otus.ts config list`.text();
    expect(list).toContain("anthropic_api_key    ✓ configured");
    expect(list).toContain("voyage_api_key       ✓ configured");
  });
});
