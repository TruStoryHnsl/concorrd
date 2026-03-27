#!/usr/bin/env python3
"""
Concord Emulator Viewer — View and interact with iOS + Android emulators from any browser.
"""
import http.server
import json
import os
import shutil
import socket
import subprocess
import threading
import time

PORT = 8090
SCREENSHOT_DIR = "/tmp/concord-emulator-viewer"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

_ios_lock = threading.Lock()
_android_lock = threading.Lock()
_status = {"ios": "waiting", "android": "waiting", "ios_frames": 0, "android_frames": 0}


def capture_ios():
    tmp = os.path.join(SCREENSHOT_DIR, "ios.tmp.png")
    final = os.path.join(SCREENSHOT_DIR, "ios.png")
    try:
        r = subprocess.run(
            ["xcrun", "simctl", "io", "booted", "screenshot", "--type=png", tmp],
            capture_output=True, timeout=8
        )
        if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 500:
            with _ios_lock:
                shutil.move(tmp, final)
            _status["ios"] = "ok"
            _status["ios_frames"] += 1
        else:
            _status["ios"] = "capture_failed"
    except subprocess.TimeoutExpired:
        _status["ios"] = "timeout"
    except Exception as e:
        _status["ios"] = str(e)[:40]
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def capture_android():
    tmp = os.path.join(SCREENSHOT_DIR, "android.tmp.png")
    final = os.path.join(SCREENSHOT_DIR, "android.png")
    adb = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
    try:
        result = subprocess.run([adb, "exec-out", "screencap", "-p"], capture_output=True, timeout=8)
        if result.returncode == 0 and len(result.stdout) > 500:
            with open(tmp, "wb") as f:
                f.write(result.stdout)
            with _android_lock:
                shutil.move(tmp, final)
            _status["android"] = "ok"
            _status["android_frames"] += 1
        else:
            _status["android"] = "capture_failed"
    except subprocess.TimeoutExpired:
        _status["android"] = "timeout"
    except Exception as e:
        _status["android"] = str(e)[:40]
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def tap_ios(x, y):
    try:
        subprocess.run(
            ["xcrun", "simctl", "io", "booted", "send_event", "touch", str(int(x)), str(int(y)), "press"],
            capture_output=True, timeout=3
        )
    except Exception:
        pass


def tap_android(x, y):
    adb = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
    try:
        subprocess.run([adb, "shell", "input", "tap", str(int(x)), str(int(y))], capture_output=True, timeout=3)
    except Exception:
        pass


def screenshot_loop():
    while True:
        t1 = threading.Thread(target=capture_ios, daemon=True)
        t2 = threading.Thread(target=capture_android, daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        time.sleep(0.8)


HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concord — Emulator Viewer</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    width: 100vw; height: 100vh; overflow: hidden;
    background: #0a0b0e; color: #e0e0e4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .viewer {
    width: 100%; height: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr auto;
    gap: 0;
  }

  .phone {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 8px; overflow: hidden;
    border-right: 1px solid #1a1c20;
  }
  .phone:last-of-type { border-right: none; }

  .phone-label {
    font-size: 11px; font-weight: 600; letter-spacing: 2px;
    text-transform: uppercase; color: #a4a5ff;
    margin-bottom: 6px; flex-shrink: 0;
  }

  .phone-screen {
    flex: 1; min-height: 0; width: 100%;
    display: flex; align-items: center; justify-content: center;
    position: relative;
  }

  .phone-screen img {
    max-height: 100%; max-width: 100%;
    height: auto; width: auto;
    object-fit: contain;
    border-radius: 20px;
    border: 3px solid #1e2025;
    cursor: crosshair;
    background: #111318;
  }

  .phone-screen img.loading { opacity: 0.3; filter: grayscale(0.5); }

  .phone-screen .badge {
    position: absolute; bottom: 12px; left: 50%;
    transform: translateX(-50%);
    background: rgba(10,11,14,0.9); border: 1px solid #2a2d33;
    padding: 3px 10px; border-radius: 6px;
    font-size: 10px; color: #666; white-space: nowrap;
    pointer-events: none;
  }

  .status-bar {
    grid-column: 1 / -1;
    display: flex; align-items: center; justify-content: center;
    gap: 24px; padding: 6px 12px;
    background: #0e1014; border-top: 1px solid #1a1c20;
    font-size: 10px; color: #555;
  }

  .indicator { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .indicator.ok { background: #4ade80; }
  .indicator.err { background: #ef4444; }
  .indicator.wait { background: #555; }
</style>
</head>
<body>
<div class="viewer">
  <div class="phone">
    <div class="phone-label">iOS — iPhone 16 Pro</div>
    <div class="phone-screen">
      <img id="ios-img" src="/screenshot/ios.png" onclick="tap('ios', event)" />
      <div id="ios-badge" class="badge" style="display:none"></div>
    </div>
  </div>
  <div class="phone">
    <div class="phone-label">Android — Pixel 7</div>
    <div class="phone-screen">
      <img id="android-img" src="/screenshot/android.png" onclick="tap('android', event)" />
      <div id="android-badge" class="badge" style="display:none"></div>
    </div>
  </div>
  <div class="status-bar">
    <span><span id="ios-ind" class="indicator wait"></span>iOS: <span id="ios-st">…</span></span>
    <span><span id="android-ind" class="indicator wait"></span>Android: <span id="android-st">…</span></span>
    <span id="fc"></span>
  </div>
</div>
<script>
// Stable image refresh: preload in hidden Image, swap only on success.
// Never touch the displayed <img> src on failure — it keeps the last good frame.
function refreshDevice(id) {
  const img = document.getElementById(id + '-img');
  const badge = document.getElementById(id + '-badge');
  const loader = new Image();
  loader.onload = function() {
    img.src = loader.src;
    img.classList.remove('loading');
    badge.style.display = 'none';
  };
  loader.onerror = function() {
    img.classList.add('loading');
    badge.textContent = 'Waiting for capture…';
    badge.style.display = '';
  };
  loader.src = '/screenshot/' + id + '.png?t=' + Date.now();
}

function refreshStatus() {
  fetch('/status').then(r => r.json()).then(s => {
    for (const p of ['ios', 'android']) {
      const ok = s[p] === 'ok';
      document.getElementById(p + '-ind').className = 'indicator ' + (ok ? 'ok' : 'err');
      document.getElementById(p + '-st').textContent = s[p];
    }
    document.getElementById('fc').textContent =
      'frames: ' + s.ios_frames + ' iOS / ' + s.android_frames + ' Android';
  }).catch(() => {});
}

setInterval(() => { refreshDevice('ios'); refreshDevice('android'); }, 1200);
setInterval(refreshStatus, 3000);

function tap(platform, e) {
  const img = e.target;
  if (!img.naturalWidth) return;
  const rect = img.getBoundingClientRect();
  const sx = img.naturalWidth / rect.width;
  const sy = img.naturalHeight / rect.height;
  const x = Math.round((e.clientX - rect.left) * sx);
  const y = Math.round((e.clientY - rect.top) * sy);
  fetch('/tap/' + platform + '?x=' + x + '&y=' + y);
}
</script>
</body>
</html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._html(HTML)
        elif self.path.startswith("/screenshot/"):
            self._screenshot()
        elif self.path == "/status":
            self._json(_status)
        elif self.path.startswith("/tap/"):
            self._tap()
        else:
            self.send_response(404)
            self.end_headers()

    def _html(self, content):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(content.encode())

    def _json(self, obj):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def _screenshot(self):
        name = self.path.split("/")[-1].split("?")[0]
        path = os.path.join(SCREENSHOT_DIR, name)
        lock = _ios_lock if "ios" in name else _android_lock
        with lock:
            if os.path.exists(path) and os.path.getsize(path) > 500:
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(path, "rb") as f:
                    self.wfile.write(f.read())
                return
        self.send_response(204)
        self.end_headers()

    def _tap(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        x = float(params.get("x", [0])[0])
        y = float(params.get("y", [0])[0])
        platform = parsed.path.split("/")[-1]
        fn = tap_ios if platform == "ios" else tap_android
        threading.Thread(target=fn, args=(x, y), daemon=True).start()
        self._json({"ok": True})


if __name__ == "__main__":
    threading.Thread(target=screenshot_loop, daemon=True).start()
    capture_ios()
    capture_android()

    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    print(f"Emulator Viewer: http://0.0.0.0:{PORT}")
    print(f"From orrion:     http://100.66.55.59:{PORT}")
    server.serve_forever()
