import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException

from dependencies import get_user_id

router = APIRouter(prefix="/api", tags=["preview"])

# Hostnames that resolve to internal Docker services — never allow preview fetches to these
_BLOCKED_HOSTNAMES = {
    "conduwuit", "concord-api", "livekit", "web", "cloudflared",
    "localhost", "metadata.google.internal",
}


def _is_private_ip(host: str) -> bool:
    """Return True if host resolves to a private/reserved IP address."""
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local
    except ValueError:
        pass
    # It's a hostname — resolve it and check the resulting IP
    try:
        resolved = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for _, _, _, _, sockaddr in resolved:
            addr = ipaddress.ip_address(sockaddr[0])
            if addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local:
                return True
    except (socket.gaierror, OSError):
        pass
    return False


class OGParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.og: dict[str, str] = {}
        self._in_title = False
        self._title_buf = ""

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "meta":
            prop = attrs_dict.get("property", "")
            name = attrs_dict.get("name", "")
            content = attrs_dict.get("content", "")
            if prop.startswith("og:") and content:
                self.og.setdefault(prop[3:], content)
            elif name in ("description", "twitter:title", "twitter:description", "twitter:image") and content:
                key = name.removeprefix("twitter:")
                self.og.setdefault(key, content)
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self._title_buf += data

    @property
    def title(self) -> str:
        return self.og.get("title") or self._title_buf.strip()


@router.get("/preview")
async def get_link_preview(
    url: str,
    user_id: str = Depends(get_user_id),
):
    """Fetch OG metadata for a URL to render a link preview card."""
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(400, "Only HTTP/HTTPS URLs are supported")
        if not parsed.netloc:
            raise HTTPException(400, "Invalid URL")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Invalid URL")

    # Block requests to private IPs, internal Docker services, and cloud metadata endpoints
    hostname = parsed.hostname or ""
    if hostname.lower() in _BLOCKED_HOSTNAMES or _is_private_ip(hostname):
        raise HTTPException(400, "URLs pointing to private or internal addresses are not allowed")

    try:
        async with httpx.AsyncClient(
            timeout=5.0,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Concord/1.0 LinkPreview)"},
        ) as client:
            resp = await client.get(url)
    except httpx.RequestError:
        raise HTTPException(502, "Failed to fetch URL")

    if resp.status_code >= 400:
        raise HTTPException(502, f"URL returned {resp.status_code}")

    content_type = resp.headers.get("content-type", "")
    if "text/html" not in content_type:
        return {
            "url": url,
            "title": parsed.netloc,
            "description": None,
            "image": None,
        }

    # Parse first 50KB only
    parser = OGParser()
    parser.feed(resp.text[:50_000])

    return {
        "url": url,
        "title": parser.title or parsed.netloc,
        "description": parser.og.get("description"),
        "image": parser.og.get("image"),
    }
