#!/usr/bin/env python3
"""
Lender Guide Vectorizer
-----------------------
Takes a directory of lender PDFs, extracts text + images per page, auto-identifies
the lender via Claude vision, vectorizes into Pinecone under lender-guides namespace.

Usage:
    python scripts/vectorize_lender_guides.py --dir /path/to/pdfs --output /path/to/image/output

Environment vars required:
    ANTHROPIC_API_KEY   - Claude API key
    PINECONE_API_KEY    - Pinecone API key
    PINECONE_INDEX_HOST - e.g. anchor-brain-7c50nhv.svc.aped-4627-b74a.pinecone.io

Design:
- Each page becomes one chunk (natural unit — a page = a coherent topic in these guides)
- Images rendered as full-page PNGs at 150dpi (captures both screenshots AND text)
- Claude vision describes each page's screenshot content
- Chunk text = page text + "[SCREENSHOTS ON THIS PAGE: ...]"
- Metadata includes lender, doc_title, page, source_file, image_path for UI retrieval
- Pinecone serverless with multilingual-e5-large embeddings (1024 dims) — matches Brain2
"""

import os
import sys
import io
import json
import base64
import hashlib
import argparse
import urllib.request
import urllib.error
from pathlib import Path

# Force UTF-8 stdout on Windows cp1252 consoles
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

try:
    import pymupdf  # PyMuPDF v1.24+
except ImportError:
    print("ERROR: PyMuPDF not installed. Run: pip install pymupdf")
    sys.exit(1)


# ─── Config ─────────────────────────────────────────────────────────

ANTHROPIC_MODEL = "claude-sonnet-4-20250514"
PINECONE_NAMESPACE = "lender-guides"
PAGE_RENDER_DPI = 150  # high enough to be readable, low enough to stay under API limits
CHUNK_CHAR_LIMIT = 4000  # safety cap per chunk — most pages are well under this
KNOWN_LENDERS = ["Freedom", "Kind", "Mega", "Plaza", "Rocket"]


# ─── HTTP helpers (no external deps besides pymupdf + stdlib) ──────

def http_post_json(url, body, headers):
    """POST a JSON body, return parsed JSON. Retries 3x with exponential backoff."""
    data = json.dumps(body).encode("utf-8")
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")
            last_err = f"HTTP {e.code}: {body_text[:300]}"
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                wait = min(2 ** attempt, 8)
                print(f"  [retry] {last_err} — waiting {wait}s")
                import time; time.sleep(wait)
                continue
            raise RuntimeError(last_err)
        except Exception as e:
            last_err = str(e)
            if attempt < 3:
                import time; time.sleep(2 ** attempt)
                continue
            raise
    raise RuntimeError(last_err or "unknown error")


# ─── Claude vision: identify lender + describe page ────────────────

def claude_identify_lender(api_key, first_page_png_b64, filename):
    """Ask Claude to identify which lender this PDF is from based on page 1."""
    prompt = f"""Look at this PDF page and identify which mortgage lender it's from.

Known lenders in this set: {', '.join(KNOWN_LENDERS)}

Look for: lender logo, company name in header/footer, URL, mortgagee clause references, specific product names (e.g. BREEZE = Plaza), specific form styles.

Respond with ONLY a JSON object, no markdown:
{{"lender": "one of the known lenders or 'Unknown'", "confidence": 0.0-1.0, "reasoning": "1 sentence"}}"""

    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 300,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": first_page_png_b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    resp = http_post_json("https://api.anthropic.com/v1/messages", body, headers)
    text = "".join(c["text"] for c in resp.get("content", []) if c.get("type") == "text")
    try:
        # strip markdown fences if present
        text = text.replace("```json", "").replace("```", "").strip()
        return json.loads(text)
    except Exception:
        return {"lender": "Unknown", "confidence": 0.0, "reasoning": f"parse error: {text[:100]}"}


def claude_describe_page(api_key, page_png_b64, lender, doc_title, page_num):
    """Get a dense description of what's visually on this page — screenshots, highlighted fields, UI elements."""
    prompt = f"""This is page {page_num} from a {lender} lender guide titled "{doc_title}".

Describe what's visible on this page in 2-4 sentences. Focus on:
- Any screenshots shown and which UI fields/buttons are highlighted or annotated
- Specific values called out (fees, field names, amounts, dropdown options)
- What a loan officer looking at this page would learn about completing a task

Write in compact prose. No preamble. No markdown. Just description."""

    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 600,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": page_png_b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    try:
        resp = http_post_json("https://api.anthropic.com/v1/messages", body, headers)
        return "".join(c["text"] for c in resp.get("content", []) if c.get("type") == "text").strip()
    except Exception as e:
        print(f"    [warn] vision description failed: {e}")
        return ""


def claude_extract_doc_title(api_key, first_page_text, lender):
    """Pull the actual document title from page 1 text."""
    if not first_page_text.strip():
        return f"{lender} guide"
    prompt = f"""This is the first page text of a {lender} lender guide for mortgage loan officers.

Extract the document title / topic in 3-8 words. Examples: "BREEZE Upload Conditions", "Non-Del Correspondent Quick Reference", "Disclosure Fee Guide", "LE & AUS Submission".

Respond with ONLY the title, no quotes, no preamble.

PAGE TEXT:
{first_page_text[:2000]}"""

    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 50,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    try:
        resp = http_post_json("https://api.anthropic.com/v1/messages", body, headers)
        text = "".join(c["text"] for c in resp.get("content", []) if c.get("type") == "text").strip()
        # Sanitize — max 100 chars, strip quotes
        return text.replace('"', '').replace("'", '')[:100] or f"{lender} guide"
    except Exception:
        return f"{lender} guide"


# ─── Pinecone embed + upsert ────────────────────────────────────────
# The anchor-brain index was created without integrated inference, so we
# embed explicitly via Pinecone's Inference API then upsert raw vectors.

def pinecone_embed(api_key, texts, model="multilingual-e5-large", input_type="passage"):
    """Embed texts via Pinecone Inference API. Returns list of 1024-dim vectors."""
    if not texts:
        return []
    url = "https://api.pinecone.io/embed"
    body = {
        "model": model,
        "parameters": {"input_type": input_type, "truncate": "END"},
        "inputs": [{"text": t} for t in texts],
    }
    headers = {
        "Api-Key": api_key,
        "Content-Type": "application/json",
        "X-Pinecone-API-Version": "2025-01",
    }
    resp = http_post_json(url, body, headers)
    return [e["values"] for e in resp.get("data", [])]


def pinecone_upsert(api_key, index_host, namespace, records):
    """Upsert records to Pinecone: embed chunk_text, then vector upsert with metadata."""
    if not records:
        return
    texts = [r["chunk_text"] for r in records]
    print(f"    embedding {len(texts)} chunks...")
    vectors = pinecone_embed(api_key, texts)
    if len(vectors) != len(records):
        raise RuntimeError(f"embed returned {len(vectors)} vectors for {len(records)} records")

    payload = {
        "vectors": [
            {
                "id": r["_id"],
                "values": v,
                "metadata": {
                    "chunk_text": r["chunk_text"],
                    "lender": r["lender"],
                    "doc_title": r["doc_title"],
                    "page": r["page"],
                    "source_file": r["source_file"],
                    "image_filename": r["image_filename"],
                    "total_pages": r["total_pages"],
                },
            }
            for r, v in zip(records, vectors)
        ],
        "namespace": namespace,
    }

    url = f"https://{index_host}/vectors/upsert"
    headers = {
        "Api-Key": api_key,
        "Content-Type": "application/json",
        "X-Pinecone-API-Version": "2025-01",
    }
    resp = http_post_json(url, payload, headers)
    return resp


# ─── Core pipeline ──────────────────────────────────────────────────

def process_pdf(pdf_path, image_output_dir, anthropic_key, pinecone_key, pinecone_host, lender_override=None):
    """Process one PDF. Returns list of records and metadata summary."""
    print(f"\n─── {pdf_path.name} ───")
    doc = pymupdf.open(pdf_path)
    num_pages = len(doc)
    print(f"  {num_pages} page(s)")

    # Render page 1 for lender identification (unless overridden)
    page_0 = doc[0]
    pix_0 = page_0.get_pixmap(dpi=PAGE_RENDER_DPI)
    page_0_png = pix_0.tobytes("png")
    page_0_b64 = base64.b64encode(page_0_png).decode("ascii")

    # Identify lender (or use override)
    if lender_override:
        lender = lender_override
        confidence = 1.0
        reason = "manual override"
    else:
        lender_result = claude_identify_lender(anthropic_key, page_0_b64, pdf_path.name)
        lender = lender_result.get("lender", "Unknown")
        confidence = lender_result.get("confidence", 0.0)
        reason = lender_result.get("reasoning", "")
    print(f"  Lender: {lender} (confidence {confidence}) — {reason}")

    # Extract first-page text for doc title
    first_page_text = page_0.get_text("text")
    doc_title = claude_extract_doc_title(anthropic_key, first_page_text, lender)
    print(f"  Title: {doc_title}")

    # Stable ID prefix based on file hash
    file_hash = hashlib.md5(pdf_path.name.encode()).hexdigest()[:8]
    slug = f"{lender.lower()}-{file_hash}"

    records = []
    image_paths = []

    for i, page in enumerate(doc):
        page_num = i + 1
        page_text = page.get_text("text").strip()

        # Render page to PNG
        pix = page.get_pixmap(dpi=PAGE_RENDER_DPI)
        page_png = pix.tobytes("png")
        image_filename = f"{slug}-p{page_num:03d}.png"
        image_path = image_output_dir / image_filename
        image_path.write_bytes(page_png)
        image_paths.append(image_filename)

        # Describe the page with vision (captures screenshot content)
        page_b64 = base64.b64encode(page_png).decode("ascii")
        visual_description = claude_describe_page(anthropic_key, page_b64, lender, doc_title, page_num)

        # Build chunk text: page text + visual description
        chunk_text = f"[{lender} — {doc_title} — Page {page_num}]\n\n"
        if page_text:
            chunk_text += f"TEXT:\n{page_text}\n\n"
        if visual_description:
            chunk_text += f"SCREENSHOTS/VISUALS:\n{visual_description}"

        # Truncate if needed
        if len(chunk_text) > CHUNK_CHAR_LIMIT:
            chunk_text = chunk_text[:CHUNK_CHAR_LIMIT] + "...[truncated]"

        record = {
            "_id": f"{slug}-p{page_num:03d}",
            "chunk_text": chunk_text,
            "lender": lender,
            "doc_title": doc_title,
            "page": page_num,
            "source_file": pdf_path.name,
            "image_filename": image_filename,
            "total_pages": num_pages,
        }
        records.append(record)
        print(f"  p{page_num}: {len(page_text)} chars + vision desc → chunk {len(chunk_text)} chars, image saved")

    doc.close()

    # Upsert to Pinecone in batches
    print(f"  Upserting {len(records)} records to Pinecone namespace '{PINECONE_NAMESPACE}'...")
    batch_size = 96
    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        pinecone_upsert(pinecone_key, pinecone_host, PINECONE_NAMESPACE, batch)
    print(f"  ✓ Done: {pdf_path.name}")

    return {
        "file": pdf_path.name,
        "lender": lender,
        "title": doc_title,
        "pages": num_pages,
        "images": image_paths,
    }


def main():
    parser = argparse.ArgumentParser(description="Vectorize lender guide PDFs into Pinecone")
    parser.add_argument("--dir", required=True, help="Directory containing PDFs to process")
    parser.add_argument("--output", required=True, help="Directory to save page images")
    parser.add_argument("--lender-map", help="Optional JSON file: {filename: 'Lender'} overrides")
    parser.add_argument("--limit", type=int, help="Only process N files (for testing)")
    args = parser.parse_args()

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    pinecone_key = os.environ.get("PINECONE_API_KEY")
    pinecone_host = os.environ.get("PINECONE_INDEX_HOST")
    if not anthropic_key:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)
    if not pinecone_key:
        print("ERROR: PINECONE_API_KEY not set")
        sys.exit(1)
    if not pinecone_host:
        print("ERROR: PINECONE_INDEX_HOST not set (e.g. anchor-brain-7c50nhv.svc.aped-4627-b74a.pinecone.io)")
        sys.exit(1)

    pdf_dir = Path(args.dir)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    lender_map = {}
    if args.lender_map:
        with open(args.lender_map) as f:
            lender_map = json.load(f)

    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if args.limit:
        pdfs = pdfs[:args.limit]

    print(f"Processing {len(pdfs)} PDFs from {pdf_dir}")
    print(f"Image output: {output_dir}")
    print(f"Pinecone host: {pinecone_host}, namespace: {PINECONE_NAMESPACE}")

    summary = []
    for pdf in pdfs:
        override = lender_map.get(pdf.name)
        try:
            result = process_pdf(pdf, output_dir, anthropic_key, pinecone_key, pinecone_host, lender_override=override)
            summary.append(result)
        except Exception as e:
            print(f"  ✗ FAILED: {pdf.name} — {e}")
            summary.append({"file": pdf.name, "error": str(e)})

    # Write summary manifest
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(summary, indent=2))
    print(f"\n{'=' * 60}")
    print(f"DONE. Summary:")
    for s in summary:
        if "error" in s:
            print(f"  ✗ {s['file']}: {s['error']}")
        else:
            print(f"  ✓ {s['file']} → {s['lender']}: {s['title']} ({s['pages']} pages)")
    print(f"\nManifest: {manifest_path}")


if __name__ == "__main__":
    main()
