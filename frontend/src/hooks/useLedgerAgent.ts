import { onBeforeUnmount, onMounted } from 'vue';
import { db } from '../db';
import {
  closeAgentChannel,
  currentAgentId,
  HEARTBEAT_INTERVAL_MS,
  openAgentChannel,
  postAgentSignal,
  type AgentSignal,
} from '../services/agent';
import { sweepLedger } from '../services/ledger';
import type { ClosedLease } from '../types/lease';

export interface UseLedgerAgentOptions {
  /** 账本发生变化（其他窗口 / 扫描释放）后重新加载本窗口缓存 */
  reload: () => void | Promise<void>;
  /** 扫描关闭租约后的提示回调 */
  onClosed?: (closed: ClosedLease[]) => void;
}

/**
 * 当前值班窗口的账本代理：
 * - 每 5s 写一次心跳（IndexedDB），并向其他窗口广播
 * - 每 5s 扫描失效租约（窗口失联 / 超过预计离港时间），释放占用、重算在港船数
 * - 收到其他窗口的账本变更广播时，重新加载缓存，避免拿着旧泊位状态保存
 * - 关闭页面前广播下线
 */
export function useLedgerAgent(options: UseLedgerAgentOptions): { agentId: string } {
  const agentId = currentAgentId();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let reloading = false;

  async function writeHeartbeat(): Promise<void> {
    const at = new Date().toISOString();
    try {
      await db.agents.put({ id: agentId, at });
      postAgentSignal({ kind: 'heartbeat', agentId, at });
    } catch {
      // 忽略单次心跳失败，下轮重试
    }
  }

  async function runSweep(): Promise<void> {
    try {
      const closed = await sweepLedger();
      if (closed.length) {
        options.onClosed?.(closed);
        await options.reload();
      }
    } catch (error) {
      console.warn('[gbfishport] 账本扫描失败：', error);
    }
  }

  async function scheduleReload(): Promise<void> {
    if (reloading) return;
    reloading = true;
    try {
      // 略微延迟，等对方事务落库
      await new Promise((resolve) => setTimeout(resolve, 120));
      await options.reload();
    } finally {
      reloading = false;
    }
  }

  function onSignal(signal: AgentSignal): void {
    if (signal.agentId === agentId) return;
    // 账本变更：立即对齐；窗口关闭：它名下租约很快会被扫描释放，提前对齐一次。
    // 普通心跳仅用于探活，不触发全量重载。
    if (signal.kind === 'ledger-changed' || signal.kind === 'offline') {
      void scheduleReload();
    }
  }

  function onUnload(): void {
    try {
      postAgentSignal({ kind: 'offline', agentId, at: new Date().toISOString() });
    } catch {
      // 忽略
    }
  }

  onMounted(() => {
    openAgentChannel(onSignal);
    void writeHeartbeat();
    // 挂载后先扫一遍（处理上个会话遗留的失效租约），再进入定时循环
    void runSweep();
    heartbeatTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
    sweepTimer = setInterval(() => void runSweep(), HEARTBEAT_INTERVAL_MS);
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
  });

  onBeforeUnmount(() => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    window.removeEventListener('beforeunload', onUnload);
    window.removeEventListener('pagehide', onUnload);
    closeAgentChannel();
  });

  return { agentId };
}
