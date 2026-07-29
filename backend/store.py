import json
import os
import time
from typing import Iterable

import redis

FALLBACK_KINDS = {"svg-render-failed", "fill-dropped", "node-render-failed"}


def _key(signature: str) -> str:
    return f"rule:{signature}"


def make_redis_client(url: str | None = None) -> "redis.Redis":
    return redis.from_url(url or os.environ["REDIS_URL"], decode_responses=True)


def get_rules(client: "redis.Redis", signatures: Iterable[str]) -> dict:
    signature_list = list(signatures)
    if not signature_list:
        return {}
    values = client.mget([_key(signature) for signature in signature_list])
    return {
        signature: (json.loads(value) if value else None)
        for signature, value in zip(signature_list, values)
    }


def report_fallback(client: "redis.Redis", signature: str, fallback_kind: str) -> dict:
    if fallback_kind not in FALLBACK_KINDS:
        raise ValueError(f"unknown fallbackKind: {fallback_kind}")
    now = time.time()
    existing_raw = client.get(_key(signature))
    if existing_raw:
        record = json.loads(existing_raw)
        record["hitCount"] += 1
        record["lastSeen"] = now
    else:
        record = {
            "signature": signature,
            "fallbackKind": fallback_kind,
            "hitCount": 1,
            "firstSeen": now,
            "lastSeen": now,
        }
    client.set(_key(signature), json.dumps(record))
    return record
