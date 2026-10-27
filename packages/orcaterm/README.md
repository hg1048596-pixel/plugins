# OrcaTerm

Tencent Cloud OrcaTerm's (腾讯云遨驰终端) AI assistant as a provider for magpie and OpenCode: its
built-in models — DeepSeek, Hunyuan, GLM, Kimi — answer through magpie's gateway, so any agent
magpie serves can use them.

## Before you use this: the terms

**This plugin uses OrcaTerm's built-in AI allowance from outside OrcaTerm, and Tencent's terms do
not clearly permit that.** Read this part before signing in.

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

## Signing in

There is one method: paste the cookie pair.

1. Sign in at <https://cloud.tencent.com> in a browser (the AI allowance follows the Tencent Cloud
   sign-in, not a separate OrcaTerm one).
2. Open DevTools → **Application** → **Cookies** → `https://cloud.tencent.com`.
3. Copy the values of **`uin`** and **`skey`**.
4. In magpie, run `magpie plugin login orcaterm` and paste them as `uin=o1234567890; skey=AbCdEf…`.

Both halves are required. The AI endpoint reads the pair as one credential: with only `skey`, or
with `p_uin`/`p_skey` under those names, it answers `NEED_UIN_AND_SKEY` and never looks further.

An automatic browser sign-in was tried and dropped: the pair is an HttpOnly cookie, the browser
never hands it to another program, and the WeChat callback address is fixed server-side, so nothing
can be redirected to a local listener. Pasting once is the whole of it — magpie keeps the pair in
`plugin-auth.json` (mode 600) and asks for nothing again until `skey` expires.

## Models

| id | name | reasoning |
| --- | --- | --- |
| `deepseek-chat-latest` | DeepSeek-V4-Pro | ✓ |
| `hy3-preview` | Hy3-preview (混元) | ✓ |
| `glm-4.7` | GLM-5.2 | |
| `glm-4.7-thinking` | GLM-5.2 Thinking | ✓ |
| `kimi-k2` | Kimi-k2.6 | |
| `kimi-k2-thinking` | Kimi-k2 Thinking | ✓ |
| `hunyuan-turbos` | Hunyuan TurboS | |
| `hunyuan-t1` | Hunyuan T1 | ✓ |

Short aliases work too (`deepseek`, `kimi`, `glm`, `hunyuan`). A model id the plugin doesn't know is
passed through, so a model Tencent adds later can be used before this package learns about it.

## How a request travels

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

## Quota

`auth.usage` reads `DescribeUserBillingStatus` and reports the `hunyuan_ai` row — the AI answer
allowance, 1000 questions a month on the basic edition — as `amount / limit` with its reset date.
The other rows there (session sharing, secrets, space) are not shown: they are unrelated resources,
and session sharing's unlimited `-1` would read as an exhausted account.

## Tests

```bash
bun test
```

`signin.test.mjs` covers the cookie shapes and what each upstream refusal means for the account;
`request.test.mjs` the body translation; `stream.test.mjs` the SSE conversion; `usage.test.mjs` the
quota rows. No test signs in or reaches the network — `fetch` is replaced in each.
