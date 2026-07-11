"""Pluggable file storage: local disk or S3-compatible (Cloudflare R2, etc.).

With the s3 backend, big files upload straight from the browser to the bucket
via a presigned PUT URL — the app server never buffers them, so it can't be
overwhelmed by large uploads. The local backend mirrors the same flow through a
token-signed PUT endpoint so the frontend code is identical either way.

Serving is same-origin by default: public_url() returns a relative /assets/…
URL and the app streams the object (see routers/files.py), so the bucket stays
private and its route never reaches the browser. Setting ENCUESTUM_S3_PUBLIC_URL
opts back into serving straight from a public bucket/CDN.
"""

from dataclasses import dataclass, field
from functools import lru_cache
import mimetypes
import os
import re
from typing import Iterator

from app.config import get_settings


@dataclass
class UploadTarget:
    key: str
    method: str          # always "PUT"
    url: str             # where the browser PUTs the raw bytes
    headers: dict        # headers the browser must send (Content-Type)
    public_url: str      # where the file is served from afterwards


@dataclass
class StoredFile:
    """An object opened for serving, with single-range support (video seek)."""

    stream: Iterator[bytes]
    status: int                    # 200 full / 206 partial
    content_type: str
    headers: dict = field(default_factory=dict)  # Content-Length/Content-Range


class FileNotFound(Exception):
    pass


class RangeNotSatisfiable(Exception):
    def __init__(self, size: int) -> None:
        self.size = size


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Single-range parser: bytes=a-b / bytes=a- / bytes=-suffix → (start, end)
    inclusive, or None to serve the whole object. Raises RangeNotSatisfiable."""
    if not header:
        return None
    m = _RANGE_RE.match(header.strip())
    if not m:
        return None  # multi-range or malformed → serve full (per RFC, MAY ignore)
    start_s, end_s = m.groups()
    if start_s == "" and end_s == "":
        return None
    if start_s == "":  # suffix: last N bytes
        n = int(end_s)
        if n == 0 or size == 0:
            raise RangeNotSatisfiable(size)
        start = max(0, size - n)
        return (start, size - 1)
    start = int(start_s)
    if start >= size:
        raise RangeNotSatisfiable(size)
    end = min(int(end_s), size - 1) if end_s else size - 1
    if end < start:
        raise RangeNotSatisfiable(size)
    return (start, end)


def _guess_type(key: str) -> str:
    return mimetypes.guess_type(key)[0] or "application/octet-stream"


_CHUNK = 256 * 1024


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
        # URL RELATIVA a propósito: el navegador la resuelve contra la base de la
        # API (misma-origen en la imagen all-in-one; el backend en dev). Antes se
        # anteponía public_base_url, que en dev apunta al FRONTEND y hacía fallar
        # el PUT (el endpoint de subida vive en el backend).
        return UploadTarget(
            key=key, method="PUT",
            url=f"/api/v1/uploads/local?token={token}",
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

    def open(self, key: str, range_header: str | None = None) -> StoredFile:
        path = os.path.join(self.root, *key.split("/"))
        if not os.path.isfile(path):
            raise FileNotFound(key)
        size = os.path.getsize(path)
        rng = parse_range(range_header, size)
        start, end = rng if rng else (0, size - 1)
        length = end - start + 1 if size else 0

        def _iter() -> Iterator[bytes]:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {"Content-Length": str(length)}
        if rng:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return StoredFile(
            stream=_iter(), status=206 if rng else 200,
            content_type=_guess_type(key), headers=headers,
        )


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
        # Default: relative /assets/… — the app proxies the object (routers/
        # files.py), the bucket stays PRIVATE and its route never reaches the
        # browser. ENCUESTUM_S3_PUBLIC_URL opts into a public bucket/CDN instead
        # (exposes the bucket domain and skips the responses/* access gate).
        if self.public_base:
            return f"{self.public_base}/{self._full(key)}"
        return f"/assets/{key}"

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

    def open(self, key: str, range_header: str | None = None) -> StoredFile:
        from botocore.exceptions import ClientError

        params = {"Bucket": self.bucket, "Key": self._full(key)}
        # Normalizamos el Range acá (mismo parser que local) en vez de pasarlo
        # crudo: S3/R2 ignora rangos malformados y algunos proveedores difieren
        # en los sufijos, así siempre mandamos un bytes=a-b canónico.
        rng = None
        if range_header:
            head = self._head(params, key)
            rng = parse_range(range_header, head)
            if rng:
                params["Range"] = f"bytes={rng[0]}-{rng[1]}"
        try:
            obj = self._client.get_object(**params)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "404"):
                raise FileNotFound(key) from exc
            raise
        body = obj["Body"]
        headers = {"Content-Length": str(obj["ContentLength"])}
        if rng:
            headers["Content-Range"] = obj.get(
                "ContentRange", f"bytes {rng[0]}-{rng[1]}/{head}"
            )
        return StoredFile(
            stream=body.iter_chunks(_CHUNK), status=206 if rng else 200,
            content_type=obj.get("ContentType") or _guess_type(key), headers=headers,
        )

    def _head(self, params: dict, key: str) -> int:
        from botocore.exceptions import ClientError

        try:
            return self._client.head_object(
                Bucket=params["Bucket"], Key=params["Key"]
            )["ContentLength"]
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "404"):
                raise FileNotFound(key) from exc
            raise


@lru_cache(maxsize=1)
def get_storage():
    return S3Storage() if get_settings().use_s3 else LocalStorage()
