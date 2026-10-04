<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useBerthStatus } from '../hooks/useBerthStatus';
import PortCard from '../components/common/PortCard.vue';
import BerthGrid from '../components/common/BerthGrid.vue';
import MapPanel from '../components/common/MapPanel.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { LiveBerth } from '../types/berth';
import { LEASE_OFFLINE_MS } from '../types/lease';
import { formatDateTime, formatNumber, percentText } from '../utils/format';
import { supplyText } from '../types/port';

const route = useRoute();
const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

const portId = computed(() => String(route.params.id ?? ''));
const port = computed(() => portStore.portById(portId.value));
const berthsRef = computed(() => portStore.berths);
const leasesRef = computed(() => portStore.leases);
const { summary, summaryOf, inPortVessels, waiting } = useBerthStatus(
  { berths: berthsRef, leases: leasesRef },
  portId,
);
const portBerths = computed(() => portStore.berthsOf(portId.value));

const activeBerthId = ref('');
const berthDialogVisible = ref(false);
const activeBerth = computed<LiveBerth | null>(
  () => portStore.berths.find((b) => b.id === activeBerthId.value) ?? null,
);
const activeVessel = computed(() =>
  activeBerth.value?.vesselId ? vesselStore.vesselById(activeBerth.value.vesselId) : undefined,
);
const activeLease = computed(() => activeBerth.value?.lease ?? null);

const addBerthVisible = ref(false);
const addBerthForm = reactive({ berthNo: '', designDepth: 4.5 });

const recentCalls = computed(() => portStore.callsOfPort(portId.value).slice(0, 8));

const supply = computed(() => (port.value ? supplyText(port.value.supply) : '—'));

const loaded = ref(false);

async function bootstrap(): Promise<void> {
  if (!portStore.ports.length || !portStore.leases.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  loaded.value = true;
}

onMounted(bootstrap);
watch(portId, bootstrap);

function openBerth(berth: LiveBerth): void {
  activeBerthId.value = berth.id;
  berthDialogVisible.value = true;
}

/** 租约剩余 / 失联提示文案 */
const activeLeaseHint = computed(() => {
  const lease = activeLease.value;
  if (!lease) return '';
  const leftMs = new Date(lease.expectedLeaveAt).getTime() - Date.now();
  const offlineMs = Date.now() - new Date(lease.heartbeatAt).getTime();
  const parts: string[] = [];
  parts.push(leftMs > 0 ? `预计 ${Math.round(leftMs / 3600000)} 小时后离港` : '已超过预计离港时间');
  parts.push(offlineMs >= LEASE_OFFLINE_MS ? `窗口失联 ${Math.round(offlineMs / 60000)} 分钟` : '窗口在线');
  return parts.join(' · ');
});

async function markMaintenance(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  try {
    await portStore.setBerthMaintenance(berth.id, true);
    ElMessage.success(`${berth.berthNo} 已置为维修`);
  } catch (error) {
    ElMessage.warning((error as Error).message);
  }
}

async function clearMaintenance(): Promise<void> {
  const berth = activeBerth.value;
  if (!berth) return;
  await portStore.setBerthMaintenance(berth.id, false);
  ElMessage.success(`${berth.berthNo} 已恢复可用`);
}

async function releaseBerth(): Promise<void> {
  const lease = activeLease.value;
  if (!lease) return;
  const result = await portStore.releaseBerthLease(lease.id);
  ElMessage.success(`${lease.vesselName} 的租约已释放，泊位已回收`);
  if (result.promoted.length) {
    const first = result.promoted[0];
    ElMessage.info(`排队队列自动补位：${first.lease.vesselName} → 泊位 ${first.berthNo}`);
  }
}

async function simulateLost(): Promise<void> {
  const lease = activeLease.value;
  if (!lease) return;
  await portStore.markWindowLost(lease.id);
  ElMessage.info(`已模拟「${lease.vesselName}」登记窗口失联，下次巡检（≤15 秒）租约将失效并释放泊位`);
}

async function runSweep(): Promise<void> {
  const result = await portStore.sweep();
  if (!result.expired.length && !result.promoted.length) {
    ElMessage.info('当前没有超时或失联的租约');
    return;
  }
  for (const lease of result.expired) {
    ElMessage.warning(`「${lease.vesselName}」租约${lease.endReason === '失联失效' ? '因窗口失联' : '超过预计离港时间'}已失效`);
  }
  for (const item of result.promoted) {
    ElMessage.success(`排队补位：${item.lease.vesselName} → 泊位 ${item.berthNo}`);
  }
}

async function submitBerth(): Promise<void> {
  const no = addBerthForm.berthNo.trim();
  if (!no) {
    ElMessage.warning('请填写泊位号，如 B09');
    return;
  }
  const created = await portStore.addBerth(portId.value, no, addBerthForm.designDepth);
  if (!created) {
    ElMessage.warning('该泊位号已存在');
    return;
  }
  addBerthVisible.value = false;
  addBerthForm.berthNo = '';
  ElMessage.success(`已新增泊位 ${created.berthNo}`);
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

function onMapSelect(selectedPortId: string): void {
  if (selectedPortId === portId.value) {
    ElMessage.info('当前即为该渔港');
    return;
  }
  void router.push(`/ports/${selectedPortId}`);
}
</script>

<template>
  <section class="page">
    <el-breadcrumb separator="/">
      <el-breadcrumb-item :to="{ path: '/' }">渔港一览</el-breadcrumb-item>
      <el-breadcrumb-item>{{ port ? port.name : '渔港详情' }}</el-breadcrumb-item>
    </el-breadcrumb>

    <template v-if="port">
      <header class="page__head">
        <div>
          <h1>{{ port.name }}</h1>
          <p class="page__sub">{{ port.level }} · 管理单位：{{ port.manager }}</p>
        </div>
        <div class="page__head-actions">
          <el-button data-testid="open-berth-dialog" @click="addBerthVisible = true">新增泊位</el-button>
          <el-button data-testid="sweep-leases" @click="runSweep">租约巡检</el-button>
          <el-button type="primary" @click="router.push('/calls')">登记进出港</el-button>
        </div>
      </header>

      <el-row :gutter="16">
        <el-col :lg="10" :md="24">
          <PortCard :port="port" :summary="summaryOf(port.id)" :clickable="false" />
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">基本信息与补给能力</span></template>
            <el-descriptions :column="1" size="small" border>
              <el-descriptions-item label="经纬度">
                {{ formatNumber(port.longitude, 4) }}°E / {{ formatNumber(port.latitude, 4) }}°N
              </el-descriptions-item>
              <el-descriptions-item label="泊位数">{{ port.berthCount }} 个</el-descriptions-item>
              <el-descriptions-item label="泊位水深">{{ formatNumber(port.berthDepth) }} m</el-descriptions-item>
              <el-descriptions-item label="码头长度">{{ formatNumber(port.wharfLength, 0) }} m</el-descriptions-item>
              <el-descriptions-item label="避风能力">{{ port.shelterLevel }} 级</el-descriptions-item>
              <el-descriptions-item label="补给能力">{{ supply }}</el-descriptions-item>
            </el-descriptions>
            <p class="detail-hint">
              当前占用率 {{ percentText(summary.occupancyRate) }}（占用 {{ summary.occupied }} / 空闲 {{ summary.free }} / 维修 {{ summary.maintenance }}）
              · 可用容量 {{ summary.capacity }} · 排队 {{ summary.waitingCount }} 艘
            </p>
          </el-card>
        </el-col>

        <el-col :lg="14" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">渔港分布（地图 / 网格）</span></template>
            <MapPanel
              :ports="portStore.ports"
              :berths="portStore.berths"
              :leases="portStore.leases"
              :focused-port-id="port.id"
              :height="300"
              @select-port="onMapSelect"
            />
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <span class="card-title">泊位网格（点击泊位查看占用船舶）</span>
        </template>
        <BerthGrid v-if="portBerths.length" :berths="portBerths" @select="openBerth" />
        <EmptyState v-else title="该渔港暂无泊位记录" description="点击右上角「新增泊位」为该渔港建立泊位清单。">
          <el-button type="primary" @click="addBerthVisible = true">新增泊位</el-button>
        </EmptyState>
      </el-card>

      <el-row :gutter="16">
        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">在港船舶（{{ inPortVessels.length }} 艘）</span></template>
            <el-table :data="inPortVessels" size="small" border empty-text="当前无在港船舶">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column prop="berthNo" label="泊位号" width="80" />
              <el-table-column label="靠泊时间" min-width="145">
                <template #default="scope">{{ formatDateTime(scope.row.berthAt) }}</template>
              </el-table-column>
              <el-table-column label="预计离港" min-width="145">
                <template #default="scope">{{ formatDateTime(scope.row.expectedLeaveAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="150">
                <template #default="scope">
                  <el-button
                    text
                    type="primary"
                    size="small"
                    :disabled="!scope.row.vesselId"
                    @click="openVessel(scope.row.vesselId)"
                  >
                    档案
                  </el-button>
                  <el-button text type="warning" size="small" @click="activeBerthId = scope.row.id; berthDialogVisible = true">
                    租约
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>

        <el-col :lg="12" :md="24">
          <el-card shadow="never" class="detail-card">
            <template #header><span class="card-title">排队等泊（{{ waiting.length }} 艘，未分配泊位）</span></template>
            <el-table :data="waiting" size="small" border empty-text="当前没有排队船舶，容量满时进港自动入队">
              <el-table-column prop="vesselName" label="船名" min-width="120" />
              <el-table-column label="入队时间" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.queuedAt ?? scope.row.createdAt) }}</template>
              </el-table-column>
              <el-table-column label="预计离港" min-width="150">
                <template #default="scope">{{ formatDateTime(scope.row.expectedLeaveAt) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="detail-card">
        <template #header><span class="card-title">近日流水</span></template>
        <el-table :data="recentCalls" size="small" border empty-text="暂无进出港流水">
          <el-table-column prop="vesselName" label="船名" min-width="120" />
          <el-table-column prop="type" label="类型" width="80" />
          <el-table-column label="时间" min-width="150">
            <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
          </el-table-column>
          <el-table-column label="泊位号" width="100">
            <template #default="scope">{{ scope.row.berthNo || '未分配' }}</template>
          </el-table-column>
          <el-table-column label="卸货 kg" min-width="100">
            <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <EmptyState
      v-else-if="loaded"
      title="未找到该渔港"
      description="该渔港可能尚未登记，返回一览页登记后再查看。"
    >
      <el-button type="primary" @click="router.push('/')">返回渔港一览</el-button>
    </EmptyState>

    <el-dialog v-model="berthDialogVisible" title="泊位占用详情" width="560px" data-testid="berth-dialog">
      <template v-if="activeBerth">
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="泊位号">{{ activeBerth.berthNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="activeBerth.status === '占用' ? 'warning' : activeBerth.status === '维修' ? 'info' : 'success'">
              {{ activeBerth.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="设计水深">{{ formatNumber(activeBerth.designDepth) }} m</el-descriptions-item>
          <el-descriptions-item label="占用渔船">
            <template v-if="activeBerth.vesselName">
              <el-link type="primary" data-testid="berth-vessel-link" @click="activeBerth.vesselId && openVessel(activeBerth.vesselId)">
                {{ activeBerth.vesselName }}
              </el-link>
            </template>
            <template v-else>—</template>
          </el-descriptions-item>
          <el-descriptions-item label="靠泊时间">{{ formatDateTime(activeBerth.berthAt) }}</el-descriptions-item>
          <el-descriptions-item label="预计离港">{{ formatDateTime(activeBerth.expectedLeaveAt) }}</el-descriptions-item>
          <el-descriptions-item label="租约版本">
            <template v-if="activeLease">
              <el-tag size="small" effect="plain" data-testid="lease-version">v{{ activeLease.version }}</el-tag>
              <span class="lease-hint">{{ activeLeaseHint }}</span>
            </template>
            <template v-else>—</template>
          </el-descriptions-item>
          <el-descriptions-item label="最近心跳">
            {{ activeLease ? formatDateTime(activeLease.heartbeatAt) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="主机功率">
            {{ activeVessel ? `${formatNumber(activeVessel.enginePower, 0)} kW` : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="总吨位">
            {{ activeVessel ? `${formatNumber(activeVessel.grossTonnage)} t` : '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="berthDialogVisible = false">关闭</el-button>
        <el-button v-if="activeBerth?.status !== '维修'" type="warning" data-testid="berth-maintenance" @click="markMaintenance">置为维修</el-button>
        <el-button v-else type="success" data-testid="berth-clear-maintenance" @click="clearMaintenance">恢复可用</el-button>
        <el-button v-if="activeLease" type="info" plain data-testid="simulate-lost" @click="simulateLost">模拟窗口失联</el-button>
        <el-button v-if="activeLease" type="danger" data-testid="berth-release" @click="releaseBerth">释放租约</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addBerthVisible" title="新增泊位" width="420px">
      <el-form label-width="90px">
        <el-form-item label="泊位号">
          <el-input id="berth-no" v-model="addBerthForm.berthNo" placeholder="如：B09" />
        </el-form-item>
        <el-form-item label="设计水深 m">
          <el-input-number id="berth-depth" v-model="addBerthForm.designDepth" :min="1" :max="30" :step="0.1" :precision="1" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addBerthVisible = false">取消</el-button>
        <el-button type="primary" data-testid="submit-berth" @click="submitBerth">保存泊位</el-button>
      </template>
    </el-dialog>
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
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.lease-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #7b8a99;
}
</style>
