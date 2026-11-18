"""Isolated public-web Chromium reader. No Docker socket or host filesystem mounts."""
import ipaddress
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, urlencode
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', '3002'))
MAX_BODY = 16 * 1024
MAX_TEXT = 20000
MAX_LINKS = 80
CHROME = os.environ.get('CHROMIUM_PATH', '/ms-playwright/chromium-1124/chrome-linux/chrome')
PROXY = os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY') or ''
REQUEST_SLOTS = threading.BoundedSemaphore(1)
BLOCKED_HOSTS = {'localhost', 'metadata.google.internal', 'metadata.google', 'instance-data'}


def validate_url(value):
    parsed = urlparse(str(value or ''))
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('只允许无凭据的 HTTP/HTTPS 地址')
    host = parsed.hostname.rstrip('.').lower()
    if host in BLOCKED_HOSTS or host.endswith(('.localhost', '.local', '.internal')):
        raise ValueError('本机或内网地址已拦截')
    try:
        addresses = [host] if ipaddress.ip_address(host) else []
    except ValueError:
        addresses = []
    if not addresses:
        try:
            addresses = list({item[4][0] for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)})
        except OSError as error:
            raise ValueError('域名解析失败') from error
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ValueError('域名解析到本机或内网地址，已拦截')
    return parsed.geturl()


def render(target):
    target = validate_url(target)
    blocked = []
    with sync_playwright() as p:
        launch = {'headless': True, 'executable_path': CHROME, 'args': ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--no-first-run']}
        if PROXY:
            launch['proxy'] = {'server': PROXY}
        browser = p.chromium.launch(**launch)
        try:
            context = browser.new_context(java_script_enabled=True, service_workers='block', accept_downloads=False,
                ignore_https_errors=False, viewport={'width': 1365, 'height': 900},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 ComposeOpsReader/1.0')
            try:
                def guard(route):
                    try:
                        validate_url(route.request.url)
                        route.continue_()
                    except Exception as error:
                        blocked.append({'url': route.request.url[:240], 'reason': str(error)[:120]})
                        route.abort('blockedbyclient')
                context.route('**/*', guard)
                page = context.new_page()
                page.set_default_navigation_timeout(18000)
                # Return as soon as the main response commits. Some JS-heavy portals keep
                # navigation open indefinitely; DOM readiness is bounded separately.
                response = page.goto(target, wait_until='commit', timeout=12000)
                try:
                    page.wait_for_load_state('domcontentloaded', timeout=9000)
                except Exception:
                    pass
                try:
                    page.wait_for_load_state('networkidle', timeout=1800)
                except Exception:
                    pass
                page.wait_for_timeout(900)
                data = page.evaluate('''({maxText,maxLinks}) => {
                  const ignored='script,style,noscript,svg,nav,footer,header,form,aside,[aria-hidden="true"]';
                  const root=document.querySelector('main,article,[role="main"]')||document.body;
                  const clone=root.cloneNode(true); clone.querySelectorAll(ignored).forEach(n=>n.remove());
                  const text=(clone.innerText||clone.textContent||'').replace(/[\\t ]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
                  const links=[...root.querySelectorAll('a[href]')].map(a=>({title:(a.innerText||a.getAttribute('aria-label')||'').trim().slice(0,120),url:a.href}))
                    .filter(a=>a.title&&/^https?:/.test(a.url)).filter((a,i,all)=>all.findIndex(b=>b.url===a.url)===i).slice(0,maxLinks);
                  return {title:document.title.slice(0,240),description:document.querySelector('meta[name="description"]')?.content?.slice(0,500)||'',text:text.slice(0,maxText),textLength:text.length,links};
                }''', {'maxText': MAX_TEXT, 'maxLinks': MAX_LINKS})
                return {'url': page.url, 'status': response.status if response else 0,
                    'contentType': response.headers.get('content-type', '') if response else '', **data,
                    'truncated': data['textLength'] > MAX_TEXT, 'blockedRequests': blocked[:20], 'rendered': True}
            finally:
                context.close()
        finally:
            browser.close()


def search(query):
    query = str(query or '').strip()[:500]
    if len(query) < 2:
        raise ValueError('搜索词太短')
    params = {'q': query, 'setlang': 'zh-CN', 'cc': 'CN'} if any('\u3400' <= c <= '\u9fff' for c in query) else {'q': query}
    target = validate_url('https://www.bing.com/search?' + urlencode(params))
    with sync_playwright() as p:
        launch = {'headless': True, 'executable_path': CHROME, 'args': ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync', '--no-first-run']}
        if PROXY:
            launch['proxy'] = {'server': PROXY}
        browser = p.chromium.launch(**launch)
        try:
            context = browser.new_context(java_script_enabled=True, service_workers='block', accept_downloads=False,
                ignore_https_errors=False, viewport={'width': 1365, 'height': 900},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 ComposeOpsReader/1.0')
            try:
                blocked = []
                def guard(route):
                    try:
                        validate_url(route.request.url)
                        route.continue_()
                    except Exception as error:
                        blocked.append({'url': route.request.url[:240], 'reason': str(error)[:120]})
                        route.abort('blockedbyclient')
                context.route('**/*', guard)
                page = context.new_page()
                page.set_default_navigation_timeout(12000)
                response = page.goto(target, wait_until='commit', timeout=12000)
                if response and response.status >= 400:
                    return {'results': [], 'status': response.status, 'pageTitle': page.title()[:160], 'blockedRequests': blocked[:20]}
                try:
                    page.wait_for_load_state('domcontentloaded', timeout=7000)
                except Exception:
                    pass
                try:
                    page.wait_for_load_state('networkidle', timeout=3500)
                except Exception:
                    pass
                page.wait_for_timeout(500)
                results = page.evaluate('''() => [...document.querySelectorAll('li.b_algo')].map(card => {
                  const a=card.querySelector('h2 a');
                  const p=card.querySelector('.b_caption p, p');
                  return {title:(a?.innerText||'').trim().slice(0,160),url:a?.href||'',snippet:(p?.innerText||'').trim().slice(0,360)};
                }).filter(x=>x.title&&x.url).slice(0,10)''')
                return {'results': results, 'status': response.status if response else 0, 'blockedRequests': blocked[:20]}
            finally:
                context.close()
        finally:
            browser.close()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'browser': True})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/render', '/search'):
            self.send_json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 2 or length > MAX_BODY:
                raise ValueError('请求体大小无效')
            body = json.loads(self.rfile.read(length))
            if not REQUEST_SLOTS.acquire(blocking=False):
                self.send_json(429, {'error': '浏览器任务繁忙，请稍后重试'})
                return
            try:
                result = search(body.get('query')) if self.path == '/search' else render(body.get('url'))
                self.send_json(200, result)
            finally:
                REQUEST_SLOTS.release()
        except Exception as error:
            self.send_json(400, {'error': str(error)[:300]})

    def log_message(self, fmt, *args):
        print('[browser]', fmt % args, flush=True)


ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
