// The quota magpie shows comes from DescribeUserBillingStatus's usageStats,
// where only hunyuan_ai is the AI-answer allowance. The other rows there
// (session sharing, secrets, space) are unrelated, and reporting one of
// them as the AI window would show a number that never moves.
import { afterEach, expect, test } from "bun:test"
import { OrcaTermAuthPlugin } from "./index.mjs"

// The suite fires far more than the account's ten-a-minute budget; lift the
// pacer so these tests measure the plugin, not the limiter.
process.env.ORCATERM_NO_PACE = "1"


const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const usage = async (reply) => {
  globalThis.fetch = async () => reply()
  const hooks = await OrcaTermAuthPlugin({ client: { app: { log: () => {} } } })
  return hooks.auth.usage(async () => ({ type: "api", key: "uin=o1234567890; skey=deadbeef" }))
}

const billing = (usageStats) =>
  new Response(JSON.stringify({ data: { Response: { roleType: "basic", usageStats } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

test("the AI allowance is reported as used out of its limit", async () => {
  const u = await usage(() =>
    billing([
      { feature: "session_share", quotaLimit: -1, quotaUsed: 0 },
      { feature: "hunyuan_ai", quotaLimit: 1000, quotaUsed: 370 },
    ]),
  )
  expect(u.windows).toHaveLength(1)
  expect(u.windows[0].name).toBe("AI Q&A")
  expect(u.windows[0].amount).toBe(370)
  expect(u.windows[0].limit).toBe(1000)
  expect(u.windows[0].used).toBe(37)
  expect(u.plan).toContain("basic")
})

// The unrelated rows must not be shown: session sharing's -1 limit would
// read as an exhausted account.
test("rows that are not the AI allowance are left out", async () => {
  const u = await usage(() =>
    billing([
      { feature: "session_share", quotaLimit: -1, quotaUsed: 0 },
      { feature: "secret", quotaLimit: 5, quotaUsed: 1 },
    ]),
  )
  expect(u.windows).toHaveLength(0)
  expect(u.error).toBeTruthy()
})

// A refusal here is the sign-in's, and magpie should mark the account
// rather than keep asking it for quota.
test("a refused quota read marks the sign-in", async () => {
  const u = await usage(
    () =>
      new Response(JSON.stringify({ data: { Response: { Error: { Code: "VERIFY_SKEY_UIN_FAILED" } } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  )
  expect(u.signIn).toBe("expired")
  expect(u.windows).toEqual([])
})

// Reading quota must never throw: a broken answer would take down the
// account card instead of just leaving the number out.
test("an unreadable answer becomes an error string, not a throw", async () => {
  const u = await usage(() => new Response("not json", { status: 200 }))
  expect(typeof u.error).toBe("string")
  expect(u.windows).toEqual([])
})
