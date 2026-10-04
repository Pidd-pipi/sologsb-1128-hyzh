import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { AgentHeartbeat, BerthLease, LedgerMeta } from '../types/lease';
import { buildBerthRecords, leasesFromLegacyBerths } from './berth';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表；
 * v4 泊位占用升级为带租约与版本号的占用账本：
 *    - leases 存每条靠泊/排队租约（占用的唯一事实来源）
 *    - ledgerMeta 按渔港存账本版本号（乐观并发控制，旧版本保存提示刷新）
 *    - agents 存值班窗口心跳（窗口失联后租约失效）
 *    - berths 回归物理泊位清单，占用字段不再使用，占用一律由生效租约推导
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  leases!: Table<BerthLease, string>;
  ledgerMeta!: Table<LedgerMeta, string>;
  agents!: Table<AgentHeartbeat, string>;

  constructor(dbName: string = 'gbfishport-db') {
    super(dbName);

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        ports: 'id, name, level, shelterLevel',
        vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
        calls: 'id, vesselId, portId, type, time',
        berths: 'id, portId, berthNo, status',
        leases: 'id, portId, vesselId, state, berthNo',
        ledgerMeta: 'portId',
        agents: 'id',
      })
      .upgrade(async (tx) => {
        // v4 迁移：旧版泊位占用 → system 靠泊租约（不设预计离港时间，不参与窗口失联）
        const berthTable = tx.table<Berth, string>('berths');
        const leaseTable = tx.table<BerthLease, string>('leases');
        const callTable = tx.table<PortCall, string>('calls');
        const metaTable = tx.table<LedgerMeta, string>('ledgerMeta');

        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const existingLeases = await leaseTable.count();
        if (existingLeases === 0) {
          const legacyBerths = await berthTable.toArray();
          const leases = leasesFromLegacyBerths(legacyBerths);
          if (leases.length) await leaseTable.bulkPut(leases);
        }

        // 物理泊位只保留维修人工状态，占用/空闲统一由生效租约推导
        await berthTable.toCollection().modify((old: Berth) => {
          const legacy = old as unknown as Record<string, unknown>;
          const next: Berth = {
            id: String(legacy.id ?? ''),
            portId: String(legacy.portId ?? ''),
            berthNo: String(legacy.berthNo ?? ''),
            status: legacy.status === '维修' ? '维修' : '空闲',
            designDepth: typeof legacy.designDepth === 'number' ? (legacy.designDepth as number) : 0,
          };
          Object.keys(legacy).forEach((key) => delete legacy[key]);
          Object.assign(legacy, next);
        });

        // 旧流水没有 portId / leaseId：泊位号非空时按渔港归属补齐，空泊位号保持未分配
        const leases = await leaseTable.toArray();
        await callTable.toCollection().modify((call) => {
          if (call.portId === undefined) call.portId = '';
          if (call.leaseId === undefined) call.leaseId = '';
          if (!call.portId && call.berthNo) {
            const lease = leases.find((l) => l.vesselId === call.vesselId && l.berthNo === call.berthNo);
            if (lease) call.portId = lease.portId;
          }
        });

        // 每个有泊位的渔港建立账本，版本号从 1 开始
        for (const port of ports) {
          const count = await berthTable.where('portId').equals(port.id).count();
          if (count > 0) {
            await metaTable.put({ portId: port.id, version: 1, updatedAt: new Date().toISOString() });
          }
        }
      });
  }
}

export const db = new FishPortDatabase();
