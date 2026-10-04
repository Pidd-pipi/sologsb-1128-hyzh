/** 租约状态 */
export type LeaseState = '靠泊' | '排队' | '已离港' | '已失效';

/** 生效中的租约状态（占用容量 / 排队等位） */
export const ACTIVE_LEASE_STATES: LeaseState[] = ['靠泊', '排队'];

/** 租约结束原因 */
export type LeaseCloseReason = '正常离港' | '窗口失联' | '超过预计离港时间' | '人工释放';

/**
 * 泊位占用租约：泊位占用账本中的一条记录。
 * - state === '靠泊'：实际占用 berthNo，计入在港船数与容量
 * - state === '排队'：berthNo 为空，容量满时排队等位，不占容量
 * - state === '已离港' / '已失效'：租约结束，占用释放，仅留审计痕迹
 */
export interface BerthLease {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号；排队期间为空字符串 */
  berthNo: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余） */
  vesselName: string;
  /** 租约状态 */
  state: LeaseState;
  /** 靠泊 / 入队时间（ISO） */
  berthAt: string;
  /** 租约结束时间（ISO），生效中为 null */
  leaveAt: string | null;
  /** 预计离港时间（ISO），超过后租约失效；system 租约可为 null 表示不自动失效 */
  expectedLeaveAt: string | null;
  /** 结束原因 */
  closeReason: LeaseCloseReason | null;
  /** 登记窗口 id；system 租约（演示数据/迁移回填）为 null，不因窗口失联失效 */
  agentId: string | null;
  /** 入队序号（仅排队/曾排队用，按先进先出抢占空泊位） */
  enqueuedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 每个渔港一份的账本元信息：版本号做乐观并发控制 */
export interface LedgerMeta {
  /** 主键：渔港 id */
  portId: string;
  /** 账本版本号，每次抢占 / 释放 / 排队 / 出队都 +1 */
  version: number;
  updatedAt: string;
}

/** 值班窗口心跳：用于判定窗口是否失联 */
export interface AgentHeartbeat {
  /** 窗口 id */
  id: string;
  /** 最近一次心跳时间（ISO） */
  at: string;
}

/** 进港登记结果 */
export interface ArrivalResult {
  lease: BerthLease;
  /** docked=已抢占泊位；queued=容量已满进入排队 */
  outcome: 'docked' | 'queued';
  /** 提交后账本最新版本 */
  version: number;
}

/** 租约失效（窗口失联 / 超预计离港）信息，用于流水补记与提示 */
export interface ClosedLease {
  lease: BerthLease;
  reason: LeaseCloseReason;
  /** 是否连带把队首船调度进了空泊位 */
  promoted: boolean;
}
