/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 进出港记录（流水） */
export interface PortCall {
  id: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /**
   * 泊位号；空串表示未分配泊位（排队进港 / 旧航次补录），
   * 未分配航次不挤占泊位容量。
   */
  berthNo: string;
  /** 所属渔港 id；v4 之前的旧流水可能没有，按未匹配渔港处理 */
  portId?: string;
  /** 关联的占用租约 id */
  leaseId?: string;
  /** 进港时填写的预计离港时间（ISO 字符串），仅进港流水有值 */
  expectedLeaveAt?: string | null;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  /** 进港渔港；排队进港也要指定渔港 */
  portId: string;
  berthNo: string;
  /** 出港时选择的在港租约 id */
  leaseId?: string;
  /** 预计离港时间（YYYY-MM-DDTHH:mm） */
  expectedLeaveAt: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
  /** 打开表单时读到的账本快照版本，旧版本保存时用于冲突判定 */
  expectedVersion: number | null;
  /** 打开表单时目标泊位的占用者（空泊位为 null） */
  expectedHolder: string | null;
}

export function emptyCallDraft(berthNo = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    portId: '',
    berthNo,
    expectedLeaveAt: '',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    expectedVersion: null,
    expectedHolder: null,
  };
}
