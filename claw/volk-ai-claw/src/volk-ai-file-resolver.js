import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const VOLK_AI_FILE_URI_PREFIX = 'volk-ai-file://';
const VOLK_AI_FILE_URI_REGEX = /volk-ai-file:\/\/([a-f0-9]{24})/g;
const RESOLVE_TIMEOUT_MS = 30_000;
const MAX_FILENAME_LENGTH = 120;

/**
 * Resolves `volk-ai-file://{fileId}` URIs found in prompts by:
 *   1. Downloading the file from the VOLK AI backend API to local disk
 *   2. Replacing the URI with a `<VOLK_AI_FILE .../>` tag the agent can use
 */
export class VolkAiFileResolver {
  constructor({ volkAiApiBaseUrl, volkAiApiKey, downloadDir, uploadMetaDir, logger }) {
    this.volkAiApiBaseUrl = volkAiApiBaseUrl;
    this.volkAiApiKey = volkAiApiKey;
    this.downloadDir = downloadDir;
    this.uploadMetaDir = uploadMetaDir;
    this.logger = logger;

    try { fs.mkdirSync(this.downloadDir, { recursive: true }); } catch {}
  }

  buildResolutionPlan(text) {
    const fileIds = new Set();
    let match;
    const re = new RegExp(VOLK_AI_FILE_URI_REGEX.source, 'g');
    while ((match = re.exec(text)) !== null) {
      fileIds.add(match[1]);
    }
    return [...fileIds];
  }

  async resolvePrompt(text) {
    if (typeof text !== 'string') return text;

    const fileIds = this.buildResolutionPlan(text);
    if (fileIds.length === 0) return text;

    this.logger?.info?.(`[file-resolver] found ${fileIds.length} volk-ai-file:// refs to resolve`);

    const resolutions = new Map();
    await Promise.all(fileIds.map(async (fileId) => {
      const result = await this._resolveFile(fileId);
      resolutions.set(fileId, result);
    }));

    let resolved = text;
    for (const [fileId, result] of resolutions) {
      const uriPattern = new RegExp(`volk-ai-file://${fileId}`, 'g');
      const tag = result.ok
        ? buildVolkAiFileRefText(result)
        : buildVolkAiFileFailedRefText(result);
      resolved = resolved.replace(uriPattern, tag);
    }

    return resolved;
  }

  async _resolveFile(fileId) {
    const cached = this._findExistingDownload(fileId);
    if (cached) {
      this.logger?.info?.(`[file-resolver] cache hit for ${fileId}: ${cached.localPath}`);
      return { ok: true, fileId, localPath: cached.localPath, name: cached.name };
    }

    const uploadMeta = this._loadUploadMeta(fileId);
    if (uploadMeta?.localPath) {
      try {
        const stat = await fsp.stat(uploadMeta.localPath);
        if (stat.isFile() && stat.size > 0) {
          this.logger?.info?.(`[file-resolver] upload-meta hit for ${fileId}: ${uploadMeta.localPath}`);
          return {
            ok: true, fileId,
            localPath: uploadMeta.localPath,
            name: uploadMeta.filename || path.basename(uploadMeta.localPath),
          };
        }
      } catch {}
    }

    let meta;
    try {
      meta = await this._fetchFileMeta(fileId);
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : `meta_fetch_failed: ${err.message}`;
      this.logger?.warn?.(`[file-resolver] metadata fetch failed for ${fileId}: ${reason}`);
      return { ok: false, fileId, name: fileId, reason };
    }

    try {
      const localPath = await this._downloadFile(fileId, meta);
      this.logger?.info?.(`[file-resolver] downloaded ${fileId} -> ${localPath}`);
      return { ok: true, fileId, localPath, name: meta.filename || fileId };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : `download_failed: ${err.message}`;
      this.logger?.warn?.(`[file-resolver] download failed for ${fileId}: ${reason}`);
      return { ok: false, fileId, name: meta.filename || fileId, reason };
    }
  }

  _findExistingDownload(fileId) {
    try {
      if (!fs.existsSync(this.downloadDir)) return null;
      const prefix = `${fileId}_`;
      const entries = fs.readdirSync(this.downloadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const filePath = path.join(this.downloadDir, entry.name);
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size > 0) {
          const name = entry.name.slice(prefix.length) || 'file';
          return { localPath: filePath, name };
        }
      }
    } catch {}
    return null;
  }

  _loadUploadMeta(fileId) {
    if (!this.uploadMetaDir) return null;
    try {
      const metaPath = path.join(this.uploadMetaDir, `${fileId}.json`);
      if (!fs.existsSync(metaPath)) return null;
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {}
    return null;
  }

  async _fetchFileMeta(fileId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

    try {
      const url = `${this.volkAiApiBaseUrl}/api/v1/claw/resolve/${encodeURIComponent(fileId)}`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Claw-Api-Key': this.volkAiApiKey || '',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const json = await resp.json();
      const data = json?.data || json;
      return {
        fileId,
        filename: data.filename || data.name || fileId,
        contentType: data.content_type || data.contentType || 'application/octet-stream',
        size: data.size || 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async _downloadFile(fileId, meta) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

    try {
      const downloadUrl = `${this.volkAiApiBaseUrl}/api/v1/claw/resolve/${encodeURIComponent(fileId)}/download`;
      const resp = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'X-Claw-Api-Key': this.volkAiApiKey || '' },
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const safeName = sanitizeFileName(meta.filename || 'file');
      const destPath = path.join(this.downloadDir, `${fileId}_${safeName}`);

      await fsp.writeFile(destPath, buffer);
      return destPath;
    } finally {
      clearTimeout(timer);
    }
  }
}

function escapeXmlAttribute(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildVolkAiFileRefText({ fileId, localPath, name }) {
  return `<VOLK_AI_FILE type="file" path="${escapeXmlAttribute(localPath)}" name="${escapeXmlAttribute(name)}" id="${escapeXmlAttribute(fileId)}" />`;
}

function buildVolkAiFileFailedRefText({ fileId, name, reason }) {
  return `<VOLK_AI_FILE type="file" path="" name="${escapeXmlAttribute(name)}" id="${escapeXmlAttribute(fileId)}" status="download_failed" reason="${escapeXmlAttribute(reason)}" />`;
}

function sanitizeFileName(name) {
  let safe = path.basename(name);
  safe = safe.replace(/[\x00-\x1f\x7f]/g, '');
  safe = safe.replace(/[/\\:*?"<>|]/g, '_');
  safe = safe.replace(/_+/g, '_');
  if (safe.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(safe);
    safe = safe.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return safe || 'file';
}
