/**
 * .otusignore Tests
 * 
 * Unit tests for ignore file parsing and integration tests for workspace sync
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import { GuestAgentClient } from "./vsock.ts";
import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { FIRECRACKER, VSOCK } from "@shared/constants.ts";

/**
 * Parse ignore file (same implementation as in daemon)
 */
async function parseIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Create a tar archive with excludes (same logic as daemon)
 */
async function createTarWithExcludes(
  sourcePath: string,
  excludes: string[]
): Promise<Buffer> {
  const excludeArgs = excludes.map((p) => `--exclude=${p}`);
  const proc = Bun.spawn(
    ["tar", "-czf", "-", ...excludeArgs, "-C", sourcePath, "."],
    { stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;
  return Buffer.from(output);
}

/**
 * List contents of a tar archive
 */
async function listTarContents(tarData: Buffer): Promise<string[]> {
  const tmpFile = join(tmpdir(), `tar-list-${Date.now()}.tar.gz`);
  await writeFile(tmpFile, tarData);
  try {
    const result = await $`tar -tzf ${tmpFile}`.text();
    return result.trim().split("\n").filter(Boolean);
  } finally {
    await rm(tmpFile, { force: true });
  }
}

// ============================================================================
// Unit Tests: Ignore File Parsing
// ============================================================================

describe("parseIgnoreFile", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `otusignore-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("parses simple patterns", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "node_modules\n.git\ndist\n");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual(["node_modules", ".git", "dist"]);
  });

  test("ignores comments", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(
      ignorePath,
      "# This is a comment\nnode_modules\n# Another comment\n.git\n"
    );

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual(["node_modules", ".git"]);
  });

  test("ignores empty lines", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "node_modules\n\n\n.git\n\ndist\n");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual(["node_modules", ".git", "dist"]);
  });

  test("trims whitespace", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "  node_modules  \n\t.git\t\n  dist\n");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual(["node_modules", ".git", "dist"]);
  });

  test("handles wildcard patterns", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "*.log\n*.tmp\n*.pyc\n");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual(["*.log", "*.tmp", "*.pyc"]);
  });

  test("returns empty array for non-existent file", async () => {
    const patterns = await parseIgnoreFile(join(testDir, "nonexistent"));

    expect(patterns).toEqual([]);
  });

  test("returns empty array for empty file", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual([]);
  });

  test("returns empty array for file with only comments", async () => {
    const ignorePath = join(testDir, ".otusignore");
    await writeFile(ignorePath, "# comment 1\n# comment 2\n");

    const patterns = await parseIgnoreFile(ignorePath);

    expect(patterns).toEqual([]);
  });
});

// ============================================================================
// Unit Tests: Tar Exclude Behavior
// ============================================================================

describe("tar exclude behavior", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tar-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("excludes patterns from tar archive", async () => {
    // Create test files
    await writeFile(join(testDir, "README.md"), "# Test");
    await writeFile(join(testDir, "test.tmp"), "temp file");
    await mkdir(join(testDir, "node_modules"));
    await writeFile(join(testDir, "node_modules", "package.json"), "{}");

    const tarData = await createTarWithExcludes(testDir, ["*.tmp", "node_modules"]);
    const contents = await listTarContents(tarData);

    expect(contents.some((f) => f.includes("README.md"))).toBe(true);
    expect(contents.some((f) => f.includes("test.tmp"))).toBe(false);
    expect(contents.some((f) => f.includes("node_modules"))).toBe(false);
  });

  test("includes .otusignore file in archive", async () => {
    await writeFile(join(testDir, "README.md"), "# Test");
    await writeFile(join(testDir, ".otusignore"), "*.tmp\nnode_modules\n");
    await writeFile(join(testDir, "test.tmp"), "temp");

    const tarData = await createTarWithExcludes(testDir, ["*.tmp", "node_modules"]);
    const contents = await listTarContents(tarData);

    expect(contents.some((f) => f.includes(".otusignore"))).toBe(true);
    expect(contents.some((f) => f.includes("README.md"))).toBe(true);
    expect(contents.some((f) => f.includes("test.tmp"))).toBe(false);
  });

  test("without excludes, all files are included", async () => {
    await writeFile(join(testDir, "README.md"), "# Test");
    await writeFile(join(testDir, "test.tmp"), "temp");
    await mkdir(join(testDir, "node_modules"));
    await writeFile(join(testDir, "node_modules", "pkg.json"), "{}");
    await mkdir(join(testDir, ".git"));
    await writeFile(join(testDir, ".git", "config"), "git config");

    const tarData = await createTarWithExcludes(testDir, []);
    const contents = await listTarContents(tarData);

    expect(contents.some((f) => f.includes("README.md"))).toBe(true);
    expect(contents.some((f) => f.includes("test.tmp"))).toBe(true);
    expect(contents.some((f) => f.includes("node_modules"))).toBe(true);
    expect(contents.some((f) => f.includes(".git"))).toBe(true);
  });

  test("excludes Python files correctly", async () => {
    await writeFile(join(testDir, "main.py"), "print('hello')");
    await writeFile(join(testDir, "main.pyc"), "compiled");
    await mkdir(join(testDir, "__pycache__"));
    await writeFile(join(testDir, "__pycache__", "main.cpython.pyc"), "cached");

    const tarData = await createTarWithExcludes(testDir, ["*.pyc", "__pycache__"]);
    const contents = await listTarContents(tarData);

    expect(contents.some((f) => f.includes("main.py"))).toBe(true);
    expect(contents.some((f) => f.includes("main.pyc"))).toBe(false);
    expect(contents.some((f) => f.includes("__pycache__"))).toBe(false);
  });

  test("excludes nested directories", async () => {
    await mkdir(join(testDir, "src"));
    await writeFile(join(testDir, "src", "main.ts"), "code");
    await mkdir(join(testDir, "src", "node_modules"));
    await writeFile(join(testDir, "src", "node_modules", "dep.js"), "dep");

    const tarData = await createTarWithExcludes(testDir, ["node_modules"]);
    const contents = await listTarContents(tarData);

    expect(contents.some((f) => f.includes("src/main.ts"))).toBe(true);
    expect(contents.some((f) => f.includes("node_modules"))).toBe(false);
  });
});

// ============================================================================
// Integration Tests: VM Sync with .otusignore
// ============================================================================

describe("VM Sync Integration Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    console.log("Starting Firecracker VM for sync tests...");

    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      throw new Error("Firecracker binary not found");
    }

    vm = new FirecrackerVM({
      binaryPath,
      kernelPath: FIRECRACKER.KERNEL_PATH,
      rootfsPath: FIRECRACKER.ROOTFS_PATH,
      apiSocket: FIRECRACKER.API_SOCKET,
      vsockSocket: FIRECRACKER.VSOCK_SOCKET,
      guestCid: VSOCK.GUEST_CID,
      enableNetwork: false,
    });

    await vm.boot();
    console.log("VM booted, waiting for agent...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        console.log("Connected to VM agent");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect to VM");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("file created in VM syncs back to host", async () => {
    // Create a Python file directly in the VM
    await client.execute(`cat > /workspace/vm_created.py << 'EOF'
print("Hello from VM!")
x = 1 + 2
print(f"Result: {x}")
EOF`);

    // Verify file exists in VM
    const catResult = await client.execute("cat /workspace/vm_created.py");
    expect(catResult.stdout).toContain("Hello from VM!");

    // Sync from guest with no excludes
    const syncResult = await client.syncFromGuest("/workspace", []);
    expect(syncResult.size).toBeGreaterThan(0);

    // Extract and verify Python file is present
    const contents = await listTarContents(syncResult.tarData);
    expect(contents.some((f) => f.includes("vm_created.py"))).toBe(true);
  });

  test("excludes are applied during sync back", async () => {
    // Create files in VM including some that should be excluded
    await client.execute(`
      mkdir -p /workspace/node_modules
      echo '{}' > /workspace/node_modules/package.json
      echo 'print("keep me")' > /workspace/keep.py
      echo 'temp' > /workspace/test.tmp
      mkdir -p /workspace/.git
      echo 'config' > /workspace/.git/config
    `);

    // Verify files exist in VM
    const lsResult = await client.execute("ls -la /workspace/");
    expect(lsResult.stdout).toContain("keep.py");
    expect(lsResult.stdout).toContain("node_modules");

    // Sync from guest WITH excludes (simulating .otusignore patterns)
    const excludes = ["node_modules", ".git", "*.tmp"];
    const syncResult = await client.syncFromGuest("/workspace", excludes);

    // Verify excludes worked by checking tar contents
    const contents = await listTarContents(syncResult.tarData);

    // Should have keep.py
    expect(contents.some((f) => f.includes("keep.py"))).toBe(true);

    // Should NOT have excluded files
    expect(contents.some((f) => f.includes("node_modules"))).toBe(false);
    expect(contents.some((f) => f.includes(".git"))).toBe(false);
    expect(contents.some((f) => f.includes("test.tmp"))).toBe(false);
  });

  test("Python .py files sync when .pyc excluded", async () => {
    // Create Python source and compiled files
    await client.execute(`
      echo 'def main(): pass' > /workspace/source.py
      echo 'compiled bytecode' > /workspace/source.pyc
      mkdir -p /workspace/__pycache__
      echo 'cache' > /workspace/__pycache__/source.cpython.pyc
    `);

    // Sync with excludes that should NOT affect .py files
    const excludes = ["__pycache__", "*.pyc", "*.pyo"];
    const syncResult = await client.syncFromGuest("/workspace", excludes);
    const contents = await listTarContents(syncResult.tarData);

    // .py should be present
    expect(contents.some((f) => f.includes("source.py"))).toBe(true);

    // .pyc and __pycache__ should be excluded
    expect(contents.some((f) => f.includes("source.pyc"))).toBe(false);
    expect(contents.some((f) => f.includes("__pycache__"))).toBe(false);
  });

  test("empty excludes means all files sync", async () => {
    // Create files that would normally be excluded
    await client.execute(`
      mkdir -p /workspace/testall
      echo 'code' > /workspace/testall/app.py
      echo 'temp' > /workspace/testall/data.tmp
      mkdir -p /workspace/testall/.hidden
      echo 'secret' > /workspace/testall/.hidden/file
    `);

    // Sync with NO excludes
    const syncResult = await client.syncFromGuest("/workspace/testall", []);
    const contents = await listTarContents(syncResult.tarData);

    // Everything should be present
    expect(contents.some((f) => f.includes("app.py"))).toBe(true);
    expect(contents.some((f) => f.includes("data.tmp"))).toBe(true);
    expect(contents.some((f) => f.includes(".hidden"))).toBe(true);
  });

  test("sync many files works", async () => {
    // Create many files in VM
    await client.execute(`
      mkdir -p /workspace/manyfiles
      for i in $(seq 1 50); do
        echo "file $i content" > /workspace/manyfiles/file_$i.txt
      done
    `);

    const syncResult = await client.syncFromGuest("/workspace/manyfiles", []);
    const contents = await listTarContents(syncResult.tarData);

    // Check a sampling of files
    expect(contents.some((f) => f.includes("file_1.txt"))).toBe(true);
    expect(contents.some((f) => f.includes("file_25.txt"))).toBe(true);
    expect(contents.some((f) => f.includes("file_50.txt"))).toBe(true);
  });
});
