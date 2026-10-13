import { encodeBase64 } from "./base64.ts";

/** Portable synchronous SHA-256, reused from the app upload hasher (VUH-2236). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private filled = 0;
  private length = 0;

  update(bytes: Uint8Array): this {
    let index = 0;
    this.length += bytes.length;
    while (index < bytes.length) {
      const take = Math.min(64 - this.filled, bytes.length - index);
      this.block.set(bytes.subarray(index, index + take), this.filled);
      this.filled += take;
      index += take;
      if (this.filled === 64) {
        this.compress();
        this.filled = 0;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.length * 8;
    this.update(new Uint8Array([0x80]));
    while (this.filled !== 56) this.update(new Uint8Array([0]));
    const tail = new Uint8Array(8);
    const high = Math.floor(bits / 0x100000000);
    const low = bits >>> 0;
    new DataView(tail.buffer).setUint32(0, high);
    new DataView(tail.buffer).setUint32(4, low);
    this.update(tail);
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < this.h.length; index += 1) view.setUint32(index * 4, this.h[index]!);
    return bytes;
  }

  private compress(): void {
    const w = this.w;
    const b = this.block;
    for (let i = 0; i < 16; i += 1)
      w[i] = (b[i * 4]! << 24) | (b[i * 4 + 1]! << 16) | (b[i * 4 + 2]! << 8) | b[i * 4 + 3]!;
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const c = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = this.h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    const hs = this.h;
    hs[0] = (hs[0]! + a) | 0;
    hs[1] = (hs[1]! + bb) | 0;
    hs[2] = (hs[2]! + c) | 0;
    hs[3] = (hs[3]! + d) | 0;
    hs[4] = (hs[4]! + e) | 0;
    hs[5] = (hs[5]! + f) | 0;
    hs[6] = (hs[6]! + g) | 0;
    hs[7] = (hs[7]! + h) | 0;
  }
}

/** SHA-256 of UTF-8 text, with the canonical unpadded base64url wire encoding. */
export function sha256Base64Url(value: string): string {
  const bytes = new Sha256().update(new TextEncoder().encode(value)).digest();
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
