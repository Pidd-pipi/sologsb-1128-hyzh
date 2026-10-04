import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { currentWindowId } from '../utils/window';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, LiveBerth } from '../types/berth';
import type { BerthLease } from '../types/lease';
import type { CallDraft, PortCall } from '../types/call';
import { buildBerthRecords } from '../db/berth';
import {
  deriveLiveBerths,
  heartbeat,
  occupancySnapshot,
  registerInbound,
  registerOutbound,
  releaseLease,
  setBerthMaintenance as setBerthMaintenanceSvc,
  simulateWindowLost,
  sweepStaleLeases,
  waitingLeasesOf,
  type SweepResult,
} from '../services/occupancy';

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

/** 跨标签页（多值班窗口）账本变更通知信号 */
const LEDGER_TICK_KEY = 'gbfishport:ledger-tick';
/** 心跳与租约巡检间隔（ms） */
const LEDGER_INTERVAL_MS = 15_000;

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  /** 物理泊位台账（仅含物理属性与维修标记） */
  const physicalBerths = ref<Berth[]>([]);
  /** 占用账本（租约） */
  const leases = ref<BerthLease[]>([]);
  const calls = ref<PortCall[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  /** 当前值班窗口（标签页）标识 */
  const windowId = currentWindowId();

  /**
   * 生效占用的唯一事实来源：物理泊位 × 生效租约的派生结果。
   * 港口详情、地图、流水、渔船档案全部读它。
   */
  const berths = computed<LiveBerth[]>(() => deriveLiveBerths(physicalBerths.value, leases.value));

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  /** 生效泊位视图（按泊位号排序） */
  function berthsOf(portId: string): LiveBerth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  /** 物理泊位（维修操作使用） */
  function physicalBerthsOf(portId: string): Berth[] {
    return physicalBerths.value.filter((b) => b.portId === portId);
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  /** 渔港流水：优先按 portId 精确匹配；旧流水没有 portId 时退化为「泊位号在本港登记」 */
  function callsOfPort(portId: string): PortCall[] {
    const numbers = new Set(physicalBerthsOf(portId).map((b) => b.berthNo));
    return callsSorted.value.filter((c) =>
      c.portId ? c.portId === portId : c.berthNo ? numbers.has(c.berthNo) : false,
    );
  }

  function leaseById(id: string): BerthLease | undefined {
    return leases.value.find((l) => l.id === id);
  }

  /** 渔船当前未结束航次（生效 / 排队） */
  function openLeaseOfVessel(vesselId: string): BerthLease | undefined {
    return leases.value.find((l) => l.vesselId === vesselId && (l.status === '生效' || l.status === '排队'));
  }

  /** 渔港排队队列（FIFO） */
  function waitingOfPort(portId: string): BerthLease[] {
    return waitingLeasesOf(leases.value, portId);
  }

  /** 登记表单打开时的账本快照（乐观锁基准） */
  function snapshotFor(portId: string, berthNo: string | null) {
    return occupancySnapshot(berths.value, leases.value, portId, berthNo);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, l] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.leases.toArray(),
      ]);
      ports.value = p;
      physicalBerths.value = b;
      calls.value = c;
      leases.value = l;
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    physicalBerths.value = [...physicalBerths.value, ...records];
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (physicalBerthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
    };
    await db.berths.put(toPlain(berth));
    physicalBerths.value = [...physicalBerths.value, berth];
    const nextCount = physicalBerthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    // 新泊位可用，尝试给排队队列补位
    await reloadAfterSweep();
    return berth;
  }

  /** 维修 / 取消维修（占用中的泊位禁止维修；恢复可用时触发补位） */
  async function setBerthMaintenance(berthId: string, maintenance: boolean): Promise<void> {
    await setBerthMaintenanceSvc(berthId, maintenance);
    await loadAll();
    notifyLedgerTick();
  }

  /** 手动释放占用租约，并让队列自动补位 */
  async function releaseBerthLease(leaseId: string): Promise<SweepResult> {
    const result = await releaseLease(leaseId);
    await loadAll();
    notifyLedgerTick();
    return result;
  }

  /** 演示：模拟登记窗口失联（心跳过期） */
  async function markWindowLost(leaseId: string): Promise<void> {
    await simulateWindowLost(leaseId);
    await loadAll();
    notifyLedgerTick();
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 登记进出港。进港 → 抢占账本（容量满则排队）；出港 → 关闭租约释放泊位。
   * 所有并发判定都在 Dexie 事务内按最新账本状态完成。
   */
  async function registerCall(
    draft: CallDraft,
    vesselName: string,
  ): Promise<{ call: PortCall; queued: boolean; promoted: number }> {
    if (draft.type === '进港') {
      const result = await registerInbound({ draft, vesselName, windowId });
      await loadAll();
      notifyLedgerTick();
      const call =
        calls.value.find((c) => c.leaseId === result.lease.id && c.type === '进港') ??
        ({
          id: '',
          vesselId: draft.vesselId,
          vesselName,
          type: '进港',
          time: result.lease.berthAt,
          berthNo: result.lease.berthNo ?? '',
          portId: result.lease.portId,
          leaseId: result.lease.id,
          iceKg: draft.iceKg,
          fuelL: draft.fuelL,
          unloadKg: draft.unloadKg,
          visaStatus: draft.visaStatus,
          createdAt: new Date().toISOString(),
        } satisfies PortCall);
      return { call, queued: result.queued, promoted: 0 };
    }

    if (!draft.leaseId) throw new Error('出港必须选择当前在港的船舶');
    const result = await registerOutbound({
      leaseId: draft.leaseId,
      time: draft.time,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
    });
    await loadAll();
    notifyLedgerTick();
    return { call: result.call, queued: false, promoted: result.promoted.length };
  }

  /** 租约巡检：失效（超时 / 失联）释放 + 队列补位 */
  async function sweep(): Promise<SweepResult> {
    const result = await sweepStaleLeases();
    if (result.expired.length || result.promoted.length) {
      await loadAll();
      notifyLedgerTick();
    }
    return result;
  }

  async function reloadAfterSweep(): Promise<void> {
    const result = await sweepStaleLeases();
    await loadAll();
    if (result.expired.length || result.promoted.length) notifyLedgerTick();
  }

  /**
   * 启动账本值守：周期心跳 + 租约巡检；并监听其他值班窗口（标签页）的变更。
   * 返回停止函数（应用卸载时调用）。
   */
  function startLedger(): () => void {
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        await heartbeat(windowId);
        const result = await sweepStaleLeases();
        if (result.expired.length || result.promoted.length) await loadAll();
      } catch {
        // 后台标签页 IndexedDB 偶发失败不影响下一轮
      }
    };

    const timer = window.setInterval(tick, LEDGER_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onStorage = (event: StorageEvent) => {
      if (event.key === LEDGER_TICK_KEY) void loadAll();
    };
    window.addEventListener('storage', onStorage);

    void tick();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }

  function notifyLedgerTick(): void {
    try {
      localStorage.setItem(LEDGER_TICK_KEY, `${windowId}:${Date.now()}`);
    } catch {
      // 忽略
    }
  }

  return {
    ports,
    physicalBerths,
    leases,
    berths,
    calls,
    loading,
    filter,
    windowId,
    filteredPorts,
    callsSorted,
    portById,
    berthsOf,
    physicalBerthsOf,
    callsOfVessel,
    callsOfPort,
    leaseById,
    openLeaseOfVessel,
    waitingOfPort,
    snapshotFor,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthMaintenance,
    releaseBerthLease,
    markWindowLost,
    updatePort,
    registerCall,
    sweep,
    reloadAfterSweep,
    startLedger,
  };
});
