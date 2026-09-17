from __future__ import annotations

import httpx
import pytest

from tiershift.providers import AnthropicProvider, CompletionRequest, OpenAICompatibleProvider, ProviderError

OK = {"model": "served-1", "choices": [{"finish_reason": "stop", "message": {"content": "hi", "tool_calls": [{"id": "c1", "function": {"name": "f", "arguments": "{\"a\":1}"}}]}}], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}


def fake_client(status: int, body: dict, capture: dict) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        capture["url"] = str(request.url)
        capture["body"] = httpx.Response(200, content=request.content).json()
        capture["headers"] = dict(request.headers)
        return httpx.Response(status, json=body)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_token_param_by_host():
    a, b = {}, {}
    OpenAICompatibleProvider("openai", "https://api.openai.com/v1", api_key="k", client=fake_client(200, OK, a)).complete(CompletionRequest(model="m", messages=[{"role": "user", "content": "x"}], max_tokens=9))
    OpenAICompatibleProvider("ollama", "http://localhost:11434/v1", client=fake_client(200, OK, b)).complete(CompletionRequest(model="m", messages=[{"role": "user", "content": "x"}], max_tokens=9))
    assert a["body"]["max_completion_tokens"] == 9 and "max_tokens" not in a["body"]
    assert b["body"]["max_tokens"] == 9 and "max_completion_tokens" not in b["body"]
    assert a["headers"]["authorization"] == "Bearer k" and "authorization" not in b["headers"]


def test_params_tools_and_parse():
    cap = {}
    r = OpenAICompatibleProvider("ds", "https://api.deepseek.com", api_key="k", client=fake_client(200, OK, cap)).complete(
        CompletionRequest(model="m", messages=[{"role": "user", "content": "x"}], tools=[{"name": "f", "description": "d"}], params={"thinking": {"type": "disabled"}}))
    assert cap["url"] == "https://api.deepseek.com/chat/completions"
    assert cap["body"]["thinking"] == {"type": "disabled"}
    assert cap["body"]["tools"][0]["function"]["name"] == "f"
    assert r.text == "hi" and r.tool_calls[0].name == "f" and r.tool_calls[0].arguments == '{"a":1}'
    assert r.served_model == "served-1" and (r.input_tokens, r.output_tokens) == (5, 2)


def test_provider_error_status_and_retryable():
    with pytest.raises(ProviderError) as ei:
        OpenAICompatibleProvider("x", "https://h", api_key="k", client=fake_client(429, {"error": {"message": "slow down"}}, {})).complete(CompletionRequest(model="m", messages=[]))
    assert ei.value.status == 429 and ei.value.retryable and "slow down" in str(ei.value)
    with pytest.raises(ProviderError) as ei2:
        OpenAICompatibleProvider("x", "https://h", api_key="k", client=fake_client(400, {"error": {"message": "bad"}}, {})).complete(CompletionRequest(model="m", messages=[]))
    assert ei2.value.status == 400 and not ei2.value.retryable
    assert ProviderError("x", 503, "down").retryable and ProviderError("x", None, "net").retryable


def test_anthropic_body_and_parse():
    cap = {}
    body = {"model": "claude-x", "stop_reason": "end_turn", "content": [{"type": "text", "text": "yo"}, {"type": "tool_use", "id": "t1", "name": "f", "input": {"a": 1}}], "usage": {"input_tokens": 7, "output_tokens": 3}}
    r = AnthropicProvider("anthropic", api_key="k", client=fake_client(200, body, cap)).complete(
        CompletionRequest(model="claude-x", messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}], tools=[{"name": "f"}], max_tokens=50))
    assert cap["url"].endswith("/v1/messages") and cap["headers"]["x-api-key"] == "k" and cap["headers"]["anthropic-version"] == "2023-06-01"
    assert cap["body"]["system"] == "S" and cap["body"]["messages"] == [{"role": "user", "content": "u"}] and cap["body"]["max_tokens"] == 50
    assert cap["body"]["tools"][0]["input_schema"] == {"type": "object", "properties": {}}
    assert r.text == "yo" and r.tool_calls[0].arguments == '{"a": 1}' and r.finish_reason == "end_turn" and (r.input_tokens, r.output_tokens) == (7, 3)
