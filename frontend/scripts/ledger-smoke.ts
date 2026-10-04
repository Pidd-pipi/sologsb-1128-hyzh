/* 运行时验证（Node + fake-indexeddb，不进生产包）：
   1. 进港按最新状态抢占泊位，容量满排队（FIFO）
   2. 版本号乐观锁：旧版本保存抛错而不是覆盖
   3. 同一渔船未结束航次拒绝重复靠泊
   4. 出港释放租约并自动调度队首，回填进港流水泊位号
   5. 超过预计离港时间 / 窗口失联 → 租约失效、占用释放、重算在港船数
   6. 生效占用只认租约，排队/未分配不挤占容量
*/
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import type { FishingPort } from '../src/types/port';
import type { FishingVessel } from '../src/types/vessel';
import type { CallDraft } from '../src/types/call';
import type { BerthLease } from '../src/types/lease';
import { buildBerthRecords } from '../src/db/berth';
import { effectiveBerths } from '../src/services/occupancy';
import {
  LedgerStaleError,
  registerArrival,
  closeLease,
  sweepLedger,
  VesselActiveError,
} from '../src/services/ledger';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}
function draft(partial: Partial<CallDraft>): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    portId: '',
    time: '',
    expectedLeaveAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    berthNo: '',
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    ...partial,
  };
}

function port(id: string, berthCount: number): FishingPort {
  return {
    id, name: id, level: '二级渔港', longitude: 121, latitude: 29,
    berthCount, berthDepth: 4, wharfLength: 100, shelterLevel: 9,
    supply: { fuel: false, ice: false, water: false }, manager: 'm',
    createdAt: new Date().toISOString(),
  };
}
function vessel(id: string): FishingVessel {
  return {
    id, name: id, vesselNo: id, homePort: 'p', length: 20, beam: 5,
    grossTonnage: 80, enginePower: 120, operationType: '拖网',
    hullMaterial: '钢质', owner: 'o', certificateExpiry: '2027-01-01',
    createdAt: new Date().toISOString(),
  };
}

async function seedPort(id: string, count: number, vesselIds: string[]): Promise<void> {
  const p = port(id, count);
  await db.ports.put(p);
  await db.berths.bulkPut(buildBerthRecords(p, []));
  await db.ledgerMeta.put({ portId: id, version: 1, updatedAt: new Date().toISOString() });
  for (const vid of vesselIds) await db.vessels.put(vessel(vid));
}

async function main(): Promise<void> {
  await seedPort('p1', 2, ['v1', 'v2', 'v3']);
  await seedPort('p2', 1, ['v4', 'v5']);
  await seedPort('p3', 1, ['v6']);

  console.log('1) 进港抢占与容量满排队');
  const r1 = await registerArrival(draft({ vesselId: 'v1', portId: 'p1' }), 'v1船', 'w-1', 1);
  check('v1 抢占最小泊位 B01', r1.outcome === 'docked' && r1.lease.berthNo === 'B01');
  check('账本版本号自增到 2', r1.version === 2);
  const call1 = await db.calls.filter((c) => c.leaseId === r1.lease.id).first();
  check('进港流水已写且带 portId/泊位号', !!call1 && call1!.portId === 'p1' && call1!.berthNo === 'B01');

  const r2 = await registerArrival(draft({ vesselId: 'v2', portId: 'p1' }), 'v2船', 'w-1', 2);
  check('v2 抢占 B02', r2.lease.berthNo === 'B02');
  const r3 = await registerArrival(draft({ vesselId: 'v3', portId: 'p1' }), 'v3船', 'w-1', 3);
  check('v3 容量满进入排队', r3.outcome === 'queued' && r3.lease.state === '排队' && r3.lease.berthNo === '');
  const call3 = await db.calls.filter((c) => c.leaseId === r3.lease.id).first();
  check('排队进港流水泊位号为空（未分配，不挤占容量）', !!call3 && call3!.berthNo === '');

  const [berths1, leases1] = await Promise.all([db.berths.where('portId').equals('p1').toArray(), db.leases.where('portId').equals('p1').toArray()]);
  const eff1 = effectiveBerths(berths1, leases1);
  check('生效占用只有 B01/B02 两条，排队船不出现在泊位上', eff1.length === 2 && eff1.every((b) => b.status === '占用'));

  console.log('2) 旧版本保存被拒绝（乐观并发）');
  let stale: unknown = null;
  try {
    await registerArrival(draft({ vesselId: 'v9', portId: 'p1' }), 'v9船', 'w-2', 1);
  } catch (e) { stale = e; }
  check('抛 LedgerStaleError 而不是覆盖', stale instanceof LedgerStaleError, (stale as Error)?.message);
  const v9 = await db.vessels.get('v9');
  check('失败事务未产生任何占用', !v9 && (await db.leases.where('portId').equals('p1').count()) === 3);

  console.log('3) 同一渔船未结束航次不能重复靠泊');
  let dup: unknown = null;
  try {
    await registerArrival(draft({ vesselId: 'v1', portId: 'p2' }), 'v1船', 'w-1', 1);
  } catch (e) { dup = e; }
  check('抛 VesselActiveError', dup instanceof VesselActiveError, (dup as Error)?.message);

  console.log('4) 出港释放占用，队首 FIFO 自动靠泊并回填流水');
  const beforeDepartureVersion = (await db.ledgerMeta.get('p1'))!.version;
  let staleDeparture: unknown = null;
  try {
    await closeLease(r1.lease.id, draft({ type: '出港', portId: 'p1', vesselId: 'v1' }), 'v1船', 1, '正常离港');
  } catch (e) { staleDeparture = e; }
  check('出港也受版本号保护', staleDeparture instanceof LedgerStaleError);

  const dep = await closeLease(r1.lease.id, draft({ type: '出港', portId: 'p1', vesselId: 'v1' }), 'v1船', beforeDepartureVersion, '正常离港');
  check('v1 租约已离港', dep.lease.state === '已离港' && dep.lease.closeReason === '正常离港');
  check('队首 v3 自动靠泊', dep.promoted.length === 1 && dep.promoted[0].vesselId === 'v3' && dep.promoted[0].berthNo === 'B01');
  const v3Lease = await db.leases.get(r3.lease.id);
  check('v3 租约已转靠泊且清空入队标记', v3Lease!.state === '靠泊' && v3Lease!.berthNo === 'B01' && v3Lease!.enqueuedAt === null);
  const call3Updated = await db.calls.get(call3!.id);
  check('v3 进港流水泊位号回填为 B01', call3Updated!.berthNo === 'B01');
  const outCall = await db.calls.filter((c) => c.leaseId === r1.lease.id && c.type === '出港').first();
  check('v1 出港流水已写', !!outCall && outCall!.berthNo === 'B01');
  const [berths1b, leases1b] = await Promise.all([db.berths.where('portId').equals('p1').toArray(), db.leases.where('portId').equals('p1').toArray()]);
  const eff1b = effectiveBerths(berths1b, leases1b);
  check('在港船数重算为 2（B01 v3、B02 v2）', eff1b.filter((b) => b.status === '占用').length === 2);

  console.log('5) 超过预计离港时间 → 租约失效，释放并重排队列');
  const r4 = await registerArrival(draft({ vesselId: 'v4', portId: 'p2' }), 'v4船', 'w-1', 1);
  const r5 = await registerArrival(draft({ vesselId: 'v5', portId: 'p2' }), 'v5船', 'w-1', 2);
  check('p2 v4 靠泊 / v5 排队', r4.outcome === 'docked' && r5.outcome === 'queued');
  await db.leases.put({ ...r4.lease, expectedLeaveAt: new Date(Date.now() - 60_000).toISOString() });
  const closed = await sweepLedger();
  const closedV4 = closed.find((c) => c.lease.vesselId === 'v4');
  check('v4 因「超过预计离港时间」失效', !!closedV4 && closedV4!.reason === '超过预计离港时间');
  const v4Final = await db.leases.get(r4.lease.id);
  check('v4 状态已失效且记录离港时间', v4Final!.state === '已失效' && !!v4Final!.leaveAt);
  const expiredCall = await db.calls.filter((c) => c.leaseId === r4.lease.id && c.leaseExpired === true).first();
  check('失效自动补记出港流水', !!expiredCall && expiredCall!.type === '出港');
  const v5Final = await db.leases.get(r5.lease.id);
  check('释放后队首 v5 自动靠泊 B01', v5Final!.state === '靠泊' && v5Final!.berthNo === 'B01');
  check('扫描结果标记发生了出泊', closedV4!.promoted === true);

  console.log('6) 窗口失联（心跳超时）→ 租约失效');
  const r6 = await registerArrival(draft({ vesselId: 'v6', portId: 'p3' }), 'v6船', 'w-dead', (await db.ledgerMeta.get('p3'))!.version);
  await db.agents.put({ id: 'w-dead', at: new Date(Date.now() - 60_000).toISOString() });
  const closed2 = await sweepLedger();
  const closedV6 = closed2.find((c) => c.lease.id === r6.lease.id);
  check('v6 因「窗口失联」失效', !!closedV6 && closedV6!.reason === '窗口失联');
  check('过期心跳已清理', (await db.agents.get('w-dead')) === undefined);
  const [berths3, leases3] = await Promise.all([db.berths.where('portId').equals('p3').toArray(), db.leases.where('portId').equals('p3').toArray()]);
  check('p3 在港船数重算为 0', effectiveBerths(berths3, leases3).every((b) => b.status === '空闲'));

  console.log('7) system 租约（无窗口、无预计离港）不被扫描误杀');
  const sysLease: BerthLease = {
    id: 'l-sys', portId: 'p3', berthNo: 'B01', vesselId: 'v4', vesselName: '系统船',
    state: '靠泊', berthAt: new Date().toISOString(), leaveAt: null, expectedLeaveAt: null,
    closeReason: null, agentId: null, enqueuedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await db.leases.put(sysLease);
  await sweepLedger();
  const sysFinal = await db.leases.get('l-sys');
  check('system 租约保持靠泊', sysFinal!.state === '靠泊');

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

void main();
