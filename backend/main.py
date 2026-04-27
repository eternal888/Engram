from fastapi import FastAPI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Engram", version="0.1.0")

@app.get("/health")
def health():
    return {"status": "ok", "project": "Engram"}