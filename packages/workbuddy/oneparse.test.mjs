// plugins#461 (jihuayu): a 45 MiB chat was parsed six times on its way to
// WorkBuddy, once by each step, and written out whole again even when no
// step changed it. prepared reads it once; what goes out is what the steps
// one by one made of it.
import { expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const { prepared, withSystem, fitted, normalizeToolChoice, withoutUnsigned } = _internal

const chats = [
  { model: "deepseek-v4.1-flash", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], tool_choice: "auto", tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] },
  { model: "m", messages: [{ role: "developer", content: "d" }, { role: "user", content: "x" }], max_completion_tokens: 9 },
  { model: "m", messages: [{ role: "user", content: "no system" }] },
  { model: "m", messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude" }, { role: "user", content: "q" }] },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }, { role: "assistant", content: "a", reasoning_content: "thought" }, { role: "user", content: "q2" }] },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "run" }], tools: [{ type: "function", function: { name: "fs.read", parameters: { type: "object", properties: { v: { type: ["string", "null"] } } } } }], tool_choice: { type: "function", function: { name: "fs.read" } } },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "x" }], tools: [{ type: "function", function: { name: "a" } }], tool_choice: "none" },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "x" }], tool_choice: { type: "required" } },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "x" }], tool_choice: null },
  { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "x" }], tool_choice: { type: "other" } },
  { model: "m", messages: [] },
  { model: "m" },
  [1, 2],
  "a string",
  42,
  null,
]

const stepByStep = (body) => {
  const fit = fitted(withSystem(body))
  return { body: normalizeToolChoice(fit.body), names: fit.names }
}
const sent = (p) => (p.changed ? JSON.stringify(p.chat) : p.body)
const read = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

test("one parse makes what the steps one by one made", () => {
  for (const c of chats) {
    const body = JSON.stringify(c)
    const old = stepByStep(body)
    const p = prepared(body, false)
    expect(read(sent(p))).toEqual(read(old.body))
    expect([...p.names]).toEqual([...old.names])
  }
  for (const body of ["not json", "", "{", new TextEncoder().encode(JSON.stringify(chats[0]))]) {
    const old = stepByStep(body)
    expect(read(sent(prepared(body, false)))).toEqual(read(old.body))
  }
})

test("a chat no step changes goes byte for byte, not written out again", () => {
  // spaced as no JSON.stringify writes it: any rewrite would show
  const body = `{"model": "m",  "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "x"}], "tool_choice": "auto"}`
  const p = prepared(body, false)
  expect(p.changed).toBe(false)
  expect(sent(p)).toBe(body)
})

test("a Messages body is read once too, its unsigned thinking dropped as before", () => {
  const body = JSON.stringify({
    model: "claude",
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }] },
      { role: "user", content: "q2" },
    ],
  })
  expect(read(sent(prepared(body, true)))).toEqual(read(withoutUnsigned(body)))
  const plain = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "q" }] })
  expect(sent(prepared(plain, true))).toBe(plain)
})

test("the loader parses a long chat once", async () => {
  const realFetch = globalThis.fetch
  const realParse = JSON.parse
  let parses = 0
  let out
  JSON.parse = (s, ...a) => {
    if (typeof s === "string" && s.length > 1 << 20) parses++
    return realParse(s, ...a)
  }
  globalThis.fetch = async (_url, init) => {
    out = unz(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } }, magpie: { option: () => false } })
    const auth = { type: "oauth", access: "test-only", refresh: "test-only", uid: "u", expires: Date.now() + 3600000 }
    const loader = await hooks.auth.loader(async () => auth)
    const body = JSON.stringify({
      model: "deepseek-v4.1-flash",
      stream: true,
      tool_choice: "auto",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "x".repeat(2 << 20) }],
      tools: [{ type: "function", function: { name: "test.tool.name", parameters: { type: "object" } } }],
    })
    const res = await loader.fetch("https://synthetic.invalid/v2/chat/completions", { method: "POST", body, headers: { "content-type": "application/json" } })
    await res.text()
    expect(parses).toBe(1)
    expect(read(out)).toEqual(read(stepByStep(body).body))
  } finally {
    globalThis.fetch = realFetch
    JSON.parse = realParse
  }
})

// counted is what the loader parsed and wrote out of chats over 1 MiB,
// through a plugin with the given magpie options, for each chat sent; the
// fake answers each chat with answer(text) or OK
async function counted(bodies, { option = () => false, answer = () => null, auth } = {}) {
  const realFetch = globalThis.fetch
  const realParse = JSON.parse
  const realStringify = JSON.stringify
  const n = { parses: 0, writes: 0 }
  JSON.parse = (s, ...a) => {
    if (typeof s === "string" && s.length > 1 << 20) n.parses++
    return realParse(s, ...a)
  }
  JSON.stringify = (...a) => {
    const s = realStringify(...a)
    if (typeof s === "string" && s.length > 1 << 20) n.writes++
    return s
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v3/config")) return Response.json({ code: 0, data: { agents: [{ name: "cli", models: ["hy3", "gemini-461"] }], models: [{ id: "hy3", credits: "x0.00" }, { id: "gemini-461", credits: "x0.00" }] } })
    return answer(unz(init.body)) ?? new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const out = []
  try {
    const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } }, magpie: { option } })
    const loader = await hooks.auth.loader(async () => auth ?? { type: "oauth", access: "test-only", refresh: "test-only", uid: "u", expires: Date.now() + 3600000 })
    for (const body of bodies) {
      n.parses = n.writes = 0
      const res = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body, headers: { "content-type": "application/json" } })
      await res.text()
      out.push({ status: res.status, ...n })
    }
  } finally {
    globalThis.fetch = realFetch
    JSON.parse = realParse
    JSON.stringify = realStringify
  }
  return out
}

const long = (model, extra = {}) =>
  JSON.stringify({ model, stream: true, messages: [{ role: "system", content: "s" }, { role: "user", content: "x".repeat(2 << 20) }], ...extra })

test("with Free models only on, the model is read off the one parse", async () => {
  const [r] = await counted([long("hy3")], { option: (_p, k) => k === "free_only", auth: { type: "api", key: "ck_test0000000000abcdefgh" } })
  expect(r).toEqual({ status: 200, parses: 1, writes: 0 })
})

test("a model that wants the reply after tools has it put in on the one parse", async () => {
  const call = { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "{}" } }] }
  const chat = (n) => JSON.stringify({ model: "gemini-461", messages: [{ role: "user", content: "go" }, call, { role: "tool", tool_call_id: "c", content: "y".repeat(2 << 20) }, { role: "user", content: `now ${n}` }] })
  // refused unless the reply sits after the tool's result; read without a
  // parse of its own, which would be counted
  const answer = (text) =>
    text.indexOf('{"role":"assistant","content":""}') > text.indexOf('"role":"tool"') ? null : new Response('{"error":{"code":11153}}', { status: 400 })
  // the first teaches the plugin (refused, sent again with the reply); the
  // second has it up front: read once, written once
  const [first, second] = await counted([chat(1), chat(2)], { answer })
  expect(first.status).toBe(200)
  expect(second).toEqual({ status: 200, parses: 1, writes: 1 })
})
