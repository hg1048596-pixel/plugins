import { test, expect } from "bun:test"
import { _internal, OrcaTermAuthPlugin } from "./index.mjs"

// Point 5 — the /conversation POST is gone. Proven without the network: run one
// chat against a stubbed fetch and look at every URL it asked for.
test("a chat makes exactly one upstream request, and it is not /conversation", async () => {
  const seen = []
  const realFetch = globalThis.fetch
  const frame = (content) =>
    `data: ${JSON.stringify({ content, reasoningContent: "", type: "ai", code: 0 })}\n\n`
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return new Response(frame("hi") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }
  try {
    const plugin = await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })
    const loader = await plugin.auth.loader(async () => ({
      type: "api",
      key: "uin=o1234567890; skey=SECRET123456",
    }))
    const res = await loader.fetch("https://lightai.cloud.tencent.com/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "TokenHub/glm-5.3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    expect(seen.length).toBe(1)
    expect(seen[0]).toContain("/assistant/chat")
    expect(seen.some((u) => u.includes("/conversation"))).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// Each case here is one of the must-fix points from the review, written so the
// old behaviour fails it.

// Point 3 — `appendedEnvelopeAt` used to cut at any `{"action":` in the reply.
test("a JSON object with an action key inside a reply is not treated as the envelope", () => {
  const redux = 'Before.\n{"action": "INCREMENT", "payload": 1}\nAfter that, more prose.'
  const ex = _internal.createAnswerExtractor()
  let out = ex.push(redux)
  out += ex.finish()
  expect(out).toBe(redux)
})

test("a trailing action object that is not the assistant's envelope is kept", () => {
  const redux = 'Answer follows.\n{"action": "INCREMENT"}'
  expect(_internal.stripTrailingEnvelope(redux)).toBe(redux)
  expect(_internal.isEnvelope(redux.replace("Answer follows.\n", ""))).toBe(false)
})

test("a reducer the user asked for is not mistaken for an envelope", () => {
  // `content` is a field the client reads a reply from, so a verb the envelope
  // never uses must not be enough to cut the snippet
  const snippet = 'Write the reducer like this:\n{"action": "SAVE", "content": "hello"}'
  expect(_internal.stripTrailingEnvelope(snippet)).toBe(snippet)
  const ex = _internal.createAnswerExtractor()
  const out = ex.push(snippet) + ex.finish()
  expect(out).toBe(snippet)
})

test("a reply that merely mentions the field name is not cut", () => {
  // The extractor used to close as soon as `"taskCompletion": "` appeared
  // anywhere, so a reply quoting the field was truncated and reported as a
  // normal stop.
  const mentioning = 'Quote the field like this: "taskCompletion": "the answer". That is all.'
  const ex = _internal.createAnswerExtractor()
  let out = ex.push(mentioning)
  out += ex.finish()
  expect(out).toBe(mentioning)
})

test("an inline envelope inside a longer answer is not cut", () => {
  const inline = 'Example: {"action": "completion", "taskCompletion": "x"} then done.'
  // both delivery shapes, because the per-character one used to close the stream
  // the instant the object completed and drop the rest
  const once = _internal.createAnswerExtractor()
  expect(once.push(inline) + once.finish()).toBe(inline)

  const perChar = _internal.createAnswerExtractor()
  let out = ""
  for (const ch of inline) out += perChar.push(ch)
  out += perChar.finish()
  expect(out).toBe(inline)
})

test("a stream that ends inside the envelope does not splice raw JSON into the answer", () => {
  // No [DONE]: the upstream died mid-envelope. `sent` counts decoded answer
  // characters, so comparing it against the raw length used to emit garbage.
  const partial = '{"action":"completion","taskCompletion":"Hello wor'
  const ex = _internal.createAnswerExtractor()
  const out = ex.push(partial) + ex.finish()
  expect(out).toBe("Hello wor")
  expect(out).not.toContain("taskCompletion")
})

test("a capitalised action key is still recognised as the envelope", () => {
  expect(_internal.unwrapAnswer('{"Action": "completion", "taskCompletion": "Hello"}')).toBe("Hello")
})

test("a long run of whitespace inside the opening does not leak the envelope", () => {
  const prose = "Answer text here. "
  const env = `{${" ".repeat(30)}"action": "completion", "taskCompletion": "hi"}`
  const ex = _internal.createAnswerExtractor()
  let out = ex.push(prose) + ex.push(env)
  out += ex.finish()
  expect(out).toBe(prose)
})

test("a context-length error is not mistaken for a rate limit", () => {
  // `/exceeded/` used to catch this and mark the account, which every account
  // would hit for the same request.
  const m = _internal.errorStatus("context length exceeded", null)
  expect(m.status).toBe(502)
  // the real quota wording still maps to 429
  expect(_internal.errorStatus("本月问答次数已用完", null).status).toBe(429)
})

test("pacing wait honours an aborted signal instead of sleeping it out", async () => {
  const saved = process.env.ORCATERM_NO_PACE
  delete process.env.ORCATERM_NO_PACE
  try {
    const p = _internal.createPacer({ limit: 1, windowMs: 60000, useEnv: false })
    await p.wait() // fills the window
    const ctrl = new AbortController()
    const t0 = Date.now()
    const waiting = p.wait(ctrl.signal)
    setTimeout(() => ctrl.abort(), 50)
    await waiting
    expect(Date.now() - t0).toBeLessThan(1500)
  } finally {
    if (saved !== undefined) process.env.ORCATERM_NO_PACE = saved
  }
})

test("an unrecognised verb that still carries taskCompletion is treated as the envelope", () => {
  const env = '{"action": "some-new-verb", "taskCompletion": "hi"}'
  expect(_internal.isEnvelope(env)).toBe(true)
  expect(_internal.unwrapAnswer(env)).toBe("hi")
})

test("the assistant's own trailing envelope is still cut", () => {
  const env = JSON.stringify({ action: "completion", ph_1: "--", taskCompletion: "答案" })
  const withProse = `已记住。\n${env}`
  expect(_internal.stripTrailingEnvelope(withProse)).toBe("已记住。\n")

  const ex = _internal.createAnswerExtractor()
  let out = ex.push("已记住。\n")
  out += ex.push(env)
  out += ex.finish()
  expect(out).toBe("已记住。\n")
})

test("a pure envelope still yields only its taskCompletion", () => {
  const env = JSON.stringify({ action: "completion", taskCompletion: "hi" })
  const ex = _internal.createAnswerExtractor()
  let out = ex.push(env)
  out += ex.finish()
  expect(out).toBe("hi")
})

// Point 6 — the ids the README says not to use must not appear in provider.models.
test("provider.models lists only the recommended nine", () => {
  const listed = _internal.MODEL_SPECS.filter((s) => s.listed !== false).map((s) => s.id)
  const hidden = _internal.MODEL_SPECS.filter((s) => s.listed === false).map((s) => s.id)
  expect(listed.length).toBe(9)
  expect(hidden.length).toBe(8)
  // hidden ones still resolve, so an existing config does not break
  for (const id of [...listed, ...hidden]) expect(_internal.resolveModel(id)).toBe(id)
  expect(_internal.resolveModel("qwen3")).toBe("qwen3")
  expect(_internal.resolveModel("deepseek-reasoner")).toBe("deepseek-reasoner")
})

// Point 4 — a pacer per account, so one account's cool-down cannot stall another.
test("pacers are per account", () => {
  const a = _internal.pacerFor({ ticket: { uin: "u1", skey: "s1" } })
  const b = _internal.pacerFor({ ticket: { uin: "u2", skey: "s2" } })
  expect(a).not.toBe(b)
  // the same account gets the same pacer back
  const a2 = _internal.pacerFor({ ticket: { uin: "u1", skey: "s1" } })
  expect(a2).toBe(a)
})

// Point 2 — the JSON refusal has to reach errorStatus, so 429 stays 429.
test("a JSON rate-limit body is classified as 429", () => {
  const body = '{"code":429,"data":null,"message":"Rate limit exceeded: chat-rpm"}'
  const m = _internal.errorStatus(`${429} Rate limit exceeded: chat-rpm ${body}`, null)
  expect(m.status).toBe(429)
})

test("a JSON quota refusal is classified as 429 too", () => {
  const body = '{"code":500,"message":"额度已用完"}'
  expect(_internal.errorStatus(`500 额度已用完 ${body}`, null).status).toBe(429)
})

test("errorStatus penalises the pacer it is given, and only that one", () => {
  const saved = process.env.ORCATERM_NO_PACE
  delete process.env.ORCATERM_NO_PACE
  try {
    const a = _internal.createPacer({ limit: 10, windowMs: 60000, useEnv: false })
    const b = _internal.createPacer({ limit: 10, windowMs: 60000, useEnv: false })
    _internal.errorStatus("Rate limit exceeded", a)
    expect(a.blockedForTest()).toBeGreaterThan(0)
    expect(b.blockedForTest()).toBe(0)
  } finally {
    if (saved !== undefined) process.env.ORCATERM_NO_PACE = saved
  }
})

// The minor points: the local sign-in page must not accept a code from anyone else.
test("/cb accepts the machine's own addresses when bound to a wildcard", async () => {
  // `ORCATERM_CAPTURE_HOST=0.0.0.0` is documented as a way to reach the page from
  // elsewhere. It has to keep working, or the knob hands out a page whose own POST
  // is refused.
  const saved = process.env.ORCATERM_CAPTURE_HOST
  process.env.ORCATERM_CAPTURE_HOST = "0.0.0.0"
  const os = await import("node:os")
  const cap = _internal.createLocalCapture({
    appid: "wxtest",
    redirectUri: "https://orcaterm.com/oauth/wechat/bridge",
    state: "state-abc",
    timeoutMs: 5000,
  })
  try {
    const page = await cap.ready
    const port = new URL(page).port
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address
    if (lan) {
      const res = await fetch(`http://127.0.0.1:${port}/cb`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://${lan}:${port}` },
        body: JSON.stringify({ code: "LAN_CODE", state: "state-abc" }),
      })
      expect((await res.json()).ok).toBe(true)
    }
    // and a hostname is still refused, which is what rebinding would use
    const forged = await fetch(`http://127.0.0.1:${port}/cb`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ code: "X", state: "state-abc" }),
    })
    expect(forged.status).toBe(403)
  } finally {
    cap.close()
    if (saved === undefined) delete process.env.ORCATERM_CAPTURE_HOST
    else process.env.ORCATERM_CAPTURE_HOST = saved
  }
})

test("/cb refuses a rebinding page that matches Origin with its own Host", async () => {
  // The state is in the page's HTML, so reading it is not the hard part. The
  // check has to be against an origin the request cannot supply: comparing
  // Origin with the request's own Host is a tautology a rebinding page satisfies.
  const cap = _internal.createLocalCapture({
    appid: "wxtest",
    redirectUri: "https://orcaterm.com/oauth/wechat/bridge",
    state: "state-abc",
    timeoutMs: 5000,
  })
  try {
    const page = await cap.ready
    const html = await (await fetch(page)).text()
    const state = /const STATE = "([^"]+)"/.exec(html)?.[1] ?? ""
    expect(state).toBe("state-abc")
    const res = await fetch(new URL("/cb", page), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example", host: "evil.example" },
      body: JSON.stringify({ code: "ATTACKER_CODE", state }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).ok).toBe(false)
  } finally {
    cap.close()
  }
})

test("/cb refuses a POST from another origin", async () => {
  const cap = _internal.createLocalCapture({
    appid: "wxtest",
    redirectUri: "https://orcaterm.com/oauth/wechat/bridge",
    state: "state-abc",
    timeoutMs: 5000,
  })
  try {
    const page = await cap.ready
    const cb = new URL("/cb", page)
    const res = await fetch(cb, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ code: "C", state: "state-abc" }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).ok).toBe(false)
  } finally {
    cap.close()
  }
})

test("/cb refuses a state it did not issue", async () => {
  const cap = _internal.createLocalCapture({
    appid: "wxtest",
    redirectUri: "https://orcaterm.com/oauth/wechat/bridge",
    state: "state-abc",
    timeoutMs: 5000,
  })
  try {
    const page = await cap.ready
    const origin = new URL(page).origin
    const res = await fetch(new URL("/cb", page), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code: "C", state: "someone-elses-state" }),
    })
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(String(j.error)).toContain("state")
  } finally {
    cap.close()
  }
})

test("/cb accepts its own origin and state, and the page carries the checks", async () => {
  const cap = _internal.createLocalCapture({
    appid: "wxtest",
    redirectUri: "https://orcaterm.com/oauth/wechat/bridge",
    state: "state-abc",
    timeoutMs: 5000,
  })
  try {
    const page = await cap.ready
    const origin = new URL(page).origin
    const html = await (await fetch(page)).text()
    expect(html).toContain("https://orcaterm.com") // the origin the message must come from
    expect(html).toContain("self_redirect: true")
    const res = await fetch(new URL("/cb", page), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code: "C", state: "state-abc" }),
    })
    expect((await res.json()).ok).toBe(true)
    expect(await cap.wait).toEqual({ code: "C", state: "state-abc" })
  } finally {
    cap.close()
  }
})
