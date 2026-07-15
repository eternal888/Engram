from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from backend.api.routes import router as memory_router
from backend.api.auth_routes import router as auth_router
from backend.core.scheduler import start_scheduler, stop_scheduler

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="Engram", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")
app.include_router(memory_router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok", "project": "Engram"}