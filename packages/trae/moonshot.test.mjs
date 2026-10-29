// Moonshot (Kimi) refuses a tool schema whose property has no type (Trae code
// 4027, "type is not defined"): the tools sent for a Kimi model are given one.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

const { chatBody, nativeTools } = _internal

// Claude Code's shape: an enum with no type, in an array's items
const ENUM_ONLY = {
  type: "object",
  properties: { ops: { type: "array", items: { type: "object", properties: { op: { enum: ["add", "remove"] }, n: { enum: [1, 2] }, f: { enum: [1, 2.5] }, b: { const: true } } } } },
}
const tool = (parameters) => [{ type: "function", function: { name: "edit", description: "d", parameters } }]
const sent = (tools, model = "kimi-k3.1-pro-max") => JSON.parse(chatBody({ model, messages: [], tools }, "chat_v3", "").tools[0].function.parameters)

let f
afterEach(() => f?.close())

test("an enum or const with no type gets the one its values have", () => {
  const p = sent(tool(ENUM_ONLY)).properties.ops.items.properties
  expect(p.op).toEqual({ type: "string", enum: ["add", "remove"] })
  expect(p.n).toEqual({ type: "integer", enum: [1, 2] })
  expect(p.f).toEqual({ type: "number", enum: [1, 2.5] })
  expect(p.b).toEqual({ type: "boolean", const: true })
})

test("the request's own tools are not changed", () => {
  const tools = tool(ENUM_ONLY)
  const before = JSON.stringify(tools)
  sent(tools)
  expect(JSON.stringify(tools)).toBe(before)
})

test("a model that is not Kimi or Moonshot is sent the schema as it is", () => {
  for (const model of ["glm-5", "DeepSeek-V4.1-Flash-1017"]) expect(sent(tool(ENUM_ONLY), model)).toEqual(ENUM_ONLY)
  expect(sent(tool(ENUM_ONLY), "Kimi-K3")).not.toEqual(ENUM_ONLY)
  expect(sent(tool(ENUM_ONLY), "moonshot-v1")).not.toEqual(ENUM_ONLY)
})

test("a schema Kimi takes goes byte for byte", () => {
  const ok = { type: "object", properties: { a: { type: "string", enum: ["x"] }, b: { anyOf: [{ type: "string" }, { type: "null" }] } } }
  expect(nativeTools(tool(ok), true)[0].function.parameters).toBe(JSON.stringify(ok))
  expect(nativeTools(tool(ok), false)[0].function.parameters).toBe(JSON.stringify(ok))
})

test("a $ref beside a type and a type beside an anyOf are written as Kimi holds them", () => {
  const p = {
    type: "object",
    properties: { n: { type: "integer", maximum: 5, $ref: "#/$defs/s0" }, u: { type: "string", anyOf: [{ type: "string" }, { type: "null" }] } },
    $defs: { s0: { type: "number" } },
  }
  const out = sent(tool(p))
  expect(out.properties.n).toEqual({ type: "integer", maximum: 5 })
  expect(out.properties.u).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
})

test("the Kimi request that carried the enum-only tool reaches Trae with a typed schema", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", {}]]))
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "kimi-k2.6", tools: tool(ENUM_ONLY), messages: [{ role: "user", content: "hi" }] }) })
  const op = JSON.parse(f.seen[0].json.tools[0].function.parameters).properties.ops.items.properties.op
  expect(op.type).toBe("string")
})
