import { computed, unref, type ComputedRef, type Ref } from 'vue';
import type { BerthSummary, EffectiveBerth } from '../types/berth';
import type { BerthLease } from '../types/lease';

export interface UseBerthStatus {
  scope: ComputedRef<EffectiveBerth[]>;
  summary: ComputedRef<BerthSummary>;
  inPortVessels: ComputedRef<EffectiveBerth[]>;
  freeBerths: ComputedRef<EffectiveBerth[]>;
  summaryOf: (portId: string) => BerthSummary;
  occupancyRateOf: (portId: string) => number;
}

type MaybeRef<T> = T | Ref<T>;

function summarize(portId: string, list: EffectiveBerth[], waiting: number): BerthSummary {
  const total = list.length;
  const occupied = list.filter((b) => b.status === '占用').length;
  const maintenance = list.filter((b) => b.status === '维修').length;
  const free = total - occupied - maintenance;
  // 容量分母排除维修泊位；全部维修时占用率按 0 处理
  const capacity = total - maintenance;
  return {
    portId,
    total,
    occupied,
    free,
    maintenance,
    waiting,
    occupancyRate: capacity === 0 ? (occupied > 0 ? 1 : 0) : occupied / capacity,
    inPortCount: occupied,
    freeBerths: list.filter((b) => b.status === '空闲'),
    occupiedBerths: list.filter((b) => b.status === '占用'),
  };
}

/**
 * 基于生效泊位视图（由 effectiveBerths 推导）聚合占用率、在港船数与排队数。
 * 调用方需保证 berths 已是「物理泊位 + 生效靠泊租约」叠加后的生效占用。
 * @param berths 生效泊位响应式数据源
 * @param leases 租约响应式数据源（用于排队计数，可传空数组）
 * @param portId 需要聚焦的渔港 id；不传则对全部泊位聚合
 */
export function useBerthStatus(
  berths: MaybeRef<EffectiveBerth[]>,
  leases: MaybeRef<BerthLease[]> = [],
  portId: MaybeRef<string> | string = '',
): UseBerthStatus {
  const focusId = computed(() => {
    if (typeof portId === 'string') return portId;
    return unref(portId) ?? '';
  });
  const allBerths = computed(() => unref(berths));
  const allLeases = computed(() => unref(leases));

  function waitingOf(id: string): number {
    return allLeases.value.filter((l) => (!id || l.portId === id) && l.state === '排队').length;
  }

  function berthsOf(id: string): EffectiveBerth[] {
    return allBerths.value.filter((b) => !id || b.portId === id);
  }

  const scope = computed(() => berthsOf(focusId.value));
  const summary = computed<BerthSummary>(() => summarize(focusId.value, scope.value, waitingOf(focusId.value)));
  const inPortVessels = computed(() => scope.value.filter((b) => b.status === '占用' && b.vesselName));
  const freeBerths = computed(() => scope.value.filter((b) => b.status === '空闲'));

  function summaryOf(id: string): BerthSummary {
    return summarize(id, berthsOf(id), waitingOf(id));
  }

  function occupancyRateOf(id: string): number {
    return summaryOf(id).occupancyRate;
  }

  return { scope, summary, inPortVessels, freeBerths, summaryOf, occupancyRateOf };
}
