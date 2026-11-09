"""Serve the built site locally.

    python serve.py                 # serves dist/ on http://localhost:8000 with COOP/COEP headers
    python serve.py 9000            # another port
    python serve.py --no-coi        # omit the headers, to mimic GitHub Pages (the page then uses its service worker)
"""
import http.server, socketserver, sys, os
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith("--")]
COI = "--no-coi" not in sys.argv
PORT = int(args[0]) if args else 8000
ROOT = Path(__file__).resolve().parent / "dist"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
                      ".onnx": "application/octet-stream", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png"}

    # /ollama/* → 로컬 Ollama(127.0.0.1:11434) 프록시. Chrome의 내부망 접근 차단(Private Network Access)이
    # 공개 https 페이지에서 로컬 Ollama 호출을 막을 때도 preflight에 ACA-PNA: true로 응답해 허용되게 해 준다.
    # 사이트에서는 ?clefBase=http://localhost:8769/ollama (또는 서버 주소 입력)로 프록시를 쓰면 된다.
    def end_headers(self):
        if COI:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _ollama_proxy(self):
        import urllib.request, urllib.error
        target = "http://127.0.0.1:11434" + self.path[len("/ollama"):]
        body = None
        if self.headers.get("Content-Length"):
            body = self.rfile.read(int(self.headers["Content-Length"]))
        req = urllib.request.Request(target, data=body, method="GET" if self.command == "GET" else ("POST" if self.command == "POST" else "PUT"), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as up:
                data, code = up.read(), up.status
        except urllib.error.HTTPError as e:
            data, code = e.read(), e.code
        except Exception as e:
            data = str(e).encode(); code = 502
        self.send_response(204 if self.command == "OPTIONS" else code)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        if self.command != "OPTIONS":
            self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "OPTIONS" and data:
            self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/ollama"):
            return self._ollama_proxy()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__diag"):
            # 진단 로그 수신: 어떤 오리진(github.io/localhost)이든 허용해 기기의 로그 파일에 적재
            try:
                ln = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(ln).decode("utf-8", "replace")
                log = os.path.expanduser("~/lab-diag.log")
                with open(log, "a", encoding="utf-8") as f:
                    f.write(f"[{self.headers.get('Origin') or 'local'}] {body}\n")
                self.send_response(204)
            except Exception as e:
                self.send_response(500)
                body = str(e).encode()
            finally:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.end_headers()
            return
        if self.path.startswith("/ollama"):
            return self._ollama_proxy()
        self.send_error(405)

    def do_OPTIONS(self):
        if self.path.startswith("/ollama"):
            return self._ollama_proxy()
        self.send_error(405)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if not ROOT.exists():
        sys.exit("dist/ not found. Run: npm ci && node scripts/prepare_site.mjs")
    os.chdir(ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving dist/ on http://localhost:{PORT}  (COOP/COEP headers: {'on' if COI else 'off'})  Ctrl+C to stop")
        httpd.serve_forever()
