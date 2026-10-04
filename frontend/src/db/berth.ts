import type { FishingPort } from '../types/port';
import type { Berth } from '../types/berth';
import type { BerthLease } from '../types/lease';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export interface SeedOccupancy {
  berthNo: string;
  vesselId: string;
  vesselName: string;
  /** 演示占用已靠泊时长（小时），用于生成租约时间 */
  hoursAgo: number;
  /** 预计离港还剩多少小时 */
  hoursLeft: number;
}

/**
 * 演示数据中的初始在港租约（v4 起占用全部走 leases 账本，
 * 维修泊位通过 SEED_MAINTENANCE 单独描述）。
 */
export const SEED_OCCUPANCY: Record<string, SeedOccupancy[]> = {
  'p-1001': [
    { berthNo: 'B01', vesselId: 'v-2001', vesselName: '浙象渔05123', hoursAgo: 5, hoursLeft: 19 },
    { berthNo: 'B02', vesselId: 'v-2005', vesselName: '浙象渔05288', hoursAgo: 3, hoursLeft: 21 },
  ],
  'p-1002': [
    { berthNo: 'B01', vesselId: 'v-2002', vesselName: '浙普渔13208', hoursAgo: 2, hoursLeft: 22 },
    { berthNo: 'B02', vesselId: 'v-2006', vesselName: '浙普渔13566', hoursAgo: 26, hoursLeft: 20 },
  ],
  'p-1003': [{ berthNo: 'B01', vesselId: 'v-2003', vesselName: '浙岱渔07156', hoursAgo: 1, hoursLeft: 23 }],
  'p-1004': [],
};

/** 演示数据中的维修泊位 */
export const SEED_MAINTENANCE: Record<string, string[]> = {
  'p-1001': ['B04'],
  'p-1002': ['B06'],
};

/**
 * 按渔港登记的泊位数生成物理泊位记录（初始播种与 Dexie v3 迁移共用）。
 * v4 起泊位只描述物理属性，占用一律以租约账本为准。
 */
export function buildBerthRecords(port: FishingPort): Berth[] {
  const maintenance = new Set(SEED_MAINTENANCE[port.id] ?? []);
  const records: Berth[] = [];
  for (let i = 1; i <= port.berthCount; i++) {
    const berthNo = `B${pad2(i)}`;
    records.push({
      id: `${port.id}-${berthNo}`,
      portId: port.id,
      berthNo,
      status: maintenance.has(berthNo) ? '维修' : '空闲',
      designDepth: port.berthDepth,
    });
  }
  return records;
}

/**
 * 按演示占用生成生效租约（新库播种使用；v3→v4 迁移在 db/index.ts 中就地转写）。
 */
export function buildSeedLeases(port: FishingPort): BerthLease[] {
  const nowIso = new Date().toISOString();
  return (SEED_OCCUPANCY[port.id] ?? []).map((o) => ({
    id: `l-${port.id}-${o.berthNo}`,
    portId: port.id,
    berthNo: o.berthNo,
    vesselId: o.vesselId,
    vesselName: o.vesselName,
    status: '生效',
    berthAt: hoursAgo(o.hoursAgo),
    queuedAt: null,
    expectedLeaveAt: hoursFromNow(o.hoursLeft),
    endedAt: null,
    endReason: '',
    windowId: 'seed',
    heartbeatAt: nowIso,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}
