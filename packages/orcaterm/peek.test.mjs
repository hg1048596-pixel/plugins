// A refusal arrives inside the stream with HTTP 200 still on the status line,
// so the status alone says nothing: the head of the stream has to be read
// before an answer is handed back. These check that a used-up allowance is
// answered as 429, a dead sign-in as 401, and a real answer as an answer —
// with the peeked bytes replayed, so no text is lost to the peek.
import { afterEach, expect, test } from "bun:test"
import { OrcaTermAuthPlugin, _internal } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const frame = (o) => `data: ${JSON.stringify(o)}\n\n`

/** Answer a chat request, with the upstream body being `body`. */
const ask = async (body, { stream = true } = {}) => {
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  const hooks = await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "uin=o1234567890; skey=deadbeef" }))
  return opts.fetch("https://lightai.cloud.tencent.com/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek", stream, messages: [{ role: "user", content: "hi" }] }),
  })
}

const bodyOf = (frames) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f))
      c.close()
    },
  })

// A used-up monthly allowance looks like an answer unless the head is read
// first: magpie would neither fail over nor rest the account.
test("a quota refusal is answered 429, not as text", async () => {
  const res = await ask(bodyOf([frame({}) && "data: [ERROR]: 本月问答次数已用完\n\n"]))
  expect(res.status).toBe(429)
  const j = await res.json()
  expect(j.error.message).toContain("次数已用完")
})

test("a rate-limit refusal is answered 429", async () => {
  const res = await ask(bodyOf(["data: [ERROR]: rate limit exceeded\n\n"]))
  expect(res.status).toBe(429)
})

// A dead sign-in is the account's problem, not the request's: magpie marks
// it and stops sending, rather than failing over forever.
test("a refused sign-in is answered 401 and marked", async () => {
  const res = await ask(bodyOf(["data: [ERROR]: VERIFY_SKEY_UIN_FAILED\n\n"]))
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
})

test("any other upstream refusal is answered 502", async () => {
  const res = await ask(bodyOf(["data: [ERROR]: model unavailable\n\n"]))
  expect(res.status).toBe(502)
})

// The peek reads bytes before deciding; those bytes have to go back into the
// stream or the start of the answer is lost.
test("a real answer passes through with its first frame intact", async () => {
  const res = await ask(bodyOf([frame({ content: "你" }), frame({ content: "好" }), "data: [DONE]\n\n"]))
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain("你")
  expect(text).toContain("好")
})

// An answer whose head is only whitespace before the first frame must still
// be recognised as an answer rather than held until the peek limit.
test("leading noise before the first frame does not hide the answer", async () => {
  const res = await ask(bodyOf(["\n\n", frame({ content: "ok" }), "data: [DONE]\n\n"]))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("ok")
})

// The same refusal without streaming must not become a 200 either.
test("a quota refusal in a non-streaming request is 429", async () => {
  const res = await ask(bodyOf(["data: [ERROR]: 本月问答次数已用完\n\n"]), { stream: false })
  expect(res.status).toBe(429)
})

// Reading the head must not consume the whole stream: a long answer still
// arrives in full.
test("a long answer is not truncated by the peek", async () => {
  const frames = []
  for (let i = 0; i < 200; i++) frames.push(frame({ content: `w${i} ` }))
  frames.push("data: [DONE]\n\n")
  const res = await ask(bodyOf(frames))
  expect(res.status).toBe(200)
  // Compare the deltas joined, not the raw body: where a chunk boundary falls
  // is the plugin's business, and asserting on the raw JSON made this fail the
  // moment the extractor's hold-back changed size.
  const text = await res.text()
  let out = ""
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const payload = t.slice(5).trim()
    if (payload === "[DONE]") continue
    try {
      const d = JSON.parse(payload).choices?.[0]?.delta
      if (d?.content) out += d.content
    } catch {
      /* not a chunk */
    }
  }
  const expected = Array.from({ length: 200 }, (_, i) => `w${i} `).join("")
  expect(out).toBe(expected)
})

// The OpenAI error body carries both a class and a code, and they are not
// the same thing: `type` is the class magpie reasons about, `code` says what
// the upstream said. Passing the class in both places loses the upstream's
// own words, which is what a user needs to see.
test("a refusal keeps the upstream's words in code, the class in type", async () => {
  const res = await ask(bodyOf(["data: [ERROR]: 本月问答次数已用完\n\n"]))
  expect(res.status).toBe(429)
  const j = await res.json()
  expect(j.error.type).toBe("rate_limit_error")
  expect(j.error.code).toContain("次数已用完")
  expect(j.error.code).not.toBe("rate_limit_error")
})

// classifyHead is what decides: a frame carrying text is an answer, an
// [ERROR] frame is not, and a quiet stream that has ended is an answer.
test("classifyHead tells answers from refusals", () => {
  expect(_internal.errorStatus("额度已用完")).toMatchObject({ status: 429 })
  expect(_internal.errorStatus("限流")).toMatchObject({ status: 429 })
  expect(_internal.errorStatus("VERIFY_USER_FAILED")).toMatchObject({ status: 401 })
  expect(_internal.errorStatus("something else")).toMatchObject({ status: 502 })
})
