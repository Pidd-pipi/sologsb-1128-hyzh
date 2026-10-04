import { db } from '../db';
import type { Berth, BerthSummary, LiveBerth, WaitingEntry } from '../types/berth';
import {
  OccupancyConflictError,
  VesselOpenVoyageError,
  isLeaseStale,
  isOpenLease,
  staleReason,
  type BerthLease,
  type LeaseEndReason,
  type LeaseRequest,
  type LeaseResult,
  type OccupancySnapshot,
} from '../types/lease';
import type { CallDraft, PortCall } from '../types/call';
import { toPlain, uid } from '../utils/format';

const nowIso = (): string => new Date().toISOString();

/* ---------------------------------- 派生层 ---------------------------------- */

/**
 * 生效占用的唯一派生入口：物理泊位台账 × 生效租约账本。
 * 港口详情、地图、流水、渔船档案都消费它的结果。
 */
export function deriveLiveBerths(physical: Berth[], leases: BerthLease[]): LiveBerth[] {
  const active = new Map<string, BerthLease>();
  for (const lease of leases) {
    if (lease.status === '生效' && lease.berthNo) active.set(`${lease.portId}|${lease.berthNo}`, lease);
  }
  return physical
    .map((b) => {
      const lease = active.get(`${b.portId}|${b.berthNo}`) ?? null;
      const status: Berth['status'] = b.status === '维修' ? '维修' : lease ? '占用' : '空闲';
      return {
        ...b,
        status,
        lease,
        vesselId: lease?.vesselId ?? null,
        vesselName: lease?.vesselName ?? null,
        berthAt: lease?.berthAt ?? null,
        expectedLeaveAt: lease?.expectedLeaveAt ?? null,
        leaseVersion: lease?.version ?? null,
      } satisfies LiveBerth;
    })
    .sort((a, b) => a.portId.localeCompare(b.portId) || a.berthNo.localeCompare(b.berthNo));
}

/** 排队队列（未分配泊位，FIFO：按入队时间） */
export function waitingLeasesOf(leases: BerthLease[], portId?: string): WaitingEntry[] {
  return leases
    .filter((l) => l.status === '排队' && (!portId || l.portId === portId))
    .sort(
      (a, b) =>
        new Date(a.queuedAt ?? a.createdAt).getTime() - new Date(b.queuedAt ?? b.createdAt).getTime(),
    );
}

/** 渔港当前生效租约 */
export function activeLeasesOf(leases: BerthLease[], portId: string): BerthLease[] {
  return leases.filter((l) => l.status === '生效' && l.portId === portId);
}

/** 同一渔船的未结束航次（生效或排队）—— 不允许重复靠泊 */
export function openLeaseOfVessel(leases: BerthLease[], vesselId: string): BerthLease | undefined {
  return leases.find((l) => l.vesselId === vesselId && isOpenLease(l));
}

/** 聚合占用统计（容量 = 非维修泊位数；未分配 / 排队不占容量） */
export function summarize(portId: string, live: LiveBerth[], leases: BerthLease[]): BerthSummary {
  const scope = live.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  const total = scope.length;
  const maintenance = scope.filter((b) => b.status === '维修').length;
  const occupied = scope.filter((b) => b.status === '占用').length;
  const capacity = total - maintenance;
  const free = capacity - occupied;
  return {
    portId,
    total,
    occupied,
    free,
    maintenance,
    capacity,
    occupancyRate: capacity === 0 ? 0 : occupied / capacity,
    inPortCount: occupied,
    waitingCount: waitingLeasesOf(leases, portId).length,
    freeBerths: scope.filter((b) => b.status === '空闲'),
    occupiedBerths: scope.filter((b) => b.status === '占用'),
    waitingLeases: waitingLeasesOf(leases, portId),
  };
}

/** 打开登记表单时的账本快照（乐观锁基准） */
export function occupancySnapshot(
  live: LiveBerth[],
  leases: BerthLease[],
  portId: string,
  berthNo: string | null,
): OccupancySnapshot {
  const target = berthNo ? live.find((b) => b.portId === portId && b.berthNo === berthNo) : undefined;
  const portLive = live.filter((b) => b.portId === portId);
  return {
    berthVersion: target?.leaseVersion ?? null,
    holderId: target?.vesselId ?? null,
    occupied: portLive.filter((b) => b.status === '占用').length,
    capacity: portLive.filter((b) => b.status !== '维修').length,
    at: nowIso(),
  };
}

/* --------------------------------- 事务操作 --------------------------------- */

export interface SweepResult {
  /** 本轮失效的租约 */
  expired: BerthLease[];
  /** 本轮自动补位的排队租约（含补位泊位号） */
  promoted: Array<{ lease: BerthLease; berthNo: string }>;
}

/** 账本内统一的队列补位：为给定渔港按 FIFO 分配空闲泊位 */
async function promoteQueueForPort(
  physical: Berth[],
  allLeases: BerthLease[],
  portId: string,
  atMs: number,
): Promise<Array<{ lease: BerthLease; berthNo: string }>> {
  const promoted: Array<{ lease: BerthLease; berthNo: string }> = [];
  const portBerths = physical.filter((b) => b.portId === portId);
  const taken = new Set(
    allLeases.filter((l) => l.status === '生效' && l.portId === portId && l.berthNo).map((l) => l.berthNo as string),
  );
  const queue = waitingLeasesOf(allLeases, portId);
  for (const waiting of queue) {
    const free = portBerths
      .filter((b) => b.status !== '维修' && !taken.has(b.berthNo))
      .sort((a, b) => a.berthNo.localeCompare(b.berthNo))[0];
    if (!free) break;
    taken.add(free.berthNo);
    const atIso = new Date(atMs).toISOString();
    // 保留原计划靠泊时长，从补位时刻重新起算预计离港；复制对象，不原地改动入参数组
    const plannedMs = Math.max(
      new Date(waiting.expectedLeaveAt).getTime() - new Date(waiting.createdAt).getTime(),
      0,
    );
    const promotedLease: BerthLease = {
      ...waiting,
      status: '生效',
      berthNo: free.berthNo,
      berthAt: atIso,
      expectedLeaveAt: new Date(atMs + plannedMs).toISOString(),
      heartbeatAt: atIso,
      version: waiting.version + 1,
      updatedAt: atIso,
    };
    promoted.push({ lease: promotedLease, berthNo: free.berthNo });
    // 排队时生成的进港流水当时没有泊位号，补位后回填
    const pendingCall = await db.calls
      .where('leaseId')
      .equals(promotedLease.id)
      .filter((c) => c.type === '进港')
      .first();
    if (pendingCall) {
      pendingCall.berthNo = free.berthNo;
      pendingCall.portId = portId;
      await db.calls.put(toPlain(pendingCall));
    }
    await db.leases.put(toPlain(promotedLease));
  }
  return promoted;
}

/**
 * 租约巡检：超过预计离港时间 / 登记窗口失联（心跳超时）的生效租约失效，
 * 释放泊位并让排队船舶 FIFO 自动补位。
 */
export async function sweepStaleLeases(at: Date = new Date()): Promise<SweepResult> {
  const atMs = at.getTime();
  const expired: BerthLease[] = [];
  const promoted: SweepResult['promoted'] = [];
  const touchedPorts = new Set<string>();

  await db.transaction('rw', db.leases, db.berths, db.calls, async () => {
    const [physical, leases] = await Promise.all([db.berths.toArray(), db.leases.toArray()]);
    for (const lease of leases) {
      if (!isLeaseStale(lease, atMs)) continue;
      const reason = staleReason(lease, atMs);
      const endedAt = new Date(atMs).toISOString();
      const next: BerthLease = {
        ...lease,
        status: '已失效',
        endedAt,
        endReason: reason,
        version: lease.version + 1,
        updatedAt: endedAt,
      };
      expired.push(next);
      touchedPorts.add(lease.portId);
      await db.leases.put(toPlain(next));
      // 同步一条出港流水，保证港口 / 渔船流水与账本一致
      const call: PortCall = {
        id: uid('c'),
        vesselId: lease.vesselId,
        vesselName: lease.vesselName,
        type: '出港',
        time: endedAt,
        berthNo: lease.berthNo ?? '',
        portId: lease.portId,
        leaseId: lease.id,
        iceKg: 0,
        fuelL: 0,
        unloadKg: 0,
        visaStatus: '免签',
        createdAt: endedAt,
      };
      await db.calls.put(toPlain(call));
    }
    // 失效释放 + 顺带巡检所有有排队的渔港
    const queuedPorts = new Set(leases.filter((l) => l.status === '排队').map((l) => l.portId));
    for (const portId of [...touchedPorts, ...queuedPorts]) {
      const fresh = await db.leases.toArray();
      promoted.push(...(await promoteQueueForPort(physical, fresh, portId, atMs)));
    }
  });

  return { expired, promoted };
}

/** 登记窗口心跳：续租自己名下所有生效租约 */
export async function heartbeat(windowId: string): Promise<number> {
  const at = nowIso();
  let count = 0;
  await db.leases
    .where('windowId')
    .equals(windowId)
    .filter((l) => l.status === '生效')
    .modify((l) => {
      l.heartbeatAt = at;
      count += 1;
    });
  return count;
}

interface InboundContext {
  draft: CallDraft;
  vesselName: string;
  windowId: string;
}

/**
 * 进港登记（抢占式）：
 * 事务内按最新账本状态校验——渔船无未结束航次、目标泊位仍空闲且版本未变；
 * 指定泊位被占且版本落后 → 冲突，提示刷新；不指定泊位则自动分配，容量满则排队。
 */
export async function registerInbound(ctx: InboundContext): Promise<LeaseResult> {
  const { draft, vesselName, windowId } = ctx;
  const atIso = draft.time ? new Date(draft.time).toISOString() : nowIso();
  const expectedLeaveAt = draft.expectedLeaveAt
    ? new Date(draft.expectedLeaveAt).toISOString()
    : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const request: LeaseRequest = {
    portId: draft.portId,
    vesselId: draft.vesselId,
    vesselName,
    berthNo: draft.berthNo ? draft.berthNo.trim().toUpperCase() : null,
    berthAt: atIso,
    expectedLeaveAt,
    windowId,
    expectedVersion: draft.expectedVersion ?? undefined,
    expectedHolder: draft.expectedHolder ?? undefined,
  };

  const created: { lease: BerthLease | null; queued: boolean } = { lease: null, queued: false };

  await db.transaction('rw', db.leases, db.berths, db.calls, async () => {
    const [physical, leases] = await Promise.all([db.berths.toArray(), db.leases.toArray()]);

    // 1. 同一渔船存在未结束航次（生效 / 排队）→ 拒绝重复靠泊
    const open = openLeaseOfVessel(leases, request.vesselId);
    if (open) {
      const where = open.status === '排队'
        ? `在渔港 ${open.portId} 的排队队列中（入队 ${open.queuedAt ?? open.createdAt}）`
        : `仍靠泊在泊位 ${open.berthNo ?? '未分配'}（靠泊于 ${open.berthAt}）`;
      throw new VesselOpenVoyageError(`该渔船已有未结束航次：${where}，不能重复靠泊`);
    }

    const portBerths = physical.filter((b) => b.portId === request.portId);
    if (!portBerths.length) throw new Error('该渔港没有泊位台账，无法登记');

    const takenByNo = new Map(
      leases
        .filter((l) => l.status === '生效' && l.portId === request.portId && l.berthNo)
        .map((l) => [l.berthNo as string, l]),
    );

    let assignedNo: string | null = null;
    let queued = false;

    if (request.berthNo) {
      const target = portBerths.find((b) => b.berthNo === request.berthNo);
      if (!target) throw new Error(`泊位 ${request.berthNo} 不属于所选渔港，请刷新后重选`);
      if (target.status === '维修') throw new Error(`泊位 ${request.berthNo} 正在维修，无法靠泊`);
      const holder = takenByNo.get(request.berthNo);
      if (holder) {
        // 旧版本保存：表单打开时该泊位的占用状态（占用者 / 版本）与现在不一致
        const holderChanged =
          (request.expectedHolder !== undefined && request.expectedHolder !== holder.vesselId) ||
          (typeof request.expectedVersion === 'number' && request.expectedVersion !== holder.version);
        if (holderChanged) {
          throw new OccupancyConflictError(
            `泊位 ${request.berthNo} 刚被「${holder.vesselName}」占用（账本已更新到 v${holder.version}），请刷新占用状态后重新选择`,
          );
        }
        throw new OccupancyConflictError(`泊位 ${request.berthNo} 已被「${holder.vesselName}」占用，请刷新后选择其他泊位`);
      }
      // 表单打开时泊位被占用、此刻却已空出，也属于账本已变更，要求刷新确认
      if (request.expectedHolder !== undefined && request.expectedHolder !== null) {
        throw new OccupancyConflictError(`泊位 ${request.berthNo} 的占用已释放（账本已变更），请刷新后确认`);
      }
      assignedNo = request.berthNo;
    } else {
      // 不挑泊位：自动抢占第一个空闲泊位；容量满则排队
      const free = portBerths
        .filter((b) => b.status !== '维修' && !takenByNo.has(b.berthNo))
        .sort((a, b) => a.berthNo.localeCompare(b.berthNo))[0];
      if (free) assignedNo = free.berthNo;
      else queued = true;
    }

    const ts = nowIso();
    const lease: BerthLease = {
      id: uid('l'),
      portId: request.portId,
      berthNo: assignedNo,
      vesselId: request.vesselId,
      vesselName: request.vesselName,
      status: queued ? '排队' : '生效',
      berthAt: atIso,
      queuedAt: queued ? ts : null,
      expectedLeaveAt: request.expectedLeaveAt,
      endedAt: null,
      endReason: '',
      windowId: request.windowId,
      heartbeatAt: ts,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.leases.put(toPlain(lease));

    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: '进港',
      time: atIso,
      berthNo: assignedNo ?? '',
      portId: request.portId,
      leaseId: lease.id,
      expectedLeaveAt: request.expectedLeaveAt,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      createdAt: ts,
    };
    await db.calls.put(toPlain(call));

    created.lease = lease;
    created.queued = queued;
  });

  return { lease: created.lease as BerthLease, queued: created.queued };
}

export interface OutboundContext {
  leaseId: string;
  time: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: CallDraft['visaStatus'];
}

export interface OutboundResult {
  lease: BerthLease;
  call: PortCall;
  promoted: Array<{ lease: BerthLease; berthNo: string }>;
  /** 关闭的是排队航次（未实际在港） */
  wasQueued: boolean;
}

/** 出港登记：关闭生效 / 排队租约，释放泊位并触发队列补位 */
export async function registerOutbound(ctx: OutboundContext): Promise<OutboundResult> {
  const atIso = ctx.time ? new Date(ctx.time).toISOString() : nowIso();
  const out: { lease: BerthLease | null; call: PortCall | null; promoted: OutboundResult['promoted']; wasQueued: boolean } = {
    lease: null,
    call: null,
    promoted: [],
    wasQueued: false,
  };

  await db.transaction('rw', db.leases, db.berths, db.calls, async () => {
    const lease = await db.leases.get(ctx.leaseId);
    if (!lease) throw new Error('未找到对应的占用租约，请刷新后重试');
    if (!isOpenLease(lease)) throw new OccupancyConflictError('该航次已结束（账本状态已变更），请刷新后重试');

    const wasQueued = lease.status === '排队';
    const next: BerthLease = {
      ...lease,
      status: '已出港',
      endedAt: atIso,
      endReason: '出港',
      version: lease.version + 1,
      updatedAt: atIso,
    };
    await db.leases.put(toPlain(next));

    const call: PortCall = {
      id: uid('c'),
      vesselId: lease.vesselId,
      vesselName: lease.vesselName,
      type: '出港',
      time: atIso,
      berthNo: lease.berthNo ?? '',
      portId: lease.portId,
      leaseId: lease.id,
      iceKg: Number(ctx.iceKg) || 0,
      fuelL: Number(ctx.fuelL) || 0,
      unloadKg: Number(ctx.unloadKg) || 0,
      visaStatus: ctx.visaStatus,
      createdAt: atIso,
    };
    await db.calls.put(toPlain(call));

    let promoted: OutboundResult['promoted'] = [];
    if (!wasQueued) {
      const [physical, fresh] = await Promise.all([db.berths.toArray(), db.leases.toArray()]);
      promoted = await promoteQueueForPort(physical, fresh, lease.portId, new Date(atIso).getTime());
    }
    out.lease = next;
    out.call = call;
    out.promoted = promoted;
    out.wasQueued = wasQueued;
  });

  return {
    lease: out.lease as BerthLease,
    call: out.call as PortCall,
    promoted: out.promoted,
    wasQueued: out.wasQueued,
  };
}

/** 手动释放占用（渔港详情弹窗） */
export async function releaseLease(leaseId: string, reason: LeaseEndReason = '手动释放'): Promise<SweepResult> {
  const at = nowIso();
  let portId = '';
  await db.transaction('rw', db.leases, db.berths, async () => {
    const lease = await db.leases.get(leaseId);
    if (!lease || lease.status !== '生效') return;
    portId = lease.portId;
    await db.leases.put(
      toPlain({ ...lease, status: '已失效', endedAt: at, endReason: reason, version: lease.version + 1, updatedAt: at }),
    );
  });
  if (!portId) return { expired: [], promoted: [] };
  const promoted = await promoteAfterRelease(portId, new Date(at).getTime());
  return { expired: [], promoted };
}

async function promoteAfterRelease(
  portId: string,
  atMs: number,
): Promise<Array<{ lease: BerthLease; berthNo: string }>> {
  let promoted: Array<{ lease: BerthLease; berthNo: string }> = [];
  await db.transaction('rw', db.leases, db.berths, db.calls, async () => {
    const [physical, fresh] = await Promise.all([db.berths.toArray(), db.leases.toArray()]);
    promoted = await promoteQueueForPort(physical, fresh, portId, atMs);
  });
  return promoted;
}

/** 泊位维修开关：占用中禁止转为维修；恢复可用时触发补位 */
export async function setBerthMaintenance(berthId: string, maintenance: boolean): Promise<void> {
  let portId = '';
  await db.transaction('rw', db.leases, db.berths, async () => {
    const berth = await db.berths.get(berthId);
    if (!berth) return;
    portId = berth.portId;
    if (maintenance) {
      const holder = await db.leases
        .where('status')
        .equals('生效')
        .filter((l) => l.portId === berth.portId && l.berthNo === berth.berthNo)
        .first();
      if (holder) throw new Error(`泊位 ${berth.berthNo} 仍有在港船舶，请先办理出港或释放租约`);
    }
    berth.status = maintenance ? '维修' : '空闲';
    await db.berths.put(toPlain(berth));
  });
  if (!maintenance && portId) await promoteAfterRelease(portId, Date.now());
}

/** 演示用：把某租约的心跳拨到失联阈值之前，下次巡检即判窗口失联 */
export async function simulateWindowLost(leaseId: string): Promise<void> {
  const lease = await db.leases.get(leaseId);
  if (!lease || lease.status !== '生效') return;
  await db.leases.put(
    toPlain({
      ...lease,
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      version: lease.version + 1,
      updatedAt: nowIso(),
    }),
  );
}
