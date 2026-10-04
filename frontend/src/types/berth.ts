import type { BerthLease } from './lease';

/** 物理泊位状态（仅维修标记仍持久化在泊位台账上；占用由租约账本派生） */
export type BerthStatus = '空闲' | '占用' | '维修';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修'];

/** 物理泊位记录：描述泊位本身；占用状态来自生效租约 */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 物理状态：维修由人工维护；占用 / 空闲以租约账本为准（迁移旧数据保留该字段） */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
  /** v3 时代的冗余占用字段，v4 起以租约账本为准，仅迁移兜底使用 */
  vesselId?: string | null;
  vesselName?: string | null;
  berthAt?: string | null;
  leaveAt?: string | null;
}

/**
 * 生效泊位视图：物理泊位台账 × 生效租约账本 的唯一派生结果。
 * 港口详情、地图、流水、渔船档案都读这一份，不再各算各的。
 */
export interface LiveBerth extends Berth {
  /** 派生状态：有生效租约 → 占用；物理维修 → 维修；否则空闲 */
  status: BerthStatus;
  /** 当前生效租约（占用时有值） */
  lease: BerthLease | null;
  vesselId: string | null;
  vesselName: string | null;
  /** 靠泊时间（生效租约的 berthAt） */
  berthAt: string | null;
  /** 预计离港时间 */
  expectedLeaveAt: string | null;
  /** 租约版本号 */
  leaseVersion: number | null;
}

/** 排队中的占用（容量满，未分配泊位，不占容量） */
export type WaitingEntry = BerthLease;

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 占用率 0-1（生效占用 / 可用容量） */
  occupancyRate: number;
  /** 在港船舶数量（= 生效租约数；未分配航次与排队不计入） */
  inPortCount: number;
  /** 容量（非维修泊位数） */
  capacity: number;
  /** 排队船舶数 */
  waitingCount: number;
  freeBerths: LiveBerth[];
  occupiedBerths: LiveBerth[];
  waitingLeases: WaitingEntry[];
}
