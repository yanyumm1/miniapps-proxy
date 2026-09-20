/**
 * miniapps.ai -> OpenAI 兼容 API (Cloudflare Workers 版)
 *
 * 路由:
 *   POST /v1/chat/completions   (stream / non-stream)
 *   GET  /v1/models
 *   GET  /healthz
 *
 * 部署: wrangler deploy
 * Secrets: MINIAPPS_COOKIE 或 MINIAPPS_TOKEN, GATEWAY_API_KEY
 */

const API_URL = "https://api.miniapps.ai";
const FRONT_URL = "https://miniapps.ai";

// 模型 -> miniapps tool 映射 (revision 为实测值)
const TOOL_MAP = {
  "gpt-6-astra": {
    toolId: "a109c325-fe40-4f50-a815-1bfac2ddb7bb",
    revision: 1,
  },
  "gpt-6-astra-free": {
    toolId: "8e650a64-e7a2-4454-9b06-d5c696ded9a2",
    revision: 2,
  },
  "gpt-6-astra-max": {
    toolId: "04a5d20f-1db5-424d-a111-bc8ba487c579",
    revision: 1,
  },
  "gpt-6-astra-pro-free": {
    toolId: "89724029-26f8-422a-84f6-ccc42fee4133",
    revision: 2,
  },
  "gpt-6-astra-max-free": {
    toolId: "1afb35c4-ba25-46dd-99a2-8b740da08606",
    revision: 2,
  },
};

// 顶层每个 worker 实例内缓存 csrf（5 分钟复用）
let csrfCache = { token: null, ts: 0 };

async function getCsrf(env) {
  if (csrfCache.token && Date.now() - csrfCache.ts < 300_000) {
    return csrfCache.token;
  }
  const res = await fetch(`${API_URL}/auth/csrf`, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Origin: FRONT_URL,
      Referer: `${FRONT_URL}/zh/gpt-6-astra`,
      ...(env.MINIAPPS_COOKIE ? { Cookie: env.MINIAPPS_COOKIE } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`csrf 获取失败: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  csrfCache = { token: data.csrfToken, ts: Date.now() };
  return data.csrfToken;
}

/**
 * 调 miniapps /chat
 * @returns {Promise<{ok: boolean, status: number, body: any, raw: string}>}
 */
async function chatRequest(prompt, model, env, retried = false) {
  const tool = TOOL_MAP[model];
  const body = {
    toolId: tool.toolId,
    revision: tool.revision,
    modelId: env.MINIAPPS_MODEL_ID || "f57145fe-a761-4ac4-9cc5-676ac291c433",
    conversationId: null,
    requestId: crypto.randomUUID(),
    elements: [{ type: "text", text: prompt }],
    language: "zh-Hans",
  };

  const headers = {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    Origin: FRONT_URL,
    Referer: `${FRONT_URL}/zh/gpt-6-astra`,
    "x-csrf-token": await getCsrf(env),
  };
  if (env.MINIAPPS_COOKIE) headers.Cookie = env.MINIAPPS_COOKIE;
  if (env.MINIAPPS_TOKEN) headers.Authorization = `Bearer ${env.MINIAPPS_TOKEN}`;

  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.text();

  // 419 -> csrf 失效，清缓存重试一次
  if (res.status === 419 && !retried) {
    csrfCache = { token: null, ts: 0 };
    return chatRequest(prompt, model, env, true);
  }
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      body: { error: "AUTH_REQUIRED: 检查 MINIAPPS_COOKIE/TOKEN 是否过期" },
      raw,
    };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, body: { error: raw.slice(0, 500) }, raw };
  }
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, body: { error: "非 JSON 响应" }, raw };
  }
  return { ok: true, status: res.status, body: json, raw };
}

/** 从 /chat 响应里提取助手文本（容错多种结构） */
function extractAssistantText(data, fallback = "") {
  const pick = (elem) => {
    if (typeof elem === "string") return elem;
    if (elem && typeof elem === "object") {
      for (const k of ["text", "content", "value"]) {
        const v = elem[k];
        if (typeof v === "string" && v) return v;
      }
      if (Array.isArray(elem.elements)) {
        return elem.elements.map(pick).join("");
      }
    }
    return "";
  };

  const msgs = data.addedMessages || [];
  const parts = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const origin = m.origin;
    if (!(origin === 2 || origin === "assistant" || origin === "Assistant")) continue;
    let txt = pick(m);
    if (!txt && m.message) txt = pick(m.message);
    if (!txt && m.content) txt = pick(m.content);
    if (txt) parts.push(txt);
  }
  return parts.join("\n") || fallback || data.message || "";
}

/** 把 OpenAI messages 拼成 miniapps 纯文本 */
function buildPrompt(messages) {
  const lines = [];
  for (const m of messages || []) {
    const role = m.role || "user";
    let content = m.content ?? "";
    if (Array.isArray(content)) {
      content = content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join(" ");
    }
    if (role === "system") lines.push(`[系统] ${content}`);
    else if (role === "user") lines.push(`[用户] ${content}`);
    else if (role === "assistant") lines.push(`[助手] ${content}`);
    else lines.push(String(content));
  }
  return lines.join("\n").trim();
}

function openaiCompletion(text, model, id) {
  return {
    id: id || `chatcmpl-${crypto.randomUUID().slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 模拟 OpenAI SSE 流式（miniapps 原生非流式，按字切块） */
function* sseChunks(text, model, id) {
  const head = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  yield `data: ${JSON.stringify(head)}\n\n`;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: text.slice(i, i + 4) }, finish_reason: null }],
    };
    yield `data: ${JSON.stringify(chunk)}\n\n`;
  }
  const tail = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  yield `data: ${JSON.stringify(tail)}\n\n`;
  yield "data: [DONE]\n\n";
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (key !== (env.GATEWAY_API_KEY || "miniapps-1234")) {
    return new Response(JSON.stringify({ error: "Invalid API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

async function handleChatCompletions(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const model = body.model || "gpt-6-astra-free";
  const stream = !!body.stream;
  const messages = body.messages || [];
  if (!messages.length) {
    return new Response(JSON.stringify({ error: "messages 不能为空" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (!TOOL_MAP[model]) {
    return new Response(
      JSON.stringify({
        error: `未知模型: ${model}，可选: ${Object.keys(TOOL_MAP).join(", ")}`,
      }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }

  const prompt = buildPrompt(messages);
  let result;
  try {
    result = await chatRequest(prompt, model, env);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.body?.error || "上游失败" }), {
      status: result.status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const text = extractAssistantText(result.body);
  if (!text) {
    return new Response(JSON.stringify({ error: "miniapps 返回空回复" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const id = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;

  if (stream) {
    const encoder = new TextEncoder();
    const gen = sseChunks(text, model, id);
    const streamBody = new ReadableStream({
      start(controller) {
        const push = () => {
          try {
            const { value, done } = gen.next();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(value));
            // 小延时模拟打字效果（保持每秒 ~30 个 token 的观感）
            setTimeout(push, 30);
          } catch (err) {
            controller.error(err);
          }
        };
        push();
      },
    });
    return new Response(streamBody, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        ...CORS_HEADERS,
      },
    });
  }

  return new Response(JSON.stringify(openaiCompletion(text, model, id)), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleChatCompletions(request, env);
    }
    if (url.pathname === "/v1/models") {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      return new Response(
        JSON.stringify({
          object: "list",
          data: Object.keys(TOOL_MAP).map((id) => ({
            id,
            object: "model",
            owned_by: "miniapps.ai",
          })),
        }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
};