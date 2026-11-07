from rooks_desk import llm


def test_anthropic_body_has_no_sampling_params(monkeypatch):
    """Current Claude models (Sonnet 5.5 and later) reject a non-default temperature with a 400."""
    seen = []
    m = llm.make("anthropic", "claude-sonnet-5-5", base_url="http://127.0.0.1:9", api_key="k")
    monkeypatch.setattr(m, "_post", lambda url, body, headers: seen.append((url, body, headers)) or
                        {"content": [{"type": "text", "text": "{}"}], "usage": {"input_tokens": 1, "output_tokens": 1}})
    m.complete("sys", "screen", "AAAA")
    url, body, headers = seen[0]
    assert url.endswith("/v1/messages") and headers["x-api-key"] == "k"
    assert "temperature" not in body and "top_p" not in body


def test_anthropic_default_is_current():
    assert llm.PROVIDERS["anthropic"].default_model == "claude-sonnet-5-5"
