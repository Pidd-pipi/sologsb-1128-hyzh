<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { LiveBerth } from '../types/berth';
import { OccupancyConflictError, VesselOpenVoyageError, type BerthLease } from '../types/lease';
import { CALL_TYPES, VISA_STATUSES, emptyCallDraft, type CallDraft } from '../types/call';
import { formatDateTime, formatNumber, isToday, nowLocalInputValue, toPlain } from '../utils/format';

type CallForm = CallDraft;

const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();

function defaultExpectedLeave(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  time: nowLocalInputValue(),
  expectedLeaveAt: defaultExpectedLeave(),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');

const rules = computed<FormRules>(() => ({
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  // 渔港仅进港需要；出港以选中的在港租约定位
  ...(form.value.type === '进港'
    ? {
        portId: [{ required: true, message: '请选择渔港', trigger: 'change' }],
        expectedLeaveAt: [{ required: true, message: '请选择预计离港时间（用于租约失效判定）', trigger: 'change' }],
      }
    : {
        leaseId: [{ required: true, message: '请选择该船当前在港的租约 / 泊位', trigger: 'change' }],
      }),
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
}));

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/** 该渔船当前未结束航次（用于提示与出港预选） */
const vesselOpenLease = computed<BerthLease | undefined>(() =>
  form.value.vesselId ? portStore.openLeaseOfVessel(form.value.vesselId) : undefined,
);

/** 进港可选渔港（全部渔港，容量满也允许选，提交时自动排队） */
const portOptions = computed(() => portStore.ports);

/** 当前聚焦渔港的生效泊位 */
const focusBerths = computed<LiveBerth[]>(() =>
  focusPortId.value ? portStore.berthsOf(focusPortId.value) : [],
);

const berthRef = computed(() => portStore.berths);
const leaseRef = computed(() => portStore.leases);
const { summary, waiting } = useBerthStatus(
  { berths: berthRef, leases: leaseRef },
  computed(() => focusPortId.value),
);

/** 进港可选泊位：仅空闲（占用中 / 维修不可选）；留空则自动分配 */
const freeBerthOptions = computed(() =>
  focusBerths.value
    .filter((b) => b.status === '空闲')
    .map((b) => ({ value: b.berthNo, label: `${b.berthNo}（水深 ${formatNumber(b.designDepth)}m）` })),
);

/** 出港租约选项：所有未结束航次（生效 / 排队），按渔船名可直接检索 */
const outboundLeaseOptions = computed(() =>
  portStore.leases
    .filter((l) => l.status === '生效' || l.status === '排队')
    .sort((a, b) => new Date(b.berthAt).getTime() - new Date(a.berthAt).getTime())
    .map((l) => ({
      value: l.id,
      label: `${l.vesselName} · ${portStore.portById(l.portId)?.name ?? l.portId} · ${l.berthNo ?? '排队中'}`,
    })),
);

const selectedLease = computed(() => (form.value.leaseId ? portStore.leaseById(form.value.leaseId) : undefined));

const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

/** 表单打开后账本是否已被其他窗口改动（版本 / 容量快照对比） */
const snapshotMismatch = computed(() => {
  if (form.value.type !== '进港' || !focusPortId.value) return false;
  const snap = portStore.snapshotFor(
    focusPortId.value,
    form.value.berthNo || null,
  );
  if (form.value.berthNo) {
    const current = focusBerths.value.find((b) => b.berthNo === form.value.berthNo);
    // 打开时记录的占用者与当前账本不一致（含「当时空闲现在被占」），提示刷新
    if (!current) return true;
    return snap.holderId !== form.value.expectedHolder || snap.berthVersion !== form.value.expectedVersion;
  }
  // 自动分配模式：容量被占满会导致排队，提示容量变化
  return false;
});

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.portId) ||
    Boolean(value.berthNo) ||
    Number(value.iceKg) > 0 ||
    Number(value.fuelL) > 0 ||
    Number(value.unloadKg) > 0
  );
}

onMounted(async () => {
  if (!portStore.ports.length) await portStore.loadAll();
  if (!vesselStore.vessels.length) await vesselStore.loadAll();
  if (restore()) {
    if (hasContent(form.value)) {
      ElMessage.info(`已恢复本地草稿（保存于 ${formatDateTime(savedAt.value)}）`);
    } else {
      // 空草稿没有恢复价值，直接清掉，避免误报「已恢复草稿」
      clearDraft();
    }
  }
  if (form.value.portId) focusPortId.value = form.value.portId;
});

watch(
  () => toPlain(form.value),
  (value) => {
    // 只有存在有效输入时才落草稿；提交后表单被重置，草稿同步清空
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch(
  () => form.value.type,
  () => {
    form.value.berthNo = '';
    form.value.leaseId = undefined;
  },
);

watch(
  () => form.value.portId,
  (id: string) => {
    focusPortId.value = id;
    form.value.berthNo = '';
    form.value.expectedVersion = null;
    form.value.expectedHolder = null;
  },
);

watch(
  () => form.value.vesselId,
  () => {
    // 选船后若该船有未结束航次，出港自动选中其租约
    const open = vesselOpenLease.value;
    if (form.value.type === '出港' && open) {
      form.value.leaseId = open.id;
      form.value.portId = open.portId;
      focusPortId.value = open.portId;
    }
  },
);

watch(
  () => form.value.leaseId,
  (leaseId) => {
    // 直接选在港租约时，同步渔船与聚焦渔港（出港以租约定位）
    if (form.value.type !== '出港' || !leaseId) return;
    const lease = portStore.leaseById(leaseId);
    if (lease) {
      form.value.vesselId = lease.vesselId;
      form.value.portId = lease.portId;
      focusPortId.value = lease.portId;
    }
  },
);

watch(
  () => [form.value.portId, form.value.berthNo, form.value.type] as const,
  () => {
    if (form.value.type !== '进港' || !form.value.portId) return;
    // 记录打开表单时的账本占用状态（版本 + 占用者），作为旧版本保存的判定基准
    const snap = portStore.snapshotFor(form.value.portId, form.value.berthNo || null);
    form.value.expectedVersion = snap.berthVersion;
    form.value.expectedHolder = snap.holderId;
  },
);

function selectBerth(berth: LiveBerth): void {
  if (form.value.type !== '进港' || berth.status !== '空闲') return;
  form.value.berthNo = berth.berthNo;
  ElMessage.info(`已选择 ${berth.berthNo}`);
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  if (form.value.type === '进港' && form.value.expectedLeaveAt <= form.value.time) {
    ElMessage.warning('预计离港时间必须晚于进港时间，否则租约登记即失效');
    return;
  }
  if (form.value.type === '出港' && selectedLease.value && selectedLease.value.vesselId !== form.value.vesselId) {
    ElMessage.warning('所选在港租约不属于该渔船，请重新选择租约或渔船');
    return;
  }
  submitting.value = true;
  try {
    const payload: CallDraft = {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      portId: form.value.portId,
      berthNo: form.value.type === '进港' ? form.value.berthNo.trim().toUpperCase() : selectedLease.value?.berthNo ?? '',
      leaseId: form.value.type === '出港' ? form.value.leaseId : undefined,
      expectedLeaveAt: form.value.expectedLeaveAt,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
      expectedVersion: form.value.expectedVersion,
      expectedHolder: form.value.expectedHolder,
    };
    const result = await portStore.registerCall(payload, selectedVessel.value.name);
    if (result.queued) {
      ElMessage.warning(`渔港容量已满，${result.call.vesselName} 已进入排队队列，泊位释放后自动补位（不占容量）`);
    } else if (result.promoted > 0) {
      ElMessage.success(`已登记 ${result.call.vesselName} 出港 · 泊位 ${result.call.berthNo || '未分配'}，${result.promoted} 艘排队船舶已自动补位`);
    } else {
      ElMessage.success(`已登记 ${result.call.vesselName} ${result.call.type} · 泊位 ${result.call.berthNo || '未分配'}`);
    }
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      time: nowLocalInputValue(),
      expectedLeaveAt: defaultExpectedLeave(),
    });
    focusPortId.value = '';
  } catch (error) {
    if (error instanceof OccupancyConflictError) {
      // 旧版本保存：不覆盖，提示刷新
      ElMessage.error({ message: `占用已变化，请刷新：${error.message}`, duration: 6000 });
      await portStore.loadAll();
      const snap = portStore.snapshotFor(form.value.portId, form.value.berthNo || null);
      form.value.expectedVersion = snap.berthVersion;
      form.value.expectedHolder = snap.holderId;
      return;
    }
    if (error instanceof VesselOpenVoyageError) {
      ElMessage.error({ message: error.message, duration: 6000 });
      return;
    }
    ElMessage.error(`登记失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}

async function runSweep(): Promise<void> {
  const result = await portStore.sweep();
  if (!result.expired.length && !result.promoted.length) {
    ElMessage.info('当前没有超时或失联的租约');
    return;
  }
  for (const lease of result.expired) {
    ElMessage.warning(`「${lease.vesselName}」租约${lease.endReason === '失联失效' ? '因窗口失联' : '超过预计离港时间'}已失效，泊位已释放`);
  }
  for (const item of result.promoted) {
    ElMessage.success(`排队补位：${item.lease.vesselName} → 泊位 ${item.berthNo}`);
  }
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          登记前按占用账本最新状态抢占泊位，容量满自动排队；租约带版本号与预计离港时间，
          窗口失联或超时自动失效释放。值班窗口：<el-tag size="small" effect="plain">{{ portStore.windowId }}</el-tag>
        </p>
      </div>
      <el-button data-testid="sweep-leases" @click="runSweep">租约巡检（超时 / 失联失效）</el-button>
    </header>

    <el-alert
      v-if="restored"
      type="info"
      show-icon
      :closable="false"
      title="已从浏览器本地草稿恢复未提交的表单"
      data-testid="draft-alert"
      class="draft-alert"
    >
      <template #default>
        草稿保存在 localStorage（键 {{ storageKey }}），提交成功后会清空。
      </template>
    </el-alert>

    <el-alert
      v-if="snapshotMismatch"
      type="warning"
      show-icon
      :closable="false"
      title="泊位占用已被其他值班窗口更新，请重新选择泊位（旧版本不会覆盖保存）"
      data-testid="snapshot-mismatch"
      class="draft-alert"
    />

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select id="call-vessel" v-model="form.vesselId" placeholder="请选择渔船" filterable style="width: 100%">
                <el-option
                  v-for="v in vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-alert
              v-if="vesselOpenLease && form.type === '进港'"
              type="error"
              :closable="false"
              class="voyage-alert"
              data-testid="vessel-open-voyage"
              :title="vesselOpenLease.status === '排队'
                ? `该船已在 ${portStore.portById(vesselOpenLease.portId)?.name ?? ''} 排队等泊，不能重复靠泊`
                : `该船仍靠泊在 ${portStore.portById(vesselOpenLease.portId)?.name ?? ''} 泊位 ${vesselOpenLease.berthNo}，不能重复靠泊`"
            />

            <el-form-item label="时间" prop="time">
              <el-date-picker
                id="call-time"
                v-model="form.time"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="选择时间"
                style="width: 100%"
              />
            </el-form-item>

            <el-form-item v-if="form.type === '进港'" label="渔港" prop="portId">
              <el-select
                id="call-port"
                v-model="form.portId"
                placeholder="选择渔港"
                style="width: 100%"
                data-testid="call-port"
              >
                <el-option v-for="p in portOptions" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </el-form-item>

            <template v-if="form.type === '进港'">
              <el-form-item label="泊位号" prop="berthNo">
                <el-select
                  id="call-berth"
                  v-model="form.berthNo"
                  placeholder="留空则自动分配；容量满将排队"
                  clearable
                  style="width: 100%"
                  data-testid="call-berth"
                >
                  <el-option v-for="opt in freeBerthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
                </el-select>
                <p class="field-hint">
                  不选泊位时由账本抢占第一个空闲泊位；全部占满时进入排队队列（不占容量、不计在港船数）。
                  当前账本版本快照：<b>{{ form.expectedVersion ?? '—' }}</b>
                </p>
              </el-form-item>

              <el-form-item label="预计离港" prop="expectedLeaveAt">
                <el-date-picker
                  id="call-expected-leave"
                  v-model="form.expectedLeaveAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm"
                  placeholder="超过该时间租约自动失效"
                  style="width: 100%"
                />
              </el-form-item>
            </template>

            <el-form-item v-else label="在港租约" prop="leaseId">
              <el-select
                id="call-lease"
                v-model="form.leaseId"
                placeholder="选择要办理出港的在港船舶"
                style="width: 100%"
                data-testid="call-lease"
              >
                <el-option v-for="opt in outboundLeaseOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>

            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="加冰 kg" prop="iceKg">
                  <el-input-number id="call-ice" v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="加油 L" prop="fuelL">
                  <el-input-number id="call-fuel" v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="卸货量 kg" prop="unloadKg">
                  <el-input-number id="call-unload" v-model="form.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="签证状态" prop="visaStatus">
              <el-select id="call-visa" v-model="form.visaStatus" style="width: 100%">
                <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>

            <el-form-item>
              <el-button
                type="primary"
                :loading="submitting"
                :disabled="form.type === '进港' && !!vesselOpenLease"
                data-testid="submit-call"
                @click="submit"
              >
                保存登记
              </el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">今日统计</span>
          </template>
          <div class="stat-row">
            <div class="stat"><span class="stat__label">进港</span><b>{{ todayStats.inbound }}</b></div>
            <div class="stat"><span class="stat__label">出港</span><b>{{ todayStats.outbound }}</b></div>
            <div class="stat"><span class="stat__label">加冰 kg</span><b>{{ formatNumber(todayStats.ice, 0) }}</b></div>
            <div class="stat"><span class="stat__label">加油 L</span><b>{{ formatNumber(todayStats.fuel, 0) }}</b></div>
            <div class="stat"><span class="stat__label">卸货 kg</span><b>{{ formatNumber(todayStats.unload, 0) }}</b></div>
          </div>
        </el-card>

        <el-card shadow="never" class="detail-card">
          <template #header>
            <span class="card-title">
              泊位占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '（选择渔港后聚焦）' }}
            </span>
          </template>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" :highlight-berth-no="form.type === '进港' ? form.berthNo : ''" />
          <EmptyState v-else title="尚未选择渔港" description="在左侧表单选择渔港，或点击下方按钮聚焦。">
            <el-button type="primary" @click="form.portId = portStore.ports[0]?.id ?? ''">聚焦第一座渔港</el-button>
          </EmptyState>
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 在港 {{ summary.occupied }} / 容量 {{ summary.capacity }}
            · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }} · 排队 {{ summary.waitingCount }}
          </p>
          <div v-if="waiting.length" class="waiting-list" data-testid="waiting-list">
            <p class="waiting-list__title">排队等泊（FIFO，释放后自动补位）</p>
            <el-tag v-for="l in waiting" :key="l.id" size="small" type="warning" effect="plain">
              {{ l.vesselName }}
            </el-tag>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">今日流水（{{ todayCalls.length }} 条）</span></template>
      <el-table :data="todayCalls" size="small" border empty-text="今日暂无进出港流水" data-testid="today-calls">
        <el-table-column prop="vesselName" label="船名" min-width="130" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位号" width="100">
          <template #default="scope">{{ scope.row.berthNo || '未分配' }}</template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="110">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="110" />
      </el-table>
    </el-card>
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
  max-width: 820px;
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.draft-alert {
  border-radius: 10px;
}
.voyage-alert {
  margin-bottom: 18px;
}
.field-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8592a0;
  line-height: 1.5;
}
.stat-row {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  color: #7b8a99;
}
.stat b {
  font-size: 18px;
  color: #17324d;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #6b7c8c;
}
.waiting-list {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.waiting-list__title {
  width: 100%;
  margin: 0 0 2px;
  font-size: 12px;
  color: #b8741a;
}
</style>
