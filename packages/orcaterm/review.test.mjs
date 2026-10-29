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
  // `content` is one of the fields the client reads a reply from, so a verb the
  // envelope never uses must not be enough to cut the snippet
  const snippet = '你的 reducer 写成这样：\n{"action": "SAVE", "content": "hello"}'
  expect(_internal.stripTrailingEnvelope(snippet)).toBe(snippet)

  const ex = _internal.createAnswerExtractor()
  let out = ex.push(snippet)
  out += ex.finish()
  expect(out).toBe(snippet)
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
