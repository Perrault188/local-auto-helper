import { randomUUID } from 'node:crypto';

// 协议版本：彻底档（A2）升到 0.3-rc1（字段按能力必填、remind 独立 remindAt、能力片段化）。
// 校验层同时接受历史 0.2-rc1 数据与新建 0.3-rc1 数据，保证升版本后旧数据可读、现有测试不破。
export const VERSION = '0.3-rc1';
export const EVENT_VERSION = '0.4-rc1';
export const FLOW_VERSION = '0.4-rc1';
export const RUN_VERSION = '0.4-rc1';
export const SUPPORTED_VERSIONS = ['0.2-rc1', '0.3-rc1'];
export const isSupportedVersion = value => SUPPORTED_VERSIONS.includes(value);
export const isSupportedEventVersion = value => [...SUPPORTED_VERSIONS, EVENT_VERSION].includes(value);
export const isSupportedFlowVersion = value => [...SUPPORTED_VERSIONS, FLOW_VERSION].includes(value);
export const clone = value => structuredClone(value);
export const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export function assert(condition, message, code = 'ACTION_INPUT_INVALID') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    error.recoverable = true;
    throw error;
  }
}

export function errorRecord(error) {
  const allowed = new Set(['PERSON_NOT_FOUND', 'ATTACHMENT_NOT_FOUND', 'FILE_NOT_FOUND', 'HOOK_INPUT_INVALID', 'ACTION_INPUT_INVALID', 'ADAPTER_ERROR', 'DELIVERY_OUTCOME_UNKNOWN']);
  return {
    code: allowed.has(error.code) ? error.code : 'ADAPTER_ERROR',
    message: error.message || '本地适配器执行失败',
    recoverable: error.recoverable ?? true
  };
}

export function isRfc3339(value) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}
