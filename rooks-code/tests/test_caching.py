"""Prompt caching and honest cost: cached reads and Anthropic cache writes are counted apart and charged at the cached
price in /cost, the receipts, the headless result and the dollar cap. A cached price that is not known is said to be
unknown, never guessed.

Every test here uses the scripted fake model (fakes.py); no real model key exists, so no live provider call is made.
"""

import json

import pytest

from conftest import rooks
from fakes import FakeModel, anthropic_reply, anthropic_stream, openai_reply


@pytest.fixture
def fake():
    servers = []

    def make(script):
        servers.append(FakeModel(script))
        return servers[-1]
    yield make
    for s in servers:
        s.close()


def receipt(project):
    rows = {}
    for f in sorted((project / ".rooks" / "runs").glob("*.jsonl")):
        for line in f.read_text().splitlines():
            r = json.loads(line)
            rows[r["id"]] = r
    return list(rows.values())


def calls(project):
    return [r for r in receipt(project) if r["kind"] == "model_call" and r["outcome"] == "ok"]


ANTHROPIC = ("-P", "anthropic", "-m", "claude-sonnet-4-5")  # $3 in, $15 out; cache read $0.30, cache write $3.75
KEY = {"ANTHROPIC_API_KEY": "test-key"}


# --- the providers read the cache counts ---------------------------------------------------------------------------

def test_openai_reads_cached_tokens_plain_and_streamed(fake):
    from rooks_code.providers import OpenAIChat

    m = fake([openai_reply("plain", tokens=(10_000, 100), cached=8_000), openai_reply("streamed", tokens=(12_000, 50), cached=9_500)])
    model = OpenAIChat(m.url, "", "gpt-4.1")
    plain = model.complete("sys", [{"role": "user", "content": "hi"}], [])
    streamed = model.complete("sys", [{"role": "user", "content": "hi"}], [], on_text=lambda _t: None)
    assert (plain.tokens_in, plain.cache_read, plain.cache_write) == (10_000, 8_000, 0)
    assert (streamed.text, streamed.tokens_in, streamed.cache_read) == ("streamed", 12_000, 9_500)


def test_anthropic_reads_cache_reads_and_writes_plain_and_streamed(fake):
    from rooks_code.providers import Anthropic

    stream = anthropic_stream("streamed", tokens=(300, 40))
    stream[0]["message"]["usage"].update(cache_read_input_tokens=7_000, cache_creation_input_tokens=1_200)
    m = fake([anthropic_reply("plain", tokens=(200, 30), cache_read=5_000, cache_write=800), stream])
    model = Anthropic(m.url, "k", "claude-sonnet-4-5")
    plain = model.complete("sys", [{"role": "user", "content": "hi"}], [])
    streamed = model.complete("sys", [{"role": "user", "content": "hi"}], [], on_text=lambda _t: None)
    # tokens_in is still the whole input (as before), with the cached part told apart
    assert (plain.tokens_in, plain.cache_read, plain.cache_write) == (6_000, 5_000, 800)
    assert (streamed.tokens_in, streamed.cache_read, streamed.cache_write) == (8_500, 7_000, 1_200)


def test_anthropic_plain_request_carries_cache_marks(fake):
    """The streamed request is checked in test_sessions_stream_login; this is the plain (piped) one."""
    from rooks_code.providers import Anthropic

    m = fake([anthropic_reply("Done.")])

    model = Anthropic(m.url, "k", "claude-sonnet-4-5")
    model.complete("the system prompt", [{"role": "user", "content": "go"}],
                   [{"name": "list_files", "description": "list", "parameters": {"type": "object", "properties": {}}}])
    body = m.requests[0]["body"]
    assert body["system"] == [{"type": "text", "text": "the system prompt", "cache_control": {"type": "ephemeral"}}]
    assert body["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    assert body["messages"][-1]["content"][-1]["cache_control"] == {"type": "ephemeral"}


# --- /cost and the receipts charge the cached price -----------------------------------------------------------------

def test_cost_shows_cached_tokens_and_charges_the_cached_price(project, fake):
    m = fake([anthropic_reply("", [("list_files", {})], tokens=(1_000, 100), cache_write=20_000),
              anthropic_reply("Done.", tokens=(500, 50), cache_read=20_000, cache_write=1_000)])
    r = rooks(project, *ANTHROPIC, "--base-url", m.url, stdin="look around\n/cost\n/exit\n", env=KEY)
    assert r.returncode == 0, r.stderr
    # call 1: 1,000 x $3 + 20,000 written x $3.75 + 100 out x $15 = $0.0795
    # call 2: 500 x $3 + 20,000 read x $0.30 + 1,000 written x $3.75 + 50 out x $15 = $0.0120
    assert [c["usd_cost"] for c in calls(project)] == [0.0795, 0.012]
    assert [(c["cache_read_tokens"], c["cache_write_tokens"]) for c in calls(project)] == [(0, 20_000), (20_000, 1_000)]
    assert "42,500 in + 150 out tokens" in r.stdout
    assert "20,000 of the input read from the cache, 21,000 written to it" in r.stdout
    assert "$0.0915" in r.stdout  # at the full input price it would have been $0.1298


def test_openai_cached_tokens_are_charged_at_the_cached_price(project, fake):
    m = fake([openai_reply("All done.", tokens=(100_000, 1_000), cached=80_000)])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "gpt-4.1", "go")
    assert r.returncode == 0, r.stderr
    # 20,000 x $2 + 80,000 cached x $0.50 + 1,000 out x $8 = $0.088 (full price: $0.208)
    assert [c["usd_cost"] for c in calls(project)] == [0.088]
    assert calls(project)[0]["cache_read_tokens"] == 80_000


def test_headless_result_reports_cached_tokens(project, fake):
    m = fake([openai_reply("All done.", tokens=(100_000, 1_000), cached=80_000)])
    r = rooks(project, "-p", "go", "--output-format", "json", "-P", "openai-compatible", "--base-url", m.url, "-m", "gpt-4.1")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["tokens"] == {"input": 100_000, "output": 1_000, "cache_read": 80_000, "cache_write": 0}
    assert out["cost_usd"] == 0.088
    import jsonschema

    from rooks_code import sdk
    jsonschema.validate(out, {**sdk.schema(), "$ref": "#/$defs/result"})


# --- the dollar cap charges the cached price ------------------------------------------------------------------------

def test_cap_counts_cached_reads_at_the_cached_price(project, fake):
    """At the full input price the first call costs $0.808 and a $0.50 cap would stop; at the cached price it is $0.238."""
    m = fake([openai_reply("", [("list_files", {})], tokens=(400_000, 1_000), cached=380_000), openai_reply("Finished.")])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "gpt-4.1", "--max-usd", "0.5", "--max-tokens", "0", "go")
    assert r.returncode == 0, r.stderr
    assert "Finished." in r.stdout and len(m.requests) == 2


def test_cap_stops_on_the_cached_spend(project, fake):
    m = fake([openai_reply("", [("list_files", {})], tokens=(400_000, 1_000), cached=380_000), openai_reply("never sent")])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "gpt-4.1", "--max-usd", "0.2", "--max-tokens", "0", "go")
    assert r.returncode == 1 and "cost cap reached: $0.2380 spent" in r.stderr and len(m.requests) == 1


def test_cap_charges_anthropic_cache_writes_above_the_input_price(project, fake):
    """A cache write costs 1.25x the input price: 1,000 x $3 + 100,000 x $3.75 = $0.378, not $0.303."""
    m = fake([anthropic_reply("", [("list_files", {})], tokens=(1_000, 0), cache_write=100_000), anthropic_reply("never sent")])
    r = rooks(project, *ANTHROPIC, "--base-url", m.url, "--max-usd", "0.35", "go", env=KEY)
    assert r.returncode == 1 and "cost cap reached: $0.3780 spent" in r.stderr and len(m.requests) == 1


def test_cap_estimate_allows_for_a_cache_write(project, fake):
    """Every Anthropic request asks for its prompt to be cached, so the next call may write all of it at $3.75 per
    million: the cap's estimate uses that, not $3, and stops before a call that could cross it."""
    from rooks_code import config
    from rooks_code.agent import Agent
    from rooks_code.cli import UI
    import io

    m = fake([anthropic_reply("never sent")])
    s = config.resolve({"provider": "anthropic", "base_url": m.url, "model": "claude-sonnet-4-5", "yes": True}, project, file={})
    s.key, s.stream = "k", False
    agent = Agent(s, UI(out=io.StringIO(), err=io.StringIO(), color=False))
    estimate = agent._estimate() + 20  # the prompt "hi" adds a few tokens
    agent.s.max_usd = agent.budget.max_usd = estimate * 3.375 / 1_000_000  # between the input and the write price
    answer = agent.run("hi")
    agent.close()
    assert answer.startswith("Stopped: cost cap reached") and m.requests == []


# --- an unknown cached price is said, not guessed --------------------------------------------------------------------

def test_unknown_cached_price_is_reported_not_guessed(project, fake, tmp_path):
    cfg = tmp_path / "rooks.toml"
    cfg.write_text(cfg.read_text() + '\n[prices]\n"my-model" = [1.0, 2.0]\n')
    m = fake([openai_reply("Hello.", tokens=(10_000, 100), cached=9_000)])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "my-model", "--max-usd", "1",
              stdin="hi\n/cost\n/exit\n")
    assert r.returncode == 0, r.stderr
    assert [c["usd_cost"] for c in calls(project)] == [None]
    assert "cost unknown" in r.stdout
    said = r.stdout + r.stderr
    assert "price of cached tokens for my-model is unknown" in said and "cannot be enforced" in said


def test_cached_price_can_be_set_in_the_config(project, fake, tmp_path):
    cfg = tmp_path / "rooks.toml"
    cfg.write_text(cfg.read_text() + '\n[prices]\n"my-model" = [1.0, 2.0, 0.1, 1.25]\n')
    m = fake([openai_reply("Hello.", tokens=(10_000, 100), cached=9_000)])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "my-model", "hi")
    assert r.returncode == 0, r.stderr
    # 1,000 x $1 + 9,000 x $0.10 + 100 x $2 = $0.0021
    assert [c["usd_cost"] for c in calls(project)] == [0.0021]


def test_a_claude_model_priced_with_two_numbers_gets_anthropics_cache_rule():
    """[prices] claude-sonnet-4-5 = [3, 15]: cached input follows Anthropic's published rule from that input price
    (a read 0.1x, a write 1.25x), so the dollar cap keeps counting once the cache is used."""
    from rooks_code import providers

    over = {"claude-sonnet-4-5": [3, 15]}
    assert providers.cost("claude-sonnet-4-5", 100000, 1000, over, False, 90000, 5000) == 0.07575
    assert providers.cost("claude-sonnet-4-5", 100000, 1000, {"claude-sonnet-4-5": [6, 30]}, False, 90000, 5000) == 0.1515
    assert providers.cost("claude-sonnet-4-5", 100000, 1000, {"claude-sonnet-4-5": [3, 15, 0.5]}, False, 90000, 5000) \
        == round((5000 * 3 + 90000 * 0.5 + 5000 * 3.75 + 1000 * 15) / 1e6, 6)  # a given read price is used as given
    assert providers.cost("my-model", 100000, 1000, {"my-model": [3, 15]}, False, 90000, 0) is None  # never guessed
