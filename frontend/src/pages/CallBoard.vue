<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore, LedgerStaleError, VesselActiveError } from '../stores/portStore';
import { useVesselStore } from '../stores/vesselStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { useBerthStatus } from '../hooks/useBerthStatus';
import { currentAgentId } from '../services/agent';
import BerthGrid from '../components/common/BerthGrid.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { CallDraft, CallType } from '../types/call';
import { CALL_TYPES, VISA_STATUSES, emptyCallDraft } from '../types/call';
import {
  formatDateTime,
  formatNumber,
  isToday,
  nowLocalInputValue,
  plusHoursLocalInput,
  toPlain,
} from '../utils/format';

interface CallForm extends CallDraft {}

const router = useRouter();
const portStore = usePortStore();
const vesselStore = useVesselStore();
const agentId = currentAgentId();

const { draft, restored, savedAt, storageKey, persist, restore, clearDraft } = useLocalDraft<CallForm>('call-board', () => ({
  ...emptyCallDraft(),
  time: nowLocalInputValue(),
  expectedLeaveAt: plusHoursLocalInput(12),
}));
const form = draft;

const formRef = ref<FormInstance>();
const submitting = ref(false);
const focusPortId = ref('');
/** 账本版本过期提示（其他窗口已抢占泊位） */
const staleHint = ref('');

const rules = computed<FormRules>(() => ({
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [
    {
      required: true,
      validator: (_r: unknown, value: string, cb: (e?: Error) => void) => {
        if (!value) {
          cb(new Error(form.value.type === '进港' ? '请选择进港渔港' : '该渔船没有可办理出港的在港租约'));
        } else cb();
      },
      trigger: 'change',
    },
  ],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
  expectedLeaveAt:
    form.value.type === '进港'
      ? [{ required: true, message: '请选择预计离港时间（超过后租约自动失效）', trigger: 'change' }]
      : [],
}));

const vesselOptions = computed(() => vesselStore.vessels);

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));

/** 所选渔船当前生效租约（同一渔船同时只能有一条未结束航次） */
const activeLease = computed(() =>
  form.value.vesselId ? portStore.activeLeaseOfVessel(form.value.vesselId) : undefined,
);

const activeLeasePort = computed(() =>
  activeLease.value ? portStore.portById(activeLease.value.portId) : undefined,
);

/** 出港可选渔船：仅当前有靠泊租约的船 */
const outboundOptions = computed(() =>
  vesselStore.vessels.filter((v) => {
    const lease = portStore.activeLeaseOfVessel(v.id);
    return lease?.state === '靠泊';
  }),
);

const portOptions = computed(() => portStore.ports);

const focusBerths = computed(() => (focusPortId.value ? portStore.berthsOf(focusPortId.value) : []));
const focusWaiting = computed(() => (focusPortId.value ? portStore.waitingLeasesOf(focusPortId.value) : []));

const { summary } = useBerthStatus(
  computed(() => portStore.effectiveBerths),
  computed(() => portStore.leases),
  computed(() => focusPortId.value),
);

/** 进港选港后实时判断容量是否已满（满了排队） */
const selectedPortSummary = computed(() => (form.value.portId ? summaryOfPort(form.value.portId) : null));

function summaryOfPort(portId: string) {
  const list = portStore.berthsOf(portId);
  const occupied = list.filter((b) => b.status === '占用').length;
  const maintenance = list.filter((b) => b.status === '维修').length;
  const waiting = portStore.waitingLeasesOf(portId).length;
  return {
    total: list.length,
    occupied,
    maintenance,
    waiting,
    free: list.length - occupied - maintenance,
    full: list.length - occupied - maintenance === 0,
  };
}

const todayCalls = computed(() => portStore.callsSorted.filter((c) => isToday(c.time)));

const todayStats = computed(() => ({
  inbound: todayCalls.value.filter((c) => c.type === '进港').length,
  outbound: todayCalls.value.filter((c) => c.type === '出港').length,
  ice: todayCalls.value.reduce((sum, c) => sum + c.iceKg, 0),
  fuel: todayCalls.value.reduce((sum, c) => sum + c.fuelL, 0),
  unload: todayCalls.value.reduce((sum, c) => sum + c.unloadKg, 0),
}));

function hasContent(value: CallForm): boolean {
  return (
    Boolean(value.vesselId) ||
    Boolean(value.portId) ||
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
      clearDraft();
    }
  }
  if (!form.value.expectedLeaveAt) form.value.expectedLeaveAt = plusHoursLocalInput(12, form.value.time);
  focusPortId.value = form.value.portId || portStore.ports[0]?.id || '';
});

watch(
  () => toPlain(form.value),
  (value) => {
    if (hasContent(value)) persist();
    else clearDraft();
  },
  { deep: true },
);

watch(
  () => form.value.type,
  () => {
    staleHint.value = '';
    // 切换类型后按租约状态重新对齐渔港
    syncPortByLease();
  },
);

watch(
  () => form.value.vesselId,
  () => {
    staleHint.value = '';
    syncPortByLease();
  },
);

watch(
  () => form.value.portId,
  (id) => {
    if (id) focusPortId.value = id;
  },
);

function syncPortByLease(): void {
  if (form.value.type === '出港') {
    const lease = form.value.vesselId ? portStore.activeLeaseOfVessel(form.value.vesselId) : undefined;
    form.value.portId = lease?.state === '靠泊' ? lease.portId : '';
    if (lease?.state === '排队') {
      ElMessage.warning('该渔船正在排队等泊，尚无泊位可出港；可在下方排队列表取消排队');
    }
  } else if (activeLease.value) {
    // 进港不自动改选港，仅提示重复航次
  }
}

function selectBerth(berth: (typeof focusBerths.value)[number]): void {
  focusPortId.value = berth.portId;
  if (berth.status === '占用' && berth.vesselName) {
    ElMessage.info(`${berth.berthNo} 已由 ${berth.vesselName} 占用（租约由账本统一抢占）`);
  } else if (berth.status === '维修') {
    ElMessage.info(`${berth.berthNo} 正在维修，不参与抢占`);
  } else {
    ElMessage.info(`${berth.berthNo} 当前空闲，提交进港时由账本自动分配`);
  }
}

async function cancelWaiting(leaseId: string): Promise<void> {
  try {
    await portStore.releaseLease(leaseId);
    ElMessage.success('已取消排队，租约释放');
  } catch (error) {
    ElMessage.error(`取消排队失败：${(error as Error).message}`);
  }
}

async function submit(): Promise<void> {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }

  submitting.value = true;
  try {
    if (form.value.type === '进港') {
      if (activeLease.value) {
        throw new VesselActiveError(activeLease.value);
      }
      const payload: CallDraft = {
        vesselId: form.value.vesselId,
        type: '进港',
        portId: form.value.portId,
        time: form.value.time,
        expectedLeaveAt: form.value.expectedLeaveAt,
        berthNo: '',
        iceKg: Number(form.value.iceKg) || 0,
        fuelL: Number(form.value.fuelL) || 0,
        unloadKg: Number(form.value.unloadKg) || 0,
        visaStatus: form.value.visaStatus,
      };
      const result = await portStore.registerArrival(payload, selectedVessel.value.name, agentId);
      if (result.outcome === 'queued') {
        const s = summaryOfPort(payload.portId);
        ElMessage.warning(
          `${selectedVessel.value.name} 进港登记成功，但 ${portStore.portById(payload.portId)?.name ?? ''} 容量已满（占用 ${s.occupied}/${s.total - s.maintenance}），已进入排队等泊，腾出泊位后自动靠泊`,
        );
      } else {
        ElMessage.success(
          `已抢占泊位 ${result.lease.berthNo}：${selectedVessel.value.name} 靠泊 ${portStore.portById(payload.portId)?.name ?? ''}（账本 v${result.version}）`,
        );
      }
    } else {
      const lease = activeLease.value;
      if (!lease || lease.state !== '靠泊') {
        ElMessage.warning('该渔船没有在港靠泊租约，不能办理出港');
        return;
      }
      const payload: CallDraft = {
        vesselId: form.value.vesselId,
        type: '出港',
        portId: lease.portId,
        time: form.value.time,
        expectedLeaveAt: '',
        berthNo: lease.berthNo,
        iceKg: Number(form.value.iceKg) || 0,
        fuelL: Number(form.value.fuelL) || 0,
        unloadKg: Number(form.value.unloadKg) || 0,
        visaStatus: form.value.visaStatus,
      };
      const result = await portStore.registerDeparture(lease.id, payload, selectedVessel.value.name);
      ElMessage.success(
        `${selectedVessel.value.name} 已办理出港，泊位 ${lease.berthNo} 释放` +
          (result.promoted.length ? `，队首 ${result.promoted.map((l) => l.vesselName).join('、')} 已自动靠泊` : ''),
      );
    }

    staleHint.value = '';
    clearDraft();
    Object.assign(form.value, {
      ...emptyCallDraft(),
      time: nowLocalInputValue(),
      expectedLeaveAt: plusHoursLocalInput(12),
    });
  } catch (error) {
    if (error instanceof LedgerStaleError) {
      staleHint.value = error.message;
      ElMessage.error({ message: '泊位状态已被其他窗口更新，请点击「刷新占用」后再提交，旧版本不会被覆盖', duration: 4000 });
      await portStore.reloadLedger();
    } else if (error instanceof VesselActiveError) {
      ElMessage.warning(error.message);
    } else {
      ElMessage.error(`登记失败：${(error as Error).message}`);
    }
  } finally {
    submitting.value = false;
  }
}

async function refreshOccupancy(): Promise<void> {
  await portStore.reloadLedger();
  staleHint.value = '';
  ElMessage.success('占用账本已刷新到最新版本');
  syncPortByLease();
}

function portNameOf(call: { portId: string }): string {
  return portStore.portById(call.portId)?.name ?? '—';
}

function onTypeChange(t: CallType): void {
  form.value.type = t;
}

function openVessel(vesselId: string): void {
  void router.push(`/vessels/${vesselId}`);
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>进出港登记</h1>
        <p class="page__sub">
          登记前按账本最新状态抢占泊位，容量满了自动排队；窗口失联或超过预计离港时间后租约失效、占用释放并重算在港船数
        </p>
      </div>
      <el-button data-testid="refresh-ledger" @click="refreshOccupancy">刷新占用</el-button>
    </header>

    <el-alert
      v-if="staleHint"
      type="error"
      show-icon
      :closable="false"
      title="泊位状态已被其他窗口更新（旧版本保存已拦截）"
      data-testid="stale-alert"
      class="draft-alert"
    >
      <template #default>
        {{ staleHint }}，请点击右上角「刷新占用」载入最新账本后重试。
      </template>
    </el-alert>

    <el-alert
      v-else-if="restored"
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

    <el-row :gutter="16">
      <el-col :lg="13" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">登记表单 · 窗口 {{ agentId }}</span></template>
          <el-form ref="formRef" :model="form" :rules="rules" label-width="110px" data-testid="call-form">
            <el-form-item label="渔船" prop="vesselId">
              <el-select
                id="call-vessel"
                v-model="form.vesselId"
                placeholder="请选择渔船"
                filterable
                style="width: 100%"
              >
                <el-option
                  v-for="v in form.type === '出港' ? outboundOptions : vesselOptions"
                  :key="v.id"
                  :label="`${v.name}（${v.homePort} · ${formatNumber(v.enginePower, 0)}kW）`"
                  :value="v.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item label="进出港类型" prop="type">
              <el-radio-group v-model="form.type" data-testid="call-type" @change="onTypeChange">
                <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
              </el-radio-group>
            </el-form-item>

            <!-- 同一渔船已有未结束航次的拦截提示 -->
            <el-alert
              v-if="form.type === '进港' && activeLease"
              type="warning"
              show-icon
              :closable="false"
              class="lease-alert"
              data-testid="duplicate-voyage-alert"
            >
              <template #title>
                该渔船已有未结束航次：{{ activeLease.state === '排队' ? '排队等泊中' : `靠泊于 ${activeLeasePort?.name ?? ''} ${activeLease.berthNo}` }}，不能重复靠泊
              </template>
            </el-alert>

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

            <el-form-item v-if="form.type === '进港'" label="进港渔港" prop="portId">
              <el-select id="call-port" v-model="form.portId" placeholder="选择渔港（泊位由账本自动抢占）" style="width: 100%">
                <el-option
                  v-for="p in portOptions"
                  :key="p.id"
                  :label="`${p.name}（占用 ${summaryOfPort(p.id).occupied}/${p.berthCount - summaryOfPort(p.id).maintenance}${summaryOfPort(p.id).maintenance ? `，维修 ${summaryOfPort(p.id).maintenance}` : ''}${summaryOfPort(p.id).waiting ? `，排队 ${summaryOfPort(p.id).waiting}` : ''}）`"
                  :value="p.id"
                />
              </el-select>
            </el-form-item>

            <el-form-item v-else label="出港渔港">
              <el-input :model-value="activeLeasePort?.name ?? '该渔船无在港靠泊租约'" disabled />
            </el-form-item>

            <!-- 进港：租约时长 + 容量提示 -->
            <template v-if="form.type === '进港'">
              <el-form-item label="预计离港" prop="expectedLeaveAt">
                <el-date-picker
                  id="call-expected-leave"
                  v-model="form.expectedLeaveAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm"
                  placeholder="预计离港时间"
                  style="width: 100%"
                />
              </el-form-item>
              <el-alert
                v-if="selectedPortSummary"
                :type="selectedPortSummary.full ? 'warning' : 'success'"
                show-icon
                :closable="false"
                class="lease-alert"
                :title="
                  selectedPortSummary.full
                    ? `该港容量已满（占用 ${selectedPortSummary.occupied}/${selectedPortSummary.total - selectedPortSummary.maintenance}），提交后进入排队等泊，不挤占容量`
                    : `当前可抢占 ${selectedPortSummary.free} 个泊位（占用 ${selectedPortSummary.occupied}/${selectedPortSummary.total - selectedPortSummary.maintenance}），提交后自动分配最小空闲泊位号`
                "
                :description="selectedPortSummary.waiting ? `另有 ${selectedPortSummary.waiting} 艘在排队，按 FIFO 先出先靠。` : ''"
              />
            </template>

            <!-- 出港：租约信息 -->
            <el-alert
              v-else-if="activeLease && activeLease.state === '靠泊'"
              type="info"
              show-icon
              :closable="false"
              class="lease-alert"
              :title="`当前租约：${activeLeasePort?.name ?? ''} · 泊位 ${activeLease.berthNo} · 靠泊于 ${formatDateTime(activeLease.berthAt)}`"
              :description="`预计离港 ${formatDateTime(activeLease.expectedLeaveAt)}，出港后释放占用并自动调度队首船舶。`"
            />

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
                :disabled="form.type === '进港' ? Boolean(activeLease) : !(activeLease && activeLease.state === '靠泊')"
                data-testid="submit-call"
                @click="submit"
              >
                {{ form.type === '进港' ? '抢占登记' : '办理出港' }}
              </el-button>
              <el-button data-testid="clear-draft" @click="clearDraft(); ElMessage.success('草稿已清空')">清空草稿</el-button>
              <el-button v-if="selectedVessel" text type="primary" @click="openVessel(selectedVessel.id)">查看渔船档案</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :lg="11" :md="24">
        <el-card shadow="never" class="detail-card">
          <template #header><span class="card-title">今日统计</span></template>
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
              生效占用网格{{ focusPortId ? ` · ${portStore.portById(focusPortId)?.name ?? ''}` : '' }}
            </span>
          </template>
          <el-select v-model="focusPortId" size="small" style="width: 220px; margin-bottom: 10px">
            <el-option v-for="p in portStore.ports" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
          <BerthGrid v-if="focusBerths.length" :berths="focusBerths" @select="selectBerth" />
          <EmptyState v-else title="尚未选择渔港" description="在上方下拉选择渔港查看生效占用。" />
          <p v-if="focusBerths.length" class="detail-hint">
            占用率 {{ (summary.occupancyRate * 100).toFixed(1) }}% · 占用 {{ summary.occupied }} · 空闲 {{ summary.free }} · 维修 {{ summary.maintenance }} · 排队 {{ summary.waiting }}
          </p>
          <div v-if="focusWaiting.length" class="queue-list" data-testid="waiting-queue">
            <p class="queue-title">排队等泊（{{ focusWaiting.length }} 艘，FIFO）</p>
            <div v-for="(lease, idx) in focusWaiting" :key="lease.id" class="queue-item">
              <span class="queue-no">#{{ idx + 1 }}</span>
              <span class="queue-name">{{ lease.vesselName }}</span>
              <span class="queue-time">入队 {{ formatDateTime(lease.enqueuedAt) }}</span>
              <el-button text type="danger" size="small" @click="cancelWaiting(lease.id)">取消排队</el-button>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="detail-card">
      <template #header><span class="card-title">今日流水（{{ todayCalls.length }} 条）</span></template>
      <el-table :data="todayCalls" size="small" border empty-text="今日暂无进出港流水" data-testid="today-calls">
        <el-table-column prop="vesselName" label="船名" min-width="120" />
        <el-table-column label="渔港" min-width="120">
          <template #default="scope">{{ portNameOf(scope.row) }}</template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column label="时间" min-width="150">
          <template #default="scope">{{ formatDateTime(scope.row.time) }}</template>
        </el-table-column>
        <el-table-column label="泊位号" width="110">
          <template #default="scope">
            <el-tag v-if="scope.row.berthNo" size="small">{{ scope.row.berthNo }}</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">未分配</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="120">
          <template #default="scope">
            <el-tag v-if="scope.row.leaseExpired" size="small" type="danger">租约失效自动出港</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="加冰 kg" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.iceKg, 0) }}</template>
        </el-table-column>
        <el-table-column label="加油 L" min-width="90">
          <template #default="scope">{{ formatNumber(scope.row.fuelL, 0) }}</template>
        </el-table-column>
        <el-table-column label="卸货 kg" min-width="100">
          <template #default="scope">{{ formatNumber(scope.row.unloadKg, 0) }}</template>
        </el-table-column>
        <el-table-column prop="visaStatus" label="签证状态" width="100" />
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
}
.detail-card {
  border-radius: 10px;
  margin-bottom: 16px;
}
.card-title {
  font-weight: 600;
  color: #17324d;
}
.draft-alert,
.lease-alert {
  border-radius: 10px;
  margin-bottom: 12px;
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
.queue-list {
  margin-top: 12px;
  border-top: 1px dashed #e0e8f0;
  padding-top: 10px;
}
.queue-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #b88230;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #4b5c6d;
  padding: 4px 0;
}
.queue-no {
  background: #fdf6ec;
  color: #b88230;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 12px;
}
.queue-name {
  font-weight: 600;
}
.queue-time {
  color: #97a6b4;
  font-size: 12px;
}
</style>
