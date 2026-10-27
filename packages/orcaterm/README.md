# @magpie-community/opencode-orcaterm-auth

Signs in to **Tencent Cloud OrcaTerm** (腾讯云遨驰终端) and serves its AI assistant's models —
DeepSeek, Hunyuan, GLM and Kimi — in OpenCode and magpie. Provider id: `orcaterm`.

> **Unofficial.** This package is not affiliated with, authorised or endorsed by Tencent; its
> names and marks belong to their owners. It talks to the non-public APIs the OrcaTerm web
> client uses and identifies itself the way that client does, which may not be allowed by
> Tencent's terms, and those APIs may change at any time. Use it at your own risk, including
> the risk of restrictions on your account — see [Before you use this](#before-you-use-this-the-terms).

## Install

```sh
magpie plugin add @magpie-community/opencode-orcaterm-auth
magpie plugin login orcaterm
```

or install it from magpie's Plugins tab and sign in there.

## Before you use this: the terms

**This plugin uses OrcaTerm's built-in AI allowance from outside OrcaTerm, and Tencent's terms do
not clearly permit that.** Read this part before signing in.

### What the cookie pair actually is

`uin` and `skey` are **not an OrcaTerm token**. They are the **full Tencent Cloud console session**
— the same pair that gets you into the console, your CVM and Lighthouse instances, your billing,
your API keys. Anything holding them can act as you across Tencent Cloud, not just in OrcaTerm.

So the account you risk is not "an OrcaTerm account". It is **the account that holds your servers
and your billing**, and Tencent Cloud's service agreement 5.8 lets Tencent limit, suspend or
terminate that account and freeze it. **Do not use an account that owns production resources.**
If you want to try this, use a separate account with nothing behind it.

The plugin sends the pair to two hosts and no others — `lightai.cloud.tencent.com` (the assistant)
and `api.orcaterm.cloud.tencent.com` (quota). It does not share, resell or pool quota, and it makes
no attempt to evade anti-abuse checks. None of that changes the paragraph above.

### Why the terms do not clearly allow it

OrcaTerm's user agreement reserves everything it has not explicitly granted:

- **2.3** — "本条及本协议其他条款未明示授权的其他一切权利仍由腾讯保留，您在行使这些权利时须另外取得腾讯的书面许可。"
- **2.1** — defines the service as OrcaTerm itself (remote connection, sign-in, file management).
  The built-in AI allowance (1000 questions a month on the basic edition, 6000 on professional) is a
  resource entitlement attached to the product; it is never described as an API callable from
  elsewhere.

Related clauses that this use touches: 3.5.3 (using data without permission), 3.5.5 (probing or
testing the platform), 3.5.7 (gaining advantage through a bug), 6.5(4) (using the service in a way
Tencent has not authorised). Tencent Cloud's service agreement 5.7(3) covers unauthorised access and
interference.

The consequences are concrete: 4.4.1 and 7.2 allow Tencent to limit features, suspend the account
or terminate the service, and Tencent Cloud's agreement 5.8 allows the same plus freezing the
account.

**One detail worth weighing:** OrcaTerm's official OpenAPI exposes session and sign-in calls —
`DescribeInstancesFeatureStatus`, `GenerateAuthLoginUrl`, `GetUserInfo`, `StartSSHTerminalSession`,
`StartRDPTerminalSession`, `VerifyOAuthUser` — and **no AI question endpoint at all**. The allowance
is not built to be called from outside the product.

What is clearly allowed: asking OrcaTerm's assistant questions inside OrcaTerm's own web, desktop or
mini-program clients; and attaching **your own** API key through OrcaTerm's custom-model setting
(officially: "自定义 AI 模型不会消耗 AI 问答次数额度").

**So: if you use this plugin, the risk is yours.** This project does not claim Tencent permits it,
does not resell or share quota, and is not affiliated with Tencent. If your account matters to you,
use the custom-model path with your own key instead, or ask Tencent for written permission first.

### On the assistant's own tools

The assistant is attached to the user's servers, and it runs in RE_ACT mode. This plugin sends no
tools, no MCP servers and no approved tools, which is what keeps it to answering questions — but
that is the request being empty of tools, not proof the assistant can do nothing on its own side.
`hideToolMessage` is therefore left `false`, so that if anything does run, its trace stays in the
reply where you can see it.

## Sign-in

Two credentials can drive the assistant, and they are **not** equal in scope:

| Credential | Comes from | Lifetime | Authority |
| --- | --- | --- | --- |
| **WeChat OAuth access token** (recommended) | scanning a QR code | 2 hours, renewed automatically | OrcaTerm only |
| `uin` + `skey` | your Tencent Cloud **console session** | until you sign out of the console | your whole Tencent Cloud account |

The QR route is preferred: it is the same sign-in the OrcaTerm clients use, and the token it yields
cannot touch anything outside OrcaTerm. Either kind is accepted — the plugin tells them apart by the
key's shape.

### Scan a QR code (recommended)

```sh
magpie plugin login orcaterm     # choose the first entry
```

A page opens at <http://127.0.0.1:4080/login> with a WeChat QR code. Scan it and the plugin carries
on by itself — there is no URL to copy.

How the callback is captured: the page embeds WeChat's `qrconnect` widget through the official
`wxLogin.js` with `self_redirect: true`. After a scan, the return to
`orcaterm.com/oauth/wechat/bridge?code=…&state=…` happens inside the widget's **own inner iframe**,
so that page's `window.parent` is still our page and its `postMessage` arrives. Without
`self_redirect`, WeChat navigates the top window instead, which replaces the page and loses the
message — that is the one detail the whole flow hangs on.

Behind a remote deploy the page listens on the server's loopback and your browser cannot reach it:

```sh
ssh -L 4080:127.0.0.1:4080 <server>
```

`ORCATERM_CAPTURE_PORT`, `ORCATERM_CAPTURE_HOST` and `ORCATERM_CAPTURE_BASE` override the address.

The token is renewed before it expires through `OAuthRefreshToken`, so a normal session never asks
you to scan again.

### Paste the cookie pair (fallback)

1. Sign in at <https://cloud.tencent.com> in a browser (the AI allowance follows the Tencent Cloud
   sign-in, not a separate OrcaTerm one).
2. Open DevTools → **Application** → **Cookies** → `https://cloud.tencent.com`.
3. Copy the values of **`uin`** and **`skey`**.
4. In magpie, run `magpie plugin login orcaterm` and pick the paste entry, as
   `uin=o1234567890; skey=AbCdEf…`.

Both halves are required. The AI endpoint reads the pair as one credential: with only `skey`, or
with `p_uin`/`p_skey` under those names, it answers `NEED_UIN_AND_SKEY` and never looks further.

## Models

Use only what OrcaTerm's own model picker offers. The ids are **namespaced** — `TokenHub/<model>`
and `Hunyuan3/<model>` — and that prefix is the whole difference: sent bare, `glm-5.3` answers
`LLM(glm-5.3) is not loaded`, while `TokenHub/glm-5.3` answers.

| id | label in the picker | reasoning |
| --- | --- | --- |
| `TokenHub/deepseek-v4-pro` | Deepseek-V4-Pro | ✓ |
| `TokenHub/deepseek-v4-flash` | DeepSeek-V4-Flash | |
| `TokenHub/deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | |
| `TokenHub/glm-5.3` | GLM-5.3 | ✓ |
| `TokenHub/glm-5.3-flash` | GLM-5.3-Flash | |
| `TokenHub/glm-5.2` | GLM-5.2 | |
| `TokenHub/kimi-k3` | Kimi-K3 | |
| `Hunyuan3/hy3` | Hy3 | ✓ |
| `Hunyuan3/hy4-preview` | Hy4-preview | ✓ |

**Do not use the others.** A few more ids answer on the endpoint but **cannot be selected in
OrcaTerm's own model picker** — `glm-4.7-thinking`, `kimi-k2-thinking`, `kimi-k2.5`,
`kimi-k2.5-thinking`, `kimi-latest`, `hunyuan-turbos`, `qwen3`, `deepseek-reasoner`. Calling them
means going around the product's own interface, which the service may treat as abnormal use, and
**your account may be restricted for it**. They remain resolvable only so that existing configs
keep working; a new config should use the nine above.

Aliases work too (`deepseek`, `kimi`, `glm`, `hunyuan`), as do the picker labels themselves
(`Deepseek-V4-Pro`, `GLM-5.3`, `Hy3-preview`…), and the older ids (`deepseek-chat-latest`,
`glm-4.7`, `kimi-k2`, `hunyuan-t1`) resolve to their current equivalents.

Context and output limits are estimates: the upstream publishes no window size per model.

## When the upstream refuses

OrcaTerm answers a refusal **inside the stream** — `data: [ERROR]: …` — with HTTP 200 still on the
status line. Taken at face value a used-up allowance would look like a normal reply, and magpie
would neither fail over to another account nor let this one rest. So the plugin reads the head of
the stream first (`peekAnswer`, as `packages/codearts` does) and answers with a real status:

| Upstream says | Status returned | What magpie does |
| --- | --- | --- |
| `quota`, `额度`, `次数已用完`, `余额不足` | **429** | fail over to the next account, rest this one |
| `rate limit`, `频繁`, `限流` | **429** | same |
| `NEED_UIN_AND_SKEY`, `VERIFY_SKEY_UIN_FAILED`, `VERIFY_LOGIN_FAILED`, `VERIFY_USER_FAILED` | **401** + `X-Magpie-Sign-In: expired` | mark the account, stop sending to it |
| anything else (model unavailable, internal error) | **502** | fail over |
| the connection dies mid-stream | the stream is errored, `statusCode` 499 (cancelled) or 502 | fail over |
| the connection dies without streaming | **499** / **502** | fail over |

A refusal that arrives after the answer has started is delivered as a stream error rather than as
text, so it still counts as a failure.

## Requests

magpie's gateway turns whatever protocol the agent speaks into a Chat Completions body and hands it
to this plugin's `fetch`. That body becomes one assistant turn — a conversation id, a user id, the
last user message as `input.content`, the earlier turns as `input.historyMessages`, and any system
text as a prefix, since the assistant has no system role. The upstream answers in SSE frames whose
`content` is that frame's addition (and whose `fullContent`, when present, is everything so far);
those become OpenAI deltas, with reasoning kept in `reasoning_content`.

Two consequences worth knowing:

- **No tool calls.** The assistant runs its own tools server-side and never emits `tool_calls`, so
  the models are declared with `tool_call: false`. A client's tool calls and their results are
  written into the conversation as text so nothing is lost, but the agent does the calling itself.
- **No images.** `image_url` parts become a `[图片]` note.

Token counts are not reported: the upstream returns none, and an estimate passed off as real usage
would make both cost and context accounting wrong. A caller that asks for `include_usage` gets the
answer without a usage block.

## Quota

`auth.usage` reads `DescribeUserBillingStatus` and reports the `hunyuan_ai` row — the AI answer
allowance, 1000 questions a month on the basic edition — as `amount / limit` with its reset date.
The other rows there (session sharing, secrets, space) are not shown: they are unrelated resources,
and session sharing's unlimited `-1` would read as an exhausted account.

## Tests

```sh
bun test
```

42 tests over six files. No test signs in or reaches the network — `fetch` is replaced in each.

| file | what it holds |
| --- | --- |
| `signin.test.mjs` | the cookie shapes, and what each refusal means for the account |
| `request.test.mjs` | the Chat Completions → assistant body translation |
| `stream.test.mjs` | the SSE → OpenAI chunk conversion |
| `chunks.test.mjs` | frames that look cumulative but aren't; a frame split across chunks; a reset mid-stream; cancelling reaching the upstream |
| `peek.test.mjs` | a refusal read from the head of the stream becoming 429/401/502, and a real answer surviving the peek |
| `usage.test.mjs` | which `usageStats` row is the AI allowance |

`chunks.test.mjs`'s cancel case fails if `releaseUpstream()` is removed, so the leak stays fixed.

## 中文

在 OpenCode 和 magpie 里使用**腾讯云遨驰终端（OrcaTerm）** AI 助手的模型：DeepSeek、混元、
GLM、Kimi。provider id：`orcaterm`。

> **非官方插件**：与腾讯、腾讯云及 OrcaTerm（遨驰终端）没有任何关联，也未获其授权或认可。
> 插件调用的是 OrcaTerm 网页端使用的非公开接口，并以与官方客户端相同的方式标识自己，
> 这可能不符合腾讯云的服务条款，接口也可能随时变更。使用风险（包括账号受限）由使用者自行承担。

- **登录**：首选**微信扫码**（`magpie plugin login orcaterm` 第一项），拿到的是 OrcaTerm 自己的
  OAuth accessToken —— 两小时有效、自动续期、只能用于 OrcaTerm。备选是粘贴 `uin` + `skey`：
  这两个是**腾讯云控制台的完整会话 cookie**，不是 OrcaTerm 专用令牌 —— 拿到它们就能在腾讯云范围内
  以你的身份操作，包括你的服务器和账单。**不要用持有生产资源的账号**，想试就用一个名下没有东西的独立账号。
- **条款**：OrcaTerm 用户协议 2.3 保留所有未明示授权的权利，2.1 把服务限定为 OrcaTerm 本身；
  内置 AI 额度是绑在产品上的资源权益，从未被授权为可外部调用的接口。相关条款还有 3.5.3、
  3.5.5、3.5.7、6.5(4) 与腾讯云服务协议 5.7(3)，后果见 4.4.1、7.2 与 5.8（可限功能、封号、终止服务）。
  一个细节：官方 OpenAPI 有会话与登录接口，**唯独没有任何 AI 问答接口**。
- **模型**：只用 OrcaTerm 模型选择器里能选到的那九个 —— `TokenHub/deepseek-v4-pro`、
  `TokenHub/deepseek-v4-flash`、`TokenHub/deepseek-v4.1-flash`、`TokenHub/glm-5.3`、
  `TokenHub/glm-5.3-flash`、`TokenHub/glm-5.2`、`TokenHub/kimi-k3`、`Hunyuan3/hy3`、
  `Hunyuan3/hy4-preview`。**id 必须带命名空间前缀**，否则上游答 `LLM(x) is not loaded`。
  **其余 id 不要用**（如 `qwen3`、`deepseek-reasoner`、`kimi-latest`、`hunyuan-turbos`、
  `glm-4.7-thinking` 等）：它们在选择器里选不到，属于绕过界面调用，**有封号风险**。
- **额度**：`magpie quota` 显示每月问答次数（基础版 1000 次）与重置日期。扫码登录的账号读不到
  配额（额度接口只认控制台会话），这不影响使用。
- **失败会如实报错**：上游把失败写在 SSE 里（`data: [ERROR]: …`），HTTP 状态仍是 200。
  插件会先读流头，把配额用完/限流回成 429、登录失效回成 401 并标记账号，这样 magpie 才会换账号
  或让账号歇着，而不是把失败当成一次正常回答。
- **不做工具调用、不支持图片**：助手在服务端跑自己的工具，插件只做文本往返。

## License

MIT — see [LICENSE](../../LICENSE).
