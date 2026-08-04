import { MemoryEntry } from "../types";

export class VectorStore {
  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase().trim();
    const vector = new Array<number>(8).fill(0);

    for (let index = 0; index < normalized.length; index += 1) {
      vector[index % vector.length] += normalized.charCodeAt(index);
    }

    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => Number((value / magnitude).toFixed(6)));
  }

  async similaritySearch(
    query: string,
    entries: MemoryEntry[],
    limit = 5
  ): Promise<MemoryEntry[]> {
    const queryEmbedding = await this.embed(query);

    return this.similaritySearchByEmbedding(queryEmbedding, entries, limit);
  }

  similaritySearchByEmbedding(
    queryEmbedding: number[],
    entries: MemoryEntry[],
    limit = 5
  ): MemoryEntry[] {

    const ranked = entries
      .map((entry) => ({
        entry,
        score: this.cosineSimilarity(queryEmbedding, entry.embedding)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.entry);

    return ranked;
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    if (left.length !== right.length || left.length === 0) {
      return 0;
    }

    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;

    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index];
      leftMagnitude += left[index] * left[index];
      rightMagnitude += right[index] * right[index];
    }

    const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude) || 1;
    return dot / denominator;
  }
}
