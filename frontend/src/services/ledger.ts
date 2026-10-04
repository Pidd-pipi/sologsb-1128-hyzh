import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { ACTIVE_LEASE_STATES, type ArrivalResult, type BerthLease, type ClosedLease, type LeaseCloseReason } from '../types/lease';
import type { CallDraft, PortCall } from '../types/call';
import { isHeartbeatStale } from './agent';

/** 事务句柄（Dexie 升级回调与业务事务共用同一形态，这里放宽类型） */
type Tx = {
  table: (name: string) => any;
};

/** 旧版本保存：提交时账本版本号与读取时不一致 */
export class LedgerStaleError extends Error {
  latestVersion: number;
  constructor(latestVersion: number) {
    super(`泊位状态已被其他窗口更新（账本版本 v${latestVersion}），请刷新后重试，不要直接覆盖`);
    this.name = 'LedgerStaleError';
    this.latestVersion = latestVersion;
  }
}

/** 同一渔船已有未结束航次（在港靠泊或排队中） */
export class VesselActiveError extends Error {
  active: BerthLease;
  constructor(active: BerthLease) {
    super(
      active.state === '排队'
        ? `该渔船已在排队等泊，不能重复靠泊`
        : `该渔船已有未结束航次，正在泊位 ${active.berthNo} 靠泊，不能重复登记进港`,
    );
    this.name = 'VesselActiveError';
    this.active = active;
  }
}

function sortBerths<T extends { berthNo: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.berthNo.localeCompare(b.berthNo, 'zh-Hans-CN', { numeric: true }));
}

/** 读取（惰性创建）某渔港账本版本号 */
export async function getLedgerVersion(portId: string): Promise<number> {
  const meta = await db.ledgerMeta.get(portId);
  return meta?.version ?? 1;
}

async function ensureMeta(tx: Tx, portId: string, nowIso: string) {
  const metaTable = tx.table('ledgerMeta') as typeof db.ledgerMeta;
  let meta = await metaTable.get(portId);
  if (!meta) {
    meta = { portId, version: 1, updatedAt: nowIso };
    await metaTable.put(meta);
  }
  return meta;
}

async function bumpVersionInTx(tx: Tx, portId: string, nowIso: string): Promise<number> {
  const metaTable = tx.table('ledgerMeta') as typeof db.ledgerMeta;
  const prev = await metaTable.get(portId);
  const meta = prev ? { ...prev, version: prev.version + 1, updatedAt: nowIso } : { portId, version: 2, updatedAt: nowIso };
  await metaTable.put(meta);
  return meta.version;
}

function buildArrivalCall(lease: BerthLease, draft: CallDraft, vesselName: string): PortCall {
  return {
    id: uid('c'),
    portId: lease.portId,
    leaseId: lease.id,
    vesselId: lease.vesselId,
    vesselName,
    type: '进港',
    time: lease.berthAt,
    berthNo: lease.berthNo,
    iceKg: Number(draft.iceKg) || 0,
    fuelL: Number(draft.fuelL) || 0,
    unloadKg: Number(draft.unloadKg) || 0,
    visaStatus: draft.visaStatus,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 进港登记：事务内按最新状态抢占泊位。
 * - 版本号与窗口读取时不一致 → LedgerStaleError（提示刷新，不覆盖）
 * - 同一渔船已有未结束航次 → VesselActiveError
 * - 容量满 → 生成排队租约（FIFO 等泊，不挤占容量）
 */
export async function registerArrival(
  draft: CallDraft,
  vesselName: string,
  agentId: string,
  expectedVersion: number,
): Promise<ArrivalResult> {
  const portId = draft.portId;
  const nowIso = new Date().toISOString();
  const time = draft.time ? new Date(draft.time).toISOString() : nowIso;
  const expectedMs = draft.expectedLeaveAt ? new Date(draft.expectedLeaveAt).getTime() : NaN;
  const expectedLeaveAt = Number.isNaN(expectedMs)
    ? new Date(new Date(time).getTime() + 12 * 3600 * 1000).toISOString()
    : new Date(expectedMs).toISOString();

  return db.transaction('rw', db.berths, db.leases, db.calls, db.ledgerMeta, async (tx: Tx) => {
    const berthTable = tx.table('berths') as typeof db.berths;
    const leaseTable = tx.table('leases') as typeof db.leases;
    const callTable = tx.table('calls') as typeof db.calls;

    const meta = await ensureMeta(tx, portId, nowIso);
    if (meta.version !== expectedVersion) {
      throw new LedgerStaleError(meta.version);
    }

    // 同一渔船已有未结束航次（任意渔港、靠泊或排队）都不能重复靠泊
    const vesselLeases = await leaseTable.where('vesselId').equals(draft.vesselId).toArray();
    const active = vesselLeases.find((l: BerthLease) => ACTIVE_LEASE_STATES.includes(l.state));
    if (active) throw new VesselActiveError(active);

    const [portBerths, portLeases] = await Promise.all([
      berthTable.where('portId').equals(portId).toArray(),
      leaseTable.where('portId').equals(portId).toArray(),
    ]);
    const occupiedNos = new Set(portLeases.filter((l: BerthLease) => l.state === '靠泊').map((l: BerthLease) => l.berthNo));
    const freeBerth = sortBerths(
      portBerths.filter((b) => b.status !== '维修' && !occupiedNos.has(b.berthNo)),
    )[0];

    const lease: BerthLease = {
      id: uid('l'),
      portId,
      berthNo: freeBerth ? freeBerth.berthNo : '',
      vesselId: draft.vesselId,
      vesselName,
      state: freeBerth ? '靠泊' : '排队',
      berthAt: time,
      leaveAt: null,
      expectedLeaveAt,
      closeReason: null,
      agentId,
      enqueuedAt: freeBerth ? null : nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await leaseTable.put(toPlain(lease));
    await callTable.put(toPlain(buildArrivalCall(lease, draft, vesselName)));

    const version = await bumpVersionInTx(tx, portId, nowIso);
    return { lease, outcome: freeBerth ? ('docked' as const) : ('queued' as const), version };
  });
}

/**
 * 出港 / 人工释放 / 取消排队：关闭生效租约、释放占用并写流水，然后按 FIFO 调度队首。
 * 排队中取消（reason 人工释放 且原状态为排队）不写进出港流水。
 */
export async function closeLease(
  leaseId: string,
  draft: CallDraft,
  vesselName: string,
  expectedVersion: number,
  reason: LeaseCloseReason = '正常离港',
): Promise<{ lease: BerthLease; promoted: BerthLease[]; version: number }> {
  const nowIso = new Date().toISOString();
  const time = draft.time ? new Date(draft.time).toISOString() : nowIso;

  return db.transaction('rw', db.berths, db.leases, db.calls, db.ledgerMeta, async (tx: Tx) => {
    const leaseTable = tx.table('leases') as typeof db.leases;
    const callTable = tx.table('calls') as typeof db.calls;

    const lease = await leaseTable.get(leaseId);
    if (!lease || !ACTIVE_LEASE_STATES.includes(lease.state)) {
      throw new Error('该租约已结束或不存在，请刷新占用账本');
    }
    const meta = await ensureMeta(tx, lease.portId, nowIso);
    if (meta.version !== expectedVersion) {
      throw new LedgerStaleError(meta.version);
    }

    const wasDocked = lease.state === '靠泊';
    const closed: BerthLease = {
      ...lease,
      state: wasDocked ? '已离港' : '已失效',
      leaveAt: time,
      closeReason: reason,
      updatedAt: nowIso,
    };
    await leaseTable.put(toPlain(closed));

    if (wasDocked) {
      const call: PortCall = {
        id: uid('c'),
        portId: lease.portId,
        leaseId: lease.id,
        vesselId: lease.vesselId,
        vesselName,
        type: '出港',
        time,
        berthNo: lease.berthNo,
        iceKg: Number(draft.iceKg) || 0,
        fuelL: Number(draft.fuelL) || 0,
        unloadKg: Number(draft.unloadKg) || 0,
        visaStatus: draft.visaStatus,
        createdAt: nowIso,
      };
      await callTable.put(toPlain(call));
    }

    const promoted = wasDocked ? await promoteQueueInTx(tx, lease.portId, nowIso) : [];
    const version = await bumpVersionInTx(tx, lease.portId, nowIso);
    return { lease: closed, promoted, version };
  });
}

/**
 * 事务内按 FIFO 把排队船调度进真实空闲泊位（自行核对物理泊位与当前靠泊租约，
 * 防止同一泊位重复分配），并回填进港流水的泊位号。
 */
async function promoteQueueInTx(tx: Tx, portId: string, nowIso: string): Promise<BerthLease[]> {
  const berthTable = tx.table('berths') as typeof db.berths;
  const leaseTable = tx.table('leases') as typeof db.leases;
  const callTable = tx.table('calls') as typeof db.calls;

  const [portBerths, portLeases] = await Promise.all([
    berthTable.where('portId').equals(portId).toArray(),
    leaseTable.where('portId').equals(portId).toArray(),
  ]);
  const dockedNos = new Set(
    portLeases.filter((l: BerthLease) => l.state === '靠泊').map((l: BerthLease) => l.berthNo),
  );
  const freeList = sortBerths(
    portBerths.filter((b) => b.status !== '维修' && !dockedNos.has(b.berthNo)),
  );
  const queue = portLeases
    .filter((l: BerthLease) => l.state === '排队')
    .sort((a: BerthLease, b: BerthLease) => (a.enqueuedAt ?? '').localeCompare(b.enqueuedAt ?? ''));

  const promoted: BerthLease[] = [];
  const count = Math.min(queue.length, freeList.length);
  for (let i = 0; i < count; i++) {
    const waiting = queue[i] as BerthLease;
    const target = freeList[i].berthNo;
    const next: BerthLease = {
      ...waiting,
      state: '靠泊',
      berthNo: target,
      enqueuedAt: null,
      updatedAt: nowIso,
    };
    await leaseTable.put(toPlain(next));
    promoted.push(next);

    const arrivalCalls = await callTable.where('vesselId').equals(waiting.vesselId).toArray();
    const arrival = arrivalCalls
      .filter((c: PortCall) => c.leaseId === waiting.id && c.type === '进港')
      .sort((a: PortCall, b: PortCall) => b.time.localeCompare(a.time))[0];
    if (arrival && !arrival.berthNo) {
      await callTable.put(toPlain({ ...arrival, berthNo: target }));
    }
  }
  return promoted;
}

/**
 * 账本扫描：窗口失联或超过预计离港时间后租约失效，释放占用、重算在港船数。
 * - 靠泊租约失效 → 写一条「失效补记」出港流水，并触发队列出泊
 * - 排队租约所属窗口失联 → 放弃排队（不写流水）
 * system 租约（agentId=null）不因窗口失联失效；无预计离港时间的不超时。
 */
export async function sweepLedger(nowMs: number = Date.now()): Promise<ClosedLease[]> {
  const nowIso = new Date(nowMs).toISOString();
  const heartbeats = await db.agents.toArray();
  const staleAgents = new Set(heartbeats.filter((h) => isHeartbeatStale(h.at, nowMs)).map((h) => h.id));

  const activeLeases = await db.leases.where('state').anyOf('靠泊', '排队').toArray();
  const expiredDocked = activeLeases.filter(
    (l) => l.state === '靠泊' && l.expectedLeaveAt !== null && new Date(l.expectedLeaveAt).getTime() <= nowMs,
  );
  const staleOwned = activeLeases.filter((l) => l.agentId !== null && staleAgents.has(l.agentId));

  // 同一租约只关一次；优先按「超过预计离港时间」归因
  const toClose = new Map<string, { lease: BerthLease; reason: LeaseCloseReason }>();
  for (const lease of expiredDocked) {
    toClose.set(lease.id, { lease, reason: '超过预计离港时间' });
  }
  for (const lease of staleOwned) {
    if (!toClose.has(lease.id)) toClose.set(lease.id, { lease, reason: '窗口失联' });
  }

  // 即使没有租约失效，也要清掉无主过期心跳
  if (toClose.size === 0) {
    if (staleAgents.size > 0) {
      await db.transaction('rw', db.agents, async (tx: Tx) => {
        const agentTable = tx.table('agents') as typeof db.agents;
        for (const agentId of staleAgents) await agentTable.delete(agentId);
      });
    }
    return [];
  }

  const portIds = new Set([...toClose.values()].map((x) => x.lease.portId));
  const closed: ClosedLease[] = [];

  for (const portId of portIds) {
    const items = [...toClose.values()].filter((x) => x.lease.portId === portId);
    await db.transaction('rw', db.berths, db.leases, db.calls, db.ledgerMeta, db.agents, async (tx: Tx) => {
      const leaseTable = tx.table('leases') as typeof db.leases;
      const callTable = tx.table('calls') as typeof db.calls;
      const agentTable = tx.table('agents') as typeof db.agents;

      for (const item of items) {
        const fresh = await leaseTable.get(item.lease.id);
        if (!fresh || !ACTIVE_LEASE_STATES.includes(fresh.state)) continue;
        const wasDocked = fresh.state === '靠泊';
        const updated: BerthLease = {
          ...fresh,
          state: '已失效',
          berthNo: wasDocked ? fresh.berthNo : '',
          leaveAt: nowIso,
          closeReason: item.reason,
          updatedAt: nowIso,
        };
        await leaseTable.put(toPlain(updated));

        if (wasDocked) {
          const call: PortCall = {
            id: uid('c'),
            portId: fresh.portId,
            leaseId: fresh.id,
            vesselId: fresh.vesselId,
            vesselName: fresh.vesselName,
            type: '出港',
            time: nowIso,
            berthNo: fresh.berthNo,
            iceKg: 0,
            fuelL: 0,
            unloadKg: 0,
            visaStatus: '免签',
            leaseExpired: true,
            createdAt: nowIso,
          };
          await callTable.put(toPlain(call));
        }
        closed.push({ lease: updated, reason: item.reason, promoted: false });
      }

      // 所有失效租约落库后统一出泊一次（内部按真实空闲泊位核对）
      const promotedLeases = await promoteQueueInTx(tx, portId, nowIso);
      if (promotedLeases.length) {
        // 出泊发生在释放出的泊位上，挂到本港第一条失效靠泊记录，供 UI 汇总提示
        const firstDocked = closed.find((c) => c.lease.portId === portId && c.lease.berthNo);
        if (firstDocked) firstDocked.promoted = true;
      }

      await bumpVersionInTx(tx, portId, nowIso);
      for (const agentId of staleAgents) {
        await agentTable.delete(agentId);
      }
    });
  }

  return closed;
}

/** 物理泊位置为维修 / 恢复可用：改变容量，账本版本号 +1 */
export async function setPhysicalBerthStatus(berthId: string, status: '维修' | '空闲'): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.transaction('rw', db.berths, db.ledgerMeta, db.leases, async (tx: Tx) => {
    const berthTable = tx.table('berths') as typeof db.berths;
    const berth = await berthTable.get(berthId);
    if (!berth) return;
    if (status === '维修') {
      const leaseTable = tx.table('leases') as typeof db.leases;
      const active = await leaseTable.where('portId').equals(berth.portId).toArray();
      if (active.some((l: BerthLease) => l.state === '靠泊' && l.berthNo === berth.berthNo)) {
        throw new Error('该泊位正在靠泊占用，请先办理离港或释放租约');
      }
    }
    await berthTable.put(toPlain({ ...berth, status }));
    await bumpVersionInTx(tx, berth.portId, nowIso);
  });
}
