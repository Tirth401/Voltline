/**
 * Seeded pseudo-random numbers, split into independent named streams.
 *
 * Every random choice in Voltline (which charger misbehaves, when, and how) comes from a Prng built
 * from a seed, so the same seed regenerates the same scenario. Lint bans Math.random (D-011).
 *
 * Generator: sfc32 ("small fast counter", 128 bits of state), seeded through a splitmix-style
 * mixer. Fast, well tested, and not cryptographic, which is fine for simulation.
 *
 * Streams: fork('charger-17') derives a child from this stream's seed and the label only. It never
 * depends on how many numbers the parent has drawn, so adding a random call in one charger doesn't
 * shift the numbers any other charger sees.
 */

const UINT32_RANGE = 2 ** 32;

export class Prng {
  /** The seed this stream was built from. Log it: it's how a run is reproduced. */
  readonly seed: number;
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
      throw new RangeError(`seed must be an integer in [0, 2^32), got ${seed}`);
    }
    this.seed = seed;
    let weyl = seed;
    const nextStateWord = (): number => {
      weyl = (weyl + 0x9e3779b9) >>> 0;
      return mix32(weyl);
    };
    this.#a = nextStateWord();
    this.#b = nextStateWord();
    this.#c = nextStateWord();
    this.#d = nextStateWord();
    // sfc32's first few outputs are poorly mixed; discarding them is the standard remedy.
    for (let i = 0; i < 15; i++) this.nextUint32();
  }

  /** Uniform integer in [0, 2^32). */
  nextUint32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1), with 32 bits of resolution. */
  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  /** Uniform integer in [min, max], both inclusive. Uses rejection sampling, so no modulo bias. */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new RangeError(`int(min, max) needs integers with min <= max, got (${min}, ${max})`);
    }
    const span = max - min + 1;
    if (span > UINT32_RANGE) {
      throw new RangeError(`int(min, max) supports spans up to 2^32, got ${span}`);
    }
    // The largest multiple of span below 2^32. Draws at or above it would favour small values.
    const limit = UINT32_RANGE - (UINT32_RANGE % span);
    let draw = this.nextUint32();
    while (draw >= limit) draw = this.nextUint32();
    return min + (draw % span);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    if (!(p >= 0 && p <= 1)) {
      throw new RangeError(`chance(p) needs 0 <= p <= 1, got ${p}`);
    }
    return this.nextFloat() < p;
  }

  /** One element, chosen uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('pick() needs a non-empty array');
    }
    return items[this.int(0, items.length - 1)] as T;
  }

  /** A shuffled copy (Fisher-Yates). The input is left untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const held = out[i] as T;
      out[i] = out[j] as T;
      out[j] = held;
    }
    return out;
  }

  /** An independent child stream, derived from this stream's seed and the label only. */
  fork(label: string): Prng {
    return new Prng(mix32((this.seed ^ fnv1a32(label)) >>> 0));
  }
}

/** murmur3's 32-bit finalizer: every input bit affects every output bit. */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** 32-bit FNV-1a over the label's UTF-16 code units. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
