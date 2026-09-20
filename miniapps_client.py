"""
miniapps.ai 原生 API 封装
- 自动获取/刷新 csrf
- 持有登录凭证（cookie 或 Bearer token）
- 调用 /chat 返回 OpenAI 兼容 LLM 响应
"""
import os
import time
import uuid
import requests

API_URL = "https://api.miniapps.ai"
BASE_URL = os.environ.get("MINIAPPS_API_URL", "https://miniapps.ai")

# 从 .env 读取的凭证（二选一）
MINIAPPS_COOKIE = os.environ.get("MINIAPPS_COOKIE", "")   # 格式: "jwt=xxx; pref-lang=en; ..."
MINIAPPS_TOKEN = os.environ.get("MINIAPPS_TOKEN", "")     # 格式: "Bearer xxx" 或裸 token

# 模型 -> miniapps tool 映射（revision 实测值）
TOOL_MAP = {
    "gpt-6-astra":          {"toolId": "a109c325-fe40-4f50-a815-1bfac2ddb7bb", "revision": 1},
    "gpt-6-astra-free":     {"toolId": "8e650a64-e7a2-4454-9b06-d5c696ded9a2", "revision": 2},
    "gpt-6-astra-max":      {"toolId": "04a5d20f-1db5-424d-a111-bc8ba487c579", "revision": 1},
    "gpt-6-astra-pro-free": {"toolId": "89724029-26f8-422a-84f6-ccc42fee4133", "revision": 2},
    "gpt-6-astra-max-free": {"toolId": "1afb35c4-ba25-46dd-99a2-8b740da08606", "revision": 2},
}
MODEL_ID = os.environ.get("MINIAPPS_MODEL_ID", "f57145fe-a761-4ac4-9cc5-676ac291c433")


class MiniappsError(Exception):
    pass


class MiniappsClient:
    def __init__(self, cookie: str = None, token: str = None):
        self.cookie = cookie or MINIAPPS_COOKIE
        self.token = token or MINIAPPS_TOKEN
        self._csrf = None
        self._csrf_ts = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Origin": BASE_URL,
            "Referer": f"{BASE_URL}/zh/gpt-6-astra",
        })
        if self.cookie:
            self.session.headers["Cookie"] = self.cookie
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token.lstrip('Bearer ')}"
        if not (self.cookie or self.token):
            raise MiniappsError("必须提供 MINIAPPS_COOKIE 或 MINIAPPS_TOKEN 之一")

    def _get_csrf(self) -> str:
        # 5 分钟内复用，过期自动刷新
        if self._csrf and time.time() - self._csrf_ts < 300:
            return self._csrf
        r = self.session.get(f"{API_URL}/auth/csrf", timeout=15)
        r.raise_for_status()
        self._csrf = r.json()["csrfToken"]
        self._csrf_ts = time.time()
        return self._csrf

    def chat(self, text: str, model: str = "gpt-6-astra-free",
             conversation_id: str = None, language: str = "zh-Hans",
             extra: dict = None) -> dict:
        """调 miniapps /chat，返回其原生 JSON（含 conversationId / addedMessages）"""
        if model not in TOOL_MAP:
            raise MiniappsError(f"未知模型: {model}，可选: {list(TOOL_MAP)}")
        tool = TOOL_MAP[model]
        body = {
            "toolId": tool["toolId"],
            "revision": tool["revision"],
            "modelId": MODEL_ID,
            "conversationId": conversation_id,
            "requestId": str(uuid.uuid4()),
            "elements": [{"type": "text", "text": text}],
            "language": language,
        }
        if extra:
            body.update(extra)
        csrf = self._get_csrf()
        headers = {"x-csrf-token": csrf}
        r = self.session.post(f"{API_URL}/chat", json=body, headers=headers, timeout=180)
        if r.status_code == 419:
            # csrf 失效 -> 强制刷新后重试一次
            self._csrf = None
            csrf = self._get_csrf()
            headers["x-csrf-token"] = csrf
            r = self.session.post(f"{API_URL}/chat", json=body, headers=headers, timeout=180)
        if r.status_code == 401:
            raise MiniappsError("401 AUTH_REQUIRED: 检查 cookie/token 是否过期，重新抓取 jwt")
        try:
            data = r.json()
        except Exception:
            raise MiniappsError(f"非 JSON 响应 {r.status_code}: {r.text[:500]}")
        if not data.get("conversationId"):
            raise MiniappsError(f"聊天未接受: {data.get('message') or data}")
        return data

    @staticmethod
    def extract_assistant_text(data: dict) -> str:
        """从 /chat 响应里提取助手回复文本（容错多种字段名）"""
        def _pick_text(elem) -> str:
            if isinstance(elem, str):
                return elem
            if isinstance(elem, dict):
                # 常见结构: {"type":"text","text":"..."} / {"content":"..."} / {"text":"..."}
                for k in ("text", "content", "value"):
                    v = elem.get(k)
                    if isinstance(v, str) and v:
                        return v
                if "elements" in elem:
                    return "".join(_pick_text(e) for e in elem["elements"])
            return ""

        msgs = data.get("addedMessages") or []
        parts = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            # 优先 assistant；origin 数字 2 或字符串 assistant
            origin = m.get("origin")
            is_assistant = origin in (2, "assistant", "Assistant")
            if not is_assistant:
                continue
            txt = _pick_text(m)
            # 有的消息塞在 message/content 嵌套里
            if not txt and m.get("message"):
                txt = _pick_text(m["message"])
            if not txt and m.get("content"):
                txt = _pick_text(m["content"])
            if txt:
                parts.append(txt)
        return "\n".join(parts) if parts else (data.get("message") or "")