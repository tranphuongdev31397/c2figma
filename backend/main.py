from functools import lru_cache

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from store import FALLBACK_KINDS, get_rules, make_redis_client, report_fallback

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@lru_cache
def get_redis_client():
    return make_redis_client()


class ReportFallbackRequest(BaseModel):
    signature: str = Field(max_length=256)
    fallbackKind: str

    @field_validator("fallbackKind")
    @classmethod
    def known_fallback_kind(cls, value: str) -> str:
        if value not in FALLBACK_KINDS:
            raise ValueError(f"unknown fallbackKind: {value}")
        return value


@app.get("/rules")
def read_rules(signatures: str = "", client=Depends(get_redis_client)):
    signature_list = [item for item in signatures.split(",") if item]
    return {"rules": get_rules(client, signature_list)}


@app.post("/rules")
def create_or_update_rule(payload: ReportFallbackRequest, client=Depends(get_redis_client)):
    return report_fallback(client, payload.signature, payload.fallbackKind)
