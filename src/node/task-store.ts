import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';
import { redactSensitiveText } from '../shared/security.js';
import { atomicWriteFile, withFileLock } from '../shared/state-io.js';

export const TASK_STORE_SCHEMA_VERSION = 1 as const;
export const TASK_ID_PATTERN = /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/;
export const TASK_STATES = [
  'ACCEPTED', 'PREPARING', 'RUNNING', 'INPUT_REQUIRED', 'AMBIGUOUS',
  'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'];

const MAX_DEPTH = 8;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_OPERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type TaskRepoContext = {
  canonicalRepo: string;
  repoPath: string;
  worktreeBranch: string;
  baseSha: string;
  leaseId: string;
};

export type TaskSummary = {
  status: string;
  isShareSafe: true;
};

export type ReachTaskRecord = {
  schemaVersion: typeof TASK_STORE_SCHEMA_VERSION;
  taskId: string;
  rootTaskId: string;
  parentTaskId: string | null;
  taskDepth: number;
  lineageIndex: number;
  actorId: string;
  nodeId: string;
  operation: string;
  safetyClass?: string;
  mutationLevel?: string;
  state: TaskState;
  attemptNumber: number;
  attemptBudget: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  idempotencyKey: string;
  payloadSha256: string;
  policyHash?: string;
  resultRef?: string;
  resultHash?: string;
  failureClass?: string;
  repoContext?: TaskRepoContext;
  summary: TaskSummary;
  archivedAtUtc?: string;
};

export type TaskCreateInput = {
  /** Used only by recovery/import callers; normal creation lets the node generate the identity. */
  taskId?: string;
  actorId: string;
  nodeId: string;
  operation: string;
  idempotencyKey: string;
  payloadSha256: string;
  policyHash?: string;
  parentTaskId?: string | null;
  rootTaskId?: string;
  taskDepth?: number;
  attemptBudget?: number;
  safetyClass?: string;
  mutationLevel?: string;
  repoContext?: TaskRepoContext;
};

export type TaskUpdate = {
  state?: TaskState;
  status?: string;
  resultRef?: string | null;
  resultHash?: string | null;
  failureClass?: string | null;
};

export type TaskQuery = {
  taskId?: string;
  rootTaskId?: string;
  state?: TaskState;
  nodeId?: string;
  actorId?: string;
  idempotencyKey?: string;
  updatedAfter?: string;
  includeArchived?: boolean;
};

type TaskIndex = {
  byTaskId: Record<string, 'active' | 'archive'>;
  byRootTaskId: Record<string, string[]>;
  byState: Record<TaskState, string[]>;
  byNodeId: Record<string, string[]>;
  byActorId: Record<string, string[]>;
  byIdempotencyKey: Record<string, string[]>;
  byUpdatedAt: Array<{ taskId: string; updatedAtUtc: string }>;
};

type TaskStoreDocument = {
  schemaVersion: typeof TASK_STORE_SCHEMA_VERSION;
  records: Record<string, ReachTaskRecord>;
  archived: Record<string, ReachTaskRecord>;
  index: TaskIndex;
  updatedAtUtc: string;
};

export class TaskStoreCorruptError extends Error {
  constructor(message: string) {
    super(`task store is corrupt; refusing mutation: ${message}`);
    this.name = 'TaskStoreCorruptError';
  }
}

export class TaskStoreVersionError extends Error {
  constructor(version: unknown) {
    super(`unsupported task store schema version ${String(version)}; no silent migration is available`);
    this.name = 'TaskStoreVersionError';
  }
}

export interface TaskStore {
  create(input: TaskCreateInput): Promise<ReachTaskRecord>;
  read(taskId: string): Promise<ReachTaskRecord | null>;
  update(taskId: string, update: TaskUpdate): Promise<ReachTaskRecord>;
  transition(taskId: string, state: TaskState, status?: string): Promise<ReachTaskRecord>;
  list(query?: TaskQuery): Promise<ReachTaskRecord[]>;
  loadActiveTasks(): Promise<ReachTaskRecord[]>;
  archive(taskId: string): Promise<ReachTaskRecord>;
  sweep(options?: { now?: Date; terminalRetentionMs?: number; archiveRetentionMs?: number }): Promise<{ archived: number; deleted: number }>;
}

export function taskStoreDir(dir = stateDir()): string { return path.join(dir, 'tasks'); }
export function taskStoreFile(dir = stateDir()): string { return path.join(taskStoreDir(dir), 'store.json'); }
export function taskStoreLockFile(dir = stateDir()): string { return path.join(taskStoreDir(dir), 'store.lock'); }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

function assertTaskId(value: string): void {
  if (!TASK_ID_PATTERN.test(value)) throw new Error('invalid task id');
}

function assertSafe(value: string, label: string, pattern = SAFE_ID): void {
  if (!pattern.test(value)) throw new Error(`invalid ${label}`);
}

function assertRepoContext(value: TaskRepoContext | undefined): void {
  if (!value) return;
  if (!value.repoPath || !path.isAbsolute(value.repoPath)) throw new Error('repoContext.repoPath must be absolute');
  if (!value.canonicalRepo || value.canonicalRepo.length > 160) throw new Error('invalid repoContext.canonicalRepo');
  if (!value.worktreeBranch || value.worktreeBranch.length > 200 || value.worktreeBranch.includes('..')) throw new Error('invalid repoContext.worktreeBranch');
  if (!/^[0-9a-f]{7,128}$/i.test(value.baseSha)) throw new Error('invalid repoContext.baseSha');
  assertSafe(value.leaseId, 'repoContext.leaseId');
}

function shareSafeStatus(value: string): string {
  return redactSensitiveText(value).slice(0, 240);
}

function assertTimestamp(value: string, label: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new TaskStoreCorruptError(`invalid ${label}`);
}

function validateRecord(value: unknown, location: string): ReachTaskRecord {
  if (!value || typeof value !== 'object') throw new TaskStoreCorruptError(`${location} is not an object`);
  const record = value as Partial<ReachTaskRecord>;
  if (record.schemaVersion !== TASK_STORE_SCHEMA_VERSION) throw new TaskStoreVersionError(record.schemaVersion);
  if (typeof record.taskId !== 'string') throw new TaskStoreCorruptError(`${location}.taskId is missing`);
  assertTaskId(record.taskId);
  if (typeof record.rootTaskId !== 'string') throw new TaskStoreCorruptError(`${location}.rootTaskId is missing`);
  assertTaskId(record.rootTaskId);
  if (record.parentTaskId !== null && typeof record.parentTaskId !== 'string') throw new TaskStoreCorruptError(`${location}.parentTaskId is invalid`);
  if (record.parentTaskId) assertTaskId(record.parentTaskId);
  if (!Number.isInteger(record.taskDepth) || record.taskDepth! < 0 || record.taskDepth! > MAX_DEPTH) throw new TaskStoreCorruptError(`${location}.taskDepth is invalid`);
  if (!Number.isInteger(record.lineageIndex) || record.lineageIndex! < 0) throw new TaskStoreCorruptError(`${location}.lineageIndex is invalid`);
  if (typeof record.actorId !== 'string') throw new TaskStoreCorruptError(`${location}.actorId is missing`);
  if (typeof record.nodeId !== 'string') throw new TaskStoreCorruptError(`${location}.nodeId is missing`);
  assertSafe(record.actorId, `${location}.actorId`);
  assertSafe(record.nodeId, `${location}.nodeId`);
  if (typeof record.operation !== 'string') throw new TaskStoreCorruptError(`${location}.operation is missing`);
  assertSafe(record.operation, `${location}.operation`, SAFE_OPERATION);
  if (!TASK_STATES.includes(record.state as TaskState)) throw new TaskStoreCorruptError(`${location}.state is invalid`);
  const attemptBudget = record.attemptBudget;
  if (record.attemptNumber !== 1 || typeof attemptBudget !== 'number' || !Number.isInteger(attemptBudget) || attemptBudget < 1 || attemptBudget > 100) {
    throw new TaskStoreCorruptError(`${location}.attempt budget is invalid for C2`);
  }
  if (typeof record.idempotencyKey !== 'string') throw new TaskStoreCorruptError(`${location}.idempotencyKey is missing`);
  assertSafe(record.idempotencyKey, `${location}.idempotencyKey`);
  if (typeof record.payloadSha256 !== 'string' || !HASH_PATTERN.test(record.payloadSha256)) throw new TaskStoreCorruptError(`${location}.payloadSha256 is invalid`);
  for (const [value, label] of [[record.policyHash, 'policyHash'], [record.resultHash, 'resultHash']] as const) {
    if (value !== undefined && (typeof value !== 'string' || !HASH_PATTERN.test(value))) throw new TaskStoreCorruptError(`${location}.${label} is invalid`);
  }
  if (record.resultRef !== undefined) assertSafe(record.resultRef, `${location}.resultRef`);
  if (record.failureClass !== undefined) assertSafe(record.failureClass, `${location}.failureClass`);
  assertTimestamp(record.createdAtUtc!, `${location}.createdAtUtc`);
  assertTimestamp(record.updatedAtUtc!, `${location}.updatedAtUtc`);
  if (!record.summary || record.summary.isShareSafe !== true || typeof record.summary.status !== 'string' || record.summary.status.length > 240) {
    throw new TaskStoreCorruptError(`${location}.summary is not share-safe`);
  }
  assertRepoContext(record.repoContext);
  if (record.archivedAtUtc !== undefined) assertTimestamp(record.archivedAtUtc, `${location}.archivedAtUtc`);
  return clone(record as ReachTaskRecord);
}

function emptyIndex(): TaskIndex {
  const byState = {} as TaskIndex['byState'];
  for (const state of TASK_STATES) byState[state] = [];
  return { byTaskId: {}, byRootTaskId: {}, byState, byNodeId: {}, byActorId: {}, byIdempotencyKey: {}, byUpdatedAt: [] };
}

function addIndex(index: TaskIndex, record: ReachTaskRecord, location: 'active' | 'archive'): void {
  index.byTaskId[record.taskId] = location;
  for (const [map, key] of [[index.byRootTaskId, record.rootTaskId], [index.byNodeId, record.nodeId], [index.byActorId, record.actorId], [index.byIdempotencyKey, record.idempotencyKey]] as const) {
    (map[key] ??= []).push(record.taskId);
  }
  index.byState[record.state].push(record.taskId);
  index.byUpdatedAt.push({ taskId: record.taskId, updatedAtUtc: record.updatedAtUtc });
}

function buildIndex(records: Record<string, ReachTaskRecord>, archived: Record<string, ReachTaskRecord>): TaskIndex {
  const index = emptyIndex();
  for (const record of Object.values(records)) addIndex(index, record, 'active');
  for (const record of Object.values(archived)) addIndex(index, record, 'archive');
  for (const values of [index.byRootTaskId, index.byNodeId, index.byActorId, index.byIdempotencyKey, index.byState]) {
    for (const value of Object.values(values)) value.sort();
  }
  index.byUpdatedAt.sort((a, b) => a.updatedAtUtc.localeCompare(b.updatedAtUtc) || a.taskId.localeCompare(b.taskId));
  return index;
}

function emptyDocument(): TaskStoreDocument {
  return { schemaVersion: TASK_STORE_SCHEMA_VERSION, records: {}, archived: {}, index: emptyIndex(), updatedAtUtc: new Date(0).toISOString() };
}

function assertIndexMatches(document: TaskStoreDocument): void {
  if (JSON.stringify(document.index) !== JSON.stringify(buildIndex(document.records, document.archived))) {
    throw new TaskStoreCorruptError('stored indexes do not match task records');
  }
}

function normalizeDocument(raw: unknown, compatibilityMode: boolean): TaskStoreDocument {
  if (!raw || typeof raw !== 'object') throw new TaskStoreCorruptError('document is not an object');
  const source = raw as Partial<TaskStoreDocument> & { schemaVersion?: unknown };
  if (source.schemaVersion !== TASK_STORE_SCHEMA_VERSION) {
    if (typeof source.schemaVersion === 'number' && source.schemaVersion < TASK_STORE_SCHEMA_VERSION && compatibilityMode) {
      const legacyRecords = source.records && typeof source.records === 'object' ? source.records : {};
      const legacyArchived = source.archived && typeof source.archived === 'object' ? source.archived : {};
      const records = Object.fromEntries(Object.entries(legacyRecords).map(([id, value]) => [id, validateRecord({ ...(value as object), schemaVersion: TASK_STORE_SCHEMA_VERSION }, `records.${id}`)]));
      const archived = Object.fromEntries(Object.entries(legacyArchived).map(([id, value]) => [id, validateRecord({ ...(value as object), schemaVersion: TASK_STORE_SCHEMA_VERSION }, `archived.${id}`)]));
      return { schemaVersion: TASK_STORE_SCHEMA_VERSION, records, archived, index: buildIndex(records, archived), updatedAtUtc: new Date().toISOString() };
    }
    throw new TaskStoreVersionError(source.schemaVersion);
  }
  if (!source.records || typeof source.records !== 'object' || !source.archived || typeof source.archived !== 'object' || !source.index || typeof source.index !== 'object') {
    throw new TaskStoreCorruptError('missing records, archive, or index');
  }
  const records = Object.fromEntries(Object.entries(source.records).map(([id, value]) => {
    const record = validateRecord(value, `records.${id}`);
    if (record.taskId !== id) throw new TaskStoreCorruptError(`records.${id} key does not match taskId`);
    if (record.archivedAtUtc) throw new TaskStoreCorruptError(`active record ${id} is archived`);
    return [id, record];
  }));
  const archived = Object.fromEntries(Object.entries(source.archived).map(([id, value]) => {
    const record = validateRecord(value, `archived.${id}`);
    if (record.taskId !== id || !record.archivedAtUtc || !isTerminal(record.state)) throw new TaskStoreCorruptError(`archive record ${id} is invalid`);
    return [id, record];
  }));
  const document = { schemaVersion: TASK_STORE_SCHEMA_VERSION, records, archived, index: source.index as TaskIndex, updatedAtUtc: typeof source.updatedAtUtc === 'string' ? source.updatedAtUtc : '' };
  assertTimestamp(document.updatedAtUtc, 'document.updatedAtUtc');
  assertIndexMatches(document);
  return document;
}

function legalTransition(from: TaskState, to: TaskState): boolean {
  const allowed: Record<TaskState, readonly TaskState[]> = {
    ACCEPTED: ['PREPARING', 'CANCELLED'],
    PREPARING: ['RUNNING', 'CANCELLED', 'FAILED'],
    RUNNING: ['INPUT_REQUIRED', 'AMBIGUOUS', 'COMPLETED', 'FAILED', 'CANCELLED'],
    INPUT_REQUIRED: ['RUNNING', 'CANCELLED'],
    AMBIGUOUS: ['RECONCILED', 'CANCELLED'],
    COMPLETED: [], FAILED: [], CANCELLED: [], RECONCILED: []
  };
  return allowed[from].includes(to);
}

export class NodeTaskStore implements TaskStore {
  constructor(private readonly dir = stateDir(), private readonly compatibilityMode = false) {}

  private async readDocument(): Promise<TaskStoreDocument> {
    let raw: string;
    try { raw = await fs.readFile(taskStoreFile(this.dir), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
      throw error;
    }
    try { return normalizeDocument(JSON.parse(raw) as unknown, this.compatibilityMode); }
    catch (error) {
      if (error instanceof TaskStoreCorruptError || error instanceof TaskStoreVersionError) throw error;
      throw new TaskStoreCorruptError(error instanceof Error ? error.message : String(error));
    }
  }

  private async mutate<T>(fn: (document: TaskStoreDocument) => T): Promise<T> {
    if (this.compatibilityMode) throw new Error('task store compatibility mode is read-only');
    return withFileLock(taskStoreLockFile(this.dir), async () => {
      const document = await this.readDocument();
      const result = fn(document);
      document.index = buildIndex(document.records, document.archived);
      document.updatedAtUtc = new Date().toISOString();
      await atomicWriteFile(taskStoreFile(this.dir), JSON.stringify(document, null, 2) + '\n', 0o600);
      // The caller must not receive a task handle until the committed snapshot is readable again.
      await this.readDocument();
      return clone(result);
    });
  }

  async create(input: TaskCreateInput): Promise<ReachTaskRecord> {
    const taskId = input.taskId ?? `rtsk_${Date.now().toString(16)}_${crypto.randomBytes(16).toString('hex')}`;
    assertTaskId(taskId);
    assertSafe(input.actorId, 'actorId');
    assertSafe(input.nodeId, 'nodeId');
    assertSafe(input.operation, 'operation', SAFE_OPERATION);
    assertSafe(input.idempotencyKey, 'idempotencyKey');
    if (!HASH_PATTERN.test(input.payloadSha256)) throw new Error('payloadSha256 must be a SHA-256 hash');
    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId) assertTaskId(parentTaskId);
    const now = new Date().toISOString();
    return this.mutate(document => {
      const existing = document.records[taskId] ?? document.archived[taskId];
      if (existing) {
        const sameBinding = existing.actorId === input.actorId
          && existing.nodeId === input.nodeId
          && existing.operation === input.operation
          && existing.idempotencyKey === input.idempotencyKey
          && existing.payloadSha256 === input.payloadSha256;
        throw new Error(sameBinding
          ? `task identity already exists; use read instead: ${taskId}`
          : `task identity has conflicting binding: ${taskId}`);
      }
      const parent = parentTaskId ? document.records[parentTaskId] ?? document.archived[parentTaskId] : undefined;
      if (parentTaskId && !parent) throw new Error(`parent task not found: ${parentTaskId}`);
      const rootTaskId = input.rootTaskId ?? parent?.rootTaskId ?? taskId;
      assertTaskId(rootTaskId);
      const taskDepth = input.taskDepth ?? (parent ? parent.taskDepth + 1 : 0);
      if (!Number.isInteger(taskDepth) || taskDepth < 0 || taskDepth > MAX_DEPTH) throw new Error(`task depth must be between 0 and ${MAX_DEPTH}`);
      if (parent && rootTaskId !== parent.rootTaskId) throw new Error('child task rootTaskId must match its parent lineage');
      if (parent && taskDepth !== parent.taskDepth + 1) throw new Error('child task depth must be parent depth + 1');
      const lineageIndex = Object.values({ ...document.records, ...document.archived }).filter(record => record.parentTaskId === parentTaskId).length;
      const record: ReachTaskRecord = {
        schemaVersion: TASK_STORE_SCHEMA_VERSION, taskId, rootTaskId, parentTaskId, taskDepth, lineageIndex,
        actorId: input.actorId, nodeId: input.nodeId, operation: input.operation,
        ...(input.safetyClass ? { safetyClass: input.safetyClass } : {}),
        ...(input.mutationLevel ? { mutationLevel: input.mutationLevel } : {}),
        state: 'ACCEPTED', attemptNumber: 1, attemptBudget: input.attemptBudget ?? 1,
        createdAtUtc: now, updatedAtUtc: now, idempotencyKey: input.idempotencyKey,
        payloadSha256: input.payloadSha256, ...(input.repoContext ? { repoContext: clone(input.repoContext) } : {}),
        ...(input.policyHash ? { policyHash: input.policyHash } : {}),
        summary: { status: 'Task accepted and durably persisted on node storage.', isShareSafe: true }
      };
      validateRecord(record, `records.${taskId}`);
      document.records[taskId] = record;
      return record;
    });
  }

  async read(taskId: string): Promise<ReachTaskRecord | null> {
    assertTaskId(taskId);
    const document = await this.readDocument();
    return clone(document.records[taskId] ?? document.archived[taskId] ?? null);
  }

  async update(taskId: string, update: TaskUpdate): Promise<ReachTaskRecord> {
    assertTaskId(taskId);
    if (update.status === undefined && update.resultRef === undefined && update.resultHash === undefined && update.failureClass === undefined) throw new Error('task update requires state, status, or outcome metadata');
    if (update.status !== undefined && update.status.length > 240) throw new Error('task status is too long');
    return this.mutate(document => {
      const record = document.records[taskId];
      if (!record) {
        if (document.archived[taskId]) throw new Error(`task is archived and immutable: ${taskId}`);
        throw new Error(`task not found: ${taskId}`);
      }
      if (update.state !== undefined) {
        if (!legalTransition(record.state, update.state)) throw new Error(`illegal task transition ${record.state} -> ${update.state}`);
        record.state = update.state;
        record.summary = { status: shareSafeStatus(update.status || `Task ${update.state.toLowerCase()}.`), isShareSafe: true };
      } else if (update.status !== undefined) {
        record.summary = { status: shareSafeStatus(update.status), isShareSafe: true };
      }
      if (update.resultRef !== undefined) {
        if (update.resultRef !== null) assertSafe(update.resultRef, 'resultRef');
        if (update.resultRef === null) delete record.resultRef; else record.resultRef = update.resultRef;
      }
      if (update.resultHash !== undefined) {
        if (update.resultHash !== null && !HASH_PATTERN.test(update.resultHash)) throw new Error('resultHash must be a SHA-256 hash');
        if (update.resultHash === null) delete record.resultHash; else record.resultHash = update.resultHash;
      }
      if (update.failureClass !== undefined) {
        if (update.failureClass !== null) assertSafe(update.failureClass, 'failureClass');
        if (update.failureClass === null) delete record.failureClass; else record.failureClass = update.failureClass;
      }
      record.updatedAtUtc = new Date().toISOString();
      return record;
    });
  }

  async transition(taskId: string, state: TaskState, status?: string): Promise<ReachTaskRecord> {
    assertTaskId(taskId);
    if (!TASK_STATES.includes(state)) throw new Error(`invalid task state: ${state}`);
    return this.mutate(document => {
      const record = document.records[taskId];
      if (!record) {
        if (document.archived[taskId]) throw new Error(`task is archived and immutable: ${taskId}`);
        throw new Error(`task not found: ${taskId}`);
      }
      if (!legalTransition(record.state, state)) throw new Error(`illegal task transition ${record.state} -> ${state}`);
      record.state = state;
      record.updatedAtUtc = new Date().toISOString();
      record.summary = { status: shareSafeStatus(status || `Task ${state.toLowerCase()}.`), isShareSafe: true };
      return record;
    });
  }

  async list(query: TaskQuery = {}): Promise<ReachTaskRecord[]> {
    if (query.taskId) assertTaskId(query.taskId);
    if (query.rootTaskId) assertTaskId(query.rootTaskId);
    if (query.nodeId) assertSafe(query.nodeId, 'nodeId');
    if (query.actorId) assertSafe(query.actorId, 'actorId');
    if (query.idempotencyKey) assertSafe(query.idempotencyKey, 'idempotencyKey');
    if (query.updatedAfter && !Number.isFinite(Date.parse(query.updatedAfter))) throw new Error('updatedAfter must be an ISO timestamp');
    const document = await this.readDocument();
    const candidates = new Set<string>(query.taskId ? [query.taskId] : document.index.byUpdatedAt.map(entry => entry.taskId));
    const applyIndex = (ids: readonly string[] | undefined) => {
      if (!ids) { candidates.clear(); return; }
      const allowed = new Set(ids);
      for (const id of candidates) if (!allowed.has(id)) candidates.delete(id);
    };
    if (query.rootTaskId) applyIndex(document.index.byRootTaskId[query.rootTaskId]);
    if (query.state) applyIndex(document.index.byState[query.state]);
    if (query.nodeId) applyIndex(document.index.byNodeId[query.nodeId]);
    if (query.actorId) applyIndex(document.index.byActorId[query.actorId]);
    if (query.idempotencyKey) applyIndex(document.index.byIdempotencyKey[query.idempotencyKey]);
    const output = [...candidates].flatMap(id => {
      const record = document.records[id] ?? (query.includeArchived ? document.archived[id] : undefined);
      if (!record || (record.archivedAtUtc && !query.includeArchived)) return [];
      if (query.updatedAfter && record.updatedAtUtc <= query.updatedAfter) return [];
      return [clone(record)];
    });
    return output.sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc) || a.taskId.localeCompare(b.taskId));
  }

  async loadActiveTasks(): Promise<ReachTaskRecord[]> {
    const document = await this.readDocument();
    return Object.values(document.records).filter(record => !isTerminal(record.state)).map(clone);
  }

  async archive(taskId: string): Promise<ReachTaskRecord> {
    assertTaskId(taskId);
    return this.mutate(document => {
      const record = document.records[taskId];
      if (!record) throw new Error(`task not found or already archived: ${taskId}`);
      if (!isTerminal(record.state)) throw new Error('only terminal tasks can be archived');
      const archived = { ...record, archivedAtUtc: new Date().toISOString() };
      document.archived[taskId] = archived;
      delete document.records[taskId];
      return archived;
    });
  }

  async sweep(options: { now?: Date; terminalRetentionMs?: number; archiveRetentionMs?: number } = {}): Promise<{ archived: number; deleted: number }> {
    const now = (options.now ?? new Date()).getTime();
    const terminalRetentionMs = options.terminalRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    const archiveRetentionMs = options.archiveRetentionMs ?? 90 * 24 * 60 * 60 * 1000;
    if (terminalRetentionMs < 0 || archiveRetentionMs < 0) throw new Error('retention windows cannot be negative');
    return this.mutate(document => {
      let archived = 0;
      let deleted = 0;
      for (const [id, record] of Object.entries(document.records)) {
        if (isTerminal(record.state) && now - Date.parse(record.updatedAtUtc) >= terminalRetentionMs) {
          document.archived[id] = { ...record, archivedAtUtc: new Date(now).toISOString() };
          delete document.records[id]; archived += 1;
        }
      }
      for (const [id, record] of Object.entries(document.archived)) {
        if (record.archivedAtUtc && now - Date.parse(record.archivedAtUtc) >= archiveRetentionMs) {
          delete document.archived[id]; deleted += 1;
        }
      }
      return { archived, deleted };
    });
  }
}
