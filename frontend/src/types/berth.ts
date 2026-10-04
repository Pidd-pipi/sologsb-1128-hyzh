/** 泊位物理状态（空闲/占用由生效租约推导，维修为人工设置） */
export type BerthStatus = '空闲' | '占用' | '维修';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修'];

/** 泊位记录（物理泊位清单；占用信息以生效租约账本为准） */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 物理状态：仅 维修 由人工维护；占用 / 空闲为冗余展示位，以生效占用推导为准 */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
}

/** 生效占用视角下的泊位（物理泊位 + 生效靠泊租约推导） */
export interface EffectiveBerth extends Berth {
  /** 当前生效占用租约（无则 null） */
  leaseId: string | null;
  vesselId: string | null;
  vesselName: string | null;
  /** 靠泊时间（ISO） */
  berthAt: string | null;
  /** 预计离港时间（ISO） */
  expectedLeaveAt: string | null;
  /** 登记窗口 id（system 租约为 null） */
  agentId: string | null;
}

/** 泊位占用聚合结果（useBerthStatus 输出，读取同一份生效占用） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 排队等泊船舶数量 */
  waiting: number;
  /** 占用率 0-1（占用 / 可用容量，维修泊位不进分母） */
  occupancyRate: number;
  /** 在港船舶数量（= 生效靠泊租约数） */
  inPortCount: number;
  freeBerths: EffectiveBerth[];
  occupiedBerths: EffectiveBerth[];
}
