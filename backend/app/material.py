"""Material base para generar preguntas: extraer texto y elegir lo relevante.

Antes sólo se aceptaba .md/.txt leído en el navegador, y el texto entero iba al
prompt sin tope: un apunte de 200 páginas reventaba el contexto (o la factura).
Ahora:

* `extract_text` saca texto de PDF (pypdf), DOCX (el XML del propio .docx, sin
  dependencias), HTML y texto plano.
* `fetch_url` baja una página con el guard SSRF de siempre y le saca el texto.
* `select_relevant` parte el material en fragmentos y, si no entra en el
  presupuesto, se queda con los que más tienen que ver con el tema (por
  coincidencia de palabras, sin embeddings), en su orden original.
* `quote_in_material` comprueba que la cita que da el modelo esté de verdad en
  el material: una pregunta que dice "sale de acá" y no sale de ningún lado se
  marca como no verificada.
"""

from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from html.parser import HTMLParser
from typing import Optional

MAX_BYTES = 15 * 1024 * 1024
MAX_TEXT = 400_000  # caracteres extraídos que se conservan (~200 páginas)
BUDGET = 24_000  # caracteres de material que viajan al modelo por pedido
_CHUNK = 1_500


class MaterialError(ValueError):
    pass


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    return "".join(ch for ch in s if not unicodedata.combining(ch))


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_TEXT]


class _HtmlText(HTMLParser):
    _SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form"}
    _BLOCK = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    p = _HtmlText()
    p.feed(html)
    return _clean("".join(p.parts))


def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise MaterialError("Falta el soporte de PDF en el servidor.") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001
                raise MaterialError("El PDF está protegido con contraseña.")
        pages = []
        for page in reader.pages:
            pages.append(page.extract_text() or "")
            if sum(len(p) for p in pages) > MAX_TEXT:
                break
    except MaterialError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise MaterialError(f"No se pudo leer el PDF: {exc}") from exc
    text = _clean("\n\n".join(pages))
    if not text:
        raise MaterialError("El PDF no tiene texto seleccionable (¿es un escaneo?).")
    return text


def _docx_text(data: bytes) -> str:
    """El texto de un .docx sin python-docx: es un zip con `word/document.xml`;
    cada `<w:p>` es un párrafo y el texto vive en los `<w:t>`."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise MaterialError("No es un .docx válido.") from exc
    paras = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S):
        runs = re.findall(r"<w:t(?: [^>]*)?>(.*?)</w:t>", p, flags=re.S)
        if runs:
            paras.append("".join(runs))
    import html as _html

    return _clean("\n\n".join(_html.unescape(x) for x in paras))


def extract_text(filename: str, data: bytes) -> str:
    if len(data) > MAX_BYTES:
        raise MaterialError("El archivo supera los 15 MB.")
    name = (filename or "").lower()
    if name.endswith(".pdf") or data[:5] == b"%PDF-":
        return _pdf_text(data)
    if name.endswith(".docx"):
        return _docx_text(data)
    if name.endswith((".html", ".htm")):
        return html_to_text(data.decode("utf-8", errors="ignore"))
    if name.endswith((".txt", ".md", ".markdown", ".csv")) or not name:
        return _clean(data.decode("utf-8", errors="ignore"))
    if name.endswith(".doc"):
        raise MaterialError("Los .doc viejos no se pueden leer: guardalo como .docx o PDF.")
    raise MaterialError("Formato no soportado: usá PDF, DOCX, TXT, MD o HTML.")


async def fetch_url(url: str) -> str:
    """Baja una página pública y devuelve su texto. Revalida el destino con el
    guard SSRF (no sigue redirecciones a otro host sin revalidarlo)."""
    import httpx

    from app.net_guard import UnsafeUrlError, assert_public_url

    actual = url
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        for _ in range(4):
            try:
                assert_public_url(actual)
            except UnsafeUrlError as exc:
                raise MaterialError(f"Esa dirección no está permitida: {exc}") from exc
            try:
                resp = await client.get(actual, headers={"User-Agent": "Encuestum/1.0 (material)"})
            except httpx.HTTPError as exc:
                raise MaterialError(f"No se pudo abrir la página: {exc}") from exc
            if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                actual = str(resp.url.join(resp.headers["location"]))
                continue
            break
        else:
            raise MaterialError("La página redirige demasiadas veces.")
    if resp.status_code >= 400:
        raise MaterialError(f"La página devolvió {resp.status_code}.")
    data = resp.content[:MAX_BYTES]
    ctype = resp.headers.get("content-type", "").lower()
    if "pdf" in ctype or data[:5] == b"%PDF-":
        return _pdf_text(data)
    if "html" in ctype or b"<html" in data[:2000].lower():
        return html_to_text(data.decode(resp.encoding or "utf-8", errors="ignore"))
    return _clean(data.decode(resp.encoding or "utf-8", errors="ignore"))


def _chunks(text: str) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out, cur = [], ""
    for p in paras:
        if len(p) > _CHUNK * 2:  # párrafo gigante (PDF sin saltos): partir por oraciones
            for s in re.split(r"(?<=[.!?])\s+", p):
                if len(cur) + len(s) > _CHUNK and cur:
                    out.append(cur)
                    cur = ""
                cur = f"{cur} {s}".strip()
            continue
        if len(cur) + len(p) > _CHUNK and cur:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{p}".strip()
    if cur:
        out.append(cur)
    return out


def select_relevant(text: str, topic: str, budget: int = BUDGET) -> tuple[str, bool]:
    """El material que entra en el presupuesto, priorizando lo que tiene que
    ver con el tema. Devuelve (texto, se_recorto)."""
    text = (text or "").strip()
    if len(text) <= budget:
        return text, False
    chunks = _chunks(text)
    palabras = {w for w in re.findall(r"\w{4,}", _fold(topic))}

    def score(c: str) -> float:
        f = _fold(c)
        return sum(f.count(w) for w in palabras) / (1 + len(c) / _CHUNK)

    orden = sorted(range(len(chunks)), key=lambda i: (-score(chunks[i]), i))
    elegidos, total = set(), 0
    for i in orden:
        if total + len(chunks[i]) > budget:
            continue
        elegidos.add(i)
        total += len(chunks[i])
    # Sin palabras del tema en común: muestra repartida en todo el material.
    if not palabras or all(score(chunks[i]) == 0 for i in elegidos):
        paso = max(1, len(chunks) * _CHUNK // budget + 1)
        elegidos, total = set(), 0
        for i in range(0, len(chunks), paso):
            if total + len(chunks[i]) > budget:
                break
            elegidos.add(i)
            total += len(chunks[i])
    return "\n\n[…]\n\n".join(chunks[i] for i in sorted(elegidos)), True


def _norm_quote(s: str) -> str:
    return re.sub(r"[^\w]+", " ", _fold(s)).strip()


def quote_in_material(quote: Optional[str], material: str) -> Optional[bool]:
    """True si la cita está en el material (ignorando tildes, mayúsculas,
    puntuación y espacios). None si no hay cita o no hay material."""
    q = _norm_quote(quote or "")
    if not q or not material:
        return None
    m = _norm_quote(material)
    if q in m:
        return True
    # Tolerancia: una cita larga que el modelo recortó o unió con "...".
    partes = [p for p in re.split(r"\s*(?:\.\.\.|…)\s*", quote or "") if len(p.strip()) > 20]
    return bool(partes) and all(_norm_quote(p) in m for p in partes)
