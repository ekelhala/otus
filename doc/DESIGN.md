Design Document: Otus

Project Persona: An autonomous, local-first system engineering agent.

Architecture: Host-side Intelligence (Daemon) + Sandboxed Execution (Firecracker VM).
1. Architectural Philosophy: The "Smart Host, Dumb Guest"

The system strictly decouples Reasoning from Execution.

    The Den (Host/Daemon): The "Brain." It holds the LLM context, API keys, long-term memory (Vector DB), and project files. It makes all decisions.

    The Cage (Guest/VM): The "Hands." A stateless, hardware-isolated Linux environment that only knows how to run shell commands and return their output.

2. Technical Stack

    Runtime: Bun (for high-performance TypeScript execution on both Host and Guest).

    Virtualization: Firecracker (KVM-based microVMs) for sub-second boot and snapshotting.

    Database: * SQLite: For episodic memory (task logs, reflections, system state).

        LanceDB: For semantic memory (vectorized project codebase).

    Communication: JSON-RPC over VSock (Virtual Socket).

    OS: Minimal Ubuntu rootfs (glibc support) created via debootstrap.

3. Core Components
3.1 The Otus Daemon (Host)

The Daemon acts as the central orchestrator.

    Workspace Manager: Detects .otus/ folders and initializes project-specific LanceDB indexes.

    Inference Engine: Manages the LLM ReAct loop. It formats prompts, injects RAG context from LanceDB, and decides when a task is finished.

    Snapshot Controller: Manages the Firecracker API. It handles "Reality Branching" by pausing VMs and creating Copy-on-Write (CoW) clones for parallel task testing.

    File Syncer: Manages a bidirectional sync between the host workspace and the VM block device.

3.2 The Guest Agent (Guest)

A tiny, zero-dependency Bun binary baked into the rootfs.

    Listener: Listens on a pre-defined VSock port (e.g., 9999).

    Executor: Receives execute_command requests. It spawns a shell, captures stdout/stderr in real-time, and streams it back to the host.

    Statelessness: The agent never stores logs; it pipes everything immediately to the host.

4. Memory & Context Strategy

Otus uses a Tiered Memory System to handle infinite-length projects without hitting context limits.

    Working Memory (LLM Context): The current plan, the last 3 command outputs, and the "Internal Monologue."

    Episodic Memory (SQLite): A searchable history of every command ever run in this project.

    Semantic Memory (LanceDB): A vectorized index of the codebase, updated automatically when host files change.

5. The Execution Loop (The "ReAct" Cycle)

    Observe: Daemon gathers the current state (last command output + relevant code snippets from LanceDB).

    Think: LLM analyzes the state and the goal. It writes an "Internal Monologue" entry.

    Act: LLM selects a tool (e.g., run_cmd("npm test")).

    Execute: Daemon sends the command to the Guest VM via VSock.

    Reflect: Daemon captures the output, updates SQLite, and starts the loop again.

6. Reality Branching (Speculative Execution)

To enable "One-Shot Demos" and safe experimentation:

    Spawn: On command, the Daemon snapshots the "Primary" VM.

    Branch: It boots N ephemeral VMs from that snapshot.

    Parallel Play: Each VM attempts a different solution or runs different tests.

    Reconcile: The Daemon evaluates the results. If a branch is successful, its changes are merged back to the host; the other VMs are instantly destroyed.

7. Security & Privacy

    Secret Isolation: API keys exist only in the Daemon's memory. The VM has zero access to environment variables containing secrets.

    Network Guardrails: The VM has no network interface by default. All "Internet" requests (like fetching a library) are proxied and logged by the Daemon.

    Hardware Isolation: Even a "jailbreak" of the Guest Agent is contained within the KVM sandbox.

8. CLI Interface

    otus init: Set up the .otus Den in the current folder.

    otus do "<task>": Begin the autonomous loop.

    otus branch "<name>": Create a new ephemeral sandbox for experimentation.

    otus status: Show active Otus "Colony" members and resource usage.