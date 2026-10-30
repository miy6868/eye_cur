import asyncio
import json
import os
import unittest
import threading
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.jev import build_request, choose
from backend import server


MESSAGE = {"type": "choose", "requestId": 3, "gaze": [10, 20], "history": [],
           "candidates": [{"id": "e1", "name": "버튼", "role": "button", "rect": [0, 0, 40, 40], "distance": 0}]}


class JevTests(unittest.IsolatedAsyncioTestCase):
    def test_request_has_abstention_and_no_camera_data(self):
        body = build_request(MESSAGE)
        self.assertEqual(body["model"], "jev-latest")
        self.assertIn("none", body["questions"]["target"]["criteria"])
        self.assertNotIn("image", json.dumps(body))
        with self.assertRaises(ValueError):
            build_request({"candidates": []})

    async def test_choice_and_unknown_choice(self):
        for target in ["e1", "none", "e99"]:
            def respond(request):
                self.assertEqual(request.headers["authorization"], "Bearer test-key")
                return httpx.Response(200, json={"answers": {"target": {"choice": target}}})
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                with patch.dict(os.environ, {"TYPESAFE_API_KEY": "test-key"}):
                    if target == "e99":
                        with self.assertRaises(ValueError): await choose(client, MESSAGE)
                    else: self.assertEqual(await choose(client, MESSAGE), target)

    async def test_missing_key_and_http_error(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(401))) as client:
            with patch.dict(os.environ, {"TYPESAFE_API_KEY": ""}):
                with self.assertRaises(RuntimeError): await choose(client, MESSAGE)
            with patch.dict(os.environ, {"TYPESAFE_API_KEY": "invalid"}):
                with self.assertRaises(httpx.HTTPStatusError): await choose(client, MESSAGE)


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def test_health_and_demo(self):
        self.assertEqual(self.client.get('/health').json()['device'], 'cpu')
        self.assertIn('클릭 0회', self.client.get('/demo').text)

    def test_health_tells_extension_whether_to_shrink_window(self):
        self.assertTrue(self.client.get('/health').json()['shrinkWindow'])
        with patch.dict(os.environ, {'SHRINK_WINDOW': '0'}):
            self.assertFalse(self.client.get('/health').json()['shrinkWindow'])

    def test_bad_origin_and_token(self):
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect('/ws', headers={'origin': 'https://example.com'}): pass
        with self.client.websocket_connect('/ws', headers={'origin': 'chrome-extension://test'}) as ws:
            ws.send_json({'token': 'bad'})
            with self.assertRaises(WebSocketDisconnect): ws.receive_json()

    def test_frames_and_camera_cleanup(self):
        closed = []
        class FakeTracker:
            def read(self): return {'type': 'frame', 'valid': False, 'time': 10}
            def close(self): closed.append(True)
        with patch.dict('sys.modules', {'backend.tracker': SimpleNamespace(Tracker=FakeTracker)}):
            with self.client.websocket_connect('/ws', headers={'origin': 'chrome-extension://test'}) as ws:
                ws.send_json({'token': server.TOKEN})
                self.assertEqual(ws.receive_json()['type'], 'status')
                self.assertEqual(ws.receive_json()['type'], 'status')
                self.assertEqual(ws.receive_json()['type'], 'frame')
                ws.send_json({'type': 'stop'})
                with self.assertRaises(WebSocketDisconnect):
                    while True: ws.receive_json()
        self.assertTrue(closed)
        self.assertFalse(server.active)

    def test_calibration_log_is_appended(self):
        class FakeTracker:
            def read(self): return {'type': 'frame', 'valid': False, 'time': 10}
            def close(self): pass
        with tempfile.TemporaryDirectory() as folder:
            log_file = Path(folder) / 'logs' / 'pursuit.jsonl'
            with patch.object(server, 'LOG_FILE', log_file), \
                 patch.dict('sys.modules', {'backend.tracker': SimpleNamespace(Tracker=FakeTracker)}):
                with self.client.websocket_connect('/ws', headers={'origin': 'chrome-extension://test'}) as ws:
                    ws.send_json({'token': server.TOKEN})
                    ws.receive_json(); ws.receive_json()
                    ws.send_json({'type': 'calibrationLog', 'lag': 100})
                    ws.send_json({'type': 'stop'})
                    with self.assertRaises(WebSocketDisconnect):
                        while True: ws.receive_json()
            saved = json.loads(log_file.read_text(encoding='utf-8'))
            self.assertEqual(saved['lag'], 100)
            self.assertIn('savedAt', saved)

    def test_cancel_old_tab_decision_keeps_camera_and_accepts_new_request(self):
        started, cancelled = threading.Event(), threading.Event()
        class FakeTracker:
            def read(self): return {'type': 'frame', 'valid': False, 'time': 10}
            def close(self): pass
        async def fake_choose(client, message):
            if message['requestId'] == 3:
                started.set()
                try: await asyncio.sleep(30)
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            return 'e1'
        with patch.dict('sys.modules', {'backend.tracker': SimpleNamespace(Tracker=FakeTracker)}), patch('backend.jev.choose', fake_choose):
            with self.client.websocket_connect('/ws', headers={'origin': 'chrome-extension://test'}) as ws:
                ws.send_json({'token': server.TOKEN})
                ws.receive_json(); ws.receive_json()
                ws.send_json(MESSAGE)
                self.assertTrue(started.wait(2))
                ws.send_json({'type': 'cancel'})
                ws.send_json({**MESSAGE, 'requestId': 4})
                selection = None
                for _ in range(100):
                    message = ws.receive_json()
                    if message['type'] == 'selection':
                        selection = message
                        break
                self.assertTrue(cancelled.is_set())
                self.assertEqual(selection['requestId'], 4)
                self.assertEqual(selection['id'], 'e1')
                ws.send_json({'type': 'stop'})
                with self.assertRaises(WebSocketDisconnect):
                    while True: ws.receive_json()
        self.assertFalse(server.active)


if __name__ == '__main__':
    unittest.main()
