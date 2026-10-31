import json
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import server


class SocketTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def test_health_and_demo(self):
        self.assertEqual(self.client.get('/health').json()['device'], 'cpu')
        self.assertIn('클릭 0회', self.client.get('/demo').text)

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
                settings = ws.receive_json()
                self.assertEqual(settings['type'], 'settings')
                self.assertEqual(settings['click']['mode'], 'mouth')
                self.assertTrue(all(url.startswith('http') for url in settings['shortcuts'].values()))
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
                    ws.receive_json(); ws.receive_json(); ws.receive_json()
                    ws.send_json({'type': 'calibrationLog', 'lag': 100})
                    ws.send_json({'type': 'stop'})
                    with self.assertRaises(WebSocketDisconnect):
                        while True: ws.receive_json()
            saved = json.loads(log_file.read_text(encoding='utf-8'))
            self.assertEqual(saved['lag'], 100)
            self.assertIn('savedAt', saved)


if __name__ == '__main__':
    unittest.main()
