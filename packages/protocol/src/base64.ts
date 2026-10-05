export function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) return (alphabet.indexOf(value.at(-3)!) & 0b1111) === 0;
  if (value.endsWith("=")) return (alphabet.indexOf(value.at(-2)!) & 0b11) === 0;
  return true;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Canonical padded base64 without Buffer or btoa, so React Native and Node share one encoder. */
export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += BASE64_ALPHABET[(triple >> 18) & 63]! + BASE64_ALPHABET[(triple >> 12) & 63]!;
    output += b === undefined ? "=" : BASE64_ALPHABET[(triple >> 6) & 63]!;
    output += c === undefined ? "=" : BASE64_ALPHABET[triple & 63]!;
  }
  return output;
}
