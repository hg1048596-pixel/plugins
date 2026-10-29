// iwinux on Discord (2026-10-28 22:30 UTC+8): magpie's image MCP through
// WorkBuddy AI failed from the minute 0.1.43 was published with
//   400 Bad Request: Unmarshal create image params failed with error:
//   invalid character '\x1f' looking for beginning of value (11101)
// 0.1.43 gzipped every body the loader's fetch sent that wasn't Messages,
// and magpie's drawing (internal/gateway/draw_workbuddy.go) sends its JSON
// to <site>/v2/images/generations and /v2/images/edits through that same
// fetch. The images API reads the body as plain JSON and met gzip's first
// byte. Only a chat completion goes gzipped. Every fetch here is a fake.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const bytesOf = (b) =>
  b == null ? new Uint8Array() : typeof b === "string" ? new TextEncoder().encode(b) : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

// serve is WorkBuddy's images API as it answered iwinux: it unmarshals the
// raw bytes as JSON, whatever Content-Encoding says, and names the first
// byte it can't read as Go's encoding/json does
function serve() {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const raw = bytesOf(init?.body)
    sent.push({ url: u, headers: new Headers(init?.headers), raw })
    if (u.endsWith("/v3/config")) return Response.json({ code: 0, data: { models: [] } })
    try {
      JSON.parse(new TextDecoder().decode(raw))
    } catch {
      const c = raw[0] < 0x20 ? `'\\x${raw[0].toString(16).padStart(2, "0")}'` : `'${String.fromCharCode(raw[0])}'`
      return new Response(
        JSON.stringify({ code: 11101, msg: `Unmarshal create image params failed with error: invalid character ${c} looking for beginning of value` }),
        { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } },
      )
    }
    return Response.json({ code: 0, msg: "ok", data: { created: 1, data: [{ b64_json: "aGk=" }] } })
  }
  return sent
}

const AUTH = { type: "oauth", access: "tok", refresh: "r", uid: "u1", expires: Date.now() + 3600_000 }

async function loader(plugin) {
  const h = await plugin({ client: {} })
  return h.auth.loader(async () => AUTH)
}

// draw is the request magpie's drawWorkBuddy sends, as host.js hands it
// over: a JSON string to an absolute URL
const draw = (opts, url, body) =>
  opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })

for (const [name, plugin, site] of [
  ["WorkBuddy AI", WorkBuddyAIAuthPlugin, "https://www.workbuddy.ai"],
  ["WorkBuddy", WorkBuddyAuthPlugin, "https://copilot.tencent.com"],
]) {
  test(`${name}: a drawing goes as plain JSON, not gzipped`, async () => {
    const sent = serve()
    const opts = await loader(plugin)
    const res = await draw(opts, `${site}/v2/images/generations`, { model: "gpt-image-2.5-sunburst", prompt: "a bird", n: 1, size: "1024x1024", response_format: "b64_json" })
    const text = await res.text()
    expect(text).not.toContain("invalid character")
    expect(res.status).toBe(200)
    const [r] = sent.filter((s) => s.url.endsWith("/v2/images/generations"))
    expect(r.raw[0]).toBe("{".charCodeAt(0))
    expect(r.headers.get("content-encoding")).toBeNull()
    expect(JSON.parse(new TextDecoder().decode(r.raw)).prompt).toBe("a bird")
  })

  test(`${name}: an edit goes as plain JSON too`, async () => {
    const sent = serve()
    const opts = await loader(plugin)
    const res = await draw(opts, `${site}/v2/images/edits`, { model: "gpt-image-2.5-sunburst", prompt: "make it red", n: 1, image: ["data:image/png;base64,aGk="] })
    expect(res.status).toBe(200)
    const [r] = sent.filter((s) => s.url.endsWith("/v2/images/edits"))
    expect(r.raw[0]).toBe("{".charCodeAt(0))
    expect(r.headers.get("content-encoding")).toBeNull()
  })

  test(`${name}: a chat still goes gzipped`, async () => {
    const sent = serve()
    const opts = await loader(plugin)
    await opts.fetch(`${site}/v2/chat/completions`, { method: "POST", body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }) })
    const [c] = sent.filter((s) => s.url.endsWith("/v2/chat/completions"))
    expect(c.headers.get("content-encoding")).toBe("gzip")
    expect([c.raw[0], c.raw[1]]).toEqual([0x1f, 0x8b])
  })
}
