/**
 * 值班窗口（浏览器标签页）身份与探活。
 *
 * 多个窗口同时登记时，每个窗口持有一个 agentId 并定时写心跳（IndexedDB）。
 * 窗口间用 BroadcastChannel 互发心跳 / 下线消息；不支持时退化为账本扫描兜底：
 * 心跳超过 AGENT_TIMEOUT_MS 未更新即视为失联，其名下生效租约失效释放。
 */

const AGENT_KEY = 'gbfishport:agent-id';
const HEARTBEAT_CHANNEL = 'gbfishport:agents';
/** 心跳间隔 */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** 超过该时长没有心跳即判定窗口失联 */
export const AGENT_TIMEOUT_MS = 15000;

function randomAgentId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前窗口 id：同标签页内稳定（sessionStorage），关闭即销毁 */
export function currentAgentId(): string {
  try {
    let id = sessionStorage.getItem(AGENT_KEY);
    if (!id) {
      id = randomAgentId();
      sessionStorage.setItem(AGENT_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage 不可用时退化为内存 id（刷新即换）
    if (!fallbackId) fallbackId = randomAgentId();
    return fallbackId;
  }
}

let fallbackId = '';

export type AgentSignal =
  | { kind: 'heartbeat'; agentId: string; at: string }
  | { kind: 'offline'; agentId: string; at: string }
  | { kind: 'ledger-changed'; agentId: string; portId: string; at: string };

let channel: BroadcastChannel | null = null;

/** 打开跨窗口消息通道；不支持 BroadcastChannel 时返回 null（扫描兜底仍生效） */
export function openAgentChannel(onSignal: (signal: AgentSignal) => void): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(HEARTBEAT_CHANNEL);
  channel.onmessage = (event: MessageEvent<AgentSignal>) => {
    if (event.data && typeof event.data === 'object') onSignal(event.data);
  };
  return channel;
}

export function postAgentSignal(signal: AgentSignal): void {
  try {
    channel?.postMessage(signal);
  } catch {
    // 忽略
  }
}

/** 本窗口成功抢占 / 释放 / 排队 / 维修后广播：其他窗口立即对齐账本 */
export function notifyLedgerChanged(portId: string): void {
  postAgentSignal({ kind: 'ledger-changed', agentId: currentAgentId(), portId, at: new Date().toISOString() });
}

export function closeAgentChannel(): void {
  try {
    channel?.close();
  } catch {
    // 忽略
  }
  channel = null;
}

/** 判定心跳是否已超时（窗口失联） */
export function isHeartbeatStale(atIso: string, nowMs: number = Date.now()): boolean {
  const t = new Date(atIso).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > AGENT_TIMEOUT_MS;
}
