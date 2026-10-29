// WorkBuddy drops an assistant message's reasoning_content and reads its own
// client's `reasoning` (uk.jent on Discord, 2026-10-27: Grok Build's
// chat.completions history lost its thinking on WorkBuddy). The history is
// the one Grok Build 1.0.67 sends after a tool call.
import { expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const { asReasoning } = _internal

const thought = "The user wants the files. Codeword ZEBRA-42."
const history = (assistant) => [
  { role: "system", content: "You are Grok." },
  { role: "user", content: "List the files here." },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } }], ...assistant },
  { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" },
  { role: "user", content: "And now?" },
]

async function upstream(messages) {
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/chat/completions")) sent.push(JSON.parse(unz(init.body)))
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  try {
    const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const res = await loader.fetch("https://www.workbuddy.ai/v2/chat/completions", { method: "POST", body: JSON.stringify({ model: "kimi-k2.6", stream: true, messages }) })
    expect(res.status).toBe(200)
  } finally {
    globalThis.fetch = realFetch
  }
  expect(sent.length).toBe(1)
  return sent[0].messages
}

test("an earlier turn's reasoning_content goes as reasoning, as WorkBuddy's own client sends it", async () => {
  const m = await upstream(history({ reasoning_content: thought, model_id: "kimi-k2.6" }))
  expect(m[2].reasoning).toBe(thought)
  expect(m[2].reasoning_content).toBeUndefined()
  expect(m[2].tool_calls[0].id).toBe("call_1")
  // nothing is folded into what the model said
  expect(m[2].content).toBe("")
  expect(m[4]).toEqual({ role: "user", content: "And now?" })
})

test("reasoning_details' text goes as reasoning too", async () => {
  const m = await upstream(history({ reasoning_details: [{ type: "reasoning.text", text: "The user wants " }, { type: "reasoning.text", text: "the files." }] }))
  expect(m[2].reasoning).toBe("The user wants the files.")
  expect(m[2].reasoning_details).toBeUndefined()
})

test("a reasoning the client set already is kept", () => {
  const messages = history({ reasoning: "own words", reasoning_content: thought })
  expect(asReasoning(messages)).toBe(true)
  expect(messages[2].reasoning).toBe("own words")
  expect(messages[2].reasoning_content).toBeUndefined()
})

test("a history without reasoning fields is left as sent", () => {
  const messages = history({ reasoning: "own words" })
  const before = JSON.stringify(messages)
  expect(asReasoning(messages)).toBe(false)
  expect(JSON.stringify(messages)).toBe(before)
})
