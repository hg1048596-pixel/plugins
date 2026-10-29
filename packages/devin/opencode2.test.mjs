// The OpenCode 2 surface yetone's review asked tests for: v2Chat's message
// shapes, devinLanguage's doStream over the GetChatMessage frame protocol,
// doGenerate's whole-reply path, setup's account states, and the default
// export the host reads.
import { afterEach, expect, test } from "bun:test"
import plugin, { _internal } from "./index.mjs"

const { PB, frame, v2Chat, v2ToolParts, v2FileData, v2Effort, v2Auth, devinLanguage, v2Setup, connKey, v2Usage } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const enc = new TextEncoder()

// reply bodies a Connect stream of the given message frames, ended by an
// empty JSON end frame.
const reply = (...msgs) => {
  const end = enc.encode("{}")
  const tail = new Uint8Array(5 + end.length)
  tail[0] = 2
  new DataView(tail.buffer).setUint32(1, end.length)
  tail.set(end, 5)
  return new Response(new Blob([...msgs.map(frame), tail]))
}
const failReply = (obj) => {
  const end = enc.encode(JSON.stringify(obj))
  const tail = new Uint8Array(5 + end.length)
  tail[0] = 2
  new DataView(tail.buffer).setUint32(1, end.length)
  tail.set(end, 5)
  return new Response(new Blob([tail]))
}

const auth = { type: "api", key: "k", metadata: {} }
const language = (modelID = "swe-2") => devinLanguage(modelID, async () => auth)

// A GetCliModelConfigs reply: one config naming swe-2's uid, so configsFor
// caches quickly and ownFamilies never falls to spawning a devin CLI.
const configs = () =>
  new Response(new PB().bytes(1, new PB().str(22, "swe-2").varint(5, 1)).done(), {
    headers: { "Content-Type": "application/proto" },
  })

// serve hands the chat stream to GetChatMessage and the configs body to
// GetCliModelConfigs, the two endpoints a call or a refresh asks.
const serve = (res) => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("GetCliModelConfigs")) return configs()
    return typeof res === "function" ? res(url) : res
  }
}

const drain = async (stream) => {
  const out = []
  const reader = stream.getReader()
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    out.push(r.value)
  }
  return out
}
const types = (evts) => evts.map((e) => e.type)

// ---- the default export ---------------------------------------------------

test("the default export is the v2 plugin shape with the v1 server on it", () => {
  expect(plugin.id).toBe("devin")
  expect(typeof plugin.setup).toBe("function")
  expect(typeof plugin.server).toBe("function")
})

test("connKey identifies a connection the way a refetch names it", () => {
  expect(connKey(undefined)).toBe("")
  expect(connKey({ type: "credential", id: "cred_1" })).toBe("credential:cred_1")
  expect(connKey({ type: "env", name: "DEVIN_KEY" })).toBe("env:DEVIN_KEY")
  expect(connKey({ type: "credential", id: "cred_1", label: "renamed" })).toBe("credential:cred_1")
})

// ---- v2Chat ---------------------------------------------------------------

test("v2Chat maps system, user and assistant parts", () => {
  const chat = v2Chat(
    {
      prompt: [
        { role: "system", content: "be terse" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool-call", toolCallId: "c1", toolName: "Bash", input: { command: "date" } },
          ],
        },
      ],
    },
    "swe-2",
  )
  expect(chat.messages).toEqual([
    { role: "system", content: "be terse" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: "checking", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"date"}' } }] },
  ])
})

test("v2Chat splits a tool result's text from its images, and the images ride the next user message", () => {
  const png = new Uint8Array([1, 2, 3])
  const chat = v2Chat(
    {
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "screenshot taken" },
                  { type: "file", mediaType: "image/png", data: png },
                ],
              },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "what's in it" }] },
      ],
    },
    "swe-2",
  )
  expect(chat.messages[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "screenshot taken" })
  expect(chat.messages[1].role).toBe("user")
  const urls = chat.messages[1].content.filter((p) => p.type === "image_url").map((p) => p.image_url.url)
  expect(urls).toEqual([`data:image/png;base64,${Buffer.from(png).toString("base64")}`])
  expect(chat.messages[1].content.at(-1)).toEqual({ type: "text", text: "what's in it" })
})

test("v2Chat sends a result's trailing images on a user message of their own", () => {
  const chat = v2Chat(
    {
      prompt: [
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", output: { type: "content", value: [{ type: "file", mediaType: "image/png", data: "aGk=" }] } }],
        },
      ],
    },
    "swe-2",
  )
  expect(chat.messages).toEqual([
    { role: "tool", tool_call_id: "c1", content: "" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
  ])
})

test("v2ToolParts covers each output shape", () => {
  expect(v2ToolParts({ type: "text", value: "done" })).toEqual({ text: "done", files: [] })
  expect(v2ToolParts({ type: "error", value: { message: "boom" } })).toEqual({ text: '{"message":"boom"}', files: [] })
  expect(v2ToolParts({ type: "json", value: { ok: 1 } })).toEqual({ text: '{"ok":1}', files: [] })
  expect(v2ToolParts("plain")).toEqual({ text: "plain", files: [] })
})

test("v2FileData takes bytes, base64, URLs and data URLs", () => {
  expect(v2FileData({ mediaType: "image/png", data: new Uint8Array([104, 105]) })).toBe("data:image/png;base64,aGk=")
  expect(v2FileData({ mediaType: "image/png", data: "aGk=" })).toBe("data:image/png;base64,aGk=")
  expect(v2FileData({ mediaType: "image/png", data: "https://x.test/i.png" })).toBe("https://x.test/i.png")
  expect(v2FileData({ mediaType: "image/png", data: "data:image/png;base64,aGk=" })).toBe("data:image/png;base64,aGk=")
  expect(v2FileData({ mediaType: "image/png", data: new URL("https://x.test/i.png") })).toBe("https://x.test/i.png")
})

test("v2Usage takes cached tokens out of the uncached count", () => {
  expect(v2Usage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 } }).inputTokens)
    .toEqual({ total: 1000, noCache: 100, cacheRead: 900, cacheWrite: 0 })
  expect(v2Usage({ prompt_tokens: 10, completion_tokens: 5 }).inputTokens.noCache).toBe(10)
  expect(v2Usage().inputTokens).toEqual({ total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined })
})

test("v2Chat turns toolChoice none into tool_choice none and reads effort from providerOptions", () => {
  const chat = v2Chat({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], toolChoice: { type: "none" }, providerOptions: { devin: { reasoningEffort: "high" } } }, "swe-2")
  expect(chat.tool_choice).toBe("none")
  expect(chat.reasoning_effort).toBe("high")
  expect(v2Effort({ providerOptions: { other: { reasoningEffort: "low" } } })).toBe("low")
})

// ---- devinLanguage ---------------------------------------------------------

const text = (s) => new PB().str(3, s).done()
const reasoning = (s) => new PB().str(9, s).done()
const call = (id, name, args) => new PB().bytes(6, new PB().str(1, id).str(2, name).str(3, args)).done()
const argsOnly = (s) => new PB().bytes(6, new PB().str(3, s)).done()
const stop = (n) => new PB().varint(5, n).done()
const use = (input, output) => new PB().bytes(7, new PB().varint(2, input).varint(3, output)).done()

const stubFetch = serve

test("doStream emits text and reasoning starts only when their first deltas land", async () => {
  stubFetch(reply(text("hello"), stop(0), use(10, 2)))
  const { stream } = await language().doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const evts = await drain(stream)
  expect(types(evts)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"])
  expect(evts.find((e) => e.type === "finish").finishReason.unified).toBe("stop")
  expect(evts.find((e) => e.type === "finish").usage.inputTokens.total).toBe(10)
})

test("doStream announces reasoning on its own track", async () => {
  stubFetch(reply(reasoning("thinking"), text("done"), stop(0), use(1, 1)))
  const { stream } = await language().doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const evts = await drain(stream)
  expect(types(evts)).toEqual(["stream-start", "reasoning-start", "reasoning-delta", "text-start", "text-delta", "reasoning-end", "text-end", "finish"])
})

test("doStream turns a tool turn into tool-call parts", async () => {
  stubFetch(reply(call("call_1", "Bash", '{"command":"da'), argsOnly('te"}'), stop(10), use(5, 3)))
  const { stream } = await language().doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const evts = await drain(stream)
  expect(types(evts)).toEqual(["stream-start", "tool-input-start", "tool-input-delta", "tool-input-delta", "tool-input-end", "tool-call", "finish"])
  const tc = evts.find((e) => e.type === "tool-call")
  expect(tc.toolCallId).toBe("call_1")
  expect(tc.toolName).toBe("Bash")
  expect(tc.input).toBe('{"command":"date"}')
  expect(evts.find((e) => e.type === "finish").finishReason.unified).toBe("tool-calls")
})

test("doStream joins a call's args split over messages to the right id", async () => {
  // args with no name of their own attach to the call last opened; they go
  // out as that call's input under its id, not the index the stream saw.
  const first = new PB().bytes(6, new PB().str(1, "call_1").str(2, "Bash").str(3, '{"command":"da')).done()
  const cont = new PB().bytes(6, new PB().str(3, 'te"}')).done()
  stubFetch(reply(first, cont, stop(10), use(5, 5)))
  const { stream } = await language().doStream({ prompt: [] })
  const evts = await drain(stream)
  const calls = evts.filter((e) => e.type === "tool-call")
  expect(calls.map((c) => [c.toolCallId, c.input])).toEqual([["call_1", '{"command":"date"}']])
  const deltas = evts.filter((e) => e.type === "tool-input-delta")
  expect(deltas.every((d) => d.id === "call_1")).toBe(true)
})

test("doStream surfaces a mid-stream error and closes", async () => {
  const msg = new PB().str(3, "half").done()
  const bad = { error: { message: "upstream broke", type: "devin_error", code: 500 } }
  const endBytes = enc.encode(JSON.stringify(bad))
  const tail = new Uint8Array(5 + endBytes.length)
  tail[0] = 2
  new DataView(tail.buffer).setUint32(1, endBytes.length)
  tail.set(endBytes, 5)
  stubFetch(new Response(new Blob([frame(msg), tail])))
  const { stream } = await language().doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const evts = await drain(stream)
  const err = evts.find((e) => e.type === "error")
  expect(err.error.message).toMatch(/broke|Devin/)
})

test("doStream finishes a stream that ends with no stop frame", async () => {
  stubFetch(reply(text("t")))
  const { stream } = await language().doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const evts = await drain(stream)
  expect(evts.at(-1).type).toBe("finish")
  expect(evts.at(-1).finishReason.unified).toBe("stop")
})

test("doGenerate answers the whole reply", async () => {
  stubFetch(reply(reasoning("why"), text("because"), call("c1", "Read", "{}"), stop(10), use(7, 4)))
  const out = await language().doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  expect(out.content).toEqual([
    { type: "reasoning", text: "why" },
    { type: "text", text: "because" },
    { type: "tool-call", toolCallId: "c1", toolName: "Read", input: "{}" },
  ])
  expect(out.finishReason.unified).toBe("tool-calls")
  expect(out.usage.inputTokens.total).toBe(7)
})

test("doGenerate throws Devin's error on a failed round", async () => {
  stubFetch(failReply({ error: { message: "key turned away", type: "devin_error", code: 401 } }))
  await expect(language().doGenerate({ prompt: [] })).rejects.toThrow()
})

test("a signed-out account fails the call instead of posting to the fallback", async () => {
  const lang = devinLanguage("swe-2", async () => null)
  await expect(lang.doGenerate({ prompt: [] })).rejects.toThrow(/isn't signed in/)
  await expect(lang.doStream({ prompt: [] })).rejects.toThrow(/isn't signed in/)
})

test("an account switch between calls goes out on the new account", async () => {
  let current = { type: "api", key: "account-a", metadata: {} }
  const lang = devinLanguage("swe-2", async () => current)
  const seen = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("GetCliModelConfigs")) return configs()
    seen.push(init?.headers?.Authorization)
    return reply(text("ok"), stop(0), use(1, 1))
  }
  await lang.doGenerate({ prompt: [] })
  current = { type: "api", key: "account-b", metadata: {} }
  await lang.doGenerate({ prompt: [] })
  expect(seen).toEqual(["Basic account-a", "Basic account-b"])
})

// ---- setup -----------------------------------------------------------------

const fakeCtx = ({ connection = null, credential = null } = {}) => {
  const reloaded = { provider: 0, model: 0 }
  const hooks = {}
  const providerAdds = []
  const queue = []
  let wake = null
  const ctx = {
    integration: {
      transform: async () => {},
      connection: {
        active: async () => connection,
        resolve: async () => credential,
      },
    },
    provider: {
      transform: async (cb) => cb({ add: (d) => providerAdds.push(d) }),
      reload: async () => reloaded.provider++,
    },
    model: {
      transform: async () => {},
      reload: async () => reloaded.model++,
    },
    aisdk: {
      hook: async (name, cb) => {
        hooks[name] = cb
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          const it = {
            next() {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
              return new Promise((r) => (wake = () => r(it.next())))
            },
          }
          return it
        },
      }),
    },
  }
  return { ctx, reloaded, hooks, providerAdds, push: (e) => (queue.push(e), wake?.()) }
}

// a credential per test that signs in: configsFor and ownFamilies cache
// their asks under the key, so a shared key shares a test's stubs.
const oauth = (access) => ({ type: "oauth", methodID: "browser", access, refresh: "", expires: 0, metadata: { email: "a@b.c" } })

test("v2Auth reads an oauth credential's access as the key", () => {
  expect(v2Auth(oauth("tok"))).toEqual({ type: "api", key: "tok", metadata: { email: "a@b.c" } })
  expect(v2Auth({ type: "key", key: "k2", metadata: { cli: true } })).toEqual({ type: "api", key: "k2", metadata: { cli: true } })
  expect(v2Auth(null)).toBe(null)
})

test("setup returns without waiting on the account's model list", async () => {
  globalThis.fetch = () => new Promise(() => {}) // Devin unreachable: never answers
  const { ctx, providerAdds } = fakeCtx({ connection: { type: "credential", id: "cred_1" }, credential: oauth("tok-unreachable") })
  await Promise.race([v2Setup(ctx), new Promise((_, r) => setTimeout(() => r(new Error("setup blocked on the network")), 3000))])
  expect(providerAdds.length).toBe(1)
  expect(providerAdds[0].info.id).toBe("devin")
  expect(providerAdds[0].models.length).toBeGreaterThan(0)
})

test("the sdk hook serves no SDK while signed out, and one once the account is read", async () => {
  let connection = null
  let credential = null
  const { ctx, hooks, push } = fakeCtx({})
  ctx.integration.connection.active = async () => connection
  ctx.integration.connection.resolve = async () => credential
  serve(reply(stop(0), use(1, 1)))
  await v2Setup(ctx)
  const evt = {}
  await hooks.sdk(evt)
  expect(evt.sdk).toBeUndefined()

  // a sign-in lands and the event tells the plugin: refresh() re-reads the
  // account and the hook arms.
  connection = { type: "credential", id: "cred_1" }
  credential = oauth("tok-armed")
  push({ type: "credential.switched", data: { integrationID: "devin", credentialID: "cred_1" } })
  for (let i = 0; i < 100 && !evt.sdk; i++) {
    await new Promise((r) => setTimeout(r, 20))
    await hooks.sdk(evt)
  }
  expect(evt.sdk).toBeDefined()
  const lang = evt.sdk.languageModel("swe-2")
  expect(lang.provider).toBe("devin")
})

test("a credential.switched event re-reads the account", async () => {
  let connection = { type: "credential", id: "cred_1" }
  let credential = oauth("tok-one")
  const { ctx, reloaded, push } = fakeCtx({})
  ctx.integration.connection.active = async () => connection
  ctx.integration.connection.resolve = async () => credential
  serve(reply(stop(0), use(1, 1)))
  const before = reloaded.provider
  await v2Setup(ctx)
  for (let i = 0; i < 100 && reloaded.provider === before; i++) await new Promise((r) => setTimeout(r, 10))
  expect(reloaded.provider).toBeGreaterThan(before)

  // switch to another account: the event's handler refreshes again.
  const n = reloaded.provider
  credential = oauth("tok-two")
  push({ type: "credential.switched", data: { integrationID: "devin", credentialID: "cred_2" } })
  for (let i = 0; i < 100 && reloaded.provider === n; i++) await new Promise((r) => setTimeout(r, 10))
  expect(reloaded.provider).toBeGreaterThan(n)
})
