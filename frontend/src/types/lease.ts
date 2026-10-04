/**
 * 泊位占用账本（带租约与版本号）。
 *
 * - 一份 BerthLease = 一条在港航次占用账：进港时抢占写入，出港 / 租约失效时关闭。
 * - version 为乐观锁版本号：值班窗口按自己打开表单时看到的版本提交，
 *   期间账本已被别的窗口改动则抛 OccupancyConflictError，提示刷新而不是覆盖。
 * - 容量满时进港不允许抢占，状态置为「排队」，不占用泊位、不计入在港船数；
 *   一旦有泊位释放，队列按 FIFO 自动补位。
 */

/** 租约状态 */
export type LeaseStatus = '生效' | '排队' | '已出港' | '已失效';

export const LEASE_STATUSES: LeaseStatus[] = ['生效', '排队', '已出港', '已失效'];

/** 租约失效原因 */
export type LeaseEndReason = '出港' | '超时失效' | '失联失效' | '手动释放' | '';

/** 值班窗口失联判定阈值（ms）：租约最后一次心跳早于该值即视为窗口失联 */
export const LEASE_OFFLINE_MS = 60 * 1000;

/** 心跳写入间隔（ms） */
export const LEASE_HEARTBEAT_MS = 15 * 1000;

/** 默认预计离港时长（小时） */
export const DEFAULT_LEASE_HOURS = 24;

/** 泊位占用账（一条记录对应一条未结束 / 已结束的在港航次） */
export interface BerthLease {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号；排队时为 null（未分配，不占容量） */
  berthNo: string | null;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余） */
  vesselName: string;
  /** 生效 / 排队（未结束航次）；已出港 / 已失效（已结束） */
  status: LeaseStatus;
  /** 靠泊时间（排队补位成功时更新为补位时间，ISO 字符串） */
  berthAt: string;
  /** 入队时间（排队态记录，补位后保留，ISO 字符串） */
  queuedAt: string | null;
  /** 预计离港时间（超过即超时失效，ISO 字符串） */
  expectedLeaveAt: string;
  /** 实际结束时间（ISO 字符串） */
  endedAt: string | null;
  /** 结束原因 */
  endReason: LeaseEndReason;
  /** 登记窗口标识（一个浏览器标签页 = 一个值班窗口） */
  windowId: string;
  /** 最后一次心跳（ISO 字符串），窗口在线时周期刷新 */
  heartbeatAt: string;
  /** 乐观锁版本号：每次修改 +1 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 进港登记入参 */
export interface LeaseRequest {
  portId: string;
  vesselId: string;
  vesselName: string;
  /** 指定泊位号；不传 / 空串表示由账本自动分配，容量满则排队 */
  berthNo?: string | null;
  /** 进港时间（ISO 字符串） */
  berthAt: string;
  /** 预计离港时间（ISO 字符串） */
  expectedLeaveAt: string;
  /** 登记窗口标识 */
  windowId: string;
  /** 打开登记表单时读到的账本版本（泊位记录版本），用于乐观锁 */
  expectedVersion?: number;
  /** 打开表单时该泊位的占用者（空泊位为 null），与当前占用者不同即视为过期保存 */
  expectedHolder?: string | null;
}

/** 登记结果 */
export interface LeaseResult {
  lease: BerthLease;
  /** queued 表示容量已满进入排队 */
  queued: boolean;
}

/** 账本打开时的快照（供登记表单做乐观锁基准） */
export interface OccupancySnapshot {
  /** 聚焦泊位记录的版本号；未指定泊位时为 null */
  berthVersion: number | null;
  /** 聚焦泊位当前的占用者（空泊位为 null） */
  holderId: string | null;
  /** 该渔港当前生效占用数 */
  occupied: number;
  /** 该渔港可用容量（物理泊位中非维修数） */
  capacity: number;
  /** 快照时间（ISO 字符串） */
  at: string;
}

/** 旧版本保存冲突：提示刷新而不是覆盖 */
export class OccupancyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OccupancyConflictError';
  }
}

/** 同一渔船存在未结束航次 */
export class VesselOpenVoyageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VesselOpenVoyageError';
  }
}

/** 租约是否未结束（生效或排队） */
export function isOpenLease(lease: Pick<BerthLease, 'status'>): boolean {
  return lease.status === '生效' || lease.status === '排队';
}

/**
 * 租约在给定时刻是否应当失效：
 * 超过预计离港时间，或登记窗口失联（心跳超时）。
 */
export function isLeaseStale(lease: BerthLease, nowMs: number): boolean {
  if (lease.status !== '生效') return false;
  if (new Date(lease.expectedLeaveAt).getTime() <= nowMs) return true;
  if (nowMs - new Date(lease.heartbeatAt).getTime() >= LEASE_OFFLINE_MS) return true;
  return false;
}

/** 失效原因：优先判定超时离港，其次窗口失联 */
export function staleReason(lease: BerthLease, nowMs: number): LeaseEndReason {
  if (new Date(lease.expectedLeaveAt).getTime() <= nowMs) return '超时失效';
  return '失联失效';
}
