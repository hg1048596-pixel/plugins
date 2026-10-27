/**
 * WeChat QR sign-in for OrcaTerm.
 *
 * This uses OrcaTerm's own OAuth rather than the console session cookie:
 *
 *   GET  {OAUTH}/oauth/wechat/config   → {appid, redirect_uri, state, scope}
 *   →  the local page below embeds WeChat's qrconnect widget
 *   the scan returns to {redirect_uri} (/oauth/wechat/bridge?code&state), and that
 *   page postMessages the result to its parent — which is our page
 *   POST {OAUTH}/oauth/wechat/exchange  → {userId, accessToken, expiresIn, …}
 *   POST {CAPI}?action=OAuthRefreshToken → renews it
 *
 * Why `self_redirect: true` matters: after a scan, qrconnect navigates the *top*
 * window by default, which replaces the host page and loses the postMessage.
 * With it set, the return happens inside the widget's own inner iframe, so the
 * bridge page's `window.parent` is still our page.
 *
 * The token this yields is a 1024-character JWT, valid two hours and renewable.
 * Measured 2026-10-27: it drives /assistant/chat directly, namespaced model ids
 * included — and it is a far smaller credential than uin+skey, which is the whole
 * Tencent Cloud console session.
 */
import http from "node:http"

export const OAUTH_BASE = "https://orcaterm.com"

const WECHAT_QRCONNECT = "https://open.weixin.qq.com/connect/qrconnect"

export class WechatLoginError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = "WechatLoginError"
    this.code = code
  }
}

const FRIENDLY = {
  STATE_EXPIRED: "The QR code expired (a WeChat code lasts about five minutes and works once). Scan again.",
  STATE_MISMATCH: "The state is no longer valid. Start the sign-in again.",
  INVALID_REQUEST: "WeChat's code was not accepted (it may already have been used). Scan again.",
  PROVIDER_DISABLED: "OrcaTerm has disabled WeChat sign-in.",
}

async function jsonFetch(url, init = {}, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { res, body, text }
  } finally {
    clearTimeout(t)
  }
}

/** Step 1: read appid/redirect_uri/state and build the scan URL. */
export async function startWechatLogin({ base = OAUTH_BASE } = {}) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/config`, {
    headers: { accept: "application/json" },
  })
  const d = body?.data
  if (!res.ok || Number(body?.code) !== 0 || !d) {
    throw new WechatLoginError(
      String(body?.code ?? "INTERNAL_ERROR"),
      body?.message || text.slice(0, 120) || `[config] http ${res.status}`,
    )
  }
  if (!d.appid || !d.redirect_uri || !d.state || !d.scope) {
    throw new WechatLoginError("INTERNAL_ERROR", "[config] response is missing a field")
  }

  const qr = new URL(WECHAT_QRCONNECT)
  qr.searchParams.set("appid", d.appid)
  qr.searchParams.set("redirect_uri", d.redirect_uri)
  qr.searchParams.set("response_type", "code")
  qr.searchParams.set("scope", d.scope)
  qr.searchParams.set("state", d.state)

  return {
    appid: d.appid,
    redirectUri: d.redirect_uri,
    state: d.state,
    scope: d.scope,
    url: `${qr.toString()}#wechat_redirect`,
  }
}

/** Step 4: trade the code for a token. */
export async function exchangeCode({ code, state, base = OAUTH_BASE }) {
  const { res, body, text } = await jsonFetch(`${base}/oauth/wechat/exchange`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code, state }),
  })
  const known = ["STATE_EXPIRED", "STATE_MISMATCH", "INVALID_REQUEST", "PROVIDER_DISABLED"]
  const c = String(body?.code ?? "")
  if (!res.ok || Number(body?.code) !== 0 || !body?.data) {
    const code2 = known.includes(c) ? c : "INTERNAL_ERROR"
    throw new WechatLoginError(
      code2,
      FRIENDLY[code2] || body?.message || text.slice(0, 160) || "WeChat sign-in failed",
    )
  }
  const d = body.data
  if (!d.accessToken) throw new WechatLoginError("INTERNAL_ERROR", "[exchange] no accessToken in the response")
  const expiresIn = Number(d.expiresIn) || 0
  return {
    userId: String(d.userId ?? ""),
    nickname: d.providerUsername ?? "",
    avatar: d.avatar ?? "",
    accessToken: d.accessToken,
    expiresIn,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  }
}

/** Renew: trade the current token for a fresh one (same two-hour life). */
export async function refreshAccessToken(token, { base = OAUTH_BASE } = {}) {
  const { body, text } = await jsonFetch(
    `${base}/cgi/api?action=OAuthRefreshToken`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ action: "OAuthRefreshToken", data: { accessToken: token } }),
    },
    15000,
  )
  const r = body?.data?.Response ?? body?.data
  const next = r?.accessToken ?? r?.AccessToken
  if (!next) {
    throw new WechatLoginError("INTERNAL_ERROR", `renewal failed: ${(r?.Error?.Message || text).slice(0, 120)}`)
  }
  const expiresIn = Number(r?.expiresIn ?? r?.ExpiresIn) || 0
  return { accessToken: next, expiresIn, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null }
}

/** Read userId/nickname/expiry out of the JWT (no signature check). */
export function readTokenClaims(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"))
    return {
      userId: p?.userId != null ? String(p.userId) : "",
      nickname: p?.providerUsername ?? "",
      exp: Number(p?.exp) || 0,
    }
  } catch {
    return { userId: "", nickname: "", exp: 0 }
  }
}

/** True for something shaped like a WeChat OAuth access token (a JWT). */
export function looksLikeAccessToken(s) {
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(String(s ?? "").trim())
}

const PAGE = ({ appid, redirectUri, state }) => `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OrcaTerm · WeChat sign-in</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;
    font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  #done{display:none;align-items:center;justify-content:center;height:100%;text-align:center;padding:24px}
  .err{color:#ff8a8a}
</style>
<div id="wrap"><div id="wxqr"></div></div>
<div id="done"></div>
<script src="https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js"></script>
<script>
  const APPID = ${JSON.stringify(appid)};
  const REDIRECT = ${JSON.stringify(redirectUri)};
  const STATE = ${JSON.stringify(state)};

  // self_redirect: true keeps the return inside the widget's own iframe, so the
  // host page (this one) survives to receive the postMessage.
  new WxLogin({
    self_redirect: true,
    id: 'wxqr',
    appid: APPID,
    scope: 'snsapi_login',
    redirect_uri: encodeURIComponent(REDIRECT),
    state: STATE,
    style: 'black',
    href: '',
  });

  function done(text, isErr) {
    document.getElementById('wrap').style.display = 'none';
    const d = document.getElementById('done');
    d.className = isErr ? 'err' : '';
    d.textContent = text;
    d.style.display = 'flex';
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.type !== 'wechat-oauth-callback') return;
    try {
      const r = await fetch('/cb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: d.code, state: d.state, error: d.error }),
      });
      const j = await r.json();
      done(j.ok ? 'Scanned — signing in… (you can close this page once it finishes)'
                : ('Sign-in failed: ' + (j.error || 'unknown error')), !j.ok);
    } catch (err) {
      done('Sign-in failed: ' + err, true);
    }
  });
</script>
</html>`

/**
 * The local page that embeds the QR widget and hands back the code.
 * Returns {ready, wait, close}: `ready` resolves to the page URL, `wait` to
 * {code, state} once the scan comes back.
 */
export function createLocalCapture({ appid, redirectUri, state, timeoutMs = 300000 }) {
  let settleWait
  let failWait
  let resolveReady
  let settled = false

  const ready = new Promise((r) => {
    resolveReady = r
  })
  const wait = new Promise((res, rej) => {
    settleWait = res
    failWait = rej
  })
  wait.catch(() => {})

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(PAGE({ appid, redirectUri, state }))
      return
    }

    if (req.method === "POST" && url.pathname === "/cb") {
      let raw = ""
      req.on("data", (c) => {
        raw += c
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on("end", () => {
        let body = {}
        try {
          body = JSON.parse(raw || "{}")
        } catch {
          /* ignore */
        }
        const ok = Boolean(body.code) && !body.error
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: body.error || "no code" }))
        if (!ok || settled) return
        settled = true
        clearTimeout(timer)
        settleWait({ code: body.code, state: body.state || state })
      })
      return
    }

    res.writeHead(404).end()
  })

  function close() {
    clearTimeout(timer)
    try {
      server.close()
    } catch {
      /* ignore */
    }
  }

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    close()
    failWait(new Error("Timed out waiting for the scan; try again."))
  }, timeoutMs)

  const wantPort = Number(process.env.ORCATERM_CAPTURE_PORT) || 4080
  const base = process.env.ORCATERM_CAPTURE_BASE || ""
  const host = process.env.ORCATERM_CAPTURE_HOST || "127.0.0.1"

  const listen = (port) => {
    const onErr = (e) => {
      // the fixed port may already be taken: any free one is fine, the URL tells
      // the user where to go
      if (e?.code === "EADDRINUSE" && port !== 0) {
        listen(0)
        return
      }
      if (!settled) {
        settled = true
        clearTimeout(timer)
        failWait(e)
      }
    }
    server.once("error", onErr)
    server.listen(port, host, () => {
      server.removeListener("error", onErr)
      const actual = server.address().port
      const shown = host === "0.0.0.0" ? "127.0.0.1" : host
      resolveReady(`${base || `http://${shown}:${actual}`}/login`)
    })
  }

  listen(wantPort)

  return { ready, wait, close }
}
