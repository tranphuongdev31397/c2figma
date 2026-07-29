import fakeredis
import pytest

from store import get_rules, report_fallback


@pytest.fixture
def client():
    return fakeredis.FakeRedis(decode_responses=True)


def test_report_fallback_creates_new_record(client):
    record = report_fallback(client, "sig-a", "fill-dropped")
    assert record["signature"] == "sig-a"
    assert record["fallbackKind"] == "fill-dropped"
    assert record["hitCount"] == 1
    assert record["firstSeen"] == record["lastSeen"]


def test_report_fallback_increments_existing_record(client):
    report_fallback(client, "sig-a", "fill-dropped")
    record = report_fallback(client, "sig-a", "fill-dropped")
    assert record["hitCount"] == 2


def test_report_fallback_rejects_unknown_kind(client):
    with pytest.raises(ValueError):
        report_fallback(client, "sig-a", "not-a-real-kind")


def test_get_rules_empty_for_no_signatures(client):
    assert get_rules(client, []) == {}


def test_get_rules_returns_none_for_unknown_signature(client):
    assert get_rules(client, ["sig-a"]) == {"sig-a": None}


def test_get_rules_returns_stored_record(client):
    report_fallback(client, "sig-a", "svg-render-failed")
    result = get_rules(client, ["sig-a"])
    assert result["sig-a"]["fallbackKind"] == "svg-render-failed"


def test_report_fallback_sets_a_ttl_on_write(client):
    report_fallback(client, "sig-a", "fill-dropped")
    ttl = client.ttl("rule:sig-a")
    assert ttl > 0
