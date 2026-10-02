import { createHash } from 'node:crypto';
import { VERSION } from './utils.mjs';

const asTime = value => {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(milliseconds)) throw new Error(`调度时钟非法：${value}`);
  return milliseconds;
};

export function scheduledEventId(flowId, runAt) {
  const digest = createHash('sha256').update(`${flowId}\0${runAt}`).digest('hex').slice(0, 24);
  return `event_schedule_${digest}`;
}

// P1-C：Flow 是计划权威源，Run 是执行事实源。
// 调度器不保存第二份计划，只扫描 enabled scheduled Flow，并用已有 Run 判断是否已经执行。
export class FlowScheduler {
  constructor({ flows, runs, dispatch, clock = () => new Date(), intervalMs = 1000, enqueue } = {}) {
    Object.assign(this, { flows, runs, dispatch, clock, intervalMs });
    this.enqueue = enqueue ?? (task => task());
    this.timer = null;
    this.pendingTick = null;
  }

  async tick(at = this.clock()) {
    if (this.pendingTick) return this.pendingTick;
    this.pendingTick = this.#tick(at).finally(() => { this.pendingTick = null; });
    return this.pendingTick;
  }

  async #tick(at) {
    const dueAt = asTime(at);
    const flows = await this.flows.list({ status: 'enabled' });
    const candidates = flows
      .filter(flow => flow.hook?.type === 'scheduled' && asTime(flow.hook.params.runAt) <= dueAt)
      .sort((a, b) => asTime(a.hook.params.runAt) - asTime(b.hook.params.runAt) || a.flowId.localeCompare(b.flowId));
    const results = [];
    for (const candidate of candidates) {
      const outcome = await this.enqueue(async () => {
        // HTTP 写操作与 tick 可能排队等待。执行前重读，确保暂停、删除或改时点立即生效。
        const flow = await this.flows.get(candidate.flowId);
        if (!flow || flow.status !== 'enabled' || flow.hook?.type !== 'scheduled') return null;
        if (asTime(flow.hook.params.runAt) > dueAt) return null;
        // 一次性语义：该 Flow 已产生任何 Run 后，编辑 runAt 也不再次自动执行。
        if ((await this.runs.listByFlow(flow.flowId)).length > 0) return null;
        const occurredAt = new Date(dueAt).toISOString();
        const event = {
          schemaVersion: VERSION,
          eventId: scheduledEventId(flow.flowId, flow.hook.params.runAt),
          type: 'timer_fired',
          occurredAt,
          payload: { scheduledFor: flow.hook.params.runAt, timezone: flow.hook.params.timezone }
        };
        return this.dispatch(event);
      });
      if (outcome) results.push(...outcome);
    }
    return results;
  }

  start({ enqueue } = {}) {
    if (enqueue) this.enqueue = enqueue;
    if (this.timer) return;
    const run = () => { this.tick().catch(error => console.warn(`[scheduler] 调度扫描失败：${error?.message ?? error}`)); };
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
