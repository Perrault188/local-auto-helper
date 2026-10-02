import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withSqliteBusyRetry } from './repositories.mjs';

const tokenHash = token => createHash('sha256').update(token).digest('hex');
const safeName = value => basename(String(value || 'file')).replace(/[\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
const flatArchiveEntries = rows => {
  const used = new Set();
  return rows.map(row => {
    const original = safeName(row.name);
    const extension = extname(original);
    const stem = basename(original, extension) || 'file';
    let name = original;
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = `${stem}_${suffix++}${extension}`;
    used.add(name.toLowerCase());
    return { name, content: row.content };
  });
};

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, start) => {
    let value = start;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export class MockArtifactStore {
  constructor(dataDir, { reset = false, now = () => new Date().toISOString(), contentForDownload = (_, content) => content } = {}) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.now = now;
    this.contentForDownload = contentForDownload;
    this.db = withSqliteBusyRetry(() => new DatabaseSync(dataDir ? join(dataDir, 'mock-artifacts.sqlite') : ':memory:'));
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (dataDir) withSqliteBusyRetry(() => this.db.exec('PRAGMA journal_mode = WAL'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_attachment_id TEXT NOT NULL,
        member_user_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_attachment_id, created_at, artifact_id);
      CREATE TABLE IF NOT EXISTS artifact_downloads (
        token_hash TEXT PRIMARY KEY,
        task_attachment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
    `);
    if (reset) this.clear();
  }

  clear() { this.db.exec('DELETE FROM artifacts; DELETE FROM artifact_downloads;'); }

  save({ artifactId = `artifact_${randomUUID()}`, taskAttachmentId, memberUserId, originalName, storedName, content }) {
    const createdAt = this.now();
    const normalizedName = safeName(storedName);
    this.db.prepare(`INSERT OR IGNORE INTO artifacts
      (artifact_id, task_attachment_id, member_user_id, original_name, stored_name, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(artifactId, taskAttachmentId, memberUserId, safeName(originalName), normalizedName, Buffer.from(content), createdAt);
    return { artifactId, name: normalizedName, size: Buffer.byteLength(content), memberUserId, createdAt };
  }

  list(taskAttachmentId) {
    return this.db.prepare(`SELECT artifact_id AS artifactId, member_user_id AS memberUserId,
      stored_name AS name, length(content) AS size, created_at AS createdAt
      FROM artifacts WHERE task_attachment_id = ? ORDER BY created_at, artifact_id`)
      .all(taskAttachmentId);
  }

  createDownload(taskAttachmentId, { ttlMs = 5 * 60 * 1000 } = {}) {
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    this.db.prepare(`INSERT INTO artifact_downloads
      (token_hash, task_attachment_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)`)
      .run(tokenHash(token), taskAttachmentId, createdAt, expiresAt);
    return { token, expiresAt };
  }

  consumeDownload(token) {
    const hash = tokenHash(token);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const download = this.db.prepare(`SELECT task_attachment_id AS taskAttachmentId,
        expires_at AS expiresAt, consumed_at AS consumedAt FROM artifact_downloads WHERE token_hash = ?`).get(hash);
      if (!download || download.consumedAt || Date.parse(download.expiresAt) <= Date.parse(this.now())) {
        this.db.exec('ROLLBACK');
        const error = new Error('下载链接已失效或已使用');
        error.code = 'DOWNLOAD_GONE';
        error.status = 410;
        throw error;
      }
      const consumedAt = this.now();
      this.db.prepare('UPDATE artifact_downloads SET consumed_at = ? WHERE token_hash = ?').run(consumedAt, hash);
      const rows = this.db.prepare(`SELECT member_user_id AS memberUserId, stored_name AS name, content
        FROM artifacts WHERE task_attachment_id = ? ORDER BY created_at, artifact_id`).all(download.taskAttachmentId);
      this.db.exec('COMMIT');
      return {
        taskAttachmentId: download.taskAttachmentId,
        content: buildStoredZip(flatArchiveEntries(rows.map(row => ({ ...row, content: this.contentForDownload(row.name, row.content) }))))
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() { this.db.close(); }
}
