import { computed, type ComputedRef, type Ref } from 'vue';
import type { LiveBerth, BerthSummary } from '../types/berth';
import type { BerthLease } from '../types/lease';
import { summarize, waitingLeasesOf } from '../services/occupancy';

export interface UseBerthStatus {
  scope: ComputedRef<LiveBerth[]>;
  summary: ComputedRef<BerthSummary>;
  inPortVessels: ComputedRef<LiveBerth[]>;
  freeBerths: ComputedRef<LiveBerth[]>;
  waiting: ComputedRef<BerthLease[]>;
  summaryOf: (portId: string) => BerthSummary;
  occupancyRateOf: (portId: string) => number;
}

export interface BerthStatusSources {
  /** 生效泊位视图（物理泊位 × 生效租约的派生结果） */
  berths: Ref<LiveBerth[]>;
  /** 租约账本（排队队列等需要） */
  leases: Ref<BerthLease[]>;
}

/**
 * 聚合泊位占用与在港船舶数量，输出占用率、空闲泊位与排队队列。
 * 只消费「生效占用」派生结果，所有页面看到的在港船数因此保持一致。
 */
export function useBerthStatus(sources: BerthStatusSources, portId?: Ref<string> | string): UseBerthStatus {
  const { berths, leases } = sources;
  const roomId = computed(() => (typeof portId === 'string' ? portId : portId?.value ?? ''));

  const scope = computed(() => {
    const id = roomId.value;
    return id
      ? berths.value.filter((b) => b.portId === id).sort((a, b) => a.berthNo.localeCompare(b.berthNo))
      : [...berths.value];
  });

  const summary = computed<BerthSummary>(() => summarize(roomId.value, berths.value, leases.value));
  const inPortVessels = computed(() => scope.value.filter((b) => b.status === '占用' && b.vesselName));
  const freeBerths = computed(() => scope.value.filter((b) => b.status === '空闲'));
  const waiting = computed(() => waitingLeasesOf(leases.value, roomId.value || undefined));

  function summaryOf(id: string): BerthSummary {
    return summarize(id, berths.value, leases.value);
  }

  function occupancyRateOf(id: string): number {
    return summaryOf(id).occupancyRate;
  }

  return { scope, summary, inPortVessels, freeBerths, waiting, summaryOf, occupancyRateOf };
}
