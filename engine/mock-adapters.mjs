import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, assert, clone } from './utils.mjs';
import { withSqliteBusyRetry } from './repositories.mjs';
import { buildStoredZip, MockArtifactStore } from './artifacts.mjs';

const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const officeZip = entries => buildStoredZip(entries.map(([name, content]) => ({ name, content: Buffer.from(content) })));

function mockPdfContent() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 60 >>\nstream\nBT /F1 18 Tf 72 720 Td (Local Helper Mock Submission) Tj ET\nendstream'
  ];
  let body = '%PDF-1.4\n%LocalHelper\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function mockDocxContent(originalName) {
  const text = xmlEscape(`本地助手Mock文件成果 原文件 ${originalName}`);
  return officeZip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`]
  ]);
}

function mockXlsxContent(originalName) {
  const text = xmlEscape(`本地助手Mock文件成果 原文件 ${originalName}`);
  return officeZip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Mock作业" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`]
  ]);
}

export function mockArtifactContent(fileName, originalName = fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.pdf') return mockPdfContent();
  if (extension === '.docx') return mockDocxContent(originalName);
  if (extension === '.xlsx') return mockXlsxContent(originalName);
  if (extension === '.doc') return Buffer.from(`{\\rtf1\\ansi Local Helper Mock Submission - ${String(originalName).replace(/[{}\\]/g, '_')}}`);
  if (extension === '.png') return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  if (extension === '.jpg' || extension === '.jpeg') return Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');
  return Buffer.from(`本地助手Mock文件成果\n原文件 ${originalName}\n`);
}

class MockConnectorJournal {
  constructor(dataDir, { reset = false } = {}) {
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.db = withSqliteBusyRetry(() => new DatabaseSync(dataDir ? join(dataDir, 'mock-connector.sqlite') : ':memory:'));
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (dataDir) withSqliteBusyRetry(() => this.db.exec('PRAGMA journal_mode = WAL'));
    withSqliteBusyRetry(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (effect_key TEXT PRIMARY KEY, operation TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS performs (perform_id INTEGER PRIMARY KEY AUTOINCREMENT, effect_key TEXT NOT NULL, operation TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL);
    `));
    if (reset) this.clear();
  }
  clear() { withSqliteBusyRetry(() => this.db.exec('DELETE FROM receipts; DELETE FROM performs;')); }
  perform({ effectKey, operation, idempotent, work }) {
    if (!idempotent) {
      const output = clone(work());
      this.db.prepare('INSERT INTO performs(effect_key, operation, output, created_at) VALUES (?, ?, ?, ?)').run(effectKey, operation, JSON.stringify(output), new Date().toISOString());
      return output;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT output FROM receipts WHERE effect_key = ?').get(effectKey);
      if (existing) { this.db.exec('COMMIT'); return JSON.parse(existing.output); }
      const connectorReceipt = { receiptId: `mock-receipt:${effectKey}`, effectKey, operation };
      const output = { ...clone(work()), connectorReceipt };
      const serialized = JSON.stringify(output);
      const at = new Date().toISOString();
      this.db.prepare('INSERT INTO performs(effect_key, operation, output, created_at) VALUES (?, ?, ?, ?)').run(effectKey, operation, serialized, at);
      this.db.prepare('INSERT INTO receipts(effect_key, operation, output, created_at) VALUES (?, ?, ?, ?)').run(effectKey, operation, serialized, at);
      this.db.exec('COMMIT');
      return output;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  receipts() { return this.db.prepare('SELECT effect_key AS effectKey, operation, output, created_at AS createdAt FROM receipts ORDER BY effect_key').all().map(item => ({ ...item, output: JSON.parse(item.output) })); }
  performs() { return this.db.prepare('SELECT perform_id AS performId, effect_key AS effectKey, operation, output, created_at AS createdAt FROM performs ORDER BY perform_id').all().map(item => ({ ...item, output: JSON.parse(item.output) })); }
  close() { this.db.close(); }
}

export class MockAdapters {
  constructor(seed = {}, { dataDir = null, idempotency = true, resetConnectorJournal = false } = {}) {
    this.state = clone({ files: seed.files ?? [], groupMessages: [], directMessages: [], replies: [], timerEvents: [], ...seed });
    this.messageProjection = null;
    this.failures = [];
    this.idempotency = idempotency;
    this.connectorJournal = new MockConnectorJournal(dataDir, { reset: resetConnectorJournal });
    this.artifactStore = new MockArtifactStore(dataDir, {
      reset: resetConnectorJournal,
      contentForDownload: (name, content) => {
        const extension = extname(name).toLowerCase();
        return ['.pdf', '.doc', '.docx', '.xlsx', '.png', '.jpg', '.jpeg'].includes(extension)
          ? mockArtifactContent(name, name)
          : content;
      }
    });
  }
  setMessageProjection(reader) { this.messageProjection = reader; }
  setFailure(rule) { this.failures.push(clone(rule)); }
  setIdempotencySupport(value) { this.idempotency = Boolean(value); }
  supportsIdempotency() { return this.idempotency; }
  connectorReceipts() { return clone(this.connectorJournal.receipts()); }
  connectorPerforms() { return clone(this.connectorJournal.performs()); }
  closeConnectorJournal() { this.connectorJournal.close(); this.artifactStore.close(); }
  #failure(operation, recipientKey) { return this.failures.find(item => item.operation === operation && item.recipientKey === recipientKey) ?? null; }
  #perform(operation, effectKey, work) { return this.connectorJournal.perform({ effectKey: effectKey ?? id('effect'), operation, idempotent: this.idempotency, work }); }
  fileExists(path) { return this.state.files.some(file => file.path === path); }
  receiveFile(file) { if (!this.fileExists(file.path)) this.state.files.push(clone(file)); return clone(file); }
  copyOrRenameFile(sourcePath, newName, { taskAttachmentId = 'unscoped', memberUserId = 'unknown' } = {}) {
    assert(this.fileExists(sourcePath), `找不到输入文件${sourcePath}`, 'FILE_NOT_FOUND');
    const artifactId = id('artifact');
    const target = join('/demo/submissions', taskAttachmentId, artifactId, newName);
    const source = this.state.files.find(file => file.path === sourcePath);
    const managed = { ...clone(source), fileId: id('file'), artifactId, taskAttachmentId, memberUserId, name: basename(target), path: target, sourcePath };
    this.state.files.push(managed);
    this.artifactStore.save({
      artifactId, taskAttachmentId, memberUserId, originalName: source.name ?? basename(sourcePath), storedName: managed.name,
      content: mockArtifactContent(managed.name, source.name ?? basename(sourcePath))
    });
    return { filePath: target, fileId: managed.fileId, artifactId };
  }
  listArtifacts(taskAttachmentId) { return clone(this.artifactStore.list(taskAttachmentId)); }
  createArtifactDownload(taskAttachmentId, options) { return this.artifactStore.createDownload(taskAttachmentId, options); }
  consumeArtifactDownload(token) { return this.artifactStore.consumeDownload(token); }
  clearArtifacts() { this.artifactStore.clear(); }
  sendGroupMessageAndFile({ groupId, text, filePath, effectKey }) {
    assert(this.fileExists(filePath), `找不到要发送的文件${filePath}`, 'FILE_NOT_FOUND');
    return this.#perform('group_message_and_file', effectKey, () => ({ messageId: id('message'), fileId: id('file'), groupId, text, filePath }));
  }
  replyToSender({ senderUserId, text, effectKey }) { return this.#perform('reply_to_sender', effectKey, () => ({ messageId: id('reply'), senderUserId, text })); }
  sendDirectMessageBatch({ userIds, text, effectKey }) {
    return this.#perform('direct_message_batch', effectKey, () => {
      const deliveries = userIds.map(userId => {
        const failure = this.#failure('direct_message', userId);
        return failure ? { userId, status: 'failed', error: { code: failure.code ?? 'ADAPTER_ERROR', message: 'Mock私信写入失败' } } : { userId, status: 'mock_recorded', messageId: id('direct'), text };
      });
      return { sentCount: deliveries.filter(item => item.status === 'mock_recorded').length, messageIds: deliveries.map(item => item.messageId ?? null), deliveries };
    });
  }
  fireTimer(event) { this.state.timerEvents.push(clone(event)); return clone(event); }
  snapshot() {
    const projection = this.messageProjection?.() ?? { groupMessages: this.state.groupMessages, directMessages: this.state.directMessages, replies: this.state.replies };
    return clone({ ...this.state, ...projection });
  }
}

export function renamedFileName(template, person, originalPath) {
  return template.replaceAll('{studentId}', person.studentId).replaceAll('{name}', person.name).replaceAll('{originalExtension}', extname(originalPath));
}
