"""
Fetchers pull raw text out of external sources.

Two supported types:
- PDF (bytes in memory) → extracted text via pypdf
- URL → HTML fetched, main article text extracted via BeautifulSoup

Both return plain text ready for chunking. No formatting preserved.
"""

import io
import requests
from pypdf import PdfReader
from bs4 import BeautifulSoup


def extract_pdf_text(pdf_bytes: bytes) -> dict:
    """
    Read a PDF from bytes, extract text.
    Returns {text, page_count, error}.
    """
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages_text = []
        for page in reader.pages:
            page_text = page.extract_text() or ""
            pages_text.append(page_text)
        full_text = "\n\n".join(pages_text)
        return {
            "text": full_text,
            "page_count": len(reader.pages),
            "error": None,
        }
    except Exception as e:
        return {"text": "", "page_count": 0, "error": str(e)}


def fetch_url_text(url: str, timeout: int = 15) -> dict:
    """
    Fetch a URL, strip HTML boilerplate, return main text content.
    Returns {text, title, error}.
    """
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; EngramBot/1.0)"
        }
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()

        soup = BeautifulSoup(r.content, "html.parser")

        # Strip noise
        for tag in soup(["script", "style", "nav", "header", "footer",
                         "iframe", "aside", "form", "button"]):
            tag.decompose()

        title = (soup.title.string.strip() if soup.title and soup.title.string else url)

        # Prefer <article> or <main>; fall back to <body>
        main = soup.find("article") or soup.find("main") or soup.body
        text = main.get_text(separator="\n") if main else soup.get_text(separator="\n")

        # Clean up whitespace
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        text = "\n".join(lines)

        return {"text": text, "title": title, "error": None}
    except Exception as e:
        return {"text": "", "title": "", "error": str(e)}