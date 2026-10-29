// coeo91 on Discord: a Qoder account whose credits are used up still serves
// its free models — Qoder's docs: "When Credits run out, you can continue
// using free basic models" — but its usage counted them on the credits
// window at 100%, so magpie put the account last for them too. Each credit
// window now names the free models it doesn't count (notModels). Every
// fetch here is a fake; nothing reaches the network.
import { afterEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const json = (v, status = 200) => new Response(JSON.stringify(v), { status })

// a free account's envelope as Qoder gives it (plan 0, no add-on: "0
// credits left"), and a paid one used up beside add-on credits
const FREE = { displayMode: "qoder", qoderUsage: { userType: "personal_standard", userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" } } }
const SPENT = {
  displayMode: "qoder",
  qoderUsage: {
    userType: "personal_professional",
    userQuota: { total: 300, used: 300, remaining: 0, unit: "credits" },
    addOnQuota: { total: 100, used: 100, remaining: 0, unit: "credits" },
  },
}

// the listing's prices: 0× is free, a discount's 0 for a while isn't, a
// listing with no price says it with is_free
const LISTING = {
  app: [
    { key: "qfmodel", display_name: "Qwen3.8-Flash", enable: true, price_factor: 0.0, original_price_factor: 0.1, is_free: true },
    { key: "dfmodel", display_name: "DeepSeek-Flash", enable: true, price_factor: 0 },
    { key: "qmodel_38max", display_name: "Qwen3.8-Max", enable: true, price_factor: 0.5, is_free: true },
    { key: "window", display_name: "W", enable: true, price_factor: 0, promotion: { active: true, discount_factor: 0.0001, before_promotion_price_factor: 0.5 } },
    { key: "kmodel_latest", display_name: "Kimi-K3", enable: true, price_factor: 1.4 },
  ],
}

const account = () => ({
  type: "oauth",
  access: "jt-one",
  refresh: "rt-one",
  expires: Date.now() + 3_600_000,
  accountId: "one@x",
  uid: "u1",
  machineId: "m1",
  deviceToken: "dt-one",
  deviceRefresh: "drt-one",
})

async function usageOf(make, envelope, listing = () => json(LISTING)) {
  const seen = []
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    seen.push(path)
    if (path.endsWith("/me/usage")) return json(envelope)
    if (path.endsWith("/model/list")) return listing()
    return new Response("", { status: 404 })
  }
  const auth = account()
  const hooks = await make({ client: { auth: { set: async () => {} } } })
  return { u: await hooks.auth.usage(async () => auth), seen, hooks, auth }
}

for (const [make, site] of [[QoderAuthPlugin, "qoder"], [QoderCNAuthPlugin, "qoder-cn"]]) {
  test(`${site}: a free account's "0 credits left" doesn't count its free models`, async () => {
    const { u } = await usageOf(make, FREE)
    expect(u.windows).toEqual([{ name: "Credits", used: 100, display: "0 credits left", notModels: ["qfmodel", "dfmodel"] }])
  })

  test(`${site}: credits used up leave the free models out of every credit window`, async () => {
    const { u } = await usageOf(make, SPENT)
    expect(u.windows.map((w) => [w.name, w.used, w.notModels])).toEqual([
      ["Total credits", 100, ["qfmodel", "dfmodel"]],
      ["Credits", 100, ["qfmodel", "dfmodel"]],
      ["Add-on credits", 100, ["qfmodel", "dfmodel"]],
    ])
  })

  test(`${site}: a listing that can't be read counts every model, as before`, async () => {
    const { u } = await usageOf(make, SPENT, () => new Response("down", { status: 502 }))
    expect(u.windows.length).toBe(3)
    for (const w of u.windows) expect(w.notModels).toBeUndefined()
    expect(u.error).toBeUndefined()
  })

  test(`${site}: a listing with no free model counts every model`, async () => {
    const { u } = await usageOf(make, SPENT, () => json({ app: [LISTING.app[4]] }))
    for (const w of u.windows) expect(w.notModels).toBeUndefined()
  })

  test(`${site}: the listing the models hook read is the one used, not asked again`, async () => {
    let lists = 0
    const { hooks, auth } = await usageOf(make, FREE, () => (lists++, json(LISTING)))
    expect(lists).toBe(1)
    await hooks.provider.models({ models: {} }, { auth })
    expect(lists).toBe(2)
    expect((await hooks.auth.usage(async () => auth)).windows[0].notModels).toEqual(["qfmodel", "dfmodel"])
    expect(lists).toBe(2)
  })
}
