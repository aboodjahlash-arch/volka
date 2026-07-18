import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionHistory } from './session-history.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
};

export class VolkAiClawHttpServer {
  constructor({ port, host, logger, gatewayBridge, workspaceDir, openclawHome, agentId }) {
    this.port = port || 18788;
    this.host = host || '0.0.0.0';
    this.logger = logger;
    this.gatewayBridge = gatewayBridge;
    this.workspaceDir = workspaceDir || '/home/node/.openclaw/workspace';
    this.server = null;
    this.sessionHistory = new SessionHistory({
      openclawHome: openclawHome || '/home/node/.openclaw',
      agentId: agentId || 'main',
      logger,
    });
  }

  start() {
    this.server = http.createServer((req, res) => this._handleRequest(req, res));
    this.server.listen(this.port, this.host, () => {
      this.logger?.info?.(`[volk-ai-claw] HTTP server listening on ${this.host}:${this.port}`);
    });
    this.server.on('error', (err) => {
      this.logger?.error?.(`[volk-ai-claw] HTTP server error: ${String(err)}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJSON(res, 200, {
        status: 'ok',
        gateway_ready: this.gatewayBridge?.isGatewayReady?.() ?? false,
      });
    }

    if (url.pathname === '/chat' && req.method === 'POST') {
      return this._handleChat(req, res);
    }

    if (url.pathname === '/workspace' && req.method === 'POST') {
      return this._handleWorkspaceUpload(req, res, url);
    }

    if (url.pathname === '/history' && req.method === 'GET') {
      return this._handleHistory(req, res, url);
    }

    if (url.pathname.startsWith('/files/') && req.method === 'GET') {
      return this._handleFileDownload(req, res, url);
    }

    sendJSON(res, 404, { error: 'Not found' });
  }

  async _handleWorkspaceUpload(req, res, url) {
    const fileId = url.searchParams.get('file_id');
    const rawFilename = url.searchParams.get('filename') || 'file';
    if (!fileId) {
      return sendJSON(res, 400, { error: 'file_id is required' });
    }

    const safeName = path.basename(rawFilename).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
    const uploadDir = path.join(this.workspaceDir, 'upload');

    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}

    const prefix = `${fileId}_`;
    try {
      const existing = fs.readdirSync(uploadDir).find(f => f.startsWith(prefix));
      if (existing) {
        const existingPath = path.join(uploadDir, existing);
        const stat = fs.statSync(existingPath);
        if (stat.size > 0) {
          this.logger?.info?.(`[workspace] cache hit: ${existingPath}`);
          return sendJSON(res, 200, { path: existingPath, cached: true });
        }
      }
    } catch {}

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);

    if (data.length === 0) {
      return sendJSON(res, 400, { error: 'Empty file body' });
    }

    const destPath = path.join(uploadDir, `${prefix}${safeName}`);
    try {
      fs.writeFileSync(destPath, data);
      this.logger?.info?.(`[workspace] saved ${destPath} (${data.length} bytes)`);
      return sendJSON(res, 200, { path: destPath, cached: false, size: data.length });
    } catch (err) {
      this.logger?.error?.(`[workspace] write failed: ${err}`);
      return sendJSON(res, 500, { error: `Write failed: ${err}` });
    }
  }

  async _handleChat(req, res) {
    let body;
    try {
      body = await parseBody(req);
    } catch {
      return sendJSON(res, 400, { error: 'Invalid request body' });
    }

    const { message, session_id, stream = true } = body;
    if (!message) {
      return sendJSON(res, 400, { error: 'message is required' });
    }

    const sessionId = session_id || 'volk-ai-main';

    if (!this.gatewayBridge?.isGatewayReady?.()) {
      return sendJSON(res, 503, { error: 'Gateway not ready' });
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS_HEADERS,
      });

      const requestId = randomUUID();
      let done = false;

      const cleanup = this.gatewayBridge.registerResponseHandler(requestId, sessionId, {
        onChunk: (text) => {
          if (done) return;
          const data = JSON.stringify({ type: 'text', content: text });
          res.write(`event: chunk\ndata: ${data}\n\n`);
        },
        onFile: (fileInfo) => {
          if (done) return;
          const data = JSON.stringify({ type: 'file', ...fileInfo });
          res.write(`event: file\ndata: ${data}\n\n`);
        },
        onComplete: (stopReason) => {
          if (done) return;
          done = true;
          const data = JSON.stringify({ type: 'done', stop_reason: stopReason });
          res.write(`event: done\ndata: ${data}\n\n`);
          res.end();
          cleanup?.();
        },
        onError: (errMsg) => {
          if (done) return;
          done = true;
          const data = JSON.stringify({ type: 'error', error: errMsg });
          res.write(`event: error\ndata: ${data}\n\n`);
          res.end();
          cleanup?.();
        },
      });

      req.on('close', () => {
        if (!done) {
          done = true;
          cleanup?.();
        }
      });

      try {
        await this.gatewayBridge.sendPrompt(sessionId, message, requestId);
      } catch (err) {
        if (!done) {
          done = true;
          const data = JSON.stringify({ type: 'error', error: String(err) });
          res.write(`event: error\ndata: ${data}\n\n`);
          res.end();
          cleanup?.();
        }
      }
    } else {
      try {
        const result = await this.gatewayBridge.sendPromptSync(sessionId, message);
        sendJSON(res, 200, { content: result.content, stop_reason: result.stopReason });
      } catch (err) {
        sendJSON(res, 500, { error: String(err) });
      }
    }
  }

  async _handleHistory(req, res, url) {
    const rawSessionId = url.searchParams.get('session_id') || 'default';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

    const sessionId = `volk-ai:${rawSessionId}`;

    const localEntries = this.sessionHistory.readEntries(sessionId, limit);
    this.logger?.info?.(`[history] local entries: ${localEntries.length} for session=${sessionId}`);

    let gwEntries = [];
    try {
      gwEntries = await this.gatewayBridge.fetchGatewayHistory(rawSessionId, limit);
      this.logger?.info?.(`[history] gateway entries: ${gwEntries.length}`);
    } catch (err) {
      this.logger?.warn?.(`[history] gateway fetch failed: ${err}`);
    }

    const merged = this._mergeAndDedup(localEntries, gwEntries, limit);

    const messages = merged.map(e => {
      let content = e.content;
      const attachments = [];

      if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const btype = block.type;
          if (btype === 'text') {
            textParts.push(block.text || '');
          } else if (btype === 'resource_link') {
            const uri = block.uri;
            if (uri) {
              const m = uri.match(/^volk-ai-file:\/\/(.+)$/);
              attachments.push({
                file_id: m ? m[1] : undefined,
                uri,
                filename: block.name || block.title || (m ? m[1] : undefined),
                content_type: block.mimeType || block.mime_type || undefined,
              });
            }
          } else if (btype === 'file' || btype === 'image') {
            attachments.push({
              uri: block.uri || undefined,
              filename: block.fileName || block.file_name || block.filename || block.name || undefined,
              content_type: block.mimeType || block.mime_type || undefined,
            });
          } else if (btype === 'resource' && block.resource) {
            const r = block.resource;
            attachments.push({
              uri: r.uri || block.uri || undefined,
              filename: r.fileName || r.file_name || r.filename || r.name || undefined,
              content_type: r.mimeType || r.mime_type || undefined,
            });
          }
        }
        content = textParts.join('');
      } else if (content && typeof content === 'object') {
        content = content.text || JSON.stringify(content);
      }

      if (typeof content === 'string' && content.includes('<VOLK_AI_FILE')) {
        const tagRegex = /<VOLK_AI_FILE\b([^>]*)\/>/g;
        let match;
        while ((match = tagRegex.exec(content)) !== null) {
          const attrs = match[1];
          const id = attrs.match(/\bid\s*=\s*"([^"]+)"/)?.[1];
          const name = attrs.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
          const type = attrs.match(/\btype\s*=\s*"([^"]+)"/)?.[1];
          const size = attrs.match(/\bsize\s*=\s*"([^"]+)"/)?.[1];
          if (id) {
            attachments.push({
              file_id: id,
              filename: name || id,
              content_type: type || undefined,
              size: size ? parseInt(size, 10) : undefined,
            });
          }
        }
        content = content.replace(/<VOLK_AI_FILE\b[^>]*\/>/g, '').trim();
      }

      const msg = {
        role: e.role,
        content: typeof content === 'string' ? content : '',
        timestamp: e.timestamp || 0,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        stopReason: e.stopReason,
      };
      if (attachments.length) msg.attachments = attachments;
      return msg;
    });

    sendJSON(res, 200, { messages });
  }

  _mergeAndDedup(local, gateway, limit) {
    const dedupKey = (entry) => {
      let text = '';
      if (typeof entry.content === 'string') {
        text = entry.content;
      } else if (Array.isArray(entry.content)) {
        text = entry.content.filter(c => c?.type === 'text').map(c => c.text || '').join('');
      }
      return `${entry.role}:${text.slice(0, 200)}`;
    };

    const localBag = new Map();
    const result = [...local];

    for (const e of local) {
      const key = dedupKey(e);
      localBag.set(key, (localBag.get(key) || 0) + 1);
    }
    for (const e of gateway) {
      const key = dedupKey(e);
      const remaining = localBag.get(key) || 0;
      if (remaining > 0) {
        localBag.set(key, remaining - 1);
        continue;
      }
      result.push(e);
    }

    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return result.slice(-limit);
  }

  _handleFileDownload(req, res, url) {
    const rawName = decodeURIComponent(url.pathname.slice('/files/'.length));
    const safeName = path.basename(rawName);
    if (!safeName) {
      return sendJSON(res, 400, { error: 'Invalid filename' });
    }

    const filePath = path.join(this.workspaceDir, safeName);
    if (!filePath.startsWith(path.resolve(this.workspaceDir))) {
      return sendJSON(res, 403, { error: 'Forbidden' });
    }

    fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        return sendJSON(res, 404, { error: 'File not found' });
      }

      const ext = path.extname(safeName).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${safeName}"`,
        ...CORS_HEADERS,
      });

      fs.createReadStream(filePath).pipe(res);
    });
  }
}
