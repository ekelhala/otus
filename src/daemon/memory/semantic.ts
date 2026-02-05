/**
 * LanceDB Semantic Memory
 * Vectorized codebase index for semantic search
 */

import * as lancedb from "@lancedb/lancedb";
import { join } from "path";
import { watch, type FSWatcher } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { WORKSPACE, EMBEDDINGS } from "@shared/constants.ts";
import { VoyageClient } from "../embeddings.ts";

export interface CodeChunk extends Record<string, unknown> {
  id: string;
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  vector: number[];
}

export interface SearchResult {
  filepath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
}

/**
 * Semantic Memory Manager using LanceDB
 */
export class SemanticMemory {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly dbPath: string;
  private readonly workspacePath: string;
  private readonly voyageClient: VoyageClient;
  private watcher: FSWatcher | null = null;

  // Files and directories to exclude
  private readonly excludePatterns = [
    /node_modules/,
    /\.git/,
    /\.otus/,
    /dist/,
    /build/,
    /\.next/,
    /\.vscode/,
    /\.idea/,
    /\.DS_Store/,
    /\.log$/,
    /\.lock$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /bun\.lockb$/,
  ];

  // File extensions to index
  private readonly includeExtensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".sh",
    ".bash",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
  ];

  constructor(workspacePath: string, voyageClient: VoyageClient) {
    this.workspacePath = workspacePath;
    this.dbPath = join(workspacePath, WORKSPACE.OTUS_DIR, WORKSPACE.LANCEDB_DIR);
    this.voyageClient = voyageClient;
  }

  /**
   * Initialize the database and create table
   */
  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);

    try {
      // Try to open existing table
      this.table = await this.db.openTable("codebase");
      console.log("[SemanticMemory] Opened existing codebase index");
    } catch {
      // Create new table
      const schema = {
        id: "",
        filepath: "",
        content: "",
        startLine: 0,
        endLine: 0,
        vector: new Array(EMBEDDINGS.DIMENSIONS).fill(0),
      };

      this.table = await this.db.createTable("codebase", [schema]);
      console.log("[SemanticMemory] Created new codebase index");
    }
  }

  /**
   * Index all files in the workspace
   */
  async indexWorkspace(): Promise<void> {
    console.log("[SemanticMemory] Indexing workspace...");
    const files = await this.findIndexableFiles(this.workspacePath);
    
    console.log(`[SemanticMemory] Found ${files.length} files to index`);

    // Process files in batches
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((file) => this.indexFile(file)));
      console.log(`[SemanticMemory] Indexed ${Math.min(i + batchSize, files.length)}/${files.length} files`);
    }

    console.log("[SemanticMemory] Indexing complete");
  }

  /**
   * Index a single file
   */
  async indexFile(filepath: string): Promise<void> {
    try {
      const content = await readFile(filepath, "utf-8");
      const relativePath = filepath.replace(this.workspacePath + "/", "");

      // Chunk the file
      const chunks = this.chunkCode(content);

      // Generate embeddings for all chunks
      const texts = chunks.map((chunk) => chunk.content);
      const embeddings = await this.voyageClient.embed(texts, "document");

      // Create records
      const records: CodeChunk[] = chunks.map((chunk, i) => ({
        id: `${relativePath}:${chunk.startLine}-${chunk.endLine}`,
        filepath: relativePath,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector: embeddings[i]!,
      }));

      // Remove old entries for this file
      if (this.table) {
        try {
          await this.table.delete(`filepath = "${relativePath}"`);
        } catch {
          // Ignore if no entries exist
        }

        // Add new records
        await this.table.add(records);
      }
    } catch (error) {
      console.error(`[SemanticMemory] Failed to index ${filepath}:`, error);
    }
  }

  /**
   * Search the codebase semantically
   */
  async search(query: string, k = 10): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error("SemanticMemory not initialized");
    }

    // Generate query embedding
    const queryEmbedding = await this.voyageClient.embedOne(query, "query");

    // Search
    const results = await this.table
      .vectorSearch(queryEmbedding)
      .limit(k)
      .toArray();

    return results.map((result: any) => ({
      filepath: result.filepath,
      content: result.content,
      startLine: result.startLine,
      endLine: result.endLine,
      score: result._distance || 0,
    }));
  }

  /**
   * Watch workspace for file changes
   */
  startWatching(): void {
    if (this.watcher) {
      return; // Already watching
    }

    console.log("[SemanticMemory] Starting file watcher");

    this.watcher = watch(
      this.workspacePath,
      { recursive: true },
      async (eventType, filename) => {
        if (!filename) return;

        const filepath = join(this.workspacePath, filename);

        // Check if file should be indexed
        if (!this.shouldIndex(filepath)) {
          return;
        }

        if (eventType === "change" || eventType === "rename") {
          try {
            const exists = await stat(filepath).then(() => true).catch(() => false);
            if (exists) {
              console.log(`[SemanticMemory] Reindexing ${filename}`);
              await this.indexFile(filepath);
            } else {
              console.log(`[SemanticMemory] Removing deleted file ${filename}`);
              const relativePath = filename;
              if (this.table) {
                await this.table.delete(`filepath = "${relativePath}"`);
              }
            }
          } catch (error) {
            console.error(`[SemanticMemory] Error handling file change:`, error);
          }
        }
      }
    );
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log("[SemanticMemory] Stopped file watcher");
    }
  }

  /**
   * Find all indexable files in a directory
   */
  private async findIndexableFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentDir: string) {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files.filter((file) => this.shouldIndex(file));
  }

  /**
   * Check if a file should be indexed
   */
  private shouldIndex(filepath: string): boolean {
    // Check exclusion patterns
    for (const pattern of this.excludePatterns) {
      if (pattern.test(filepath)) {
        return false;
      }
    }

    // Check file extension
    return this.includeExtensions.some((ext) => filepath.endsWith(ext));
  }

  /**
   * Chunk code into smaller segments
   */
  private chunkCode(
    content: string
  ): Array<{ content: string; startLine: number; endLine: number }> {
    const lines = content.split("\n");
    const chunks: Array<{ content: string; startLine: number; endLine: number }> = [];

    // Simple chunking by approximate token count (1 token ≈ 4 characters)
    const approxChunkChars = EMBEDDINGS.CHUNK_SIZE * 4;
    let currentChunk: string[] = [];
    let currentStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
      currentChunk.push(lines[i]!);

      const chunkSize = currentChunk.join("\n").length;
      
      if (chunkSize >= approxChunkChars || i === lines.length - 1) {
        if (currentChunk.length > 0) {
          chunks.push({
            content: currentChunk.join("\n"),
            startLine: currentStartLine,
            endLine: i + 1,
          });
          currentChunk = [];
          currentStartLine = i + 2;
        }
      }
    }

    // Handle remaining lines
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join("\n"),
        startLine: currentStartLine,
        endLine: lines.length,
      });
    }

    return chunks;
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    this.stopWatching();
    // LanceDB connections don't need explicit closing
  }
}
