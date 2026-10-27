/**
 * opencode-orcaterm-auth
 *
 * OrcaTerm (腾讯云遨驰终端, Tencent Cloud's terminal) AI reverse proxy: both an
 * OpenCode v1 plugin and a magpie provider plugin.
 *
 * Upstream protocol (reverse-engineered from orcaterm.cloud.tencent.com's
 * frontend bundle, the 2026-10 build):
 *   chat endpoint   POST {ASSISTANT_BASE}/chat?name=<assistant>&mode=<0|1|2>&csrfCode=<skey-hash>
 *                   body: {conversationId, user:{id, setting:{...}}, input:{id, content, files,
 *                          historyMessages}, stream:true}
 *                   headers: x-seqid + cookie(uin/skey) + the browser-family headers
 *                   response: SSE, one `data: {...}` per line; the text is in content, the
 *                   thinking in reasoningContent
 *   account API     POST https://api.orcaterm.cloud.tencent.com/cgi/api?<signed action>
 *                   body: {action, data}; signed head and tail (X-CsrfCode is the djb2 of
 *                   the cookie's skey)
 *
 * The outward contract of this file follows magpie's docs exactly:
 *   config / auth{methods, loader, usage} / provider.models / chat.headers
 */
import { createHash, randomBytes } from "node:crypto"

const PROVIDER = "orcaterm"

// ---- upstream constants (the only place to change them) ---------------------
const ASSISTANT_BASE = "https://lightai.cloud.tencent.com/assistant"
const CAPI_ORIGIN = "https://orcaterm.cloud.tencent.com"
const CAPI_URL = "https://api.orcaterm.cloud.tencent.com/cgi/api"
const WEB_TERMINAL = "https://orcaterm.cloud.tencent.com/terminal"

/** OrcaTerm's built-in assistants (lighthouse/orcaterm/cvm...): which script and tool set runs */
const ASSISTANT = {
  orcaterm: "orcaterm",
  lighthouse: "lighthouse",
}
/** 0=RE_ACT 1=PLAN_ACT 2=AUTO_ACT */
const MODE = { react: 0, planact: 1, autoact: 2 }

/**
 * Upstream model ids (the frontend's bt.* constants, 2026-10 snapshot).
 *
 * `id` is what actually goes into the request body as the model; `name` is only
 * shown in the picker, so it has to match the id — earlier the marketing names
 * on the UI (DeepSeek-V4-Pro, GLM-5.2, Kimi-k2.6) were taken for model names.
 * Those were guessed from interface copy, with nothing behind them, and they
 * don't match what the server actually serves.
 *
 * The context and output caps are estimates too: upstream never publishes a
 * window size for a model.
 */
const MODEL_SPECS = [
  {
    id: "deepseek-chat-latest",
    name: "deepseek-chat-latest",
    reasoning: true,
    context: 128000,
    output: 32000,
    tool_call: false,
    aliases: ["deepseek", "deepseek-v3", "deepseek-chat", "deepseek-v4", "deepseek-v4-pro"],
  },
  {
    id: "hy3-preview",
    name: "hy3-preview",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    // "hunyuan-t1" used to hang off this entry, but there is a real hunyuan-t1
    // model below, which would shadow the alias — keeping it here only misleads.
    aliases: ["hy3", "hunyuan", "hunyuan-3"],
  },
  {
    id: "glm-4.7",
    name: "glm-4.7",
    reasoning: false,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["glm", "glm-5", "glm-5.2", "bigmodel"],
  },
  {
    id: "glm-4.7-thinking",
    name: "glm-4.7-thinking",
    reasoning: true,
    context: 200000,
    output: 32000,
    tool_call: false,
    aliases: ["glm-thinking", "glm-5.2-thinking"],
  },
  {
    id: "kimi-k2",
    name: "kimi-k2",
    reasoning: false,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["kimi", "kimi-k2.6", "moonshot"],
  },
  {
    id: "kimi-k2-thinking",
    name: "kimi-k2-thinking",
    reasoning: true,
    context: 256000,
    output: 32000,
    tool_call: false,
    aliases: ["kimi-thinking"],
  },
  {
    id: "hunyuan-turbos",
    name: "hunyuan-turbos",
    reasoning: false,
    context: 128000,
    output: 16000,
    tool_call: false,
    aliases: ["turbos"],
  },
  {
    id: "hunyuan-t1",
    name: "hunyuan-t1",
    reasoning: true,
    context: 128000,
    output: 16000,
    tool_call: false,
    aliases: ["hunyuan-t1-latest"],
  },
]

const ALIAS_TO_ID = (() => {
  const m = new Map()
  for (const spec of MODEL_SPECS) {
    m.set(spec.id.toLowerCase(), spec.id)
    for (const a of spec.aliases) m.set(a.toLowerCase(), spec.id)
  }
  return m
})()

// ---- small helpers ----------------------------------------------------------
function uid(prefix = "") {
  return prefix + randomBytes(12).toString("hex")
}

/** Tencent's skey-style csrf: djb2 of the cookie's skey, & 0x7fffffff */
function csrfCode(skey) {
  if (!skey) return ""
  let h = 5381
  for (let i = 0; i < skey.length; i++) h = ((h << 5) + h + skey.charCodeAt(i)) | 0
  return String(h & 0x7fffffff)
}

function parseTicket(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return null
  const out = { uin: "", skey: "", p_skey: "", p_uin: "", raw: "" }

  if (text.includes("=") && text.includes(";")) {
    out.raw = text
    for (const part of text.split(";")) {
      const eq = part.indexOf("=")
      if (eq < 0) continue
      const k = part.slice(0, eq).trim()
      const v = part.slice(eq + 1).trim()
      if (k === "uin" || k === "p_uin") out[k] = v
      else if (k === "skey" || k === "p_skey") out[k] = v
    }
  } else if (text.includes("=")) {
    // a single k=v, or k=v&k=v
    const pairs = text.split(/[&\s]+/)
    const obj = {}
    for (const p of pairs) {
      const eq = p.indexOf("=")
      if (eq > 0) obj[p.slice(0, eq).trim()] = p.slice(eq + 1).trim()
    }
    if (obj.skey || obj.p_skey || obj.uin || obj.p_uin) {
      Object.assign(out, {
        uin: obj.uin || obj.p_uin || "",
        skey: obj.skey || "",
        p_skey: obj.p_skey || obj.skey || "",
        p_uin: obj.p_uin || obj.uin || "",
      })
      out.raw = text
    } else {
      // one value alone: treat it as the skey
      out.skey = text
    }
  } else {
    out.skey = text
  }

  if (!out.skey && out.p_skey) out.skey = out.p_skey
  if (!out.uin && out.p_uin) out.uin = out.p_uin
  if (!out.skey) return null
  if (!out.raw) {
    out.raw = [out.uin && `uin=${out.uin}`, `skey=${out.skey}`].filter(Boolean).join("; ")
  }
  return out
}

/**
 * The cookie header upstream accepts.
 *
 * Measured (2026-10-26, lightai gateway):
 *   - skey alone          → NEED_UIN_AND_SKEY
 *   - p_uin+p_skey alone  → NEED_UIN_AND_SKEY
 *   - uin + skey          → VERIFY_SKEY_UIN_FAILED (it reaches the verify layer;
 *                           fake credentials stop there)
 *   - uin with or without the o prefix → both accepted
 * So uin and skey must be a pair, and both real: no placeholder uin is derived
 * here any more.
 */
function cookieHeader(auth) {
  const t = auth?.ticket
  if (!t?.skey || !t?.uin) return ""
  const parts = [`uin=${t.uin}`, `skey=${t.skey}`]
  if (t.p_skey) parts.push(`p_skey=${t.p_skey}`)
  if (t.p_uin) parts.push(`p_uin=${t.p_uin}`)
  return parts.join("; ")
}

function fingerprint(auth) {
  // account identity: uin + the first 12 characters of skey
  const t = auth?.ticket
  const uin = t?.uin || t?.p_uin || ""
  return `${uin}:${String(t?.skey ?? "").slice(0, 12)}`
}

function baseHeaders(extra = {}) {
  return {
    accept: "text/event-stream",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    origin: CAPI_ORIGIN,
    referer: `${WEB_TERMINAL}`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ...extra,
  }
}

/**
 * magpie's docs: init.body is a JSON string, **or bytes when it isn't UTF-8
 * text**. This folds the shapes (string / Uint8Array / ArrayBuffer / any object
 * that isn't a readable stream) into text.
 */
function bodyToText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (typeof body === "object") {
    // URLSearchParams and the like
    if (typeof body.toString === "function" && body.constructor?.name !== "Object") return String(body)
    try {
      return JSON.stringify(body)
    } catch {
      return ""
    }
  }
  return String(body)
}

// ---- model resolution -------------------------------------------------------
function resolveModel(requested) {
  const raw = String(requested ?? "").trim()
  const key = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw
  // An empty string, or a bare slash ("orcaterm/"), falls back to the default
  // model: an empty model must never be sent upstream
  if (!key) return MODEL_SPECS[0].id
  const hit = ALIAS_TO_ID.get(key.toLowerCase())
  if (hit) return hit
  // so a model upstream adds later doesn't 404: pass it through as given
  return key
}


// ---- request body: OpenAI Chat Completions → OrcaTerm assistant -------------
/**
 * OrcaTerm's assistant only takes "one user message + a list of history
 * messages"; it has no system field. So OpenAI's messages are squeezed into:
 *   - system/developer joined together at the head of input.content (marked, so
 *     the model can tell them apart)
 *   - everything except the last user message goes into historyMessages
 *   - assistant.tool_calls / tool results degrade into plain text turns
 */
function toUpstreamBody(body, { conversationId, userId }) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const systems = []
  const turns = []

  const textOf = (content) => {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part
          if (part?.type === "text") return part.text ?? ""
          if (part?.type === "image_url") return "[图片]"
          return ""
        })
        .filter(Boolean)
        .join("\n")
    }
    return ""
  }

  for (const msg of messages) {
    const role = msg?.role ?? "user"
    if (role === "system" || role === "developer") {
      const t = textOf(msg.content).trim()
      if (t) systems.push(t)
      continue
    }
    if (role === "tool") {
      const t = textOf(msg.content).trim()
      if (t) turns.push({ role: "user", content: `[工具结果 ${msg.tool_call_id ?? ""}]\n${t}` })
      continue
    }
    if (role === "assistant") {
      const t = textOf(msg.content).trim()
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      if (t) turns.push({ role: "assistant", content: t })
      if (calls.length) {
        const desc = calls
          .map((c) => `${c?.function?.name ?? "tool"}(${c?.function?.arguments ?? ""})`)
          .join("\n")
        turns.push({ role: "assistant", content: `[调用工具]\n${desc}` })
      }
      continue
    }
    const t = textOf(msg.content)
    turns.push({ role: "user", content: t })
  }

  const lastUser = (() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user") return i
    return -1
  })()

  let inputText = ""
  const history = []
  if (lastUser === -1) {
    // all assistant / empty: use the last turn as the input
    inputText = turns.length ? turns[turns.length - 1].content : ""
    history.push(...turns.slice(0, -1))
  } else {
    inputText = turns[lastUser].content
    history.push(...turns.slice(0, lastUser))
    // an assistant turn after the last user (rare) comes along as history too
    history.push(...turns.slice(lastUser + 1))
  }

  // In a tool loop / multi-turn chat the trailing assistant content just joins
  // the history; upstream's input has to be a user turn
  const historyMessages = history
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content }))

  const prefix = systems.length
    ? `[系统指令，优先级高于后续对话]\n${systems.join("\n\n")}\n[系统指令结束]\n\n`
    : ""

  // Upstream requires input.content to be non-empty: an empty messages list or
  // a null content can't go up blank
  let content = prefix + inputText
  if (!content.trim()) {
    content = prefix
      ? `${prefix}（用户没有提供内容，请简短说明你需要什么信息）`
      : "（用户没有提供内容，请简短说明你需要什么信息）"
  }

  return {
    conversationId,
    user: {
      id: userId,
      setting: {
        model: null, // filled in by the caller
        enableThinking: false,
        language: "zh",
        multimodal: false,
        // Turn off upstream's own tools and MCP so this request is a plain
        // question and answer.
        //
        // Note: these fields mean "give it no tools", not "forbid it to act".
        // The assistant runs in RE_ACT mode, so upstream may still decide by
        // itself to call a built-in ability (running a command on the user's
        // server, say). That can't be confirmed from this plugin's side, so:
        //   - declare no tools and approve none;
        //   - hideToolMessage: false — if it does call one, the trace shows up
        //     in the reply where the user can see it, instead of being quietly
        //     hidden.
        tools: [],
        mcpServers: [],
        uiServers: [],
        approvedTools: [],
        approvedMCPTools: [],
        hideToolMessage: false,
        isNormalToolMessageIgnored: false,
      },
    },
    input: {
      id: uid("in-"),
      content,
      files: [],
      historyMessages,
    },
    stream: true,
  }
}

// ---- SSE parsing: upstream data lines → delta {content, reasoning} ----------
/**
 * Cut complete lines out of the buffer.
 * SSE allows \r\n, \n and \r line ends, and all three are handled here.
 * Returns [lines, rest]; rest is the tail that hasn't seen a line end yet.
 */
function takeSseLines(buf) {
  const lines = []
  let i = 0
  let start = 0
  while (i < buf.length) {
    const ch = buf[i]
    if (ch === "\n") {
      lines.push(buf.slice(start, i))
      i += 1
      start = i
    } else if (ch === "\r") {
      lines.push(buf.slice(start, i))
      i += buf[i + 1] === "\n" ? 2 : 1
      start = i
    } else {
      i += 1
    }
  }
  return [lines, buf.slice(start)]
}

function parseSseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith("data:")) return null
  const payload = trimmed.slice(5).trim()
  if (!payload) return null
  if (payload === "[DONE]") return { done: true }
  if (payload.startsWith("[ERROR]")) {
    return { error: payload.replace(/^\[ERROR\]:?\s*/, "") || "上游返回错误" }
  }
  if (payload.startsWith("[ABORTED]")) return { done: true }
  try {
    const obj = JSON.parse(payload)
    // both wrappers have been seen: a bare object, and {data: {...}}
    const d = obj?.data && typeof obj.data === "object" ? obj.data : obj
    const content = typeof d?.content === "string" ? d.content : ""
    const reasoning =
      typeof d?.reasoningContent === "string"
        ? d.reasoningContent
        : typeof d?.reasoning === "string"
          ? d.reasoning
          : ""
    const full =
      typeof d?.fullContent === "string" ? d.fullContent : undefined
    return { content, reasoning, full, raw: d }
  } catch {
    return null
  }
}

/**
 * `fullContent` is the whole text so far, turned into the delta this frame
 * should send.
 *
 * Two cases:
 *   - it continues on top of what was sent (same prefix) → the difference is
 *     the delta;
 *   - it rewrote what came before (different prefix) → the difference means
 *     nothing, so send the whole thing again and let the client see the
 *     complete new text, instead of gluing two halves into garbage.
 *     The earlier implementation only did slice(sent.length), so "xyzw" after
 *     "abc" came out as "w".
 */
function fullToDelta(full, sent) {
  if (full === sent) return ""
  if (full.startsWith(sent)) return full.slice(sent.length)
  return full
}

/**
 * Upstream error codes → the status we answer magpie with.
 *
 * Measured (2026-10-27): OrcaTerm's AI gateway reports a failure as
 * `[ERROR]: …` inside the SSE — exhausted quota, rate limiting and an
 * unavailable model alike — while the HTTP status stays 200. Handed back to the
 * client as body text, magpie would take it for a normal answer: it would not
 * fail over to the next account, nor let this account rest — so it has to
 * become an error status.
 */
const ERROR_MAP = [
  // monthly quota gone: another account is worth trying, so mark it 429 and
  // magpie moves to the next one
  { re: /quota|exceeded|额度|次数已用完|余额不足/i, status: 429, type: "rate_limit_error" },
  // rate limited: the same, but it has to wait a while
  { re: /rate.?limit|too many|频繁|限流/i, status: 429, type: "rate_limit_error" },
  // sign-in problem: mark the account as needing to sign in again
  { re: /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED|unauthorized|登录/i, status: 401, type: "authentication_error" },
]

/** Which status to answer with, judged from upstream's error text. */
function errorStatus(text) {
  const t = String(text ?? "")
  for (const m of ERROR_MAP) {
    if (m.re.test(t)) return m
  }
  // every other upstream error (model unavailable, internal error) counts as a
  // server fault, so magpie fails over
  return { status: 502, type: "upstream_error" }
}

/** At most this much of the stream head is read: enough to see whether the first frame is an answer or an error. */
const SSE_PEEK_LIMIT = 8 * 1024

/**
 * Read the stream head until it's clear whether this is an answer or an error —
 * following packages/codearts' peekAnswer.
 *
 * Returns { verdict, code, chunks, reader, text }:
 *   verdict is "answer" or "error"; chunks are the raw bytes already read, and
 *   they must be replayed, or the opening text is lost.
 */
async function peekAnswer(body) {
  const head = { verdict: "", code: "", chunks: [], reader: null, text: "", decoder: new TextDecoder() }
  if (!body) return head
  head.reader = body.getReader()
  let done = false
  for (;;) {
    const v = classifyHead(head.text, done)
    if (v) {
      head.verdict = v
      break
    }
    if (head.text.length >= SSE_PEEK_LIMIT) break
    const r = await head.reader.read()
    if (r.done) {
      done = true
      continue
    }
    head.chunks.push(r.value)
    head.text += head.decoder.decode(r.value, { stream: true })
  }
  if (head.verdict === "error") {
    // an error stream is dropped outright; cancel isn't awaited, it can hang on
    // a live stream
    void head.reader.cancel().catch(() => {})
  }
  return head
}

/**
 * Look for an error frame among the head bytes read so far.
 * When `done` is true and no error has shown up, the stream is a normal answer
 * (or an empty one).
 */
function classifyHead(text, done) {
  const [lines] = takeSseLines(text)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (!ev) continue
    if (ev.error) return "error"
    // text means it's an answer; no need to wait for more
    if (ev.content || ev.reasoning || typeof ev.full === "string") return "answer"
  }
  if (done) return "answer"
  return ""
}

/** Pull upstream's error text out of the stream head already read. */
function errorCodeFromHead(text) {
  const [lines] = takeSseLines(text)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (ev?.error) return ev.error
  }
  return "上游返回了错误"
}

/** Splice the bytes peek read back into the stream, then read the rest. */
function replayBody(head) {
  let i = 0
  return new ReadableStream({
    async pull(controller) {
      if (i < head.chunks.length) {
        controller.enqueue(head.chunks[i++])
        return
      }
      try {
        const r = await head.reader.read()
        if (r.done) {
          controller.close()
          return
        }
        controller.enqueue(r.value)
      } catch (err) {
        controller.error(err)
      }
    },
    cancel(reason) {
      return head.reader.cancel(reason).catch(() => {})
    },
  })
}

/**
 * Turn the upstream SSE byte stream into an OpenAI chat.completion.chunk stream.
 * Upstream sends increments (content is what this frame adds), so the delta goes
 * out as is; when a frame turns out to carry the cumulative value (longer than
 * what was sent and starting with it), it is converted to an increment.
 */
function upstreamToOpenAI(upstreamBody, { model }) {
  const encoder = new TextEncoder()
  const id = uid("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  let sentContent = ""
  let sentReasoning = ""
  let emitText = 0
  let closed = false
  let reader = null

  // Upstream has to be closed when the client disconnects or cancels, or the
  // connection leaks.
  //
  // reader only: once getReader() has been called the body is locked, and
  // upstreamBody.cancel() then throws "Cannot cancel a locked ReadableStream".
  // reader.cancel() returns a promise, and it isn't awaited — it can hang on a
  // live stream.
  const releaseUpstream = () => {
    if (!reader) {
      try {
        upstreamBody?.cancel?.()?.catch?.(() => {})
      } catch {
        /* ignore */
      }
      return
    }
    try {
      const r = reader.cancel()
      if (r && typeof r.catch === "function") r.catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const chunk = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...extra,
    })}\n\n`

  const stream = new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(encoder.encode(s))
      const finishUp = (reason = "stop", { skipReasoningFallback = false } = {}) => {
        if (closed) return
        // Upstream sent thinking but no text: turn the thinking into text
        // before closing, so the client doesn't show a blank answer.
        // The error path (skipReasoningFallback) must not — otherwise the error
        // text is pushed out by the thinking, and what the user finally sees is
        // "let me think" instead of "quota used up".
        if (!skipReasoningFallback && emitText === 0 && sentReasoning) {
          push(chunk({ content: sentReasoning }))
          emitText = sentReasoning.length
        }
        closed = true
        push(chunk({}, reason))
        // No usage is reported: upstream returns no token counts, and the
        // character count here is only an estimate. Reported to magpie as real
        // usage it would make both cost and context statistics wrong; better to
        // report nothing and let the client know there is no such number.
        push("data: [DONE]\n\n")
        controller.close()
      }

      // first chunk: carries the role, which is how the client builds the message
      push(chunk({ role: "assistant", content: "" }))

      reader = upstreamBody.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const [lines, rest] = takeSseLines(buf)
          buf = rest
          for (const line of lines) {
            const ev = parseSseLine(line)
            if (!ev) continue
            if (ev.done) {
              finishUp("stop")
              return
            }
            if (ev.error) {
              // A failure halfway through the stream: end this stream with an
              // error instead of sending some text and closing normally. The
              // latter would let magpie count it as a success — no failover, no
              // rest for the account.
              closed = true
              const m = errorStatus(ev.error)
              controller.error(Object.assign(new Error(`OrcaTerm: ${ev.error}`), { statusCode: m.status }))
              releaseUpstream()
              return
            }

            // `content` is this frame's increment and is used as is; only
            // `fullContent` (the whole text so far) has to be converted to an
            // increment. Treating a content that started with what was already
            // sent as cumulative and truncating it was wrong: "haha" after "ha"
            // got cut to "", and the text was lost.
            const textDelta = typeof ev.full === "string" ? fullToDelta(ev.full, sentContent) : (ev.content ?? "")
            if (textDelta) {
              sentContent += textDelta
              emitText += textDelta.length
              push(chunk({ content: textDelta }))
            }

            // thinking works the same way: content-style increments go out as
            // is, fullContent-style ones get converted
            let reasonDelta = ev.reasoning ?? ""
            if (reasonDelta) {
              sentReasoning += reasonDelta
              push(chunk({ reasoning_content: reasonDelta }))
            }
          }
        }
        const [tailLines, tailRest] = takeSseLines(buf)
        const pending = tailRest.trim() ? [...tailLines, tailRest] : tailLines
        for (const line of pending) {
          const ev = parseSseLine(line)
          if (!ev || ev.done || ev.error) continue
          const d = typeof ev.full === "string" ? fullToDelta(ev.full, sentContent) : (ev.content ?? "")
          if (d) {
            sentContent += d
            emitText += d.length
            push(chunk({ content: d }))
          }
          const r = ev.reasoning ?? ""
          if (r) {
            sentReasoning += r
            push(chunk({ reasoning_content: r }))
          }
        }
        finishUp("stop")
      } catch (err) {
        // Interrupted while reading (abort / connection reset): this stream has
        // to end with an error. Earlier a "connection lost" text was sent here
        // and the stream stopped normally, so the client took it for an answer
        // and magpie didn't fail over.
        if (!closed) {
          closed = true
          controller.error(
            Object.assign(new Error(`OrcaTerm 连接中断：${err?.message ?? err}`), {
              statusCode: err?.name === "AbortError" ? 499 : 502,
            }),
          )
          releaseUpstream()
        }
      }
    },
    // cut upstream off the moment the client disconnects (the agent gave up),
    // so the connection doesn't leak
    cancel() {
      closed = true
      releaseUpstream()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  })
}

async function upstreamToJSON(upstreamBody, { model }) {
  const reader = upstreamBody.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let content = ""
  let reasoning = ""
  let upstreamError = ""
  let sawDone = false

  const absorb = (line) => {
    const ev = parseSseLine(line)
    if (!ev) return
    if (ev.done) {
      sawDone = true
      return
    }
    if (ev.error) {
      upstreamError = ev.error
      return
    }
    // same rule as the streaming path: content is an increment, only fullContent
    // needs converting
    if (typeof ev.full === "string") {
      const d = fullToDelta(ev.full, content)
      content += d
    } else if (ev.content) {
      content += ev.content
    }
    if (ev.reasoning) {
      reasoning += ev.reasoning
    }
  }

  for (;;) {
    let chunkRead
    try {
      chunkRead = await reader.read()
    } catch (err) {
      // Client abort / connection lost: answer with a real error status; it
      // must not be dressed up as an answer. Earlier this returned 200 plus a
      // "connection lost" text, magpie took it as success, and failover stopped.
      const aborted = err?.name === "AbortError"
      return openaiError(aborted ? 499 : 502, `OrcaTerm 连接中断：${err?.message ?? err}`)
    }
    const { done, value } = chunkRead
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const [lines, rest] = takeSseLines(buf)
    buf = rest
    for (const line of lines) absorb(line)
    if (sawDone) {
      buf = ""
      break
    }
  }
  if (buf.trim() && !sawDone) absorb(buf)

  // upstream ended with an error (quota, rate limit, sign-in) → answer with the
  // real error status
  if (upstreamError) {
    const m = errorStatus(upstreamError)
    // the upstream's own code is the useful thing here, not our error class:
    // pass the class as `type` and leave `code` to say what the upstream said.
    return openaiError(m.status, `OrcaTerm: ${upstreamError}`, upstreamError, m.type)
  }

  // An empty text can't go up blank: the thinking is used first, then a note
  let finalContent = content
  if (!finalContent && reasoning) finalContent = reasoning
  if (!finalContent) finalContent = "（OrcaTerm 返回了空回复）"
  const message = { role: "assistant", content: finalContent }
  if (reasoning) message.reasoning_content = reasoning
  return new Response(
    JSON.stringify({
      id: uid("chatcmpl-"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/**
 * An error message can carry a full URL (with csrfCode — a djb2 derived from the
 * skey). The query string is wiped before anything reaches a log or the UI, so
 * the derived credential doesn't leak out.
 */
function redactUrl(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'）)]+/g, (m) => {
    const q = m.indexOf("?")
    return q < 0 ? m : `${m.slice(0, q)}?…`
  })
}

/**
 * An OpenAI-shaped error response.
 * `code` is upstream's own error code or classification; `type` is OpenAI's
 * error category, honoured when it is passed (errorStatus gives a more accurate
 * one than the status code alone).
 */
function openaiError(status, message, code = "upstream_error", type) {
  const kind = type ?? (status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "upstream_error")
  return new Response(JSON.stringify({ error: { message, type: kind, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

// ---- upstream call: one assistant/chat (streaming), failures readable -------
async function callAssistant({ auth, upstream, model, assistant, mode, signal }) {
  const skey = auth?.ticket?.skey
  const csrf = csrfCode(skey)
  const url = `${ASSISTANT_BASE}/chat?name=${encodeURIComponent(assistant)}&mode=${mode}&csrfCode=${csrf}`
  const body = structuredClone(upstream)
  body.user.setting.model = model

  const headers = baseHeaders({
    // x-seqid is this request's id, not the conversation's: the web page makes a
    // new one for every send, and reusing a fixed value could make upstream take
    // several requests for one.
    "x-seqid": body.input.id,
    cookie: cookieHeader(auth),
  })

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

/** Read human-readable text out of an upstream error response + decide whether a new sign-in is needed */
async function classifyUpstreamError(res) {
  let text = ""
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let code = ""
  let message = text.slice(0, 500)
  try {
    const j = JSON.parse(text)
    code = j?.error?.name ?? j?.message ?? j?.code ?? ""
    message = j?.error?.message ?? j?.message ?? message
  } catch {
    /* not JSON: as is */
  }
  const signIn =
    /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_USER_FAILED|VERIFY_LOGIN_FAILED|NOT_LOGIN|UNAUTHORIZED|LOGIN_EXPIRED/i.test(`${code} ${message}`)
  return {
    code: String(code || `${res.status}`),
    message: String(message || `OrcaTerm answered ${res.status}`),
    signIn: signIn ? "expired" : undefined,
    status: res.status,
  }
}

/**
 * Check the credential right at sign-in, so the user doesn't store a broken one.
 *
 * The evidence (measured 2026-10):
 *   - skey alone / p_uin+p_skey alone → NEED_UIN_AND_SKEY (the cookie was never
 *     accepted at all)
 *   - uin + skey but a fake skey      → VERIFY_SKEY_UIN_FAILED (it got into the
 *     verify layer)
 *   - uin + skey and real             → SSE frames start coming right away
 * So "a non-auth error came back" means the credential is valid.
 */
async function capiRequest(auth, action, data = {}) {
  const t = auth?.ticket ?? {}
  const seq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const uin = t.uin || t.p_uin || ""
  const url = `${CAPI_URL}?action=${encodeURIComponent(action)}&t=${seq}`
  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders({
      accept: "application/json",
      "content-type": "application/json",
      "x-seqid": seq,
      "x-referer": WEB_TERMINAL,
      "x-csrfcode": csrfCode(t.skey),
      cookie: cookieHeader(auth),
    }),
    // Measured: upstream validates the data field strictly, and an extra sig
    // comes back as "property feature should not exist". Sending {action, data}
    // as it is works.
    body: JSON.stringify({ action, data }),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

// ---- the plugin itself ------------------------------------------------------
// Note: magpie calls every function an entry module exports as a plugin, so the
// factory isn't exported on its own and only hangs off default.server (the
// OpenCode v1 shape).
export const OrcaTermAuthPlugin = async ({ client } = {}) => {
  const log = (level, message) => {
    try {
      // magpie: client.app.log; OpenCode has the same signature
      client?.app?.log?.({ body: { service: "orcaterm", level, message } })
    } catch {
      /* no client: stay quiet */
    }
  }

  /**
   * Each account's own state: conversation ids and temporary settings.
   * Keyed by the sign-in fingerprint rather than the provider — with several
   * accounts on magpie, none of them gets in another's way.
   */
  const sessions = new Map()
  /**
   * Session key = account fingerprint + magpie session id.
   * Upstream keeps conversations by conversationId, so with the account
   * fingerprint alone, different chats on one account would share context.
   * There is a cap as well, so signing in over and over doesn't pile up without
   * limit.
   */
  const sessionFor = (auth, sid) => {
    const fp = `${fingerprint(auth)}:${sid || "default"}`
    let s = sessions.get(fp)
    if (!s) {
      if (sessions.size > 64) sessions.clear()
      s = { conversationId: uid("cid-"), userId: uid("u-") }
      sessions.set(fp, s)
    }
    return s
  }

  const modelsBlock = Object.fromEntries(
    MODEL_SPECS.map((spec) => [
      spec.id,
      {
        name: spec.name,
        id: spec.id,
        limit: { context: spec.context, output: spec.output },
        reasoning: spec.reasoning,
        // Upstream answers with text only and never produces tool_calls;
        // declaring true would leave the agent waiting for a call it never gets
        // and spinning up to its step cap
        tool_call: false,
        modalities: { input: ["text"] },
        // metered by quota, not billed, so cost is all 0 — magpie then doesn't
        // price it as a paid model
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
    ]),
  )

  return {
    // ---- provider declaration -----------------------------------------------
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OrcaTerm",
        npm: "@ai-sdk/openai-compatible", // chat completions: the gateway converts each vendor's protocol into it
        api: `${ASSISTANT_BASE}/chat`,
        models: modelsBlock,
      }
    },

    auth: {
      provider: PROVIDER,

      methods: [
        {
          type: "api",
          label: "粘贴 OrcaTerm cookie（uin=…; skey=…）",
          placeholder: "uin=o1234567890; skey=AbCdEf123456...",
        },
      ],

      /**
       * The exit for every request. magpie's gateway has already turned the
       * agent's protocol into Chat Completions; what's left here is:
       * OpenAI body → OrcaTerm body → upstream SSE → OpenAI SSE.
       */
      async loader(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? auth?.ticket?.skey ?? auth?.access ?? "")
        // Not signed in: an empty object from the loader is the OpenCode
        // convention (it means "not configured yet"), and the account shows as
        // signed out
        if (!ticket) return {}
        // Measured: upstream wants uin and skey as a pair, and either one
        // missing is a flat NEED_UIN_AND_SKEY. Throwing an error with signIn set
        // makes magpie mark the account "needs a new sign-in", instead of
        // falling back to an address that is bound to 404.
        if (!ticket.uin) {
          throw Object.assign(
            new Error("OrcaTerm 需要 uin 与 skey 成对：请在 F12 → Cookies 里把 uin 一起复制进来"),
            { signIn: "expired" },
          )
        }
        const bound = { ...auth, ticket }

        return {
          baseURL: ASSISTANT_BASE,
          apiKey: "orcaterm", // magpie fills Authorization with it; upstream doesn't look, but don't leave it empty

          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? String(input)
            // Take the headers the gateway and chat.headers added (the docs'
            // 4-layer override order), especially the session id chat.headers
            // writes, which is what splits conversations upstream.
            const inHeaders = new Headers(init?.headers ?? {})
            const sessionId = inHeaders.get("x-orcaterm-session") || ""
            const session = sessionFor(bound, sessionId)
            let openaiBody
            try {
              openaiBody = JSON.parse(bodyToText(init?.body) || "{}")
            } catch {
              return openaiError(400, "请求体不是合法 JSON")
            }

            const requested = openaiBody?.model
            const model = resolveModel(requested)
            const stream = openaiBody?.stream !== false

            const upstream = toUpstreamBody(openaiBody, session)

            let res
            try {
              res = await callAssistant({
                auth: bound,
                upstream,
                model,
                assistant: ASSISTANT.orcaterm,
                mode: MODE.react,
                signal: init?.signal,
              })
            } catch (err) {
              // an interruption (the client gave up) isn't an upstream fault
              if (err?.name === "AbortError") return openaiError(499, "客户端已取消请求")
              return openaiError(502, `连不上 OrcaTerm：${redactUrl(err?.message ?? err)}`)
            }

            if (!res.ok) {
              const info = await classifyUpstreamError(res)
              // Only a confirmed sign-in problem answers 401 (magpie marks the
              // account and stops dispatching on a 401 by default); quota gone /
              // risk control / 5xx all answer 502, so magpie fails over instead
              // of mistaking it for a new sign-in.
              const status = info.signIn ? 401 : info.status >= 400 ? info.status : 502
              const e = openaiError(status, `OrcaTerm: ${info.message}`, info.code)
              if (info.signIn) e.headers.set("x-magpie-sign-in", info.signIn)
              return e
            }

            // Upstream can answer 200 with something that isn't SSE at all: a
            // JSON error, an HTML sign-in page, a plain-text risk-control
            // notice. Anything whose content-type isn't event-stream is treated
            // as an error — otherwise the SSE parser swallows it silently and
            // the client sees an empty 200 answer, which is painful to diagnose.
            const ctype = res.headers.get("content-type") ?? ""
            const looksSSE = ctype.includes("event-stream")
            const looksHTML = ctype.includes("html") || ctype.includes("xml")
            if (!looksSSE) {
              const text = await res.text()
              let msg = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
              let signIn
              try {
                const j = JSON.parse(text)
                msg = j?.error?.message ?? j?.message ?? msg
              } catch {
                /* HTML / plain text: use the tag-stripped text */
              }
              if (/NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED/i.test(msg)) {
                signIn = "expired"
              }
              const e = openaiError(
                signIn ? 401 : 502,
                `OrcaTerm${looksHTML ? " 返回了非 SSE 响应（可能被网关/登录页拦截）" : ""}：${msg || "空响应"}`,
                "upstream_error",
              )
              if (signIn) e.headers.set("x-magpie-sign-in", signIn)
              return e
            }
            // a missing content-type needs its fallback too: no body is a
            // straight error, not a silent empty answer
            if (!res.body) return openaiError(502, "OrcaTerm 返回了空响应")

            // Upstream reports a failure as `data: [ERROR]: …` while the HTTP
            // status stays 200. The head is read first to tell an answer from an
            // error: quota gone has to be 429 so magpie switches accounts, and a
            // dead sign-in has to be 401 to mark the account — otherwise the
            // failure is taken for a normal answer.
            const head = await peekAnswer(res.body)
            if (head.verdict === "error") {
              const code = errorCodeFromHead(head.text)
              const m = errorStatus(code)
              const e = openaiError(m.status, `OrcaTerm: ${code}`, code, m.type)
              if (m.status === 401) e.headers.set("x-magpie-sign-in", "expired")
              return e
            }

            // The stream head has already been read; splice it back in before
            // handing the stream to the converters, or the opening text is lost
            const body = head.chunks.length ? replayBody(head) : res.body

            if (stream) return upstreamToOpenAI(body, { model })
            return upstreamToJSON(body, { model })
          },
        }
      },

      /** magpie's own hook: show OrcaTerm's Q&A quota on the account card */
      async usage(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? "")
        if (!ticket) return { error: "还没登录", windows: [] }
        if (!ticket.uin) return { error: "凭据缺少 uin，请重新粘贴 uin 与 skey", windows: [] }
        const bound = { ...auth, ticket }

        // A throw in usage puts an error on the account card, so everything is
        // caught here; the worst case is just "can't read the quota"
        try {
          // Measured (2026-10-27): the real quota is in DescribeUserBillingStatus'
          // usageStats[], not in DescribeUserUsageStats (whose feature only knows
          // hunyuan_ai/session_share/secret).
          const billing = await capiRequest(bound, "DescribeUserBillingStatus", {})
          const resp = billing?.data?.Response ?? billing?.Response
          if (resp?.Error) {
            const code = resp.Error.Code ?? ""
            if (/VERIFY_SKEY_UIN_FAILED|VERIFY_USER_FAILED|VERIFY_LOGIN_FAILED|NOT_LOGIN/i.test(code)) {
              return { error: `OrcaTerm 拒绝了登录（${code}），请重新登录`, windows: [], signIn: "expired" }
            }
            return { error: `OrcaTerm 读额度失败：${code || resp.Error.Message}`, windows: [] }
          }

          const stats = Array.isArray(resp?.usageStats) ? resp.usageStats : []
          const windows = []
          for (const st of stats) {
            const feature = st?.feature ?? ""
            // hunyuan_ai = the AI Q&A turn quota; the other features are session
            // sharing / keys / storage, which aren't what we want
            if (feature !== "hunyuan_ai") continue
            const limit = Number(st.quotaLimit)
            const used = Number(st.quotaUsed)
            if (!Number.isFinite(limit) || limit < 0) continue
            windows.push({
              name: "AI 问答",
              used: limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0,
              display: `${used} / ${limit}`,
              amount: used,
              limit,
              unit: "次",
              ...(st.quotaEndDate ? { resetsAt: toIso(st.quotaEndDate) } : {}),
              ...(st.quotaStartDate && st.quotaEndDate
                ? {
                    span: Math.max(
                      1,
                      Math.round((Date.parse(st.quotaEndDate) - Date.parse(st.quotaStartDate)) / 1000),
                    ),
                  }
                : {}),
            })
          }

          // also pick up the account name, so the account card reads clearly
          let user
          try {
            const info = await capiRequest(bound, "GetUserInfo", {})
            const ir = info?.data?.Response ?? info?.Response
            user = ir?.nickName ?? ir?.username ?? ir?.uin
          } catch {
            /* fine if it can't be read */
          }

          if (!windows.length) {
            return {
              user,
              plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
              windows: [],
              error: "OrcaTerm 没有返回 AI 问答额度字段",
            }
          }
          return {
            user,
            plan: resp?.roleType ? `OrcaTerm ${resp.roleType}` : undefined,
            windows,
          }
        } catch (err) {
          return { error: `读取额度失败：${redactUrl(err?.message ?? err)}`, windows: [] }
        }
      },

    },

    // ---- conversation header: carry magpie's session id to fetch, to split
    // conversations upstream ---------------------------------------------------
    // magpie's input.sessionID stays the same across the turns of one
    // conversation, so conversationId is derived from it: different chats on one
    // account don't share context.
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER) return
      try {
        output.headers["x-orcaterm-session"] = input.sessionID || uid("s-")
      } catch {
        /* ignore */
      }
    },
  }
}

function toIso(v) {
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

// ---- test exit (magpie calls only exported functions as plugins; _internal is
// an object, never called) ----------------------------------------------------
// Everything the tests reach for, as the other packages do: nothing here is
// part of the provider contract.
export const _internal = {
  PROVIDER,
  MODEL_SPECS,
  ALIAS_TO_ID,
  ASSISTANT,
  ASSISTANT_BASE,
  CAPI_URL,
  WEB_TERMINAL,
  uid,
  csrfCode,
  parseTicket,
  cookieHeader,
  fingerprint,
  baseHeaders,
  bodyToText,
  resolveModel,
  toUpstreamBody,
  takeSseLines,
  parseSseLine,
  fullToDelta,
  errorStatus,
  peekAnswer,
  classifyHead,
  errorCodeFromHead,
  replayBody,
  upstreamToOpenAI,
  upstreamToJSON,
  redactUrl,
  openaiError,
  callAssistant,
  classifyUpstreamError,
  capiRequest,
  toIso,
}


