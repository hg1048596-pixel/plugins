/**
 * opencode-orcaterm-auth
 *
 * OrcaTerm（腾讯云遨驰终端）AI 反代插件，同时是 OpenCode v1 插件与 magpie 供应商插件。
 *
 * 上游协议（逆向自 orcaterm.cloud.tencent.com 前端 bundle，2026-10 版本）：
 *   会话接口  POST {ASSISTANT_BASE}/chat?name=<assistant>&mode=<0|1|2>&csrfCode=<skey-hash>
 *             body: {conversationId, user:{id, setting:{...}}, input:{id, content, files,
 *                    historyMessages}, stream:true}
 *             headers: x-seqid + cookie(uin/skey) + 浏览器族头
 *             响应: SSE，逐行 `data: {...}`，正文在 content，思考在 reasoningContent
 *   账号接口  POST https://api.orcaterm.cloud.tencent.com/cgi/api?<action 签名>
 *             body: {action, data}；head/tail 双写（X-CsrfCode 取 cookie skey 的 djb2）
 *
 * 本文件的对外契约完全按 magpie 文档：
 *   config / auth{methods, loader, usage} / provider.models / chat.headers
 */
import { createHash, randomBytes } from "node:crypto"

const PROVIDER = "orcaterm"

// ── 上游常量（改动只需改这里） ───────────────────────────────────────────────
const ASSISTANT_BASE = "https://lightai.cloud.tencent.com/assistant"
const CAPI_ORIGIN = "https://orcaterm.cloud.tencent.com"
const CAPI_URL = "https://api.orcaterm.cloud.tencent.com/cgi/api"
const WEB_TERMINAL = "https://orcaterm.cloud.tencent.com/terminal"

/** OrcaTerm 内置助手的名字（lighthouse/orcaterm/cvm...），决定话术与工具集 */
const ASSISTANT = {
  orcaterm: "orcaterm",
  lighthouse: "lighthouse",
}
/** 0=RE_ACT 1=PLAN_ACT 2=AUTO_ACT */
const MODE = { react: 0, planact: 1, autoact: 2 }

/**
 * 上游模型 id（前端常量 bt.*，2026-10 快照）。
 *
 * `id` 是真正写进请求体的 model；`name` 只在选择器里显示，所以它必须与
 * id 一致 —— 早先把 UI 上的营销名（DeepSeek-V4-Pro、GLM-5.2、Kimi-k2.6）
 * 当成了模型名，那些是从界面文案推的，没有依据，也和服务端实际提供的不符。
 *
 * 上下文与输出上限同样是估计值：上游没有公开每个模型的窗口大小。
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
    // 早先这里挂了 "hunyuan-t1" 别名，但下面有真正的 hunyuan-t1 模型，
    // 别名会被那个模型覆盖，写在这里只是误导。
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

// ── 小工具 ─────────────────────────────────────────────────────────────────
function uid(prefix = "") {
  return prefix + randomBytes(12).toString("hex")
}

/** 腾讯 sckey 系 csrf：cookie 里 skey 的 djb2，& 0x7fffffff */
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
    // 单个 k=v，或 k=v&k=v
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
      // 只有一个值：当作 skey
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
 * 上游能接受的 cookie 头。
 *
 * 实测（2026-10-26，lightai 网关）：
 *   - 只有 skey          → NEED_UIN_AND_SKEY
 *   - 只有 p_uin+p_skey  → NEED_UIN_AND_SKEY
 *   - uin + skey         → VERIFY_SKEY_UIN_FAILED（进入校验层，假凭据到此为止）
 *   - uin 带不带 o 前缀   → 都认
 * 所以 uin 和 skey 必须成对且真实，这里不再派生占位 uin。
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
  // 账号唯一性：uin + skey 前 12 位
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
 * magpie 文档：init.body 是 JSON 字符串，**不是 UTF-8 文本时为字节**。
 * 这里把三种形态（string / Uint8Array / ArrayBuffer / 可读流之外的对象）统一成文本。
 */
function bodyToText(body) {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  if (typeof body === "object") {
    // URLSearchParams 之类
    if (typeof body.toString === "function" && body.constructor?.name !== "Object") return String(body)
    try {
      return JSON.stringify(body)
    } catch {
      return ""
    }
  }
  return String(body)
}

// ── 模型解析 ───────────────────────────────────────────────────────────────
function resolveModel(requested) {
  const raw = String(requested ?? "").trim()
  const key = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1).trim() : raw
  // 空串、只有斜杠（"orcaterm/"）都回落默认模型，不能把空 model 发给上游
  if (!key) return MODEL_SPECS[0].id
  const hit = ALIAS_TO_ID.get(key.toLowerCase())
  if (hit) return hit
  // 上游新增模型时不至于 404：原样透传
  return key
}


// ── 请求体：OpenAI Chat Completions → OrcaTerm assistant ────────────────────
/**
 * OrcaTerm 的 assistant 只吃「一段用户话 + 历史消息列表」，没有 system 字段。
 * 这里把 OpenAI 的 messages 压成：
 *   - system/developer 拼接后塞进 input.content 头部（带标记，便于模型识别）
 *   - 除最后一条 user 外，其余全部进 historyMessages
 *   - assistant.tool_calls / tool 结果降级成普通文本轮次
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
    // 全是 assistant / 空：把最后一条当输入
    inputText = turns.length ? turns[turns.length - 1].content : ""
    history.push(...turns.slice(0, -1))
  } else {
    inputText = turns[lastUser].content
    history.push(...turns.slice(0, lastUser))
    // 最后一条 user 之后如果还有 assistant（罕见），当历史一起带过去
    history.push(...turns.slice(lastUser + 1))
  }

  // 工具循环 / 多轮里，把末尾 assistant 内容并入历史即可；上游 input 必须是 user
  const historyMessages = history
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content }))

  const prefix = systems.length
    ? `[系统指令，优先级高于后续对话]\n${systems.join("\n\n")}\n[系统指令结束]\n\n`
    : ""

  // 上游要求 input.content 非空：messages 为空 / content 为 null 时不能交白卷
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
        model: null, // 由调用方填
        enableThinking: false,
        language: "zh",
        multimodal: false,
        // 关掉上游自带的工具与 MCP，让这次请求只做问答。
        //
        // 注意：这些字段是「不给它工具」，不是「禁止它动手」。assistant 跑在
        // RE_ACT 模式下，上游仍可能自己决定调用内置能力（比如在用户的服务器上
        // 执行命令）。这一点无法从这个插件侧确认，所以：
        //   - 不声明任何工具、不批准任何工具；
        //   - hideToolMessage: false —— 万一真的调用了，痕迹会出现在回复里，
        //     用户能看见，而不是被悄悄隐掉。
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

// ── SSE 解析：上游 data 行 → delta {content, reasoning} ─────────────────────
/**
 * 从缓冲区切出完整行。
 * SSE 规范允许 \r\n、\n、\r 三种行尾，这里统一处理，
 * 返回 [lines, rest]；rest 是还没收到换行的尾巴。
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
    // 两种封装都见过：裸对象 与 {data: {...}}
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
 * `fullContent` 是累计全文，换算成这一帧该发的增量。
 *
 * 两种情况：
 *   - 它在已发内容之上继续（前缀相同）→ 差集就是增量；
 *   - 它改写了前面（前缀不同）→ 差值没有意义，直接发整段重来，
 *     让客户端看到完整的新正文，而不是把两段拼成乱码。
 *     早先的实现只做 slice(sent.length)，"abc" 之后来 "xyzw" 会变成 "w"。
 */
function fullToDelta(full, sent) {
  if (full === sent) return ""
  if (full.startsWith(sent)) return full.slice(sent.length)
  return full
}

/**
 * 上游的错误码 → 我们回给 magpie 的状态。
 *
 * 实测（2026-10-27）OrcaTerm 的 AI 网关用 SSE 里的 `[ERROR]: …` 表达失败，
 * 配额用完、限流、模型不可用都是这样，HTTP 状态仍然是 200。
 * 如果原样当正文回给客户端，magpie 会以为这是一次正常回答：
 * 不会故障切换到下一个账号，也不会让这个账号歇一会儿 —— 所以必须转成错误状态。
 */
const ERROR_MAP = [
  // 月度额度用完：换账号有意义，标 429 让 magpie 换下一个
  { re: /quota|exceeded|额度|次数已用完|余额不足/i, status: 429, type: "rate_limit_error" },
  // 限流：同上，但要等一会儿
  { re: /rate.?limit|too many|频繁|限流/i, status: 429, type: "rate_limit_error" },
  // 登录态问题：标记账号需要重登
  { re: /NEED_UIN_AND_SKEY|VERIFY_SKEY_UIN_FAILED|VERIFY_LOGIN_FAILED|VERIFY_USER_FAILED|unauthorized|登录/i, status: 401, type: "authentication_error" },
]

/** 从上游的错误文本判断该回什么状态。 */
function errorStatus(text) {
  const t = String(text ?? "")
  for (const m of ERROR_MAP) {
    if (m.re.test(t)) return m
  }
  // 其余上游错误（模型不可用、内部错误）算服务端故障，让 magpie 故障切换
  return { status: 502, type: "upstream_error" }
}

/** 流头最多读这么多，够看清第一帧是回答还是错误。 */
const SSE_PEEK_LIMIT = 8 * 1024

/**
 * 读流头直到能判断这是回答还是错误 —— 照 packages/codearts 的 peekAnswer。
 *
 * 返回 { verdict, code, chunks, reader, text }：
 *   verdict 是 "answer" 或 "error"；chunks 是已读的原始字节，必须回放，
 *   否则开头那段正文会丢。
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
    // 错误流直接丢弃；cancel 不 await，活体上可能挂住
    void head.reader.cancel().catch(() => {})
  }
  return head
}

/**
 * 看已读到的头部里有没有错误帧。
 * `done` 为真时还没见到错误，就说明这段流是正常回答（或空回答）。
 */
function classifyHead(text, done) {
  const [lines] = takeSseLines(text)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (!ev) continue
    if (ev.error) return "error"
    // 见到正文就说明是回答，不必再等
    if (ev.content || ev.reasoning || typeof ev.full === "string") return "answer"
  }
  if (done) return "answer"
  return ""
}

/** 从已读到的流头里取出上游的错误文本。 */
function errorCodeFromHead(text) {
  const [lines] = takeSseLines(text)
  for (const line of lines) {
    const ev = parseSseLine(line)
    if (ev?.error) return ev.error
  }
  return "上游返回了错误"
}

/** 把 peek 读到的字节接回流里，再继续读剩余部分。 */
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
 * 把上游 SSE 字节流转成 OpenAI chat.completion.chunk 流。
 * 上游给的是「累计全文」式增量（content 为本次新增），因此直接对外发 delta；
 * 若发现上游发的是累计值（比已发长度长且以已发内容开头），则换算成增量。
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

  // 客户端断连 / 主动取消时要能反手关掉上游，否则连接会泄漏。
  //
  // 只走 reader：一旦 getReader() 过了，body 就是 locked 的，
  // 再调 upstreamBody.cancel() 会抛 "Cannot cancel a locked ReadableStream"。
  // reader.cancel() 会返回 promise，这里不 await —— 活体上可能挂住。
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
        // 上游只给了思考、没给正文：收尾前把思考补成正文，避免客户端显示空白。
        // 但出错路径（skipReasoningFallback）不能补——否则错误信息会被思考文本顶掉，
        // 用户最后看到的是「我先想想」而不是「额度已用尽」。
        if (!skipReasoningFallback && emitText === 0 && sentReasoning) {
          push(chunk({ content: sentReasoning }))
          emitText = sentReasoning.length
        }
        closed = true
        push(chunk({}, reason))
        // 不报 usage：上游不返回 token 数，这里的字符数估算只是估算。
        // 把它当真实用量报给 magpie，会让费用和上下文统计都是错的；
        // 宁可不报，让客户端知道「没有这个数」。
        push("data: [DONE]\n\n")
        controller.close()
      }

      // 首个 chunk：给 role，客户端据此建消息
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
              // 流到一半才失败：让这条流以错误结束，而不是发一段正文再正常收尾。
              // 后者会让 magpie 把这次当成功，既不故障切换也不让账号歇着。
              closed = true
              const m = errorStatus(ev.error)
              controller.error(Object.assign(new Error(`OrcaTerm: ${ev.error}`), { statusCode: m.status }))
              releaseUpstream()
              return
            }

            // `content` 是这一帧的增量，直接用；只有 `fullContent`（累计全文）
            // 需要换算成增量。曾经把「以已发内容开头」的 content 当成累计值
            // 来截断，那是错的：帧 "ha" 之后来 "haha" 会被截成 ""，正文丢失。
            const textDelta = typeof ev.full === "string" ? fullToDelta(ev.full, sentContent) : (ev.content ?? "")
            if (textDelta) {
              sentContent += textDelta
              emitText += textDelta.length
              push(chunk({ content: textDelta }))
            }

            // 思考内容同理：content 式增量直发，fullContent 式换算
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
        // 读流时中断（abort / 连接重置）：这条流必须以错误结束。
        // 早先在这里补一段「连接中断」正文再 stop，客户端会当成正常回答，
        // magpie 也就不故障切换了。
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
    // 客户端断连（agent 放弃请求）时立刻掐掉上游，避免连接泄漏
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
    // 与流式路径同一规则：content 是增量，fullContent 才需要换算
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
      // 客户端 abort / 连接中断：回真正的错误状态，不能伪装成一条回答。
      // 早先这里回 200 + 「连接中断」正文，magpie 会当成成功，故障切换就停了。
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

  // 上游以错误收尾（配额、限流、登录）→ 回真实错误状态
  if (upstreamError) {
    const m = errorStatus(upstreamError)
    return openaiError(m.status, `OrcaTerm: ${upstreamError}`)
  }

  // 正文为空时不能交白卷：优先用思考内容，再退到说明
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
 * 错误信息里可能带完整 URL（含 csrfCode —— 它是 skey 的 djb2 派生值）。
 * 进日志 / UI 前把查询串抹掉，避免把派生凭据带出去。
 */
function redactUrl(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'）)]+/g, (m) => {
    const q = m.indexOf("?")
    return q < 0 ? m : `${m.slice(0, q)}?…`
  })
}

function openaiError(status, message, code = "upstream_error") {
  return new Response(
    JSON.stringify({
      error: { message, type: status === 401 ? "authentication_error" : "upstream_error", code },
    }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

// ── 上游调用：一次 assistant/chat（流式），失败可判读 ────────────────────────
async function callAssistant({ auth, upstream, model, assistant, mode, signal }) {
  const skey = auth?.ticket?.skey
  const csrf = csrfCode(skey)
  const url = `${ASSISTANT_BASE}/chat?name=${encodeURIComponent(assistant)}&mode=${mode}&csrfCode=${csrf}`
  const body = structuredClone(upstream)
  body.user.setting.model = model

  const headers = baseHeaders({
    // x-seqid 是「这一次请求」的 id，不是会话 id：网页端每发一次都生成新的，
    // 复用一个固定的值可能让上游把多次请求当成同一次。
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

/** 从上游错误响应里读出人话 + 判断是否需要重新登录 */
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
    /* 非 JSON：原样 */
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
 * 登录时立刻校验凭据，别让用户存进一个坏的。
 *
 * 判据（2026-10 实测）：
 *   - 只有 skey / 只有 p_uin+p_skey → NEED_UIN_AND_SKEY（cookie 根本没被接受）
 *   - uin + skey 但 skey 是假的     → VERIFY_SKEY_UIN_FAILED（进了校验层）
 *   - uin + skey 且真实             → 直接开始出 SSE 帧
 * 所以「拿到非鉴权类错误」就等于凭据是有效的。
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
    // 实测：上游对 data 字段严格校验，多塞 sig 会回
    // "property feature should not exist"。原样发 {action, data} 即可。
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

// ── 插件本体 ───────────────────────────────────────────────────────────────
// 注意：magpie 会把入口模块导出的每个函数都当插件调用，
// 所以工厂不单独 export，只挂在 default.server 上（OpenCode v1 形状）。
export const OrcaTermAuthPlugin = async ({ client } = {}) => {
  const log = (level, message) => {
    try {
      // magpie: client.app.log；OpenCode 同签名
      client?.app?.log?.({ body: { service: "orcaterm", level, message } })
    } catch {
      /* 没有 client 就静默 */
    }
  }

  /**
   * 每个账号自己的状态：会话 id 与临时配置。
   * 键用「登录指纹」，不用 provider —— magpie 多账号时各账号互不干扰。
   */
  const sessions = new Map()
  /**
   * 会话键 = 账号指纹 + magpie 会话 id。
   * 上游按 conversationId 存会话，若只用账号指纹，同一账号下不同对话会串上下文。
   * 顺手做个上限，反复重登时不至于无限累积。
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
        // 上游只回文本、从不产生 tool_calls；声明 true 会让 agent 等不到工具调用而空转到步数上限
        tool_call: false,
        modalities: { input: ["text"] },
        // 走额度而非计费，cost 全 0，避免 magpie 当成付费模型参与比价
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
    ]),
  )

  return {
    // ── 供应商声明 ──────────────────────────────────────────────────────
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "OrcaTerm",
        npm: "@ai-sdk/openai-compatible", // chat completions：网关负责把各家协议转成它
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
       * 每个请求的出口。magpie 的网关已经把 agent 的协议转成 Chat Completions，
       * 我们负责：OpenAI body → OrcaTerm body → 上游 SSE → OpenAI SSE。
       */
      async loader(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? auth?.ticket?.skey ?? auth?.access ?? "")
        // 没登录：loader 返回空对象是 OpenCode 惯例（等于「还没配」），账号显示未登录
        if (!ticket) return {}
        // 实测：上游要求 uin 与 skey 成对出现，缺一个直接 NEED_UIN_AND_SKEY。
        // 这里抛带 signIn 的错误，magpie 会把账号标成「需要重新登录」，
        // 而不是退回去打一个注定 404 的地址。
        if (!ticket.uin) {
          throw Object.assign(
            new Error("OrcaTerm 需要 uin 与 skey 成对：请在 F12 → Cookies 里把 uin 一起复制进来"),
            { signIn: "expired" },
          )
        }
        const bound = { ...auth, ticket }

        return {
          baseURL: ASSISTANT_BASE,
          apiKey: "orcaterm", // magpie 会用它填 Authorization；上游不看，但别留空

          async fetch(input, init) {
            const url = typeof input === "string" ? input : input?.url ?? String(input)
            // 接住网关与 chat.headers 加的头（文档的 4 层覆盖顺序），
            // 尤其是 chat.headers 写进来的会话 id，用来给上游分会话。
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
              // 中断（客户端放弃）不该被当成上游故障
              if (err?.name === "AbortError") return openaiError(499, "客户端已取消请求")
              return openaiError(502, `连不上 OrcaTerm：${redactUrl(err?.message ?? err)}`)
            }

            if (!res.ok) {
              const info = await classifyUpstreamError(res)
              // 只有确认是登录问题才回 401（magpie 默认 401 会标记账号、停止派发）；
              // 额度不足 / 风控 / 5xx 一律 502，让 magpie 走故障切换而不是误标重登。
              const status = info.signIn ? 401 : info.status >= 400 ? info.status : 502
              const e = openaiError(status, `OrcaTerm: ${info.message}`, info.code)
              if (info.signIn) e.headers.set("x-magpie-sign-in", info.signIn)
              return e
            }

            // 上游可能 200 但回的压根不是 SSE：JSON 错误、HTML 登录页、纯文本风控提示。
            // 只要 content-type 不是 event-stream，一律当错误处理 —— 否则会被 SSE 解析器
            // 静默吞掉，客户端看到一个 200 的空回答，排查起来极其难受。
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
                /* HTML / 纯文本：用剥标签后的文本 */
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
            // content-type 缺失也要兜底：没有 body 就直接报错，别静默空回答
            if (!res.body) return openaiError(502, "OrcaTerm 返回了空响应")

            // 上游用 `data: [ERROR]: …` 表达失败，HTTP 状态仍是 200。
            // 先读流头判断这是回答还是错误：配额用完要回 429 让 magpie 换账号，
            // 登录失效要回 401 标记账号 —— 否则失败会被当成正常回答。
            const head = await peekAnswer(res.body)
            if (head.verdict === "error") {
              const code = errorCodeFromHead(head.text)
              const m = errorStatus(code)
              const e = openaiError(m.status, `OrcaTerm: ${code}`, m.type)
              if (m.status === 401) e.headers.set("x-magpie-sign-in", "expired")
              return e
            }

            // 已经把流头读掉了，接回去再交给后面的转换，否则开头正文会丢
            const body = head.chunks.length ? replayBody(head) : res.body

            if (stream) return upstreamToOpenAI(body, { model })
            return upstreamToJSON(body, { model })
          },
        }
      },

      /** magpie 自己的钩子：把 OrcaTerm 的问答额度显示在账号卡片上 */
      async usage(getAuth) {
        const auth = await getAuth()
        const ticket = parseTicket(auth?.key ?? "")
        if (!ticket) return { error: "还没登录", windows: [] }
        if (!ticket.uin) return { error: "凭据缺少 uin，请重新粘贴 uin 与 skey", windows: [] }
        const bound = { ...auth, ticket }

        // usage 抛异常会让账号卡片显示报错，这里全部兜住，最差只是「读不到额度」
        try {
          // 实测（2026-10-27）：真实额度在 DescribeUserBillingStatus 的 usageStats[]，
          // 不在 DescribeUserUsageStats（那个的 feature 只认 hunyuan_ai/session_share/secret）。
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
            // hunyuan_ai = AI 问答次数额度；其它 feature 是会话分享/密钥/空间，不是我们要的
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

          // 顺手拿一下账号名，让账号卡片显示得清楚些
          let user
          try {
            const info = await capiRequest(bound, "GetUserInfo", {})
            const ir = info?.data?.Response ?? info?.Response
            user = ir?.nickName ?? ir?.username ?? ir?.uin
          } catch {
            /* 取不到就算了 */
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

    // ── 会话头：把 magpie 的会话 id 带到 fetch，用来给上游分会话 ─────────────
    // magpie 的 input.sessionID 在同一段对话的各轮之间保持不变，
    // 用它派生 conversationId，避免同一账号下不同对话串上下文。
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

// ── 测试出口（magpie 只把导出的函数当插件，_internal 是对象，不会被调用） ────
export const _internal = {
  PROVIDER,
  MODEL_SPECS,
  ASSISTANT_BASE,
  CAPI_URL,
  csrfCode,
  parseTicket,
  cookieHeader,
  fingerprint,
  bodyToText,
  resolveModel,
  toUpstreamBody,
  parseSseLine,
  fullToDelta,
  errorStatus,
  upstreamToOpenAI,
  openaiError,
}


