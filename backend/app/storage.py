"""Pluggable file storage: local disk or S3-compatible (Cloudflare R2, etc.).

With the s3 backend, big files upload straight from the browser to the bucket
via a presigned PUT URL — the app server never buffers them, so it can't be
overwhelmed by large uploads. The local backend mirrors the same flow through a
token-signed PUT endpoint so the frontend code is identical either way.
"""

from dataclasses import dataclass
from functools import lru_cache
import os

from app.config import get_settings


@dataclass
class UploadTarget:
    key: str
    method: str          # always "PUT"
    url: str             # where the browser PUTs the raw bytes
    headers: dict        # headers the browser must send (Content-Type)
    public_url: str      # where the file is served from afterwards


class LocalStorage:
    """Files under asset_dir, served by the /assets static mount."""

    def __init__(self) -> None:
        self.root = get_settings().asset_dir

    def public_url(self, key: str) -> str:
        return f"/assets/{key}"

    def save_bytes(self, key: str, data: bytes, content_type: str) -> str:
        path = os.path.join(self.root, *key.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return self.public_url(key)

    def presign_upload(self, key: str, content_type: str) -> UploadTarget:
        from app.security import create_purpose_token

        s = get_settings()
        token = create_purpose_token(
            "upload", {"key": key, "ct": content_type}, max(1, s.upload_url_ttl // 3600) or 1
        )
        base = s.public_base_url
        return UploadTarget(
            key=key, method="PUT",
            url=f"{base}/api/v1/uploads/local?token={token}",
            headers={"Content-Type": content_type},
            public_url=self.public_url(key),
        )

    def delete(self, key: str) -> None:
        path = os.path.join(self.root, *key.split("/"))
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


class S3Storage:
    """S3-compatible object storage (Cloudflare R2 / AWS S3 / MinIO / …)."""

    def __init__(self) -> None:
        s = get_settings()
        if not (s.s3_endpoint and s.s3_bucket and s.s3_access_key and s.s3_secret_key):
            raise RuntimeError(
                "ENCUESTUM_STORAGE=s3 requiere S3_ENDPOINT, S3_BUCKET, "
                "S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY."
            )
        import boto3
        from botocore.config import Config

        self.bucket = s.s3_bucket
        self.prefix = s.s3_prefix
        self.public_base = (s.s3_public_url or "").rstrip("/")
        self.ttl = s.upload_url_ttl
        self._client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
            region_name=s.s3_region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def _full(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def public_url(self, key: str) -> str:
        full = self._full(key)
        if self.public_base:
            return f"{self.public_base}/{full}"
        # Fallback (bucket must be public); prefer setting ENCUESTUM_S3_PUBLIC_URL.
        return full

    def save_bytes(self, key: str, data: bytes, content_type: str) -> str:
        self._client.put_object(
            Bucket=self.bucket, Key=self._full(key), Body=data, ContentType=content_type
        )
        return self.public_url(key)

    def presign_upload(self, key: str, content_type: str) -> UploadTarget:
        url = self._client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": self._full(key), "ContentType": content_type},
            ExpiresIn=self.ttl,
        )
        return UploadTarget(
            key=key, method="PUT", url=url,
            headers={"Content-Type": content_type},
            public_url=self.public_url(key),
        )

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(Bucket=self.bucket, Key=self._full(key))
        except Exception:  # noqa: BLE001
            pass


@lru_cache(maxsize=1)
def get_storage():
    return S3Storage() if get_settings().use_s3 else LocalStorage()
