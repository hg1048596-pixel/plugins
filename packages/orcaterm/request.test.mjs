// What magpie hands the plugin is a Chat Completions body; OrcaTerm's
// assistant takes one user turn plus a history list and has no system
// role. This checks that the translation keeps the conversation's meaning:
// system text survives, turns stay in order, and tool traffic degrades to
// text instead of being dropped.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const turn = (messages) => _internal.toUpstreamBody({ messages }, { conversationId: "cid-1", userId: "u-1" })

test("system text is carried as a prefix, the last user turn as the input", () => {
  const up = turn([
    { role: "system", content: "you are a terminal assistant" },
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second" },
  ])
  expect(up.conversationId).toBe("cid-1")
  expect(up.input.content.startsWith("[系统指令")).toBe(true)
  expect(up.input.content.endsWith("second")).toBe(true)
  // the two earlier turns travel as history, in order
  expect(up.input.historyMessages).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
  ])
  expect(up.stream).toBe(true)
})

// OrcaTerm runs its own tools server-side; the client's tool calls can only
// be described, so they become text the model can read.
test("tool calls and their results become text, nothing is lost", () => {
  const up = turn([
    { role: "user", content: "what's the weather" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"SZ"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "sunny 30C" },
  ])
  const all = [up.input.content, ...up.input.historyMessages.map((m) => m.content)].join("\n")
  expect(all).toContain("get_weather")
  expect(all).toContain("sunny 30C")
  // the tool result is the last turn, so it is what gets asked
  expect(up.input.content).toContain("工具结果")
})

// An empty input is answered with a 400 by the assistant, so an empty
// conversation has to be given something to reply to.
test("an empty conversation still sends a non-empty input", () => {
  expect(turn([]).input.content.trim().length).toBeGreaterThan(0)
  expect(turn([{ role: "system", content: "be brief" }]).input.content.trim().length).toBeGreaterThan(0)
})

test("image parts are noted, text parts kept", () => {
  const up = turn([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "http://x/y.png" } },
      ],
    },
  ])
  expect(up.input.content).toContain("look")
  expect(up.input.content).toContain("[图片]")
})

// A model id magpie may pass with its provider prefix, in any case, with
// padding — and one it doesn't know, which must reach the endpoint as is
// rather than be swallowed.
test("model ids resolve through aliases, prefixes and case", () => {
  expect(_internal.resolveModel("deepseek")).toBe("deepseek-chat-latest")
  expect(_internal.resolveModel("orcaterm/kimi")).toBe("kimi-k2")
  expect(_internal.resolveModel("  GLM-4.7-THINKING  ")).toBe("glm-4.7-thinking")
  expect(_internal.resolveModel("some-new-model")).toBe("some-new-model")
  // a bare prefix must fall back to a real model, not send an empty id
  expect(_internal.resolveModel("orcaterm/")).toBe("deepseek-chat-latest")
  expect(_internal.resolveModel(undefined)).toBe("deepseek-chat-latest")
})
