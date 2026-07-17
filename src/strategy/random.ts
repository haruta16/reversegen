import { mulberry32 } from '../random-utils.js';

export function deriveSeed(root: number, ...parts: Array<string | number>): number {
  let hash = root >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function seededRandom(root: number, ...parts: Array<string | number>): () => number {
  return mulberry32(deriveSeed(root, ...parts));
}
