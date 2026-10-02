import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clone } from './utils.mjs';
import { validateMessage } from './objects.mjs';

const sqliteRetryWait = delayMs => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
const isSqliteBusy = error => /SQLITE_BUSY|database (?:table )?is locked/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
export function withSqliteBusyRetry(work, { attempts = 20, delayMs = 25 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return work(); }
    catch (error) {
      if (!isSqliteBusy(error) || attempt === attempts - 1) throw error;
      lastError = error;
      sqliteRetryWait(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

// 统一存储后端接口：list / get / save / replaceAll。
// 底层可切换 JSON 文件或 SQLite，仓库层与 EngineService 均只依赖本接口。
// 所有读写返回值都经过 clone，保证外部改动不污染底层存储。
export class StorageBackend {
  constructor(key) { this.key = key; }
  async list(predicate = () => true) { throw new Error('StorageBackend.list 未实现'); }
  async get(id) { throw new Error('StorageBackend.get 未实现'); }
  async save(value) { throw new Error('StorageBackend.save 未实现'); }
  async replaceAll(values) { throw new Error('StorageBackend.replaceAll 未实现'); }
}

// JSON 文件后端：保留原有「读整表、内存过滤、临时文件原子替换」的行为。
export class JsonBackend extends StorageBackend {
  constructor(filePath, key) { super(key); this.filePath = filePath; }
  async #read() { try { return JSON.parse(await readFile(this.filePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  async #write(items) { await mkdir(dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp`; await writeFile(temp, `${JSON.stringify(items, null, 2)}\n`); await rename(temp, this.filePath); }
  async list(predicate = () => true) { return clone((await this.#read()).filter(predicate)); }
  async get(id) { return clone((await this.#read()).find(item => item[this.key] === id) ?? null); }
  async save(value) { const items = await this.#read(); const index = items.findIndex(item => item[this.key] === value[this.key]); if (index < 0) items.push(clone(value)); else items[index] = clone(value); await this.#write(items); return clone(value); }
  async replaceAll(values) { await this.#write(clone(values)); }
}

// SQLite 后端：零第三方依赖，使用运行时内置 node:sqlite。
// 每个仓库对应一张表：主键列存业务 id，doc 列存整份 JSON 文档。
// 派生查询在读出文档后于内存过滤/排序，行为与 JSON 后端一致。
export class SqliteBackend extends StorageBackend {
  constructor(db, table, key) { super(key); this.db = db; this.table = table; withSqliteBusyRetry(() => db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`)); }
  #all() { return this.db.prepare(`SELECT doc FROM "${this.table}"`).all().map(row => JSON.parse(row.doc)); }
  listSync(predicate = () => true) { return clone(this.#all().filter(predicate)); }
  getSync(id) { const row = this.db.prepare(`SELECT doc FROM "${this.table}" WHERE id = ?`).get(String(id)); return row ? clone(JSON.parse(row.doc)) : null; }
  async list(predicate = () => true) { return this.listSync(predicate); }
  async get(id) { return this.getSync(id); }
  async save(value) { const doc = JSON.stringify(value); this.db.prepare(`INSERT INTO "${this.table}" (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc`).run(String(value[this.key]), doc); return clone(value); }
  saveIfAbsentSync(value) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO "${this.table}" (id, doc) VALUES (?, ?)`).run(String(value[this.key]), JSON.stringify(value));
    return { inserted: result.changes === 1, value: this.getSync(value[this.key]) };
  }
  async saveIfAbsent(value) { return this.saveIfAbsentSync(value); }
  async replaceAll(values) {
    const items = clone(values);
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DELETE FROM "${this.table}"`);
      const insert = this.db.prepare(`INSERT INTO "${this.table}" (id, doc) VALUES (?, ?)`);
      for (const item of items) insert.run(String(item[this.key]), JSON.stringify(item));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

// 打开一个 SQLite 数据库连接。dataDir 下生成单个 engine.sqlite 文件，多张表共用一个连接。
// node:sqlite 的 DatabaseSync 是同步 API，静态 import 后本函数即可同步创建连接，
// 使 EngineService 构造函数在默认 SQLite 后端下仍保持同步。
export function openSqliteDatabase(dataDir, fileName = 'engine.sqlite') {
  mkdirSync(dataDir, { recursive: true });
  const db = withSqliteBusyRetry(() => new DatabaseSync(join(dataDir, fileName)));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    withSqliteBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'));
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

let sqliteUowQueue = Promise.resolve();
export class SqliteUnitOfWork {
  constructor(db) { this.db = db; this.depth = 0; }
  async run(work) {
    if (!this.db || this.depth > 0) return work();
    const execute = async () => {
      this.db.exec('BEGIN IMMEDIATE');
      this.depth += 1;
      try {
        const result = await work();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { this.depth -= 1; }
    };
    const next = sqliteUowQueue.then(execute, execute);
    sqliteUowQueue = next.catch(() => {});
    return next;
  }
}

class JsonUnitOfWork {
  async run(work) { return work(); }
}

function ensureMessageIndexes(db) {
  withSqliteBusyRetry(() => db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_conversations_external ON conversations(
      json_extract(doc, '$.connector'), json_extract(doc, '$.kind'), json_extract(doc, '$.externalKey')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_message_physical ON message_logs(
      json_extract(doc, '$.connector'), json_extract(doc, '$.conversationId'), json_extract(doc, '$.externalMessageId')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_message_event_inbound ON message_logs(json_extract(doc, '$.eventId'))
      WHERE json_extract(doc, '$.direction') = 'inbound';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_message_action ON message_logs(json_extract(doc, '$.actionKey'))
      WHERE json_extract(doc, '$.actionKey') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_message_run_link ON message_run_links(
      json_extract(doc, '$.messageId'), json_extract(doc, '$.runId')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_run_event_flow ON runs(
      json_extract(doc, '$.eventId'), json_extract(doc, '$.flowId')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_run_claim_event_flow ON run_claims(
      json_extract(doc, '$.eventId'), json_extract(doc, '$.flowId')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_active_conversation_binding ON conversation_bindings(
      json_extract(doc, '$.conversationId'), json_extract(doc, '$.capability')
    ) WHERE json_extract(doc, '$.active') = 1;
  `));
}

// 兼容旧命名：JsonRepository 等价于 JsonBackend（保留原构造签名 (filePath, key)）。
export class JsonRepository extends JsonBackend {}

class BaseRepository {
  constructor(backend) { this.backend = backend; }
  list(predicate) { return this.backend.list(predicate); }
  listSync(predicate) { return this.backend.listSync ? this.backend.listSync(predicate) : []; }
  get(id) { return this.backend.get(id); }
  getSync(id) { return this.backend.getSync ? this.backend.getSync(id) : null; }
  save(value) { return this.backend.save(value); }
  saveIfAbsent(value) {
    if (this.backend.saveIfAbsent) return this.backend.saveIfAbsent(value);
    return this.get(value[this.backend.key]).then(existing => existing ? { inserted: false, value: existing } : this.save(value).then(saved => ({ inserted: true, value: saved })));
  }
  replaceAll(values) { return this.backend.replaceAll(values); }
}

export class FlowRepository extends BaseRepository {
  async list({ status, includeDeleted = false } = {}) { return this.backend.list(flow => (includeDeleted || flow.status !== 'deleted') && (!status || flow.status === status)); }
}
export class AttachmentRepository extends BaseRepository {}
export class RunRepository extends BaseRepository {
  async listByFlow(flowId) { return (await this.backend.list(run => run.flowId === flowId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  async findByEventFlow(eventId, flowId) { return (await this.backend.list(run => run.eventId === eventId && run.flowId === flowId))[0] ?? null; }
  async unseenFailureCount() { return (await this.backend.list(run => run.status === 'failed' && run.viewedAt === null)).length; }
}

// —— 通用对象仓库（P0-B 任务3 初版，命名中性，去掉「学生交作业」假设）——
// Automation：用户想达成的目标，含状态草稿/启用/暂停/结束/删除。默认列表隐藏 deleted。
export class AutomationRepository extends BaseRepository {
  async list({ status, includeDeleted = false } = {}) { return this.backend.list(item => (includeDeleted || item.status !== 'deleted') && (!status || item.status === status)); }
  async listByAutomation() { return this.backend.list(); }
}
// Resource：联系人、名单、表格、文件夹、业务记录等数据资源；班委作业附件是其一种领域实现。
export class ResourceRepository extends BaseRepository {
  async listByAutomation(automationId) { return this.backend.list(item => item.automationId === automationId); }
  async listByKind(kind) { return this.backend.list(item => item.kind === kind); }
}
// RecordStore：记录表容器（提交记录、台账、订单记录、审核记录）。
export class RecordStoreRepository extends BaseRepository {
  async listByAutomation(automationId) { return this.backend.list(item => item.automationId === automationId); }
  // B-2：按来源附件反查提交记录片段（sourceAttachmentId 由 packEducationAssignment 回填）。
  async findByAttachment(taskAttachmentId) { return (await this.backend.list(item => item.sourceAttachmentId === taskAttachmentId))[0] ?? null; }
}
// EntityDirectory：可被匹配的实体目录（联系人、门店、项目、订单）。
export class EntityDirectoryRepository extends BaseRepository {
  async listByAutomation(automationId) { return this.backend.list(item => item.automationId === automationId); }
  // B-2：按来源附件反查名单目录。
  async findByAttachment(taskAttachmentId) { return (await this.backend.list(item => item.sourceAttachmentId === taskAttachmentId))[0] ?? null; }
}
export class AgentDraftRepository extends BaseRepository {
  async listByConversation(conversationId) { return this.backend.list(item => item.conversationId === conversationId); }
}

// —— P2-M1 消息事实、关联、路由与恢复仓库 ——
export class ConversationRepository extends BaseRepository {
  async findByExternal(connector, kind, externalKey) { return (await this.backend.list(item => item.connector === connector && item.kind === kind && item.externalKey === externalKey))[0] ?? null; }
}
export class ConversationBindingRepository extends BaseRepository {
  async listByConversation(conversationId, { capability, active } = {}) {
    return this.backend.list(item => item.conversationId === conversationId && (!capability || item.capability === capability) && (active === undefined || item.active === active));
  }
}
export class MessageLogRepository extends BaseRepository {
  save(value) { validateMessage(value); return super.save(value); }
  saveIfAbsent(value) { validateMessage(value); return super.saveIfAbsent(value); }
  async findByEvent(eventId) { return this.backend.list(item => item.eventId === eventId); }
  async findByExternal(connector, conversationId, externalMessageId) { return (await this.backend.list(item => item.connector === connector && item.conversationId === conversationId && item.externalMessageId === externalMessageId))[0] ?? null; }
  async listByConversation(conversationId) { return (await this.backend.list(item => item.conversationId === conversationId)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.messageId.localeCompare(b.messageId)); }
}
export class MessageRunLinkRepository extends BaseRepository {
  async listByMessage(messageId) { return this.backend.list(item => item.messageId === messageId); }
  async listByRun(runId) { return this.backend.list(item => item.runId === runId); }
}
export class EventClaimRepository extends BaseRepository {}
export class RunClaimRepository extends BaseRepository {
  async listByEvent(eventId) { return this.backend.list(item => item.eventId === eventId); }
}
export class ActionClaimRepository extends BaseRepository {
  async listByRun(runId) { return (await this.backend.list(item => item.runId === runId)).sort((a, b) => a.actionIndex - b.actionIndex); }
}
export class EffectRepository extends BaseRepository {
  async listByRun(runId) { return (await this.backend.list(item => item.runId === runId)).sort((a, b) => a.actionIndex - b.actionIndex); }
}
export class OutboxRepository extends BaseRepository {
  async listByRun(runId) { return this.backend.list(item => item.runId === runId); }
}
export class MigrationRepository extends BaseRepository {}

// 后端工厂：按 kind 为核心表创建对应仓库实例。
// 完全同步，无异步依赖：
// - kind 'sqlite'（默认）：未传 db 时用 dataDir 自动打开 engine.sqlite。
// - kind 'json'：保持原有文件布局，供回归对照与回退。
export function createRepositories({ kind = 'sqlite', dataDir, db } = {}) {
  if (kind === 'sqlite') {
    const database = db ?? openSqliteDatabase(dataDir);
    const repositories = {
      db: database,
      unitOfWork: new SqliteUnitOfWork(database),
      flows: new FlowRepository(new SqliteBackend(database, 'flows', 'flowId')),
      attachments: new AttachmentRepository(new SqliteBackend(database, 'attachments', 'taskAttachmentId')),
      runs: new RunRepository(new SqliteBackend(database, 'runs', 'runId')),
      automations: new AutomationRepository(new SqliteBackend(database, 'automations', 'automationId')),
      resources: new ResourceRepository(new SqliteBackend(database, 'resources', 'resourceId')),
      recordStores: new RecordStoreRepository(new SqliteBackend(database, 'record_stores', 'recordStoreId')),
      entityDirectories: new EntityDirectoryRepository(new SqliteBackend(database, 'entity_directories', 'entityDirectoryId')),
      agentDrafts: new AgentDraftRepository(new SqliteBackend(database, 'agent_drafts', 'draftId')),
      conversations: new ConversationRepository(new SqliteBackend(database, 'conversations', 'conversationId')),
      conversationBindings: new ConversationBindingRepository(new SqliteBackend(database, 'conversation_bindings', 'bindingId')),
      messageLogs: new MessageLogRepository(new SqliteBackend(database, 'message_logs', 'messageId')),
      messageRunLinks: new MessageRunLinkRepository(new SqliteBackend(database, 'message_run_links', 'linkId')),
      eventClaims: new EventClaimRepository(new SqliteBackend(database, 'event_claims', 'eventId')),
      runClaims: new RunClaimRepository(new SqliteBackend(database, 'run_claims', 'claimId')),
      actionClaims: new ActionClaimRepository(new SqliteBackend(database, 'action_claims', 'actionKey')),
      effects: new EffectRepository(new SqliteBackend(database, 'effects', 'effectKey')),
      outbox: new OutboxRepository(new SqliteBackend(database, 'outbox', 'actionKey')),
      migrations: new MigrationRepository(new SqliteBackend(database, 'migrations', 'migrationId'))
    };
    ensureMessageIndexes(database);
    return repositories;
  }
  return {
    db: null,
    unitOfWork: new JsonUnitOfWork(),
    flows: new FlowRepository(new JsonBackend(join(dataDir, 'flows.json'), 'flowId')),
    attachments: new AttachmentRepository(new JsonBackend(join(dataDir, 'attachments.json'), 'taskAttachmentId')),
    runs: new RunRepository(new JsonBackend(join(dataDir, 'runs.json'), 'runId')),
    automations: new AutomationRepository(new JsonBackend(join(dataDir, 'automations.json'), 'automationId')),
    resources: new ResourceRepository(new JsonBackend(join(dataDir, 'resources.json'), 'resourceId')),
    recordStores: new RecordStoreRepository(new JsonBackend(join(dataDir, 'record_stores.json'), 'recordStoreId')),
    entityDirectories: new EntityDirectoryRepository(new JsonBackend(join(dataDir, 'entity_directories.json'), 'entityDirectoryId')),
    agentDrafts: new AgentDraftRepository(new JsonBackend(join(dataDir, 'agent_drafts.json'), 'draftId')),
    conversations: new ConversationRepository(new JsonBackend(join(dataDir, 'conversations.json'), 'conversationId')),
    conversationBindings: new ConversationBindingRepository(new JsonBackend(join(dataDir, 'conversation_bindings.json'), 'bindingId')),
    messageLogs: new MessageLogRepository(new JsonBackend(join(dataDir, 'message_logs.json'), 'messageId')),
    messageRunLinks: new MessageRunLinkRepository(new JsonBackend(join(dataDir, 'message_run_links.json'), 'linkId')),
    eventClaims: new EventClaimRepository(new JsonBackend(join(dataDir, 'event_claims.json'), 'eventId')),
    runClaims: new RunClaimRepository(new JsonBackend(join(dataDir, 'run_claims.json'), 'claimId')),
    actionClaims: new ActionClaimRepository(new JsonBackend(join(dataDir, 'action_claims.json'), 'actionKey')),
    effects: new EffectRepository(new JsonBackend(join(dataDir, 'effects.json'), 'effectKey')),
    outbox: new OutboxRepository(new JsonBackend(join(dataDir, 'outbox.json'), 'actionKey')),
    migrations: new MigrationRepository(new JsonBackend(join(dataDir, 'migrations.json'), 'migrationId'))
  };
}
