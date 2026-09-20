"""
miniapps.ai -> OpenAI 兼容反代服务
暴露: POST /v1/chat/completions   (stream 与 non-stream 均支持)
用法:   uvicorn proxy:app --host 0.0.0.0 --port 8787
"""
import os
import time
import json
import uuid
from typing import List, Dict

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse

from miniapps_client import MiniappsClient, MiniappsError

app = FastAPI(title="miniapps-openai-proxy")

# 网关自身校验 key（OpenAI 兼容客户端填的 api_key）
GATEWAY_KEY = os.environ.get("GATEWAY_API_KEY", "miniapps-1234")

_client: MiniappsClient | None = None


def get_client() -> MiniappsClient:
    global _client
    if _client is None:
        try:
            _client = MiniappsClient()
        except MiniappsError as e:
            raise HTTPException(500, f"客户端初始化失败: {e}")
    return _client


def check_auth(request: Request):
    auth = request.headers.get("Authorization", "")
    key = auth.removeprefix("Bearer ").strip()
    if key != GATEWAY_KEY:
        raise HTTPException(401, "Invalid API key")


def build_messages_prompt(messages: List[Dict]) -> str:
    """把 OpenAI 格式 messages 拼成 miniapps 的纯文本输入（保留角色标记）"""
    lines = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if isinstance(content, list):  # 多模态结构，只取 text
            content = " ".join(
                c.get("text", "") for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        if role == "system":
            lines.append(f"[系统] {content}")
        elif role == "user":
            lines.append(f"[用户] {content}")
        elif role == "assistant":
            lines.append(f"[助手] {content}")
        else:
            lines.append(str(content))
    return "\n".join(lines).strip()


def openai_response(text: str, model: str) -> Dict:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def sse_encode(chunk: Dict) -> str:
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


def stream_openai_response(text: str, model: str):
    """模拟 OpenAI SSE 流式输出（按字切块）"""
    head = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
    }
    yield sse_encode(head)
    # 按 4 字一批模拟流式
    for i in range(0, len(text), 4):
        delta = {"index": 0, "delta": {"content": text[i:i + 4]}, "finish_reason": None}
        yield sse_encode({"id": head["id"], "object": head["object"],
                          "created": head["created"], "model": model, "choices": [delta]})
    tail = {"index": 0, "delta": {}, "finish_reason": "stop"}
    yield sse_encode({"id": head["id"], "object": head["object"],
                      "created": head["created"], "model": model, "choices": [tail]})
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    check_auth(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    messages: List[Dict] = body.get("messages", [])
    model: str = body.get("model", "gpt-6-astra-free")
    stream: bool = bool(body.get("stream", False))
    if not messages:
        raise HTTPException(400, "messages 不能为空")

    prompt = build_messages_prompt(messages)
    try:
        client = get_client()
        data = client.chat(text=prompt, model=model)
        text = client.extract_assistant_text(data)
        if not text:
            raise MiniappsError("miniapps 返回空回复")
    except MiniappsError as e:
        raise HTTPException(502, str(e))

    if stream:
        return StreamingResponse(stream_openai_response(text, model),
                                 media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})
    return Response(content=json.dumps(openai_response(text, model), ensure_ascii=False),
                    media_type="application/json")


@app.get("/v1/models")
async def list_models():
    check_auth(request := Request())
    from miniapps_client import TOOL_MAP
    return {
        "object": "list",
        "data": [
            {"id": name, "object": "model", "owned_by": "miniapps.ai"}
            for name in TOOL_MAP
        ],
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8787"))
    uvicorn.run(app, host="0.0.0.0", port=port)