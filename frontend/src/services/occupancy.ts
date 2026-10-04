import type { Berth, EffectiveBerth } from '../types/berth';
import type { BerthLease } from '../types/lease';

/**
 * 生效占用：以物理泊位清单为底，叠加 state==='靠泊' 的生效租约推导。
 * 排队租约（无泊位号）不进入任何泊位视图，也不挤占容量。
 * 所有页面（渔港详情、地图、流水、渔船档案）都通过这里读同一份生效占用。
 */
export function effectiveBerths(berths: Berth[], leases: BerthLease[]): EffectiveBerth[] {
  const docked = new Map<string, BerthLease>();
  for (const lease of leases) {
    if (lease.state === '靠泊' && lease.berthNo) docked.set(lease.berthNo, lease);
  }
  return [...berths]
    .sort((a, b) => a.berthNo.localeCompare(b.berthNo, 'zh-Hans-CN', { numeric: true }))
    .map((berth) => {
      const lease = docked.get(berth.berthNo);
      // 维修是人工物理状态，优先级最高；其余由生效租约决定
      const status: Berth['status'] = berth.status === '维修' ? '维修' : lease ? '占用' : '空闲';
      return {
        ...berth,
        status,
        leaseId: lease?.id ?? null,
        vesselId: lease?.vesselId ?? null,
        vesselName: lease?.vesselName ?? null,
        berthAt: lease?.berthAt ?? null,
        expectedLeaveAt: lease?.expectedLeaveAt ?? null,
        agentId: lease?.agentId ?? null,
      };
    });
}

/** 某渔港的生效泊位视图 */
export function effectiveBerthsOfPort(
  portId: string,
  berths: Berth[],
  leases: BerthLease[],
): EffectiveBerth[] {
  return effectiveBerths(
    berths.filter((b) => b.portId === portId),
    leases.filter((l) => l.portId === portId),
  );
}

/** 某渔船当前生效租约（靠泊 / 排队，至多一条） */
export function activeLeaseOfVessel(leases: BerthLease[], vesselId: string): BerthLease | undefined {
  return leases.find((l) => l.vesselId === vesselId && (l.state === '靠泊' || l.state === '排队'));
}
