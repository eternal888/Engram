"""
Document ingestion endpoints. All require a valid JWT.

- POST /api/documents/upload  — PDF file upload
- POST /api/documents/url     — ingest a URL's article text
- GET  /api/documents         — list this user's documents
- DELETE /api/documents/{id}  — delete a document and all its chunks
"""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, HttpUrl, Field
from backend.core.auth import get_current_user
from backend.ingestion.fetchers import extract_pdf_text, fetch_url_text
from backend.ingestion.pipeline import (
    ingest_text,
    list_user_documents,
    delete_document,
)

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB cap


class UrlIngestRequest(BaseModel):
    url: HttpUrl
    document_name: str = Field(default="", max_length=200)


@router.post("/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user),
):
    # Validate extension
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    # Read + size check
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB)")

    # Extract text
    extract = extract_pdf_text(contents)
    if extract["error"]:
        raise HTTPException(status_code=400, detail=f"PDF error: {extract['error']}")
    if not extract["text"].strip():
        raise HTTPException(status_code=400, detail="No text found in PDF")

    # Ingest
    result = ingest_text(
        user_id=user_id,
        text=extract["text"],
        document_name=file.filename,
        document_source="upload",
    )
    if result["error"]:
        raise HTTPException(status_code=500, detail=result["error"])

    return {
        "document_id": result["document_id"],
        "document_name": result["document_name"],
        "chunks_written": result["chunks_written"],
        "pii_scrubbed": result["pii_scrubbed"],
        "page_count": extract["page_count"],
    }


@router.post("/url")
def ingest_url(
    request: UrlIngestRequest,
    user_id: str = Depends(get_current_user),
):
    fetched = fetch_url_text(str(request.url))
    if fetched["error"]:
        raise HTTPException(status_code=400, detail=f"Fetch error: {fetched['error']}")
    if not fetched["text"].strip():
        raise HTTPException(status_code=400, detail="No article text found")

    doc_name = request.document_name.strip() or fetched["title"] or str(request.url)

    result = ingest_text(
        user_id=user_id,
        text=fetched["text"],
        document_name=doc_name,
        document_source="url",
        source_url=str(request.url),
    )
    if result["error"]:
        raise HTTPException(status_code=500, detail=result["error"])

    return {
        "document_id": result["document_id"],
        "document_name": result["document_name"],
        "chunks_written": result["chunks_written"],
        "pii_scrubbed": result["pii_scrubbed"],
        "source_url": str(request.url),
    }


@router.get("")
def list_documents(user_id: str = Depends(get_current_user)):
    return {"documents": list_user_documents(user_id)}


@router.delete("/{document_id}")
def delete_doc(document_id: str, user_id: str = Depends(get_current_user)):
    deleted = delete_document(user_id, document_id)
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"deleted_chunks": deleted}