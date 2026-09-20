# miniapps.ai -> OpenAI 兼容反代

把 miniapps.ai 的私有 /chat 协议包装成 OpenAI 标准接口，任何兼容客户端（Cherry Studio、NextChat、Chatbox、LobeChat）都能直连。

## 两种部署方式

### 方式 A：Cloudflare Workers（推荐，免费、无需服务器）

```bash
cd miniapps-proxy

# 1. 安装 wrangler 并登录
npm i -g wrangler
wrangler login

# 2. 配置 secrets（cookie 从浏览器 F12 抓，见下）
wrangler secret put MINIAPPS_COOKIE      # 或 MINIAPPS_TOKEN
wrangler secret put GATEWAY_API_KEY      # 你的网关密钥
# (可选) wrangler secret put MINIAPPS_MODEL_ID

# 3. 部署
wrangler deploy
```

部署完成后会给你 `https://miniapps-proxy.<你的子域>.workers.dev`。

### 方式 B：本地 Python（自托管）

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填 MINIAPPS_COOKIE
python proxy.py        # 默认 8787
```

## 抓 cookie（必需，一次抓可用很久）

1. 电脑浏览器登录 https://miniapps.ai （Google 登录最快）
2. 打开 F12 → Network，随便发一句话
3. 找到 `api.miniapps.ai/chat` 请求 → Headers → Request Headers
4. 复制整段 `Cookie:` 值（含 `jwt=...`）作为 `MINIAPPS_COOKIE`
   - 或复制 `Authorization: Bearer xxx` 的 `xxx` 作为 `MINIAPPS_TOKEN`

## 客户端接入

```
Base URL : https://miniapps-proxy.<你的子域>.workers.dev/v1
API Key  : <你的 GATEWAY_API_KEY>
模型名   : gpt-6-astra / gpt-6-astra-free / gpt-6-astra-max / gpt-6-astra-pro-free / gpt-6-astra-max-free
```

## curl 测试

```bash
# 非流式
curl https://miniapps-proxy.<子域>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra-free","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N .../v1/chat/completions \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra-free","messages":[{"role":"user","content":"写首诗"}],"stream":true}'
```

## 已知限制 / 说明

- **必须登录**：miniapps 无匿名聊天，cookie 过期需重新抓
- **多轮对话**：每次请求把完整 messages 拼进首轮文本（简单可靠）；如需 conversationId 复用作长对话记忆可自行扩展
- **流式**：miniapps 原生非流式，代理按切块模拟 SSE；Workers 版内置 30ms 打字机延时，客户端体验一致（免费版 CPU 限制 10ms 只算计算时间，异步等待不算，放心）
- **速率**：个人自用没问题；高频调用有封号风险，Workers 默认 IP 出口混合，被封了就换新 cookie
- **验证码**：登出后触发 Turnstile 需浏览器重新登录抓新 cookie

## 文件

| 文件 | 说明 |
|---|---|
| `worker.js` + `wrangler.toml` | Cloudflare Workers 版（Node 语法已过检） |
| `miniapps_client.py` | miniapps 原生 API 封装（Python 版） |
| `proxy.py` | OpenAI 兼容 FastAPI 网关（Python 版） |
| `.env.example` | Python 版配置模板 |
| `README.md` | 本文档 |