/**
 * Credentials Module Tests
 * 
 * Tests for secure credential storage in ~/.otus/credentials.json
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as credentials from "./credentials.ts";

// Use OTUS_TEST_HOME environment variable for testing
let tempHome: string;

describe("Credentials Module", () => {
  beforeEach(() => {
    // Create a temporary home directory for testing
    tempHome = mkdtempSync(join(tmpdir(), "otus-cred-test-"));
    
    // Set test home directory
    process.env.OTUS_TEST_HOME = tempHome;
  });

  afterEach(() => {
    // Clean up environment
    delete process.env.OTUS_TEST_HOME;
    
    // Clean up temp directory
    if (tempHome && existsSync(tempHome)) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  describe("getGlobalConfigDir", () => {
    test("returns ~/.otus path", () => {
      const dir = credentials.getGlobalConfigDir();
      expect(dir).toBe(join(tempHome, ".otus"));
    });
  });

  describe("getCredentialsPath", () => {
    test("returns ~/.otus/credentials.json path", () => {
      const path = credentials.getCredentialsPath();
      expect(path).toBe(join(tempHome, ".otus", "credentials.json"));
    });
  });

  describe("ensureSecureDir", () => {
    test("creates directory with 0700 permissions", () => {
      const testDir = join(tempHome, ".otus");
      credentials.ensureSecureDir(testDir);
      
      expect(existsSync(testDir)).toBe(true);
      
      const stats = statSync(testDir);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o700);
    });

    test("creates nested directories", () => {
      const testDir = join(tempHome, "deep", "nested", "dir");
      credentials.ensureSecureDir(testDir);
      
      expect(existsSync(testDir)).toBe(true);
    });

    test("sets permissions on existing directory", () => {
      const testDir = join(tempHome, ".otus");
      
      // Create directory with wrong permissions
      mkdirSync(testDir, { mode: 0o755 });
      expect((statSync(testDir).mode & 0o777)).toBe(0o755);
      
      // Fix permissions
      credentials.ensureSecureDir(testDir);
      expect((statSync(testDir).mode & 0o777)).toBe(0o700);
    });
  });

  describe("checkPermissions", () => {
    test("returns null for non-existent file", () => {
      const result = credentials.checkPermissions("/nonexistent/file");
      expect(result).toBe(null);
    });

    test("returns null for secure permissions (0600)", () => {
      const testFile = join(tempHome, "secure");
      writeFileSync(testFile, "test", { mode: 0o600 });
      
      const result = credentials.checkPermissions(testFile);
      expect(result).toBe(null);
    });

    test("returns warning for group-readable file (0640)", () => {
      const testFile = join(tempHome, "group-readable");
      writeFileSync(testFile, "test", { mode: 0o640 });
      
      const result = credentials.checkPermissions(testFile);
      expect(result).toContain("WARNING");
      expect(result).toContain("too open");
    });

    test("returns warning for world-readable file (0644)", () => {
      const testFile = join(tempHome, "world-readable");
      writeFileSync(testFile, "test", { mode: 0o644 });
      
      const result = credentials.checkPermissions(testFile);
      expect(result).toContain("WARNING");
      expect(result).toContain("chmod 600");
    });
  });

  describe("readCredentials", () => {
    test("returns empty object when file doesn't exist", () => {
      const creds = credentials.readCredentials();
      expect(creds).toEqual({});
    });

    test("reads valid credentials file", () => {
      const configDir = credentials.getGlobalConfigDir();
      const credPath = credentials.getCredentialsPath();
      
      mkdirSync(configDir, { recursive: true });
      writeFileSync(credPath, JSON.stringify({
        openrouter_api_key: "sk-or-test123",
        voyage_api_key: "pa-test456",
      }), { mode: 0o600 });
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBe("sk-or-test123");
      expect(creds.voyage_api_key).toBe("pa-test456");
    });

    test("ignores unknown keys in file", () => {
      const configDir = credentials.getGlobalConfigDir();
      const credPath = credentials.getCredentialsPath();
      
      mkdirSync(configDir, { recursive: true });
      writeFileSync(credPath, JSON.stringify({
        openrouter_api_key: "sk-or-test123",
        unknown_key: "should-be-ignored",
        voyage_api_key: "pa-test456",
      }), { mode: 0o600 });
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBe("sk-or-test123");
      expect(creds.voyage_api_key).toBe("pa-test456");
      expect("unknown_key" in creds).toBe(false);
    });

    test("returns empty object on invalid JSON", () => {
      const configDir = credentials.getGlobalConfigDir();
      const credPath = credentials.getCredentialsPath();
      
      mkdirSync(configDir, { recursive: true });
      writeFileSync(credPath, "invalid json {{{", { mode: 0o600 });
      
      const creds = credentials.readCredentials();
      expect(creds).toEqual({});
    });
  });

  describe("writeCredentials", () => {
    test("creates directory and file with secure permissions", () => {
      const testCreds = {
        openrouter_api_key: "sk-or-test123",
        voyage_api_key: "pa-test456",
      };
      
      credentials.writeCredentials(testCreds);
      
      const configDir = credentials.getGlobalConfigDir();
      const credPath = credentials.getCredentialsPath();
      
      // Check directory exists with 0700
      expect(existsSync(configDir)).toBe(true);
      expect((statSync(configDir).mode & 0o777)).toBe(0o700);
      
      // Check file exists with 0600
      expect(existsSync(credPath)).toBe(true);
      expect((statSync(credPath).mode & 0o777)).toBe(0o600);
      
      // Check content
      const written = credentials.readCredentials();
      expect(written).toEqual(testCreds);
    });

    test("overwrites existing file", () => {
      credentials.writeCredentials({ openrouter_api_key: "old-key" });
      credentials.writeCredentials({ voyage_api_key: "new-key" });
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBeUndefined();
      expect(creds.voyage_api_key).toBe("new-key");
    });
  });

  describe("setCredential", () => {
    test("sets a single credential", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBe("sk-or-test123");
    });

    test("updates existing credential", () => {
      credentials.setCredential("openrouter_api_key", "old-key");
      credentials.setCredential("openrouter_api_key", "new-key");
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBe("new-key");
    });

    test("preserves other credentials", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      credentials.setCredential("voyage_api_key", "pa-test456");
      
      const creds = credentials.readCredentials();
      expect(creds.openrouter_api_key).toBe("sk-or-test123");
      expect(creds.voyage_api_key).toBe("pa-test456");
    });
  });

  describe("getCredential", () => {
    test("returns undefined for non-existent credential", () => {
      const value = credentials.getCredential("openrouter_api_key");
      expect(value).toBeUndefined();
    });

    test("returns credential value", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      
      const value = credentials.getCredential("openrouter_api_key");
      expect(value).toBe("sk-or-test123");
    });
  });

  describe("unsetCredential", () => {
    test("removes a credential", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      expect(credentials.hasCredential("openrouter_api_key")).toBe(true);
      
      credentials.unsetCredential("openrouter_api_key");
      expect(credentials.hasCredential("openrouter_api_key")).toBe(false);
    });

    test("preserves other credentials", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      credentials.setCredential("voyage_api_key", "pa-test456");
      
      credentials.unsetCredential("openrouter_api_key");
      
      expect(credentials.hasCredential("openrouter_api_key")).toBe(false);
      expect(credentials.hasCredential("voyage_api_key")).toBe(true);
    });

    test("does nothing if credential doesn't exist", () => {
      credentials.unsetCredential("openrouter_api_key");
      expect(credentials.hasCredential("openrouter_api_key")).toBe(false);
    });
  });

  describe("hasCredential", () => {
    test("returns false for non-existent credential", () => {
      expect(credentials.hasCredential("openrouter_api_key")).toBe(false);
    });

    test("returns true for existing credential", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      expect(credentials.hasCredential("openrouter_api_key")).toBe(true);
    });

    test("returns false for empty string credential", () => {
      credentials.setCredential("openrouter_api_key", "");
      expect(credentials.hasCredential("openrouter_api_key")).toBe(false);
    });
  });

  describe("getConfiguredKeys", () => {
    test("returns empty array when no credentials", () => {
      const keys = credentials.getConfiguredKeys();
      expect(keys).toEqual([]);
    });

    test("returns list of configured keys", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      credentials.setCredential("voyage_api_key", "pa-test456");
      
      const keys = credentials.getConfiguredKeys();
      expect(keys).toContain("openrouter_api_key");
      expect(keys).toContain("voyage_api_key");
      expect(keys).toHaveLength(2);
    });

    test("excludes empty credentials", () => {
      credentials.setCredential("openrouter_api_key", "sk-or-test123");
      credentials.setCredential("voyage_api_key", "");
      
      const keys = credentials.getConfiguredKeys();
      expect(keys).toEqual(["openrouter_api_key"]);
    });
  });
});
