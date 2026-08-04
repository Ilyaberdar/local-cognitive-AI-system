export interface SemanticCoordinate {
  x: number;
  y: number;
}

/**
 * A deterministic, versioned projection for routing embeddings into sparse 2D cells.
 * The full embedding remains the source of truth for local similarity ranking.
 */
export class SemanticProjector {
  private static readonly projectionVersion = "v1";

  project(embedding: number[]): SemanticCoordinate {
    if (embedding.length === 0) {
      return { x: 0, y: 0 };
    }

    let x = 0;
    let y = 0;

    for (let index = 0; index < embedding.length; index += 1) {
      const value = embedding[index] ?? 0;
      const frequency = index + 1;
      x += value * Math.sin(frequency * 12.9898 + 0.37);
      y += value * Math.cos(frequency * 78.233 + 1.91);
    }

    return {
      x: Math.tanh(x),
      y: Math.tanh(y)
    };
  }

  get version(): string {
    return SemanticProjector.projectionVersion;
  }
}
