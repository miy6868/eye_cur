import asyncio
import contextlib
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", encoding="utf-8-sig")
runtime_path = ROOT / "runtime.json"
# 보정 분석용 기록. 한 줄에 보정 한 번 (시선 값·점 위치·검증 결과, 카메라 이미지는 없음)
LOG_FILE = ROOT / "logs" / "pursuit.jsonl"
if runtime_path.exists():
    TOKEN = json.loads(runtime_path.read_text())["token"]
else:
    TOKEN = secrets.token_urlsafe(24)
    runtime_path.write_text(json.dumps({"token": TOKEN}), encoding="utf-8")

app = FastAPI()
active = False


@app.get("/health")
async def health():
    return {"ok": True, "model": "GazeTR-Hybrid", "device": "cpu", "active": active,
            "weights": (ROOT / "models/GazeTR-H-ETH.pt").exists()}


@app.get("/demo")
async def demo():
    return FileResponse(ROOT / "demo.html")


@app.websocket("/ws")
async def socket(ws: WebSocket):
    global active
    origin = ws.headers.get("origin", "")
    if not origin.startswith("chrome-extension://"):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        auth = await asyncio.wait_for(ws.receive_json(), timeout=5)
        if not secrets.compare_digest(str(auth.get("token", "")), TOKEN):
            await ws.close(code=1008, reason="Invalid pairing token")
            return
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close()
        return
    if active:
        await ws.send_json({"type": "error", "recoverable": True,
                            "error": "이전 카메라 연결을 정리 중이거나 다른 세션이 사용 중입니다."})
        await ws.close()
        return
    active = True
    tracker = None
    frame_task = None
    decision_task = None
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="camera")
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()

    async def send(payload):
        async with send_lock:
            await ws.send_json(payload)

    async def frames():
        try:
            while True:
                payload = await loop.run_in_executor(executor, tracker.read)
                await send(payload)
                await asyncio.sleep(0.02)
        except asyncio.CancelledError:
            raise
        except Exception:
            with contextlib.suppress(Exception):
                await send({"type": "error", "error": "카메라 처리 오류: 서버를 다시 시작하세요."})
                await ws.close()

    async def decide(client, message):
        from backend.jev import choose
        try:
            target = await choose(client, message)
            await send({"type": "selection", "requestId": message["requestId"], "id": target})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Do not expose request headers, camera images or API keys in errors.
            error = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__
            await send({"type": "selection", "requestId": message.get("requestId"),
                        "id": "none", "error": error[:200]})

    try:
        await send({"type": "status", "message": "CPU 모델과 카메라 준비 중…"})
        from backend.tracker import Tracker
        tracker = await loop.run_in_executor(executor, Tracker)
        await send({"type": "status", "message": "카메라 연결됨 · 보정을 시작합니다."})
        frame_task = asyncio.create_task(frames())
        async with httpx.AsyncClient() as client:
            while True:
                message = await ws.receive_json()
                if message.get("type") == "choose":
                    if decision_task and not decision_task.done():
                        continue
                    decision_task = asyncio.create_task(decide(client, message))
                elif message.get("type") == "calibrationLog":
                    LOG_FILE.parent.mkdir(exist_ok=True)
                    message["savedAt"] = time.time()
                    with open(LOG_FILE, "a", encoding="utf-8") as file:
                        file.write(json.dumps(message, ensure_ascii=False) + "\n")
                    # 서버 터미널에서 저장됐는지 바로 확인할 수 있게 한 줄 남긴다
                    print(f"보정 기록 저장: {LOG_FILE} · 검증 점 오차 {message.get('checkPixels')}px", flush=True)
                elif message.get("type") == "stop":
                    break
                elif message.get("type") == "cancel" and decision_task:
                    decision_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await decision_task
                    decision_task = None
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        with contextlib.suppress(Exception):
            await send({"type": "error", "error": str(exc)[:240]})
    finally:
        for task in (frame_task, decision_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        if tracker:
            await loop.run_in_executor(executor, tracker.close)
        executor.shutdown(wait=False)
        active = False
        with contextlib.suppress(Exception):
            await ws.close()


if __name__ == "__main__":
    from backend.camera import choose_camera
    choose_camera()
    print(f"\n확장 프로그램 연결 토큰: {TOKEN}")
    print("테스트 페이지: http://127.0.0.1:8765/demo\n")
    # 메시지 크기 상한: 보정 기록(표본 수백 개, 약 40~100KB)이 들어가도록 1MB. 너무 큰 메시지는 여전히 거부한다
    uvicorn.run(app, host="127.0.0.1", port=8765, ws_max_size=1024 * 1024)
