// The upstream streams SSE frames whose `content` is this frame's addition
// and whose `fullContent`, when present, is the whole answer so far. Both
// have to come out as OpenAI deltas, with no word repeated and no answer
// cut short — including when a frame is split across TCP chunks.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"

const stream = (frames) => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse(frames)))
      c.close()
    },
  })
  return _internal.upstreamToOpenAI(body, { model: "deepseek-chat-latest" })
}

const deltas = async (res) => {
  const text = await res.text()
  const out = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const p = t.slice(5).trim()
    if (p === "[DONE]") continue
    const j = JSON.parse(p)
    const d = j.choices?.[0]?.delta
    if (d?.content) out.push(d.content)
  }
  return out.join("")
}

test("per-frame additions are joined into the whole answer", async () => {
  const res = stream([{ content: "你" }, { content: "好" }, { content: "，世界" }])
  expect(await deltas(res)).toBe("你好，世界")
})

// Some deployments send the whole answer each time; the deltas must be
// worked out, or the client would see every word again and again.
test("cumulative frames are turned into deltas", async () => {
  const res = stream([
    { fullContent: "你" },
    { fullContent: "你好" },
    { fullContent: "你好，世界" },
  ])
  expect(await deltas(res)).toBe("你好，世界")
})

test("reasoning is streamed apart from the answer", async () => {
  const res = stream([{ reasoningContent: "先想" }, { content: "答案" }])
  const text = await res.text()
  const reasoning = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(5).trim()))
    .map((j) => j.choices?.[0]?.delta?.reasoning_content ?? "")
    .join("")
  expect(reasoning).toBe("先想")
})

// A stream that stops without [DONE] still has to end the answer, or the
// client waits forever.
test("a stream with no [DONE] is still finished", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"content":"ok"}\n\n'))
      c.close()
    },
  })
  const text = await _internal.upstreamToOpenAI(body, { model: "m" }).text()
  expect(text).toContain("[DONE]")
  const hasStop = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .some((l) => JSON.parse(l.slice(5).trim()).choices?.[0]?.finish_reason === "stop")
  expect(hasStop).toBe(true)
})

// A refusal arriving mid-stream must error the stream, not become answer
// text: as text it would read as a successful reply, and magpie would neither
// fail over nor rest the account.
test("an upstream error frame errors the stream", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: [ERROR]: quota exhausted\n\n"))
      c.close()
    },
  })
  const res = _internal.upstreamToOpenAI(body, { model: "m" })
  await expect(res.text()).rejects.toThrow(/quota exhausted/)
})

// The OpenAI response must not carry the upstream's framing headers: the
// body is rewritten, so a content-length would be wrong.
test("the rewritten stream sets no content-length", async () => {
  const res = stream([{ content: "a" }])
  expect(res.headers.get("content-length")).toBeNull()
  expect(res.headers.get("content-type")).toContain("event-stream")
})
