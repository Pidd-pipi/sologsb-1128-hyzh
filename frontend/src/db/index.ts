import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import type { BerthLease } from '../types/lease';
import { buildBerthRecords } from './berth';

/** 迁移 / 播种时给历史占用补的租约有效期（小时） */
const LEGACY_LEASE_HOURS = 48;

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表；
 * v4 新增 leases 占用账本（带租约与版本号），berths 退化为物理泊位台账。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;
  leases!: Table<BerthLease, string>;

  constructor() {
    super('gbfishport-db');

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
        // 占用账本：按渔港 / 渔船 / 状态 / 泊位 / 登记窗口建索引
        leases: 'id, portId, vesselId, status, berthNo, windowId',
        // 流水补充 portId / leaseId 索引
        calls: 'id, vesselId, type, time, portId, leaseId',
      })
      .upgrade(async (tx) => {
        // v4 迁移：把 v3 泊位上的「占用」状态转写为生效租约（账本），
        // 泊位自身退化为物理台账（占用字段清空，维修标记保留）。
        const nowIso = new Date().toISOString();
        const expectedLeaveIso = new Date(Date.now() + LEGACY_LEASE_HOURS * 3600 * 1000).toISOString();
        const berthTable = tx.table<Berth, string>('berths');
        const legacyBerths = await berthTable.toArray();
        const leases: BerthLease[] = legacyBerths
          .filter((b) => b.status === '占用' && b.vesselId)
          .map((b) => ({
            id: `l-${b.id}`,
            portId: b.portId,
            berthNo: b.berthNo,
            vesselId: b.vesselId as string,
            vesselName: b.vesselName ?? '',
            status: '生效',
            berthAt: b.berthAt ?? nowIso,
            queuedAt: null,
            expectedLeaveAt: expectedLeaveIso,
            endedAt: null,
            endReason: '',
            windowId: 'migration',
            heartbeatAt: nowIso,
            version: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          }));
        const leaseTable = tx.table<BerthLease, string>('leases');
        if (leases.length) await leaseTable.bulkPut(leases);
        await berthTable.toCollection().modify((b) => {
          if (b.status === '占用') b.status = '空闲';
        });
      });
  }
}

export const db = new FishPortDatabase();
