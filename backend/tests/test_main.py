import fakeredis
from fastapi.testclient import TestClient

from main import app, get_redis_client

fake_client = fakeredis.FakeRedis(decode_responses=True)
app.dependency_overrides[get_redis_client] = lambda: fake_client
client = TestClient(app)


def setup_function():
    fake_client.flushall()


def test_get_rules_returns_null_for_unknown_signature():
    response = client.get("/rules", params={"signatures": "sig-a"})
    assert response.status_code == 200
    assert response.json() == {"rules": {"sig-a": None}}


def test_post_new_rule_creates_record_with_hit_count_1():
    response = client.post("/rules", json={"signature": "sig-a", "fallbackKind": "fill-dropped"})
    assert response.status_code == 200
    body = response.json()
    assert body["signature"] == "sig-a"
    assert body["fallbackKind"] == "fill-dropped"
    assert body["hitCount"] == 1


def test_post_existing_rule_increments_hit_count():
    client.post("/rules", json={"signature": "sig-b", "fallbackKind": "svg-render-failed"})
    response = client.post("/rules", json={"signature": "sig-b", "fallbackKind": "svg-render-failed"})
    assert response.json()["hitCount"] == 2


def test_post_rejects_unknown_fallback_kind():
    response = client.post("/rules", json={"signature": "sig-c", "fallbackKind": "not-real"})
    assert response.status_code == 422


def test_get_rules_after_post_returns_the_rule():
    client.post("/rules", json={"signature": "sig-d", "fallbackKind": "node-render-failed"})
    response = client.get("/rules", params={"signatures": "sig-d,sig-unknown"})
    body = response.json()["rules"]
    assert body["sig-d"]["fallbackKind"] == "node-render-failed"
    assert body["sig-unknown"] is None


def test_post_rejects_over_length_signature():
    response = client.post("/rules", json={"signature": "x" * 300, "fallbackKind": "fill-dropped"})
    assert response.status_code == 422
