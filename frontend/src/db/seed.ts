import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { BerthLease } from '../types/lease';
import { toPlain } from '../utils/format';
import { db } from './index';
import { buildBerthRecords, SEED_OCCUPANCY, type SeedOccupancy } from './berth';

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}
function hoursAgo(hours: number): string {
  return hoursFromNow(-hours);
}
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

/** 初始渔港 */
export const SEED_PORTS: FishingPort[] = [
  {
    id: 'p-1001',
    name: '石浦中心渔港',
    level: '中心渔港',
    longitude: 121.9437,
    latitude: 29.2119,
    berthCount: 6,
    berthDepth: 5.5,
    wharfLength: 420,
    shelterLevel: 12,
    supply: { fuel: true, ice: true, water: true },
    manager: '象山县渔港管理站',
    createdAt: daysAgo(420),
  },
  {
    id: 'p-1002',
    name: '沈家门中心渔港',
    level: '中心渔港',
    longitude: 122.2979,
    latitude: 29.9447,
    berthCount: 8,
    berthDepth: 6.2,
    wharfLength: 680,
    shelterLevel: 11,
    supply: { fuel: true, ice: true, water: false },
    manager: '普陀区渔港服务中心',
    createdAt: daysAgo(365),
  },
  {
    id: 'p-1003',
    name: '岱山高亭渔港',
    level: '一级渔港',
    longitude: 122.2031,
    latitude: 30.2567,
    berthCount: 5,
    berthDepth: 4.8,
    wharfLength: 300,
    shelterLevel: 10,
    supply: { fuel: false, ice: true, water: true },
    manager: '岱山县渔业合作社',
    createdAt: daysAgo(280),
  },
  {
    id: 'p-1004',
    name: '温岭石塘渔港',
    level: '二级渔港',
    longitude: 121.6612,
    latitude: 28.3407,
    berthCount: 4,
    berthDepth: 3.9,
    wharfLength: 210,
    shelterLevel: 9,
    supply: { fuel: false, ice: false, water: true },
    manager: '温岭市石塘镇渔业服务站',
    createdAt: daysAgo(150),
  },
];

/** 初始渔船档案 */
export const SEED_VESSELS: FishingVessel[] = [
  {
    id: 'v-2001',
    name: '浙象渔05123',
    vesselNo: 'ZXY05123',
    homePort: '石浦',
    length: 32.5,
    beam: 6.4,
    grossTonnage: 168,
    enginePower: 268,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '林海平',
    certificateExpiry: '2027-06-30',
    createdAt: daysAgo(300),
  },
  {
    id: 'v-2002',
    name: '浙普渔13208',
    vesselNo: 'ZPY13208',
    homePort: '沈家门',
    length: 28.6,
    beam: 5.8,
    grossTonnage: 120,
    enginePower: 202,
    operationType: '围网',
    hullMaterial: '钢质',
    owner: '王阿明',
    certificateExpiry: '2026-11-15',
    createdAt: daysAgo(260),
  },
  {
    id: 'v-2003',
    name: '浙岱渔07156',
    vesselNo: 'ZDY07156',
    homePort: '高亭',
    length: 24.2,
    beam: 5.1,
    grossTonnage: 88,
    enginePower: 158,
    operationType: '刺网',
    hullMaterial: '木质',
    owner: '郑友良',
    certificateExpiry: '2026-02-28',
    createdAt: daysAgo(210),
  },
  {
    id: 'v-2004',
    name: '浙岭渔09342',
    vesselNo: 'ZLY09342',
    homePort: '石塘',
    length: 19.8,
    beam: 4.6,
    grossTonnage: 56,
    enginePower: 96,
    operationType: '钓具',
    hullMaterial: '玻璃钢',
    owner: '陈小军',
    certificateExpiry: '2027-03-20',
    createdAt: daysAgo(180),
  },
  {
    id: 'v-2005',
    name: '浙象渔05288',
    vesselNo: 'ZXY05288',
    homePort: '石浦',
    length: 35.0,
    beam: 6.8,
    grossTonnage: 196,
    enginePower: 330,
    operationType: '拖网',
    hullMaterial: '钢质',
    owner: '张卫国',
    certificateExpiry: '2028-01-10',
    createdAt: daysAgo(120),
  },
  {
    id: 'v-2006',
    name: '浙普渔13566',
    vesselNo: 'ZPY13566',
    homePort: '沈家门',
    length: 21.5,
    beam: 4.9,
    grossTonnage: 72,
    enginePower: 132,
    operationType: '围网',
    hullMaterial: '铝合金',
    owner: '刘建军',
    certificateExpiry: '2026-08-05',
    createdAt: daysAgo(90),
  },
  {
    id: 'v-2007',
    name: '浙岱渔07612',
    vesselNo: 'ZDY07612',
    homePort: '高亭',
    length: 26.4,
    beam: 5.4,
    grossTonnage: 98,
    enginePower: 176,
    operationType: '刺网',
    hullMaterial: '钢质',
    owner: '方阿毛',
    certificateExpiry: '2027-09-01',
    createdAt: daysAgo(60),
  },
  {
    id: 'v-2008',
    name: '浙岱渔07833',
    vesselNo: 'ZDY07833',
    homePort: '高亭',
    length: 22.7,
    beam: 4.8,
    grossTonnage: 76,
    enginePower: 142,
    operationType: '围网',
    hullMaterial: '木质',
    owner: '沈海峰',
    certificateExpiry: '2028-04-15',
    createdAt: daysAgo(40),
  },
];

/** 初始租约（system：agentId=null，不因窗口失联失效；预计离港时间决定超时） */
export const SEED_LEASES: BerthLease[] = [
  {
    id: 'l-4001',
    portId: 'p-1001',
    berthNo: 'B01',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    state: '靠泊',
    berthAt: hoursAgo(5),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(5),
  },
  {
    id: 'l-4002',
    portId: 'p-1001',
    berthNo: 'B02',
    vesselId: 'v-2005',
    vesselName: '浙象渔05288',
    state: '靠泊',
    berthAt: hoursAgo(3),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(3),
  },
  {
    id: 'l-4003',
    portId: 'p-1002',
    berthNo: 'B01',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    state: '靠泊',
    berthAt: hoursAgo(2),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
  },
  {
    // 已超过预计离港时间：首次账本扫描即失效，释放 B02 并重算在港船数
    id: 'l-4004',
    portId: 'p-1002',
    berthNo: 'B02',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    state: '靠泊',
    berthAt: hoursAgo(26),
    leaveAt: null,
    expectedLeaveAt: hoursAgo(2),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(26),
  },
  {
    id: 'l-4005',
    portId: 'p-1003',
    berthNo: 'B01',
    vesselId: 'v-2003',
    vesselName: '浙岱渔07156',
    state: '靠泊',
    berthAt: hoursAgo(1),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
  {
    id: 'l-4006',
    portId: 'p-1003',
    berthNo: 'B02',
    vesselId: 'v-2007',
    vesselName: '浙岱渔07612',
    state: '靠泊',
    berthAt: hoursAgo(1),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
  {
    // 高亭 B01/B02 已占，B03/B04 维修，容量满：新船排队等泊（不挤占容量）
    id: 'l-4007',
    portId: 'p-1003',
    berthNo: '',
    vesselId: 'v-2008',
    vesselName: '浙岱渔07833',
    state: '排队',
    berthAt: hoursAgo(1),
    leaveAt: null,
    expectedLeaveAt: hoursFromNow(48),
    closeReason: null,
    agentId: null,
    enqueuedAt: hoursAgo(1),
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  },
];

/** 高亭 B03/B04/B05 演示为维修（B01/B02 被租约占用，容量占满，触发排队） */
const SEED_EXTRA_MAINTENANCE: Record<string, string[]> = {
  'p-1003': ['B03', 'B04', 'B05'],
};

/** 初始进出港流水 */
export const SEED_CALLS: PortCall[] = [
  {
    id: 'c-3001',
    portId: 'p-1001',
    leaseId: 'l-4001',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '进港',
    time: hoursAgo(5),
    berthNo: 'B01',
    iceKg: 1200,
    fuelL: 800,
    unloadKg: 8600,
    visaStatus: '已签证',
    createdAt: hoursAgo(5),
  },
  {
    id: 'c-3002',
    portId: 'p-1001',
    leaseId: 'l-4002',
    vesselId: 'v-2005',
    vesselName: '浙象渔05288',
    type: '进港',
    time: hoursAgo(3),
    berthNo: 'B02',
    iceKg: 900,
    fuelL: 1200,
    unloadKg: 12400,
    visaStatus: '已签证',
    createdAt: hoursAgo(3),
  },
  {
    id: 'c-3003',
    portId: 'p-1002',
    leaseId: 'l-4003',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '进港',
    time: hoursAgo(2),
    berthNo: 'B01',
    iceKg: 600,
    fuelL: 0,
    unloadKg: 5200,
    visaStatus: '待签证',
    createdAt: hoursAgo(2),
  },
  {
    id: 'c-3004',
    portId: 'p-1003',
    leaseId: 'l-4005',
    vesselId: 'v-2003',
    vesselName: '浙岱渔07156',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B01',
    iceKg: 300,
    fuelL: 260,
    unloadKg: 2100,
    visaStatus: '免签',
    createdAt: hoursAgo(1),
  },
  {
    id: 'c-3005',
    portId: 'p-1004',
    leaseId: '',
    vesselId: 'v-2004',
    vesselName: '浙岭渔09342',
    type: '出港',
    time: daysAgo(1),
    berthNo: 'B02',
    iceKg: 0,
    fuelL: 420,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(1),
  },
  {
    id: 'c-3006',
    portId: 'p-1002',
    leaseId: 'l-4004',
    vesselId: 'v-2006',
    vesselName: '浙普渔13566',
    type: '进港',
    time: hoursAgo(26),
    berthNo: 'B02',
    iceKg: 480,
    fuelL: 300,
    unloadKg: 3600,
    visaStatus: '已签证',
    createdAt: hoursAgo(26),
  },
  {
    id: 'c-3007',
    portId: 'p-1001',
    leaseId: '',
    vesselId: 'v-2001',
    vesselName: '浙象渔05123',
    type: '出港',
    time: daysAgo(2),
    berthNo: 'B01',
    iceKg: 0,
    fuelL: 950,
    unloadKg: 0,
    visaStatus: '已签证',
    createdAt: daysAgo(2),
  },
  {
    id: 'c-3008',
    portId: '',
    leaseId: '',
    vesselId: 'v-2002',
    vesselName: '浙普渔13208',
    type: '出港',
    time: daysAgo(4),
    // 旧航次没有泊位号：按未分配处理，不挤占容量
    berthNo: '',
    iceKg: 200,
    fuelL: 540,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: daysAgo(4),
  },
  {
    id: 'c-3009',
    portId: 'p-1003',
    leaseId: 'l-4006',
    vesselId: 'v-2007',
    vesselName: '浙岱渔07612',
    type: '进港',
    time: hoursAgo(1),
    berthNo: 'B02',
    iceKg: 260,
    fuelL: 180,
    unloadKg: 1800,
    visaStatus: '已签证',
    createdAt: hoursAgo(1),
  },
  {
    // 排队登记：进港时容量已满，泊位号为空（未分配），不挤占容量
    id: 'c-3010',
    portId: 'p-1003',
    leaseId: 'l-4007',
    vesselId: 'v-2008',
    vesselName: '浙岱渔07833',
    type: '进港',
    time: hoursAgo(1),
    berthNo: '',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    createdAt: hoursAgo(1),
  },
];

/** 初始账本：每港版本号从 1 开始 */
export const SEED_LEDGER_META = SEED_PORTS.map((p) => ({
  portId: p.id,
  version: 1,
  updatedAt: new Date().toISOString(),
}));

/** 首次播种用：物理泊位只保留维修标记（占用由 SEED_LEASES 独立表达） */
function buildSeedBerthRecords(port: FishingPort) {
  const records = buildBerthRecords(port, SEED_OCCUPANCY[port.id] ?? []);
  for (const berth of records) {
    if (berth.status === '占用') berth.status = '空闲';
  }
  const maintenance = SEED_EXTRA_MAINTENANCE[port.id] ?? [];
  for (const no of maintenance) {
    const hit = records.find((b) => b.berthNo === no);
    if (hit) hit.status = '维修';
  }
  return records;
}

/**
 * 首次进入时写入演示数据（渔港 / 渔船 / 流水 / 物理泊位 / 占用租约 / 账本版本），
 * 并为缺少泊位记录的渔港补齐物理泊位。写库前统一 toPlain 脱代理。
 */
export async function ensureSeedData(): Promise<void> {
  const portCount = await db.ports.count();
  if (portCount === 0) {
    await db.ports.bulkPut(toPlain(SEED_PORTS));
    await db.vessels.bulkPut(toPlain(SEED_VESSELS));
    await db.calls.bulkPut(toPlain(SEED_CALLS));
    await db.leases.bulkPut(toPlain(SEED_LEASES));
    await db.ledgerMeta.bulkPut(toPlain(SEED_LEDGER_META));
    const berths = SEED_PORTS.flatMap((p) => buildSeedBerthRecords(p));
    await db.berths.bulkPut(toPlain(berths));
  }
  const ports = await db.ports.toArray();
  for (const port of ports) {
    const existing = await db.berths.where('portId').equals(port.id).count();
    if (existing === 0) {
      await db.berths.bulkPut(toPlain(buildBerthRecords(port)));
    }
    const meta = await db.ledgerMeta.get(port.id);
    if (!meta) {
      await db.ledgerMeta.put(toPlain({ portId: port.id, version: 1, updatedAt: new Date().toISOString() }));
    }
  }
}
