/**
 * .otusignore Tests
 * 
 * Unit tests for ignore file parsing and integration tests for workspace sync
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { existsSync } from "fs";
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
  let testWorkspace: string;

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
        break;
      } catch {
        if (i === 9) throw new Error("Failed to connect to VM");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Create test workspace directory
    testWorkspace = join(tmpdir(), `otusignore-integration-${Date.now()}`);
    await mkdir(testWorkspace, { recursive: true });
  }, 90000);

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
    if (vm) {
      try {
        await vm.destroy();
      } catch {}
    }
    if (testWorkspace) {
      await rm(testWorkspace, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Clean workspace between tests
    const files = await readdir(testWorkspace);
    for (const file of files) {
      await rm(join(testWorkspace, file), { recursive: true, force: true });
    }
    // Clean guest workspace
    await client.execute("rm -rf /workspace/* /workspace/.*");
  });

  test("sync files to guest and back without .otusignore", async () => {
    // Create test files on host
    await writeFile(join(testWorkspace, "hello.py"), "print('hello')");
    await writeFile(join(testWorkspace, "data.txt"), "test data");

    // Create tar and sync to guest
    const tarData = await createTarWithExcludes(testWorkspace, []);
    const syncResult = await client.syncToGuest(tarData, "/workspace");
    expect(syncResult.success).toBe(true);

    // Verify files exist in guest
    const lsResult = await client.execute("ls -la /workspace/");
    console.log("Guest workspace:", lsResult.stdout);
    expect(lsResult.stdout).toContain("hello.py");
    expect(lsResult.stdout).toContain("data.txt");

    // Sync back from guest (no excludes = everything)
    const syncBack = await client.syncFromGuest("/workspace", []);
    expect(syncBack.size).toBeGreaterThan(0);

    // Extract and verify
    const extractDir = join(testWorkspace, "extracted");
    await mkdir(extractDir);
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncBack.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    expect(existsSync(join(extractDir, "hello.py"))).toBe(true);
    expect(existsSync(join(extractDir, "data.txt"))).toBe(true);
  }, 30000);

  test("file created in VM syncs back to host", async () => {
    // Create a Python file directly in the VM
    const pythonCode = `print("Hello from VM!")
x = 1 + 2
print(f"Result: {x}")
`;
    await client.execute(`cat > /workspace/vm_created.py << 'PYEOF'
${pythonCode}
PYEOF`);

    // Verify file exists in VM
    const catResult = await client.execute("cat /workspace/vm_created.py");
    expect(catResult.stdout).toContain("Hello from VM!");

    // Sync from guest with no excludes
    const syncResult = await client.syncFromGuest("/workspace", []);
    expect(syncResult.size).toBeGreaterThan(0);

    // Extract and verify Python file is present
    const extractDir = join(testWorkspace, "from-vm");
    await mkdir(extractDir, { recursive: true });
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncResult.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    expect(existsSync(join(extractDir, "vm_created.py"))).toBe(true);
    const content = await readFile(join(extractDir, "vm_created.py"), "utf-8");
    expect(content).toContain("Hello from VM!");
  }, 30000);

  test(".otusignore excludes files from sync back", async () => {
    // Create files in VM including some that should be excluded
    await client.execute(`
      mkdir -p /workspace/node_modules
      echo '{}' > /workspace/node_modules/package.json
      echo 'print("keep me")' > /workspace/keep.py
      echo 'temp' > /workspace/test.tmp
      echo 'log data' > /workspace/app.log
      mkdir -p /workspace/.git
      echo 'config' > /workspace/.git/config
    `);

    // Verify all files exist in VM
    const lsResult = await client.execute("find /workspace -type f");
    console.log("Files in VM:", lsResult.stdout);
    expect(lsResult.stdout).toContain("keep.py");
    expect(lsResult.stdout).toContain("package.json");
    expect(lsResult.stdout).toContain("test.tmp");

    // Sync from guest WITH excludes (simulating .otusignore patterns)
    const excludes = ["node_modules", ".git", "*.tmp", "*.log"];
    const syncResult = await client.syncFromGuest("/workspace", excludes);

    // Extract and verify excludes worked
    const extractDir = join(testWorkspace, "filtered");
    await mkdir(extractDir, { recursive: true });
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncResult.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    // Should have keep.py
    expect(existsSync(join(extractDir, "keep.py"))).toBe(true);
    const content = await readFile(join(extractDir, "keep.py"), "utf-8");
    expect(content).toContain("keep me");

    // Should NOT have excluded files
    expect(existsSync(join(extractDir, "node_modules"))).toBe(false);
    expect(existsSync(join(extractDir, ".git"))).toBe(false);
    expect(existsSync(join(extractDir, "test.tmp"))).toBe(false);
    expect(existsSync(join(extractDir, "app.log"))).toBe(false);
  }, 30000);

  test("Python files sync correctly when not excluded", async () => {
    // This specifically tests the reported issue where .py files weren't syncing
    
    // Create Python files in VM
    await client.execute(`
      echo 'def main():' > /workspace/main.py
      echo '    print("hello")' >> /workspace/main.py
      echo 'import os' > /workspace/utils.py
      mkdir -p /workspace/src
      echo 'class Foo: pass' > /workspace/src/models.py
    `);

    // Sync with excludes that should NOT affect .py files
    const excludes = ["__pycache__", "*.pyc", "*.pyo", ".pytest_cache"];
    const syncResult = await client.syncFromGuest("/workspace", excludes);

    // Extract
    const extractDir = join(testWorkspace, "python-test");
    await mkdir(extractDir, { recursive: true });
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncResult.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    // All .py files should be present
    expect(existsSync(join(extractDir, "main.py"))).toBe(true);
    expect(existsSync(join(extractDir, "utils.py"))).toBe(true);
    expect(existsSync(join(extractDir, "src", "models.py"))).toBe(true);

    // Verify content
    const mainContent = await readFile(join(extractDir, "main.py"), "utf-8");
    expect(mainContent).toContain("def main():");
  }, 30000);

  test(".otusignore itself is always included in sync", async () => {
    // Create .otusignore and other files in VM
    await client.execute(`
      echo 'node_modules' > /workspace/.otusignore
      echo '.git' >> /workspace/.otusignore
      echo '*.tmp' >> /workspace/.otusignore
      echo 'test file' > /workspace/test.txt
      echo 'temp' > /workspace/file.tmp
    `);

    // Sync with the patterns from .otusignore
    const excludes = ["node_modules", ".git", "*.tmp"];
    const syncResult = await client.syncFromGuest("/workspace", excludes);

    // Extract
    const extractDir = join(testWorkspace, "otusignore-sync");
    await mkdir(extractDir, { recursive: true });
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncResult.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    // .otusignore should be present (it's not in the excludes list)
    expect(existsSync(join(extractDir, ".otusignore"))).toBe(true);
    expect(existsSync(join(extractDir, "test.txt"))).toBe(true);
    
    // .tmp file should be excluded
    expect(existsSync(join(extractDir, "file.tmp"))).toBe(false);
  }, 30000);

  test("empty workspace syncs correctly", async () => {
    // Ensure workspace is empty
    await client.execute("rm -rf /workspace/* /workspace/.*");

    const syncResult = await client.syncFromGuest("/workspace", []);

    // Should return valid (possibly empty) tar
    expect(syncResult).toBeDefined();
    // Size might be small but should be valid tar header at minimum
  }, 30000);

  test("large number of files syncs correctly", async () => {
    // Create many files in VM
    await client.execute(`
      for i in $(seq 1 50); do
        echo "file $i content" > /workspace/file_$i.txt
      done
      mkdir -p /workspace/subdir
      for i in $(seq 1 50); do
        echo "subfile $i" > /workspace/subdir/sub_$i.txt
      done
    `);

    const syncResult = await client.syncFromGuest("/workspace", []);

    // Extract
    const extractDir = join(testWorkspace, "many-files");
    await mkdir(extractDir, { recursive: true });
    const tarFile = join(extractDir, "sync.tar.gz");
    await writeFile(tarFile, syncResult.tarData);
    await $`tar -xzf ${tarFile} -C ${extractDir}`.quiet();

    // Check a sampling of files
    expect(existsSync(join(extractDir, "file_1.txt"))).toBe(true);
    expect(existsSync(join(extractDir, "file_50.txt"))).toBe(true);
    expect(existsSync(join(extractDir, "subdir", "sub_1.txt"))).toBe(true);
    expect(existsSync(join(extractDir, "subdir", "sub_50.txt"))).toBe(true);
  }, 60000);
});
