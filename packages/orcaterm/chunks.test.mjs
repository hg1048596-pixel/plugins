// Frames that look cumulative but aren't, a frame split across network
// chunks, and a connection that dies or is cancelled: the three cases that
// decide whether the client sees the answer it was given, and whether a
// failure is reported as one.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const frame = (o) => `data: ${JSON.stringify(o)}\n\n`

const collect = async (res) => {
  const text = await res.text()
  const out = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const p = t.slice(5).trim()
    if (p === "[DONE]") continue
    const d = JSON.parse(p).choices?.[0]?.delta
    if (d?.content) out.push(d.content)
  }
  return out.join("")
}

const bodyOf = (frames, close = true) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f))
      if (close) c.close()
    },
  })

// The old "cumulative content" check cut real per-frame text whenever a frame
// happened to start with everything sent so far: "ha" then "haha" streamed as
// "haha" instead of "hahaha". `content` is each frame's addition, so it must
// be passed on untouched.
test("a frame that starts with what was already sent is still an addition", async () => {
  const res = _internal.upstreamToOpenAI(bodyOf([frame({ content: "ha" }), frame({ content: "haha" })]), { model: "m" })
  expect(await collect(res)).toBe("hahaha")
})

test("repeated and overlapping text is kept, not trimmed", async () => {
  const res = _internal.upstreamToOpenAI(
    bodyOf([frame({ content: "ab" }), frame({ content: "ab" }), frame({ content: "abc" })]),
    { model: "m" },
  )
  expect(await collect(res)).toBe("abababc")
})

// fullContent is the whole answer so far: its difference is the addition.
test("fullContent still becomes a delta", async () => {
  const res = _internal.upstreamToOpenAI(
    bodyOf([frame({ fullContent: "你" }), frame({ fullContent: "你好" }), frame({ fullContent: "你好，世界" })]),
    { model: "m" },
  )
  expect(await collect(res)).toBe("你好，世界")
})

// A fullContent that rewrites earlier text has no meaningful difference; the
// whole new text is sent rather than a slice from the wrong offset, which
// used to produce "abcw" from "abc" then "xyzw".
test("a fullContent that rewrites earlier text is sent whole", async () => {
  const res = _internal.upstreamToOpenAI(bodyOf([frame({ fullContent: "abc" }), frame({ fullContent: "xyzw" })]), {
    model: "m",
  })
  expect(await collect(res)).toBe("abcxyzw")
})

// A frame can arrive in pieces; the split may fall inside a multi-byte
// character. Neither may lose or mangle text.
test("a frame split across chunks keeps every character", async () => {
  const whole = frame({ content: "你好，世界" })
  const cut = Math.floor(whole.length / 2)
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      c.enqueue(enc.encode(whole.slice(0, cut)))
      c.enqueue(enc.encode(whole.slice(cut)))
      c.close()
    },
  })
  const res = _internal.upstreamToOpenAI(body, { model: "m" })
  expect(await collect(res)).toBe("你好，世界")
})

// A connection that dies mid-stream must error the stream. As an ordinary
// end it would read as a complete answer, and magpie would not fail over.
test("a reset mid-stream errors the stream", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(frame({ content: "par" })))
      c.error(new Error("socket hang up"))
    },
  })
  await expect(_internal.upstreamToOpenAI(body, { model: "m" }).text()).rejects.toThrow(/socket hang up/)
})

// Cancelling must reach the upstream reader: the connection is not left
// open when the agent gives up. Removing releaseUpstream() turns this red.
test("cancelling the answer cancels the upstream", async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new TextEncoder().encode(frame({ content: "a" })))
    },
    cancel() {
      cancelled = true
    },
  })
  const res = _internal.upstreamToOpenAI(body, { model: "m" })
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel()
  // the cancel propagates asynchronously
  for (let i = 0; i < 20 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10))
  expect(cancelled).toBe(true)
})
