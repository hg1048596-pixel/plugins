# Kimi Work

Use the ordinary **Kimi desktop Work subscription** as a provider in Magpie or OpenCode. This is separate from Kimi Code's subscription/API and from the Kimi agent package, which sends Kimi's inference in the opposite direction to Magpie.

```sh
magpie plugin add @magpie-community/opencode-kimi-work-auth
magpie plugin login kimi-work
```

Open Kimi desktop and sign in to Work on the same computer first. Choose **使用本机 Kimi Work 登录** in the provider's sign-in menu. There is no browser sign-in or API-key fallback in this package. It cannot sign in on a headless machine without an existing desktop session file.

## Models and requests

The account's models and reasoning options come from the two lists Kimi's desktop reads: Work's model menu, `kimi.gateway.config.v1.ConfigService/DescribeKimiWorkConfig` on `www.kimi.com` (asked with the desktop's web sign-in), and `https://agent-gw.kimi.com/coding/v1/models`. The menu lists the models a membership tier adds (K3.1 Pro on the 99 plan) that `/models` leaves out; since 0.1.7 both are listed, the menu's names first, and either one failing leaves the other. Since 0.1.9 the menu is asked with the headers the desktop sends it (`x-msh-platform` `mac` or `windows`, `x-msh-version`, `R-Timezone`): asked without them, Kimi answers with the web menu, which has no K3.1 Pro (`k3d1-agent`). Since 0.1.10, when the menu can't be had with the web sign-in (Kimi's file holds a web sign-in www.kimi.com no longer takes, answered 401, or another failure or an empty reply), it is asked again without one, as the desktop asks it before signing in, which gives the same desktop menu; each failure is written to Magpie's log, without the token. Chat completions, streaming, tool calls and cancellation use the same Work gateway, with the headers Kimi's own Work client sends it (0.1.8). It never uses `api.kimi.com` or a Kimi Code API key.

Version 0.1.4 preserves the calling agent's shared instructions, prompts, history and tools unchanged. Since 0.1.5 one exception: tool schemas Kimi's "moonshot flavored json schema" check refuses are rewritten to an equivalent it takes (#287). A `$ref` beside a `type`, as zod writes a schema derived from a reused one, gets its target written in; a `type` beside an `anyOf` is left out; an untyped `enum`, `const` or `$ref` target gets the type its values or keywords say. A request with none of these goes byte for byte. Instructions, MCP and skills are assigned to that agent in Magpie's Library; the provider does not create a second target or enable resources on its own. The ordinary Kimi agent's Library support starts at `@magpie-community/agent-kimi-desktop` 0.1.1.

An inference HTTP 401 marks the provider sign-in as expired (`kimi_work_login_expired`). Sign in to desktop Work if needed, then **reconnect Kimi Work in Magpie** (or run `magpie plugin login kimi-work`); signing in to the desktop alone does not reconnect the provider. A 403 whose body says the allowance is spent (Kimi's "You've reached your usage limit for this billing cycle", `resource_exhausted` "insufficient balance") goes to Magpie as a 429 with Kimi's body and headers, so Magpie rests that account until its allowance is back and asks another one (#465); any other 403 passes through as a 403. Other HTTP errors, including 429 and 5xx, pass through unchanged with Kimi's status, headers, body and Retry-After. This preserves the distinction between concurrency limits and exhausted allowance, including any upstream reset details. Network failures use `kimi_work_connection_failed` and retain the underlying cause code or fetch error message for diagnosis. Rate limits and service failures do not invalidate the desktop sign-in. Cancellation stays cancellation. No automatic retry sends a conversation twice or falls back to Code.

Models use standard context, capped at 262,144 tokens, rather than silently enabling the higher-priced XL context. The reply limit is the menu's `maxTokens` (32,768 for every model it lists today). Until the signed-in account's live catalog is read, and when it can't be, the models offered are `kimi-work/k3-agent` and `kimi-work/k2d8-preview`, the two ids Work's `/models` has listed; the live catalog replaces them, so a model Kimi adds to the account (such as K3.1 Pro) shows under the id the menu gives it. Since 0.1.6 a model whose reasoning levels come in a shape not seen before keeps the levels that can be read, rather than the whole catalog failing over to the fallback.

Usage comes from Kimi's membership `GetSubscriptionStats` endpoint and is labelled **shared membership allowance**, not a separate free Work allowance. No reset time is reported: `subscriptionBalance.expireTime` and `upcomingExpiration.timestamp` are expiration fields, and have not been verified to describe allowance resets. An observed Windows request was classified by Kimi as `FEATURE_WORK` while the Code five-hour and weekly ratios stayed unchanged. This is an observation, not a promise about future quota accounting: Kimi controls billing, shared allowances, access and rate limits.

Every reasoning-effort value returned by `/models` is retained, including `STANDARD` if listed. The checked Windows catalog in `tests/fixtures/work-models.redacted.json` lists `LOW` (displayed by Kimi as **Standard**), `HIGH` and `MAX`; the plugin sends the advertised effort value instead of guessing from the display label.

## Sign-in and local files

The plugin reads only the desktop app's `daimon/config.json`, and since 0.1.13 its `daimon/kimi-code-key.json`, in its `daimon-share` folder. That folder is where Kimi's own `daimon-storage.json` points (`shareDir`), or, with no such file, `daimon-share` itself, in Kimi's data folder:

- Windows: `%APPDATA%/kimi-desktop/`
- macOS: `~/Library/Application Support/kimi-desktop/`
- Linux: `~/.config/kimi-desktop/`

Kimi 3.2.21 on Windows, installed on another drive than `%APPDATA%`'s, keeps it there (`D:\KimiData\daimon-share` for an install on D:), and Kimi writes the same pointer on any system when its storage is moved. When the sign-in can't be found, the error names the file it looked for. Since 0.1.13, when the `daimon-share` folder itself is gone (moved, deleted, or on a drive that isn't mounted), the error names that folder instead (`kimi_work_share_missing`) and does not mark the account signed out: the sign-in in it isn't known to have lapsed. Putting the folder back makes the account work again at once, with no new sign-in. Kimi makes the folder again only when it starts, so signing in again in a running Kimi doesn't bring it back; quit and reopen Kimi, then sign in to Work.

The internal Work credential is named `credentials.kimiCode`, but its origin must be exactly `https://agent-gw.kimi.com/coding/v1`. `credentials.kimiWeb` supplies the membership sign-in. The plugin rejects missing credentials and other origins. It saves only a hashed account reference in Magpie/OpenCode's auth store; the actual tokens remain in Kimi's own files (`config.json`, and `kimi-code-key.json` for an account Kimi has switched away from) and are reread on each operation. It never reads Magpie's credential files, writes Kimi configuration, consumes refresh tokens, or stores copies of desktop credentials.

Kimi desktop remains responsible for refreshing its sign-in. If it expires, sign in there and reconnect this provider. Each synced device must have its own Kimi desktop sign-in.

### Several Kimi accounts

Since 0.1.13 each Kimi user signed in here is an account of its own (named `Kimi Work · ` and the start of its hashed id), and requests never switch silently from one to another. To add a second one, switch Kimi desktop to that user, open Work once, and sign in to this provider again. Both keep working after Kimi switches back and forth: Kimi keeps one minted Work key per user in `daimon/kimi-code-key.json` (`{"v":2,"keys":[{userId,apiKey,keyId?}]}`, Kimi 3.2.21) and reuses a user's key when it switches back to them; it drops one only when the Work gateway refuses it. The account Kimi is signed in to uses `config.json`'s key; any other uses its key from that file. Only the user Kimi is signed in to has a web sign-in, so the shared membership allowance can be read only for that account; the others show that they need switching to in Kimi, and chat is unaffected. An account whose key is no longer in Kimi's file, or whose key the gateway refuses, is marked signed out (`kimi_work_account_not_here`) until Kimi is switched to it and opens Work. Kimi signed out entirely (no Work sign-in in `config.json`) serves none of them. Accounts signed in before 0.1.13 are named `Kimi Work (local)`; signing in to the same user again adds it under the new name, and the old entry can be removed.

## Origin and provider-id conflict

This submission packages the local desktop-sign-in implementation from [`kupakupar/kimi-work-provider`](https://github.com/kupakupar/kimi-work-provider), whose Git-installed package was version 0.1.2. The community package now starts at 0.1.3. The previously stated preservation of model IDs/account references referred only to that implementation: both use `source: "kimi-work-desktop"` and a hashed account reference.

The separate MIT-licensed [`kimi-work-opencode`](https://www.npmjs.com/package/kimi-work-opencode) by Jared Boynton also uses provider ID `kimi-work`. It is not the source or a dependency of this package, and no migration from its authentication format is implemented. **Do not enable both packages together:** they claim the same provider/auth hooks, so load order can replace model/configuration or sign-in handling. Back up your configuration, keep only the desired plugin enabled, and reconnect it using its own sign-in method. This package does not automatically delete or convert the other package's settings or login data.

## Compatibility and validation

These are undocumented desktop interfaces, not a supported public Kimi API. Windows and Apple-silicon macOS have been tested with real Work inference, including streaming. The [macOS record](COMPATIBILITY.md) includes the Kimi build, observed file/fields, real Magpie route and test limits. Linux and Intel macOS remain unverified. Changed desktop layouts stop with a sign-in error; changed upstream schemas stop model discovery or usage with an error. Inference failures are returned without retrying against Code or another service. Users remain responsible for their subscription's terms.

```sh
bun test packages/kimi-work
bun scripts/check.mjs kimi-work
```

Tests use synthetic sessions and fake HTTP responses: credential separation/rotation, read-only local import, account changes, endpoint restrictions, streaming/tool preservation, model discovery and shared-usage accounting. No account, token, prompt, conversation or vendor binary is distributed. No runtime dependencies.
