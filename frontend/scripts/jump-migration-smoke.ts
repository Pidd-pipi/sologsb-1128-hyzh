/* v1 → v4 跳级迁移验证：旧用户只建过 v1（ports/vessels），
   打开新版后需一次性建好物理泊位、账本元信息且不报错（占用应为空）。 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { FishPortDatabase } from '../src/db';
import { effectiveBerths } from '../src/services/occupancy';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  const DB_NAME = 'jump-test-db';
  const oldDb = new Dexie(DB_NAME);
  oldDb.version(1).stores({
    ports: 'id, name, level, shelterLevel',
    vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
  });
  await (oldDb as any).ports.put({
    id: 'p1', name: '老港', level: '二级渔港', longitude: 121, latitude: 29,
    berthCount: 3, berthDepth: 4, wharfLength: 100, shelterLevel: 9,
    supply: { fuel: false, ice: false, water: false }, manager: 'm',
    createdAt: new Date().toISOString(),
  });
  oldDb.close();

  const db = new FishPortDatabase(DB_NAME);

  const berths = await db.berths.toArray();
  check('v3 迁移补齐 3 个物理泊位', berths.length === 3, `实际 ${berths.length}`);
  check('跳级升级后无占用（无旧占用可回填）', berths.every((b) => b.status === '空闲'));
  const leases = await db.leases.toArray();
  check('无租约', leases.length === 0);
  const meta = await db.ledgerMeta.get('p1');
  check('账本元信息已建立', !!meta && meta.version === 1);
  const eff = effectiveBerths(berths, leases);
  check('生效占用全空闲，在港船数 0', eff.every((b) => b.status === '空闲'));

  console.log(failures === 0 ? '\n跳级迁移验证全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

void main();
