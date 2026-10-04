/* v4 迁移验证（Node + fake-indexeddb）：
   先按 v3 旧结构写库（berths 自带占用字段、calls 无 portId/leaseId），
   再打开新版 db 触发升级，校验旧占用转为 system 租约、空泊位号流水保持未分配。 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  // 1) 用旧 schema（v3）建库并写入旧数据
  const oldDb = new Dexie('gbfishport-db');
  oldDb.version(3).stores({
    ports: 'id, name, level, shelterLevel',
    vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    calls: 'id, vesselId, type, time',
    berths: 'id, portId, berthNo, status, vesselId',
  });
  await (oldDb as any).ports.bulkPut([
    {
      id: 'p1', name: '旧渔港', level: '二级渔港', longitude: 121, latitude: 29,
      berthCount: 2, berthDepth: 4, wharfLength: 100, shelterLevel: 9,
      supply: { fuel: false, ice: false, water: false }, manager: 'm',
      createdAt: new Date().toISOString(),
    },
  ]);
  await (oldDb as any).berths.bulkPut([
    {
      id: 'p1-B01', portId: 'p1', berthNo: 'B01', status: '占用',
      vesselId: 'v1', vesselName: '旧船01', berthAt: new Date().toISOString(), leaveAt: null, designDepth: 4,
    },
    {
      id: 'p1-B02', portId: 'p1', berthNo: 'B02', status: '空闲',
      vesselId: null, vesselName: null, berthAt: null, leaveAt: null, designDepth: 4,
    },
  ]);
  await (oldDb as any).calls.bulkPut([
    {
      id: 'c1', vesselId: 'v1', vesselName: '旧船01', type: '进港',
      time: new Date().toISOString(), berthNo: 'B01',
      iceKg: 10, fuelL: 20, unloadKg: 30, visaStatus: '已签证',
      createdAt: new Date().toISOString(),
    },
    {
      // 旧航次没有泊位号，也没有 portId
      id: 'c2', vesselId: 'v1', vesselName: '旧船01', type: '出港',
      time: new Date().toISOString(), berthNo: '',
      iceKg: 0, fuelL: 5, unloadKg: 0, visaStatus: '待签证',
      createdAt: new Date().toISOString(),
    },
  ]);
  oldDb.close();

  // 2) 打开新版 db（首次查询触发 v3→v4 升级）
  const { db } = await import('../src/db');
  const { effectiveBerths } = await import('../src/services/occupancy');

  const leases = await db.leases.toArray();
  check('旧占用泊位回填为 1 条 system 靠泊租约', leases.length === 1 && leases[0].state === '靠泊');
  check('回填租约指向 B01 / 旧船01', leases[0].berthNo === 'B01' && leases[0].vesselId === 'v1');
  check('system 租约 agentId 与预计离港均为空（不参与失联/超时）', leases[0].agentId === null && leases[0].expectedLeaveAt === null);

  const b01 = await db.berths.get('p1-B01');
  check('物理泊位 B01 回归「空闲」（占用以租约为准）', b01!.status === '空闲');
  check('旧占用字段已清除', (b01 as any).vesselId === undefined);

  const eff = effectiveBerths(await db.berths.toArray(), leases);
  check('生效占用推导：B01 仍占用、B02 空闲', eff[0].status === '占用' && eff[1].status === '空闲');
  check('生效占用记录在港船数为 1', eff.filter((b) => b.status === '占用').length === 1);

  const c1 = await db.calls.get('c1');
  check('有泊位号的旧流水按租约回填 portId', c1!.portId === 'p1');
  check('旧流水补上 leaseId 字段', c1!.leaseId === '');

  const c2 = await db.calls.get('c2');
  check('无泊位号旧航次 portId 保持空（按未分配处理）', c2!.portId === '' && c2!.berthNo === '');

  const meta = await db.ledgerMeta.get('p1');
  check('账本元信息建立，版本号从 1 开始', !!meta && meta.version === 1);

  console.log(failures === 0 ? '\n迁移验证全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

void main();
