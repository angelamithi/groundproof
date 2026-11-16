# Local stand-in for a Walrus publisher + aggregator (PUT/GET /v1/blobs).
import hashlib, http.server
store = {}
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def do_PUT(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        bid = hashlib.sha256(data).hexdigest()[:43]; store[bid] = data
        body = ('{"newlyCreated":{"blobObject":{"blobId":"%s"}}}' % bid).encode()
        self.send_response(200); self.cors(); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        bid = self.path.rsplit('/', 1)[-1]
        if bid not in store: self.send_response(404); self.cors(); self.end_headers(); return
        self.send_response(200); self.cors(); self.end_headers(); self.wfile.write(store[bid])
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', 9300), H).serve_forever()
