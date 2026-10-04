/* 应用启动路径冒烟：ensureSeedData() → sweepLedger() → 各页读取的生效占用。
   验证首屏：超时船 v-2006 自动失效释放 B02；高亭容量满、v-2008 排队不占容量。 */
import 'fake-indexeddb/auto';
import { db } from '../src/db';
import { ensureSeedData } from '../src/db/seed';
import { sweepLedger } from '../src/services/ledger';
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
  await ensureSeedData();
  const closed = await sweepLedger();
  check('启动扫描关闭 v-2006 的超时租约', closed.some((c) => c.lease.vesselId === 'v-2006'));
  check('失效原因=超过预计离港时间', closed.every((c) => c.reason === '超过预计离港时间'));
  check('没有排队船被误调度（沈家门 B02 空出，但该港无排队）', closed.every((c) => c.promoted === false));

  const [ports, berths, leases] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.leases.toArray()]);

  for (const port of ports) {
    const eff = effectiveBerths(
      berths.filter((b) => b.portId === port.id),
      leases.filter((l) => l.portId === port.id),
    );
    const occupied = eff.filter((b) => b.status === '占用');
    const waiting = leases.filter((l) => l.portId === port.id && l.state === '排队');
    console.log(
      `  · ${port.name}: 占用 ${occupied.length}/${eff.filter((b) => b.status !== '维修').length}（维修 ${eff.filter((b) => b.status === '维修').length}）排队 ${waiting.length}`,
    );
    // 任一泊位上的生效占用渔船至多一条（不允许同泊位两条在港）
    const vessels = occupied.map((b) => b.vesselId);
    check(`${port.name} 无同泊位重复在港记录`, new Set(vessels).size === vessels.length);
  }

  const shen = effectiveBerths(berths.filter((b) => b.portId === 'p-1002'), leases.filter((l) => l.portId === 'p-1002'));
  check('沈家门 B02 已释放为空闲（v-2006 失效）', shen.find((b) => b.berthNo === 'B02')!.status === '空闲');
  check('沈家门 B01 仍由 v-2002 占用', shen.find((b) => b.berthNo === 'B01')!.vesselId === 'v-2002');

  const gaoting = leases.filter((l) => l.portId === 'p-1003');
  check('高亭 v-2008 仍是排队租约且无泊位号', gaoting.some((l) => l.vesselId === 'v-2008' && l.state === '排队' && l.berthNo === ''));
  const gaotingEff = effectiveBerths(berths.filter((b) => b.portId === 'p-1003'), gaoting);
  check('排队船 v-2008 不出现在任何物理泊位上', gaotingEff.every((b) => b.vesselId !== 'v-2008'));
  check('高亭在港船数=2（B01/B02），不含排队船', gaotingEff.filter((b) => b.status === '占用').length === 2);

  // 未分配泊位旧航次不挤占容量
  const calls = await db.calls.toArray();
  const c3008 = calls.find((c) => c.id === 'c-3008');
  check('旧航次 c-3008 无泊位号且无 portId（未分配）', c3008!.berthNo === '' && c3008!.portId === '');

  // 账本版本号：沈家门发生过失效+释放，版本号 +1
  const metaShen = await db.ledgerMeta.get('p-1002');
  check('沈家门账本版本号已递增', metaShen!.version === 2, `v${metaShen!.version}`);

  console.log(failures === 0 ? '\n启动路径冒烟全部通过' : `\n${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

void main();
