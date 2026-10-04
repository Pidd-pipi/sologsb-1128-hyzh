<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useVesselStore } from '../stores/vesselStore';
import { usePortStore } from '../stores/portStore';
import VesselSpecTable from '../components/common/VesselSpecTable.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { PortCall } from '../types/call';
import { daysUntilExpiry, expiryText, powerTier, tonnageTier } from '../utils/tonnage';
import { formatDateTime, formatNumber } from '../utils/format';

const route = useRoute();
const router = useRouter();
const vesselStore = useVesselStore();
const portStore = usePortStore();

const vesselId = computed(() => String(route.params.id ?? ''));
const vessel = computed(() => vesselStore.vesselById(vesselId.value));
const loaded = ref(false);

const calls = computed<PortCall[]>(() => (vessel.value ? portStore.callsOfVessel(vessel.value.id) : []));

/** 当前占用读同一份生效账本：同一渔船至多一条生效租约（靠泊 / 排队） */
const occupancy = computed(() => {
  if (!vessel.value) return null;
  const lease = portStore.activeLeaseOfVessel(vessel.value.id);
  if (!lease) return null;
  return {
    lease,
    portName: portStore.portById(lease.portId)?.name ?? lease.portId,
    berthNo: lease.berthNo,
    state: lease.state,
    berthAt: lease.berthAt,
    expectedLeaveAt: lease.expectedLeaveAt,
    enqueuedAt: lease.enqueuedAt,
  };
});

const expiryDays = computed(() => (vessel.value ? daysUntilExpiry(vessel.value.certificateExpiry) : Number.NaN));

const expiryTagType = computed(() => {
  const days = expiryDays.value;
  if (Number.isNaN(days)) return 'info';
  if (days < 0) return 'danger';
  if (days <= 90) return 'warning';
  return 'success';
});

const totals = computed(() => ({
  ice: calls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: calls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: calls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function timelineType(call: PortCall): 'primary' | 'success' {
  return call.type === '进港' ? 'primary' : 'success';
}

async function bootstrap(): Promise<void> {
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (!portStore.calls.length) await portStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(vesselId, bootstrap);
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/vessels' }">渔船检索</el-breadcrumb-item>
      <el-breadcrumb-item>{{ vessel ? vessel.name : '渔船档案' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="vessel">
      <header class="page__head">
        <div>
          <h1>{{ vessel.name }}</h1>
          <p class="page__sub">
            渔船编号 {{ vessel.vesselNo }} · 船籍港 {{ vessel.homePort }} · 船主 {{ vessel.owner }}
          </p>
        </div>
        <div class="page__head-actions">
          <el-tag effect="dark">{{ vessel.operationType }}</el-tag>
          <el-tag type="info" effect="plain">{{ vessel.hullMaterial }}</el-tag>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-row :gutter="16">
        <el-col :lg="16" :md="24">
          <VesselSpecTable :vessels="[vessel]" :clickable="false" />
        </el-col>
        <el-col :lg="8" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">档案要点</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="总吨位">
                {{ formatNumber(vessel.grossTonnage) }} t（{{ tonnageTier(vessel.grossTonnage) }}）
              </el-descriptions-item>
              <el-descriptions-item label="主机功率">
                {{ formatNumber(vessel.enginePower, 0) }} kW（{{ powerTier(vessel.enginePower) }}）
              </el-descriptions-item>
              <el-descriptions-item label="证书有效期">
                {{ vessel.certificateExpiry }}
                <el-tag size="small" :type="expiryTagType" data-testid="expiry-tag">{{ expiryText(vessel.certificateExpiry) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="累计进出港">{{ calls.length }} 次</el-descriptions-item>
              <el-descriptions-item label="累计加冰 / 加油">
                {{ formatNumber(totals.ice, 0) }} kg / {{ formatNumber(totals.fuel, 0) }} L
              </el-descriptions-item>
              <el-descriptions-item label="累计卸货">{{ formatNumber(totals.unload, 0) }} kg</el-descriptions-item>
            </el-descriptions>
          </el-card>

          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">当前航次</span></template>
            <el-descriptions v-if="occupancy" :column="1" size="small" border data-testid="vessel-current-voyage">
              <el-descriptions-item label="状态">
                <el-tag :type="occupancy.state === '排队' ? 'warning' : 'primary'" size="small">
                  {{ occupancy.state === '排队' ? '排队等泊中' : '在港靠泊' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="渔港">{{ occupancy.portName }}</el-descriptions-item>
              <el-descriptions-item label="泊位号">
                <el-tag v-if="occupancy.berthNo" size="small">{{ occupancy.berthNo }}</el-tag>
                <el-tag v-else size="small" type="info" effect="plain">未分配（排队中，不挤占容量）</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="靠泊/入队时间">
                {{ formatDateTime(occupancy.state === '排队' ? occupancy.enqueuedAt : occupancy.berthAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="预计离港">
                {{ formatDateTime(occupancy.expectedLeaveAt) }}
              </el-descriptions-item>
            </el-descriptions>
            <EmptyState v-else title="该船当前不在港" description="没有生效中的靠泊或排队租约。" />
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">进出港记录时间线（{{ calls.length }} 条）</span></template>
        <el-timeline v-if="calls.length" data-testid="call-timeline">
          <el-timeline-item
            v-for="call in calls"
            :key="call.id"
            :timestamp="formatDateTime(call.time)"
            :type="timelineType(call)"
            placement="top"
          >
            <div class="timeline-row">
              <el-tag size="small" :type="call.type === '进港' ? 'primary' : 'success'">{{ call.type }}</el-tag>
              <span>{{ portStore.portById(call.portId)?.name ?? '未记录渔港' }}</span>
              <span>泊位 <el-tag v-if="call.berthNo" size="small">{{ call.berthNo }}</el-tag><el-tag v-else size="small" type="info" effect="plain">未分配</el-tag></span>
              <span>加冰 {{ formatNumber(call.iceKg, 0) }} kg</span>
              <span>加油 {{ formatNumber(call.fuelL, 0) }} L</span>
              <span>卸货 {{ formatNumber(call.unloadKg, 0) }} kg</span>
              <el-tag size="small" type="info" effect="plain">{{ call.visaStatus }}</el-tag>
              <el-tag v-if="call.leaseExpired" size="small" type="danger">租约失效</el-tag>
            </div>
          </el-timeline-item>
        </el-timeline>
        <EmptyState v-else title="暂无进出港记录" description="该渔船尚未登记进出港流水，可前往登记页补录。">
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </EmptyState>
      </el-card>
    </template>

    <EmptyState v-else-if="loaded" title="未找到该渔船" description="该渔船档案可能尚未建立，返回检索页建档后再查看。">
      <el-button type="primary" @click="router.push('/vessels')">返回渔船检索</el-button>
    </EmptyState>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page__head h1 {
  margin: 0;
  font-size: 22px;
  color: #17324d;
}
.page__sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6b7c8c;
}
.page__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.timeline-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
</style>
