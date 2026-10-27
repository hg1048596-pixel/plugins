// The credential shape OrcaTerm's AI endpoint accepts, and what it says
// when it doesn't: `uin` and `skey` must both be present and real. Only
// `skey` or only `p_uin`+`p_skey` is answered with NEED_UIN_AND_SKEY;
// a wrong pair gets as far as VERIFY_SKEY_UIN_FAILED, which is how a bad
// sign-in is told from a missing one.
import { afterEach, expect, test } from "bun:test"
import { OrcaTermAuthPlugin, _internal } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const plugin = () => OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })

const sign = async (key) => {
  const hooks = await plugin()
  const opts = await hooks.auth.loader(async () => ({ type: "api", key }))
  return opts
}

// Every way a user may paste the pair: a whole Cookie header, a `k=v; k=v`
// fragment, a bare pair, or `p_uin`/`p_skey` under their prefixed names.
test("parseTicket reads the pair however it was pasted", () => {
  const header = _internal.parseTicket("uin=o123; skey=AAA")
  expect(header.uin).toBe("o123")
  expect(header.skey).toBe("AAA")

  const bare = _internal.parseTicket("skinnySecret")
  expect(bare.skey).toBe("skinnySecret")
  expect(bare.uin).toBe("")

  // p_* names are the same cookies under another name: they are lifted to
  // the plain ones, since that is what the endpoint checks for.
  const prefixed = _internal.parseTicket("p_uin=o9; p_skey=BBB")
  expect(prefixed.uin).toBe("o9")
  expect(prefixed.skey).toBe("BBB")

  expect(_internal.parseTicket("")).toBeNull()
})

test("cookieHeader needs both halves; one alone makes no header", () => {
  expect(_internal.cookieHeader({ ticket: { skey: "AAA" } })).toBe("")
  const both = _internal.cookieHeader({ ticket: { uin: "o123", skey: "AAA" } })
  expect(both).toContain("uin=o123")
  expect(both).toContain("skey=AAA")
})

// The sign-in is refused at the loader, before any request goes out, so a
// half pair never reaches the endpoint and never shows up as a failed
// request in the account's history.
test("a key with no uin is refused as expired, not sent", async () => {
  await expect(sign("justASkey")).rejects.toMatchObject({ signIn: "expired" })
})

test("no key at all leaves the account unsigned rather than failing", async () => {
  expect(await sign("")).toEqual({})
})

// The upstream answers 200 with a JSON body even for a refusal, so the
// status code alone would read as success: the body is what decides.
test("a refused sign-in comes back as 401 and marks the account", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 500, message: "VERIFY_SKEY_UIN_FAILED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  const opts = await sign("uin=o1234567890; skey=deadbeef")
  const res = await opts.fetch("https://lightai.cloud.tencent.com/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
})

// NEED_UIN_AND_SKEY means the pair was never read, which is also a sign-in
// problem rather than an upstream fault.
test("a pair the endpoint won't read also marks the account", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 500, message: "NEED_UIN_AND_SKEY" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  const opts = await sign("uin=o1; skey=AA")
  const res = await opts.fetch("https://lightai.cloud.tencent.com/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
})

// Anything else — a quota wall, a rate limit, an upstream 5xx — is not the
// sign-in's fault, and must not mark the account: magpie would stop sending
// to a perfectly good account.
test("a non-auth failure is passed on without marking the account", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 500, message: "model_rate_limit" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  const opts = await sign("uin=o1; skey=AA")
  const res = await opts.fetch("https://lightai.cloud.tencent.com/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).not.toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBeNull()
})
