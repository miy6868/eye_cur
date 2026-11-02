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
        self.assertIn('테스트', self.client.get('/demo').text)  # /demo/로 넘어가 첫 화면
        page = self.client.get('/demo/test.html')
        self.assertIn('클릭 0회', page.text)
        self.assertEqual(page.headers['cache-control'], 'no-cache')
        for page in ('games.html', 'ghost.html', 'ship.html', 'mole.html', 'gaze.js', 'kit.js', 'style.css', 'img/ship.jpg'):
            self.assertEqual(self.client.get(f'/demo/{page}').status_code, 200, page)

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
                self.assertIsInstance(settings['words'], list)
                self.assertEqual(ws.receive_json()['type'], 'status')
                self.assertEqual(ws.receive_json()['type'], 'status')
                self.assertEqual(ws.receive_json()['type'], 'frame')
                ws.send_json({'type': 'stop'})
                with self.assertRaises(WebSocketDisconnect):
                    while True: ws.receive_json()
        self.assertTrue(closed)
        self.assertFalse(server.active)

    def test_my_words_skip_comments_blanks_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'my_words.txt'
            path.write_text('\ufeff# 설명\n학교 축제\n\n  GitHub  # 영어\n학교 축제\n', encoding='utf-8')
            with patch.object(server, 'WORDS_FILE', path):
                self.assertEqual(server.my_words(), ['학교 축제', 'GitHub'])
            path.write_bytes('학교'.encode('cp949'))  # 메모장 ANSI 저장
            with patch.object(server, 'WORDS_FILE', path):
                self.assertEqual(server.my_words(), [])
            with patch.object(server, 'WORDS_FILE', Path(directory) / 'none.txt'):
                self.assertEqual(server.my_words(), [])

    def send_calibration_log(self, log_file, save):
        class FakeTracker:
            def read(self): return {'type': 'frame', 'valid': False, 'time': 10}
            def close(self): pass
        with patch.object(server, 'LOG_FILE', log_file), patch.dict(server.CONFIG, {'save_calibration_log': save}), \
             patch.dict('sys.modules', {'backend.tracker': SimpleNamespace(Tracker=FakeTracker)}):
            with self.client.websocket_connect('/ws', headers={'origin': 'chrome-extension://test'}) as ws:
                ws.send_json({'token': server.TOKEN})
                ws.receive_json(); ws.receive_json(); ws.receive_json()
                ws.send_json({'type': 'calibrationLog', 'lag': 100})
                ws.send_json({'type': 'stop'})
                with self.assertRaises(WebSocketDisconnect):
                    while True: ws.receive_json()

    def test_calibration_log_is_appended(self):
        with tempfile.TemporaryDirectory() as folder:
            log_file = Path(folder) / 'logs' / 'pursuit.jsonl'
            self.send_calibration_log(log_file, True)
            saved = json.loads(log_file.read_text(encoding='utf-8'))
            self.assertEqual(saved['lag'], 100)
            self.assertIn('savedAt', saved)

    def test_calibration_log_is_not_saved_when_turned_off(self):
        with tempfile.TemporaryDirectory() as folder:
            log_file = Path(folder) / 'logs' / 'pursuit.jsonl'
            self.send_calibration_log(log_file, False)
            self.assertFalse(log_file.exists())


if __name__ == '__main__':
    unittest.main()
