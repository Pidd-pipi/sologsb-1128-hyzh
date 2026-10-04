import type { FishingPort } from '../types/port';
import type { Berth } from '../types/berth';
import type { BerthLease } from '../types/lease';
import { uid } from '../utils/format';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/** 演示数据中的初始占用 / 维修泊位 */
export interface SeedOccupancy {
  berthNo: string;
  vesselId: string;
  vesselName: string;
  /** 占用 / 维修 */
  status: '占用' | '维修';
  berthAt: string;
  /** 预计离港时间（相对靠泊时间的小时数）；不传表示不自动失效 */
  leaseHours?: number;
}

export const SEED_OCCUPANCY: Record<string, SeedOccupancy[]> = {
  'p-1001': [
    { berthNo: 'B01', vesselId: 'v-2001', vesselName: '浙象渔05123', status: '占用', berthAt: hoursAgo(5), leaseHours: 12 },
    { berthNo: 'B02', vesselId: 'v-2005', vesselName: '浙象渔05288', status: '占用', berthAt: hoursAgo(3), leaseHours: 12 },
    { berthNo: 'B04', vesselId: '', vesselName: '', status: '维修', berthAt: '' },
  ],
  'p-1002': [
    { berthNo: 'B01', vesselId: 'v-2002', vesselName: '浙普渔13208', status: '占用', berthAt: hoursAgo(2), leaseHours: 12 },
    { berthNo: 'B02', vesselId: 'v-2006', vesselName: '浙普渔13566', status: '占用', berthAt: hoursAgo(26), leaseHours: 12 },
    { berthNo: 'B06', vesselId: '', vesselName: '', status: '维修', berthAt: '' },
  ],
  'p-1003': [
    { berthNo: 'B01', vesselId: 'v-2003', vesselName: '浙岱渔07156', status: '占用', berthAt: hoursAgo(1), leaseHours: 12 },
  ],
  'p-1004': [],
};

/**
 * 按渔港登记的泊位数生成泊位记录。
 * 注意：v3→v4 升级依赖这里保留「占用」标记，v4 迁移据此回填 system 租约后再把
 * 物理泊位状态归一化为空闲；首次播种（seed.ts）不想要占用字段，会自行归一化。
 */
export function buildBerthRecords(
  port: FishingPort,
  occupancy: SeedOccupancy[] = SEED_OCCUPANCY[port.id] ?? [],
): Berth[] {
  const records: Berth[] = [];
  for (let i = 1; i <= port.berthCount; i++) {
    const berthNo = `B${pad2(i)}`;
    const hit = occupancy.find((o) => o.berthNo === berthNo);
    records.push({
      id: `${port.id}-${berthNo}`,
      portId: port.id,
      berthNo,
      // 仅维修/空闲是物理状态；占用仅用于 v3 升级中间态（v4 会转为租约）
      status: hit?.status === '维修' ? '维修' : hit?.status === '占用' ? '占用' : '空闲',
      designDepth: port.berthDepth,
    });
  }
  return records;
}

interface LegacyBerthLike {
  portId: string;
  berthNo: string;
  status: string;
  vesselId?: string | null;
  vesselName?: string | null;
  berthAt?: string | null;
  designDepth?: number;
}

/**
 * v4 迁移：把旧版「占用」泊位回填成 system 靠泊租约。
 * 旧版没有预计离港时间，回填租约不自动失效（agentId=null 且 expectedLeaveAt=null）。
 */
export function leasesFromLegacyBerths(berths: LegacyBerthLike[]): BerthLease[] {
  const now = new Date().toISOString();
  return berths
    .filter((b) => b.status === '占用' && b.vesselId)
    .map((b) => ({
      id: uid('l'),
      portId: b.portId,
      berthNo: b.berthNo,
      vesselId: b.vesselId as string,
      vesselName: b.vesselName ?? '',
      state: '靠泊' as const,
      berthAt: b.berthAt ?? now,
      leaveAt: null,
      expectedLeaveAt: null,
      closeReason: null,
      agentId: null,
      enqueuedAt: null,
      createdAt: now,
      updatedAt: now,
    }));
}
