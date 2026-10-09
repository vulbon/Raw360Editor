# Dev server: `python -m http.server`, but every response says Cache-Control: no-cache, so the browser revalidates
# each module after an edit instead of running a stale mix. Listens on all interfaces (iPad on the same Wi-Fi).
# Run from the repository root: python tools/serve.py [port]
import http.server, sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


http.server.ThreadingHTTPServer(('', int(sys.argv[1]) if len(sys.argv) > 1 else 8765), Handler).serve_forever()
