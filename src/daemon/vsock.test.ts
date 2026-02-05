/**
 * VSock VM Integration Tests
 * 
 * These tests start a Firecracker VM and test the vsock connection.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { GuestAgentClient } from "./vsock.ts";
import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { FIRECRACKER, VSOCK } from "@shared/constants.ts";

describe("VM Integration Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    console.log("Starting Firecracker VM...");
    
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      throw new Error("Firecracker binary not found. Please install firecracker.");
    }
    console.log(`Using firecracker binary: ${binaryPath}`);
    
    vm = new FirecrackerVM({
      binaryPath,
      kernelPath: FIRECRACKER.KERNEL_PATH,
      rootfsPath: FIRECRACKER.ROOTFS_PATH,
      apiSocket: FIRECRACKER.API_SOCKET,
      vsockSocket: FIRECRACKER.VSOCK_SOCKET,
      guestCid: VSOCK.GUEST_CID,
      vcpuCount: 2,
      memSizeMib: 512,
      enableNetwork: false, // Disable network for simpler test setup
    });

    await vm.boot();
    console.log("VM booted, waiting for agent to start...");
    
    // Wait for VM to initialize
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Connect to agent with retries
    client = new GuestAgentClient();
    
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        console.log("Connected to VM agent");
        return;
      } catch (e) {
        console.log(`Connection attempt ${i + 1}/10 failed, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error("Failed to connect to VM agent after 10 attempts");
  }, 60000); // 60 second timeout for VM boot

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
        console.log("Disconnected from VM agent");
      } catch {}
    }
    
    if (vm) {
      try {
        await vm.destroy();
        console.log("VM destroyed");
      } catch {}
    }
  });

  test("health check returns valid response", async () => {
    const health = await client.health();
    
    console.log("Health response:", health);
    
    expect(health.status).toBeDefined();
    expect(health.hostname).toBeDefined();
    expect(health.uptime).toBeGreaterThan(0);
  });

  test("execute simple echo command", async () => {
    const result = await client.execute("echo 'Hello from VM'");
    
    console.log("Execute result:", result);
    
    expect(result.stdout).toContain("Hello from VM");
    expect(result.exitCode).toBe(0);
  });

  test("execute command with stderr output", async () => {
    const result = await client.execute("echo 'error message' >&2");
    
    console.log("Stderr result:", result);
    
    expect(result.stderr).toContain("error message");
    expect(result.exitCode).toBe(0);
  });

  test("execute command with non-zero exit code", async () => {
    const result = await client.execute("exit 42");
    
    console.log("Exit code result:", result);
    
    expect(result.exitCode).toBe(42);
  });

  test("execute command with both stdout and stderr", async () => {
    const result = await client.execute("echo 'stdout'; echo 'stderr' >&2");
    
    console.log("Combined result:", result);
    
    expect(result.stdout).toContain("stdout");
    expect(result.stderr).toContain("stderr");
    expect(result.exitCode).toBe(0);
  });

  test("execute multiple sequential commands", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await client.execute(`echo "Request ${i}"`);
      expect(result.stdout).toContain(`Request ${i}`);
      expect(result.exitCode).toBe(0);
    }
    console.log("Sequential commands completed successfully");
  });

  test("execute command that lists files", async () => {
    const result = await client.execute("ls -la /");
    
    console.log("ls result:", result.stdout.substring(0, 200) + "...");
    
    expect(result.stdout).toBeTruthy();
    expect(result.exitCode).toBe(0);
  });

  test("execute command that checks environment", async () => {
    const result = await client.execute("uname -a && whoami && pwd");
    
    console.log("Environment result:", result);
    
    expect(result.stdout).toBeTruthy();
    expect(result.exitCode).toBe(0);
  });

  test("execute python command", async () => {
    const result = await client.execute("python3 -c 'print(2 + 2)'");
    
    console.log("Python result:", result);
    
    // May fail if python3 not installed in VM
    if (result.exitCode === 0) {
      expect(result.stdout.trim()).toBe("4");
    }
  });

  test("measure execution duration", async () => {
    const result = await client.execute("sleep 0.5 && echo done");
    
    console.log("Duration result:", result);
    
    expect(result.durationMs).toBeGreaterThan(400);
    expect(result.stdout).toContain("done");
  });
});

describe("VM File System Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("create and read a file", async () => {
    const content = "Hello, this is a test file!";
    
    // Create file
    const write = await client.execute(`echo '${content}' > /tmp/testfile.txt`);
    expect(write.exitCode).toBe(0);
    
    // Read file
    const read = await client.execute("cat /tmp/testfile.txt");
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe(content);
  });

  test("create nested directories", async () => {
    const result = await client.execute("mkdir -p /tmp/a/b/c/d && ls -la /tmp/a/b/c/");
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("d");
  });

  test("write and append to file", async () => {
    await client.execute("echo 'line1' > /tmp/append.txt");
    await client.execute("echo 'line2' >> /tmp/append.txt");
    await client.execute("echo 'line3' >> /tmp/append.txt");
    
    const result = await client.execute("cat /tmp/append.txt");
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).toContain("line3");
  });

  test("copy and move files", async () => {
    await client.execute("echo 'original' > /tmp/original.txt");
    await client.execute("cp /tmp/original.txt /tmp/copy.txt");
    await client.execute("mv /tmp/copy.txt /tmp/moved.txt");
    
    const result = await client.execute("cat /tmp/moved.txt");
    expect(result.stdout.trim()).toBe("original");
    
    const noOriginal = await client.execute("test -f /tmp/copy.txt && echo exists || echo gone");
    expect(noOriginal.stdout.trim()).toBe("gone");
  });

  test("delete files and directories", async () => {
    await client.execute("mkdir -p /tmp/todelete && touch /tmp/todelete/file.txt");
    
    const rm = await client.execute("rm -rf /tmp/todelete && echo deleted");
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.trim()).toBe("deleted");
    
    const check = await client.execute("test -d /tmp/todelete && echo exists || echo gone");
    expect(check.stdout.trim()).toBe("gone");
  });

  test("file permissions", async () => {
    await client.execute("echo '#!/bin/bash\\necho hello' > /tmp/script.sh");
    await client.execute("chmod +x /tmp/script.sh");
    
    const result = await client.execute("/tmp/script.sh");
    expect(result.stdout.trim()).toBe("hello");
  });

  test("symbolic links", async () => {
    await client.execute("echo 'target content' > /tmp/target.txt");
    await client.execute("ln -sf /tmp/target.txt /tmp/link.txt");
    
    const result = await client.execute("cat /tmp/link.txt");
    expect(result.stdout.trim()).toBe("target content");
  });

  test("find files", async () => {
    await client.execute("mkdir -p /tmp/findtest && touch /tmp/findtest/a.txt /tmp/findtest/b.log");
    
    const result = await client.execute("find /tmp/findtest -name '*.txt'");
    expect(result.stdout).toContain("a.txt");
    expect(result.stdout).not.toContain("b.log");
  });

  test("disk usage", async () => {
    const df = await client.execute("df -h /");
    expect(df.exitCode).toBe(0);
    expect(df.stdout).toContain("Filesystem");
    
    const du = await client.execute("du -sh /tmp");
    expect(du.exitCode).toBe(0);
  });
});

describe("VM Package Management Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("check installed packages with dpkg", async () => {
    const result = await client.execute("dpkg -l | head -20");
    console.log("Installed packages:", result.stdout.substring(0, 500));
    
    // Should have something installed
    expect(result.exitCode).toBe(0);
  });

  test("pip list installed packages", async () => {
    const result = await client.execute("pip3 list 2>/dev/null || pip list 2>/dev/null || echo 'pip not available'");
    console.log("Python packages:", result.stdout.substring(0, 500));
    
    expect(result.exitCode).toBe(0);
  });

  test("pip install a package (offline - may fail)", async () => {
    // This test demonstrates pip install - it may fail without network
    const result = await client.execute("pip3 install --user cowsay 2>&1 || echo 'Install failed (expected without network)'");
    console.log("Pip install result:", result.stdout);
    
    // Just verify the command runs
    expect(result.exitCode).toBeDefined();
  });

  test("check node and npm versions", async () => {
    const node = await client.execute("node --version 2>/dev/null || echo 'node not installed'");
    const npm = await client.execute("npm --version 2>/dev/null || echo 'npm not installed'");
    
    console.log("Node version:", node.stdout.trim());
    console.log("NPM version:", npm.stdout.trim());
    
    expect(node.exitCode).toBe(0);
  });

  test("check available system tools", async () => {
    const tools = ["gcc", "make", "git", "curl", "wget", "vim", "nano"];
    
    for (const tool of tools) {
      const result = await client.execute(`which ${tool} 2>/dev/null || echo '${tool} not found'`);
      console.log(`${tool}: ${result.stdout.trim()}`);
    }
  });
});

describe("VM Process and Environment Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("environment variables", async () => {
    const result = await client.execute("export MY_VAR='test123' && echo $MY_VAR");
    expect(result.stdout.trim()).toBe("test123");
  });

  test("PATH environment", async () => {
    const result = await client.execute("echo $PATH");
    expect(result.stdout).toContain("/usr/bin");
  });

  test("process list", async () => {
    const result = await client.execute("ps aux");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
    console.log("Processes:", result.stdout.substring(0, 500));
  });

  test("memory info", async () => {
    const result = await client.execute("free -m");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mem:");
    console.log("Memory info:", result.stdout);
  });

  test("CPU info", async () => {
    const result = await client.execute("cat /proc/cpuinfo | head -30");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("processor");
  });

  test("working directory operations", async () => {
    const result = await client.execute("cd /tmp && pwd && cd / && pwd");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toContain("/tmp");
    expect(lines).toContain("/");
  });

  test("background process and wait", async () => {
    const result = await client.execute("sleep 0.1 & PID=$!; wait $PID; echo 'done'");
    expect(result.stdout.trim()).toBe("done");
  });

  test("pipe commands", async () => {
    const result = await client.execute("printf 'banana\\napple\\ncherry\\n' | sort");
    expect(result.stdout.trim()).toBe("apple\nbanana\ncherry");
  });

  test("command substitution", async () => {
    const result = await client.execute("echo \"Today is $(date +%A)\"");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Today is");
  });

  test("heredoc", async () => {
    const result = await client.execute(`cat << EOF
line1
line2
line3
EOF`);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).toContain("line3");
  });
});

describe("VM Python Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("python arithmetic", async () => {
    const result = await client.execute("python3 -c 'print(10 * 5 + 3)'");
    expect(result.stdout.trim()).toBe("53");
  });

  test("python string operations", async () => {
    const result = await client.execute(`python3 -c "print('hello world'.upper())"`);
    expect(result.stdout.trim()).toBe("HELLO WORLD");
  });

  test("python list operations", async () => {
    const result = await client.execute(`python3 -c "print(sorted([3, 1, 4, 1, 5, 9, 2, 6]))"`);
    expect(result.stdout.trim()).toBe("[1, 1, 2, 3, 4, 5, 6, 9]");
  });

  test("python file I/O", async () => {
    // Write python script to file and execute
    await client.execute(`cat > /tmp/fileio.py << 'PYEOF'
import json
data = {'name': 'test', 'value': 42}
with open('/tmp/test.json', 'w') as f:
    json.dump(data, f)
with open('/tmp/test.json', 'r') as f:
    loaded = json.load(f)
print(loaded['name'], loaded['value'])
PYEOF`);
    const result = await client.execute("python3 /tmp/fileio.py");
    expect(result.stdout.trim()).toBe("test 42");
  });

  test("python script from file", async () => {
    await client.execute(`cat > /tmp/script.py << 'EOF'
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print(fibonacci(10))
EOF`);
    
    const result = await client.execute("python3 /tmp/script.py");
    expect(result.stdout.trim()).toBe("55");
  });

  test("python import standard library", async () => {
    const result = await client.execute(`python3 -c "
import os
import sys
import json
import re
print('imports ok')
"`);
    expect(result.stdout.trim()).toBe("imports ok");
  });

  test("python exception handling", async () => {
    const result = await client.execute(`python3 -c "
try:
    x = 1 / 0
except ZeroDivisionError as e:
    print('caught:', type(e).__name__)
"`);
    expect(result.stdout.trim()).toBe("caught: ZeroDivisionError");
  });
});

describe("VM Node.js Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("node arithmetic", async () => {
    const result = await client.execute("node -e 'console.log(10 * 5 + 3)'");
    expect(result.stdout.trim()).toBe("53");
  });

  test("node string operations", async () => {
    const result = await client.execute(`node -e "console.log('hello world'.toUpperCase())"`);
    expect(result.stdout.trim()).toBe("HELLO WORLD");
  });

  test("node array operations", async () => {
    const result = await client.execute(`node -e "console.log([3,1,4,1,5,9,2,6].sort((a,b)=>a-b))"`);
    expect(result.stdout.trim()).toContain("1,1,2,3,4,5,6,9");
  });

  test("node file I/O", async () => {
    const code = `
const fs = require('fs');
const data = {name: 'test', value: 42};
fs.writeFileSync('/tmp/test-node.json', JSON.stringify(data));
const loaded = JSON.parse(fs.readFileSync('/tmp/test-node.json'));
console.log(loaded.name, loaded.value);
`;
    const result = await client.execute(`node -e "${code.replace(/"/g, '\\"').replace(/\n/g, '')}"`);
    expect(result.stdout.trim()).toBe("test 42");
  });

  test("node script from file", async () => {
    await client.execute(`cat > /tmp/script.js << 'EOF'
function fibonacci(n) {
  let a = 0, b = 1;
  for (let i = 0; i < n; i++) {
    [a, b] = [b, a + b];
  }
  return a;
}
console.log(fibonacci(10));
EOF`);
    
    const result = await client.execute("node /tmp/script.js");
    expect(result.stdout.trim()).toBe("55");
  });

  test("node async/await", async () => {
    const result = await client.execute(`node -e "
(async () => {
  const result = await Promise.resolve(42);
  console.log('result:', result);
})();
"`);
    expect(result.stdout.trim()).toBe("result: 42");
  });

  test("node require built-in modules", async () => {
    const result = await client.execute(`node -e "
const os = require('os');
const path = require('path');
const fs = require('fs');
console.log('imports ok');
"`);
    expect(result.stdout.trim()).toBe("imports ok");
  });
});

describe("VM Stress Tests", () => {
  let client: GuestAgentClient;
  let vm: FirecrackerVM;

  beforeAll(async () => {
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) throw new Error("Firecracker not found");
    
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
    await new Promise((resolve) => setTimeout(resolve, 5000));

    client = new GuestAgentClient();
    for (let i = 0; i < 10; i++) {
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new Error("Failed to connect");
  }, 60000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await vm?.destroy().catch(() => {});
  });

  test("rapid sequential commands", async () => {
    const start = Date.now();
    const count = 20;
    
    for (let i = 0; i < count; i++) {
      const result = await client.execute(`echo ${i}`);
      expect(result.exitCode).toBe(0);
    }
    
    const elapsed = Date.now() - start;
    console.log(`Executed ${count} commands in ${elapsed}ms (${(elapsed/count).toFixed(1)}ms avg)`);
  });

  test("large output handling", async () => {
    const result = await client.execute("seq 1 1000");
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(1000);
    expect(lines[0]).toBe("1");
    expect(lines[999]).toBe("1000");
  });

  test("large input handling", async () => {
    const largeString = "x".repeat(10000);
    const result = await client.execute(`echo '${largeString}' | wc -c`);
    // wc -c counts bytes including newline
    expect(parseInt(result.stdout.trim())).toBeGreaterThanOrEqual(10000);
  });

  test("cpu intensive task", async () => {
    const result = await client.execute(`python3 -c "
import time
start = time.time()
total = sum(i*i for i in range(100000))
elapsed = time.time() - start
print(f'sum={total}, time={elapsed:.3f}s')
"`);
    console.log("CPU test:", result.stdout.trim());
    expect(result.exitCode).toBe(0);
  });

  test("memory allocation", async () => {
    const result = await client.execute(`python3 -c "
data = [0] * (10 * 1024 * 1024)  # 10M integers
print(f'allocated {len(data)} items')
"`);
    expect(result.stdout).toContain("allocated");
    expect(result.exitCode).toBe(0);
  });
});
