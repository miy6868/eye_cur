import asyncio
import contextlib
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from backend.config import CONFIG

ROOT = Path(__file__).resolve().parents[1]
runtime_path = ROOT / "runtime.json"
# 보정 분석용 기록. 한 줄에 보정 한 번 (시선 값·점 위치·검증 결과, 카메라 이미지는 없음)
LOG_FILE = ROOT / "logs" / "pursuit.jsonl"
# 사용자가 직접 넣는 키보드 추천 단어. 한 줄에 하나, #부터는 설명
WORDS_FILE = ROOT / "my_words.txt"
if runtime_path.exists():
    TOKEN = json.loads(runtime_path.read_text())["token"]
else:
    TOKEN = secrets.token_urlsafe(24)
    runtime_path.write_text(json.dumps({"token": TOKEN}), encoding="utf-8")

app = FastAPI()
active = False


def my_words():
    # 연결할 때마다 다시 읽는다: 파일을 고친 뒤 팝업에서 중지 → 시작만 하면 된다
    if not WORDS_FILE.exists():
        return []
    try:
        text = WORDS_FILE.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        # 메모장에서 ANSI로 저장하면 못 읽는다. 연결은 끊지 않고 내 단어만 뺀다
        print(f"{WORDS_FILE.name}을 읽지 못했습니다. UTF-8로 저장하세요.", flush=True)
        return []
    lines = (line.split("#")[0].strip() for line in text.splitlines())
    return list(dict.fromkeys(line for line in lines if line))  # 빈 줄·중복 제거, 순서 유지


@app.get("/health")
async def health():
    from backend.tracker import model_path
    return {"ok": True, "model": "UniGaze-B", "device": "cpu", "active": active,
            "weights": model_path().exists()}


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

    try:
        # 확장이 쓰는 조정 값(config.toml). 워커가 기억했다가 새로 붙는 페이지에도 넘긴다
        await send({"type": "settings", **{name: CONFIG.get(name, {}) for name in ("click", "select", "calibration", "scroll", "keyboard", "shortcuts")}, "words": my_words()})
        await send({"type": "status", "message": "CPU 모델과 카메라 준비 중…"})
        from backend.tracker import Tracker
        tracker = await loop.run_in_executor(executor, Tracker)
        await send({"type": "status", "message": "카메라 연결됨 · 보정을 시작합니다."})
        frame_task = asyncio.create_task(frames())
        while True:
            message = await ws.receive_json()
            if message.get("type") == "calibrationLog":
                if not CONFIG.get("save_calibration_log", True):
                    continue  # config.toml save_calibration_log = false
                LOG_FILE.parent.mkdir(exist_ok=True)
                message["savedAt"] = time.time()
                with open(LOG_FILE, "a", encoding="utf-8") as file:
                    file.write(json.dumps(message, ensure_ascii=False) + "\n")
                # 서버 터미널에서 저장됐는지 바로 확인할 수 있게 한 줄 남긴다
                print(f"보정 기록 저장: {LOG_FILE} · 점 오차 {message.get('errorPixels')}px", flush=True)
            elif message.get("type") == "stop":
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        with contextlib.suppress(Exception):
            await send({"type": "error", "error": str(exc)[:240]})
    finally:
        if frame_task:
            frame_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await frame_task
        if tracker:
            await loop.run_in_executor(executor, tracker.close)
        executor.shutdown(wait=False)
        active = False
        with contextlib.suppress(Exception):
            await ws.close()


# 시연 페이지(첫 화면·테스트·게임). /demo는 /demo/로 넘어가 index.html을 연다
app.mount("/demo", StaticFiles(directory=ROOT / "demo", html=True), name="demo")

if __name__ == "__main__":
    from backend.camera import choose_camera
    choose_camera()
    print(f"\n확장 프로그램 연결 토큰: {TOKEN}")
    print("테스트 페이지: http://127.0.0.1:8765/demo\n")
    # 메시지 크기 상한: 보정 기록(표본 수백 개, 약 40~100KB)이 들어가도록 1MB. 너무 큰 메시지는 여전히 거부한다
    uvicorn.run(app, host="127.0.0.1", port=8765, ws_max_size=1024 * 1024)
