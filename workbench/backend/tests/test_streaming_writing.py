"""Replies start at once (design 0003, section 6, principle 4): a model that streams its answer reaches the chat as
`writing` events piece by piece, while the model is still writing, never held back until the answer is complete."""

import asyncio


def test_writing_events_arrive_while_the_model_is_still_writing(client, monkeypatch):
    from app import adapters, assistant

    cid = assistant.new_conversation("web")
    more = asyncio.Event()  # the model's last piece waits until the chat has shown the first ones
    model_done = {"v": False}

    async def fake_sse(conn, url, body, headers, timeout):
        for piece in ("Hello", " there", ","):
            yield {"choices": [{"delta": {"content": piece}}]}
            await asyncio.sleep(0)
        try:
            await asyncio.wait_for(more.wait(), 5)
        except asyncio.TimeoutError:
            pass
        yield {"choices": [{"delta": {"content": " friend."}}]}
        yield {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 4}}
        model_done["v"] = True

    monkeypatch.setattr(adapters, "_sse", fake_sse)

    async def go():
        writes: list[tuple[str, bool]] = []
        events = []
        ctx = assistant.Ctx(channel="web", conversation_id=cid)
        async for e in assistant.run_turn(ctx, "say hello", None):
            events.append(e)
            if e["type"] == "writing":
                writes.append((e["text"], model_done["v"]))
                if "".join(t for t, _ in writes) == "Hello there,":
                    more.set()
        return writes, events

    writes, events = asyncio.run(go())
    text = "".join(t for t, _ in writes)
    assert text == "Hello there, friend."
    assert len(writes) >= 3, writes  # one event per piece, not one at the end
    early = [t for t, done in writes if not done]
    assert "".join(early).startswith("Hello there,"), writes  # shown before the model finished
    final = [e for e in events if e["type"] == "message"]
    assert final and final[-1]["content"] == "Hello there, friend."
