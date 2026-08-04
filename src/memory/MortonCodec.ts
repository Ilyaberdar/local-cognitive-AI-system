const MAX_GRID_BITS = 16;

export class MortonCodec {
  static encode(x: number, y: number): string {
    const normalizedX = this.normalizeCoordinate(x);
    const normalizedY = this.normalizeCoordinate(y);
    let code = 0n;

    for (let bit = 0; bit < MAX_GRID_BITS; bit += 1) {
      code |= BigInt((normalizedX >> bit) & 1) << BigInt(bit * 2);
      code |= BigInt((normalizedY >> bit) & 1) << BigInt(bit * 2 + 1);
    }

    return code.toString(36);
  }

  private static normalizeCoordinate(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** MAX_GRID_BITS) {
      throw new Error(`Morton coordinate must be an integer between 0 and ${2 ** MAX_GRID_BITS - 1}.`);
    }

    return value;
  }
}
