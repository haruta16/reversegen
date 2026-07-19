/** Legacy System.Random used by Tile Explorer's Unity/IL2CPP build. */
export interface DotNetRandomState {
  seed_array: number[];
  inext: number;
  inextp: number;
}

export class DotNetRandom {
  static readonly MBIG = 2_147_483_647;
  static readonly MSEED = 161_803_398;

  private readonly seedArray: number[];
  private inext: number;
  private inextp: number;

  constructor(seed: number);
  constructor(seed: number, state?: DotNetRandomState);
  constructor(seed: number, state?: DotNetRandomState) {
    if (state) {
      if (!Array.isArray(state.seed_array) || state.seed_array.length !== 56) {
        throw new Error('System.Random seed_array 必须包含 56 个整数');
      }
      if (!Number.isInteger(state.inext) || !Number.isInteger(state.inextp)) {
        throw new Error('System.Random inext/inextp 必须是整数');
      }
      this.seedArray = state.seed_array.map(value => Math.trunc(value));
      this.inext = state.inext;
      this.inextp = state.inextp;
      return;
    }

    const intSeed = seed | 0;
    const subtraction = intSeed === -2_147_483_648
      ? DotNetRandom.MBIG
      : Math.abs(intSeed);
    let mj = DotNetRandom.MSEED - subtraction;
    if (mj < 0) mj += DotNetRandom.MBIG;
    this.seedArray = Array.from({ length: 56 }, () => 0);
    this.seedArray[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += DotNetRandom.MBIG;
      mj = this.seedArray[ii];
    }
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < 56; i++) {
        this.seedArray[i] -= this.seedArray[1 + ((i + 30) % 55)];
        if (this.seedArray[i] < 0) this.seedArray[i] += DotNetRandom.MBIG;
      }
    }
    this.inext = 0;
    this.inextp = 21;
  }

  static fromState(state: DotNetRandomState): DotNetRandom {
    return new DotNetRandom(0, state);
  }

  private internalSample(): number {
    this.inext += 1;
    if (this.inext >= 56) this.inext = 1;
    this.inextp += 1;
    if (this.inextp >= 56) this.inextp = 1;
    let value = this.seedArray[this.inext] - this.seedArray[this.inextp];
    if (value === DotNetRandom.MBIG) value -= 1;
    if (value < 0) value += DotNetRandom.MBIG;
    this.seedArray[this.inext] = value;
    return value;
  }

  next(maxValue: number): number {
    if (!Number.isInteger(maxValue) || maxValue <= 0) {
      throw new Error('System.Random Next(maxValue) 要求正整数');
    }
    return Math.trunc(this.internalSample() * (1 / DotNetRandom.MBIG) * maxValue);
  }

  nextDouble(): number {
    return this.internalSample() * (1 / DotNetRandom.MBIG);
  }

  state(): DotNetRandomState {
    return {
      seed_array: [...this.seedArray],
      inext: this.inext,
      inextp: this.inextp,
    };
  }
}

export function seededShuffle<T>(values: T[], seed: number): void {
  const rng = new DotNetRandom(seed);
  for (let i = values.length - 1; i > 0; i--) {
    const j = rng.next(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
}
