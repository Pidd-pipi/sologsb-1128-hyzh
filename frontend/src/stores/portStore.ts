import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, EffectiveBerth } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import type { BerthLease, ClosedLease } from '../types/lease';
import { buildBerthRecords } from '../db/berth';
import { effectiveBerths } from '../services/occupancy';
import { notifyLedgerChanged } from '../services/agent';
import {
  closeLease as closeLeaseService,
  LedgerStaleError,
  registerArrival as registerArrivalService,
  setPhysicalBerthStatus,
  VesselActiveError,
} from '../services/ledger';

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

export interface ArrivalOutcome {
  lease: BerthLease;
  outcome: 'docked' | 'queued';
  version: number;
}

export interface DepartureOutcome {
  lease: BerthLease;
  promoted: BerthLease[];
  version: number;
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const leases = ref<BerthLease[]>([]);
  const calls = ref<PortCall[]>([]);
  /** 各渔港账本版本号（portId -> version） */
  const versions = ref<Record<string, number>>({});
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  /** 生效占用：物理泊位叠加生效靠泊租约（所有页面读这一份） */
  const effectiveBerthList = computed<EffectiveBerth[]>(() => effectiveBerths(berths.value, leases.value));

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

  /** 生效泊位视图（已按泊位号排序） */
  function berthsOf(portId: string): EffectiveBerth[] {
    return effectiveBerthList.value.filter((b) => b.portId === portId);
  }

  function physicalBerthsOf(portId: string): Berth[] {
    return berths.value
      .filter((b) => b.portId === portId)
      .sort((a, b) => a.berthNo.localeCompare(b.berthNo, 'zh-Hans-CN', { numeric: true }));
  }

  function leasesOf(portId: string): BerthLease[] {
    return leases.value.filter((l) => l.portId === portId);
  }

  function waitingLeasesOf(portId: string): BerthLease[] {
    return leases.value
      .filter((l) => l.portId === portId && l.state === '排队')
      .sort((a, b) => (a.enqueuedAt ?? '').localeCompare(b.enqueuedAt ?? ''));
  }

  function activeLeaseOfVessel(vesselId: string): BerthLease | undefined {
    return leases.value.find((l) => l.vesselId === vesselId && (l.state === '靠泊' || l.state === '排队'));
  }

  function ledgerVersion(portId: string): number {
    return versions.value[portId] ?? 1;
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  /** 渔港流水：按流水上的 portId 归集；旧流水无 portId 不归属任何渔港 */
  function callsOfPort(portId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.portId === portId);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c, l, m] = await Promise.all([
        db.ports.toArray(),
        db.berths.toArray(),
        db.calls.toArray(),
        db.leases.toArray(),
        db.ledgerMeta.toArray(),
      ]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
      leases.value = l;
      versions.value = Object.fromEntries(m.map((meta) => [meta.portId, meta.version]));
    } finally {
      loading.value = false;
    }
  }

  /** 仅重读占用账本（租约 / 流水 / 版本），跨窗口变更后调用 */
  async function reloadLedger(): Promise<void> {
    const [b, c, l, m] = await Promise.all([db.berths.toArray(), db.calls.toArray(), db.leases.toArray(), db.ledgerMeta.toArray()]);
    berths.value = b;
    calls.value = c;
    leases.value = l;
    versions.value = Object.fromEntries(m.map((meta) => [meta.portId, meta.version]));
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
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    await db.ledgerMeta.put(toPlain({ portId: port.id, version: 1, updatedAt: new Date().toISOString() }));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    versions.value = { ...versions.value, [port.id]: 1 };
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
    berths.value = [...berths.value, berth];
    const nextCount = physicalBerthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    // 扩容后账本版本号 +1
    await reloadLedger();
    notifyLedgerChanged(portId);
    return berth;
  }

  /** 泊位置维修 / 恢复可用（占用占用账本一致性，不允许直接覆盖占用状态） */
  async function setBerthStatus(berthId: string, status: '维修' | '空闲'): Promise<void> {
    const target = berths.value.find((b) => b.id === berthId);
    await setPhysicalBerthStatus(berthId, status);
    await reloadLedger();
    if (target) notifyLedgerChanged(target.portId);
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 进港登记：登记前按最新状态抢占泊位；容量满了排队。
   * 版本号不一致抛 LedgerStaleError（窗口提示刷新）；重复靠泊抛 VesselActiveError。
   */
  async function registerArrival(
    draft: CallDraft,
    vesselName: string,
    agentId: string,
  ): Promise<ArrivalOutcome> {
    const expectedVersion = ledgerVersion(draft.portId);
    const result = await registerArrivalService(draft, vesselName, agentId, expectedVersion);
    await reloadLedger();
    notifyLedgerChanged(draft.portId);
    return result;
  }

  /**
   * 出港登记 / 人工释放：关闭租约、释放泊位并调度排队。
   */
  async function registerDeparture(
    leaseId: string,
    draft: CallDraft,
    vesselName: string,
  ): Promise<DepartureOutcome> {
    const lease = leases.value.find((l) => l.id === leaseId);
    if (!lease) throw new Error('未找到生效租约，请刷新后重试');
    const expectedVersion = ledgerVersion(lease.portId);
    const result = await closeLeaseService(leaseId, draft, vesselName, expectedVersion, '正常离港');
    await reloadLedger();
    notifyLedgerChanged(lease.portId);
    return result;
  }

  /** 人工释放（详情页「释放为空闲」）/ 取消排队 */
  async function releaseLease(leaseId: string): Promise<DepartureOutcome> {
    const lease = leases.value.find((l) => l.id === leaseId);
    if (!lease) throw new Error('未找到生效租约，请刷新后重试');
    const expectedVersion = ledgerVersion(lease.portId);
    const draft: CallDraft = {
      vesselId: lease.vesselId,
      type: '出港',
      portId: lease.portId,
      time: new Date().toISOString(),
      expectedLeaveAt: '',
      berthNo: lease.berthNo,
      iceKg: 0,
      fuelL: 0,
      unloadKg: 0,
      visaStatus: '免签',
    };
    const result = await closeLeaseService(leaseId, draft, lease.vesselName, expectedVersion, '人工释放');
    await reloadLedger();
    notifyLedgerChanged(lease.portId);
    return result;
  }

  /** 扫描关闭租约后的本地同步（结果已在 IndexedDB，补缓存） */
  async function syncClosed(_closed: ClosedLease[]): Promise<void> {
    await reloadLedger();
  }

  function findActiveLease(vesselId: string): BerthLease | undefined {
    return leases.value.find((l) => l.vesselId === vesselId && (l.state === '靠泊' || l.state === '排队'));
  }

  return {
    ports,
    berths,
    effectiveBerths: effectiveBerthList,
    leases,
    calls,
    versions,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    portById,
    berthsOf,
    physicalBerthsOf,
    leasesOf,
    waitingLeasesOf,
    activeLeaseOfVessel,
    findActiveLease,
    ledgerVersion,
    callsOfVessel,
    callsOfPort,
    resetFilter,
    loadAll,
    reloadLedger,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerArrival,
    registerDeparture,
    releaseLease,
    syncClosed,
  };
});

export { LedgerStaleError, VesselActiveError };
