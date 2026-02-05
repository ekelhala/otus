/**
 * Voyage AI Embeddings Client
 * Generates code embeddings using voyage-code-3 model
 */

import { EMBEDDINGS } from "@shared/constants.ts";

export interface EmbeddingRequest {
  input: string | string[];
  model: string;
  input_type?: "query" | "document";
}

export interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

/**
 * Voyage AI client for generating embeddings
 */
export class VoyageClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.voyageai.com/v1";
  private readonly cache = new Map<string, number[]>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generate embeddings for one or more texts
   */
  async embed(
    texts: string | string[],
    inputType: "query" | "document" = "document"
  ): Promise<number[][]> {
    const inputs = Array.isArray(texts) ? texts : [texts];
    
    // Check cache first
    const uncachedIndices: number[] = [];
    const results: number[][] = new Array(inputs.length);

    for (let i = 0; i < inputs.length; i++) {
      const cached = this.cache.get(this.getCacheKey(inputs[i]!, inputType));
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
      }
    }

    // If all cached, return immediately
    if (uncachedIndices.length === 0) {
      return results;
    }

    // Batch uncached texts
    const uncachedTexts = uncachedIndices.map((i) => inputs[i]!);
    
    // Split into batches if needed
    const batches = this.createBatches(uncachedTexts, EMBEDDINGS.BATCH_SIZE);
    const embeddings: number[][] = [];

    for (const batch of batches) {
      const batchEmbeddings = await this.embedBatch(batch, inputType);
      embeddings.push(...batchEmbeddings);
    }

    // Update cache and results
    for (let i = 0; i < uncachedIndices.length; i++) {
      const originalIndex = uncachedIndices[i]!;
      const embedding = embeddings[i]!;
      results[originalIndex] = embedding;
      this.cache.set(this.getCacheKey(inputs[originalIndex]!, inputType), embedding);
    }

    return results;
  }

  /**
   * Generate embedding for a single text (convenience method)
   */
  async embedOne(text: string, inputType: "query" | "document" = "document"): Promise<number[]> {
    const results = await this.embed([text], inputType);
    return results[0]!;
  }

  /**
   * Embed a batch of texts
   */
  private async embedBatch(
    texts: string[],
    inputType: "query" | "document"
  ): Promise<number[][]> {
    const request: EmbeddingRequest = {
      input: texts,
      model: EMBEDDINGS.MODEL,
      input_type: inputType,
    };

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Voyage API error: ${error}`);
      }

      const data = (await response.json()) as EmbeddingResponse;
      
      // Sort by index to ensure correct order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } catch (error) {
      throw new Error(
        `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Split texts into batches
   */
  private createBatches(texts: string[], batchSize: number): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Generate cache key
   */
  private getCacheKey(text: string, inputType: string): string {
    // Simple hash for caching (could use a proper hash function)
    return `${inputType}:${text.slice(0, 100)}:${text.length}`;
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}
