// unz is a request body as the text it carries: a chat goes gzipped (see
// gzipped in index.mjs), anything else as it was sent
import { gunzipSync } from "node:zlib"

export function unz(b) {
  if (b == null || typeof b === "string") return b
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  if (u[0] === 0x1f && u[1] === 0x8b) return new TextDecoder().decode(gunzipSync(u))
  return b
}
