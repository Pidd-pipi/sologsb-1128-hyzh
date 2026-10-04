/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 进出港记录（流水） */
export interface PortCall {
  id: string;
  /** 渔港 id；旧版本流水可能为空字符串（按未分配处理） */
  portId: string;
  /** 对应租约 id；旧版本流水为空字符串 */
  leaseId: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 泊位号；为空表示未分配泊位（不挤占容量） */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  /** 租约是否因窗口失联 / 超过预计离港时间而失效（失效补记的出港流水） */
  leaseExpired?: boolean;
  createdAt: string;
}

/** 进出港登记表单模型（窗口只选渔港，泊位由账本按最新状态抢占） */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  /** 渔港 id */
  portId: string;
  time: string;
  /** 预计离港时间（datetime-local），进港时需要 */
  expectedLeaveAt: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
}

/** 进港时默认租约时长（毫秒） */
export const DEFAULT_LEASE_DURATION_MS = 12 * 60 * 60 * 1000;

export function emptyCallDraft(portId = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    portId,
    time: '',
    expectedLeaveAt: '',
    berthNo: '',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
  };
}

/** 旧版本流水没有泊位号时，按未分配处理，不能挤占容量 */
export function callBerthAssigned(call: PortCall): boolean {
  return Boolean(call.berthNo && call.berthNo.trim());
}
