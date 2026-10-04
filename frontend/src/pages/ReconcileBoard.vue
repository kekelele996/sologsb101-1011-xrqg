<script setup lang="ts">
/**
 * 编号对账台 /reconcile：站网科编号与巡测队测次按「编号 + 版本」对账。
 * - 悬空队列：编号已撤 / 已并走 / 换版，等站网科重新指派；期间流量先不报；
 * - 待认领：旧数据没记编号版本、自动迁移补不齐，单列交人认；
 * - 重新指派只改巡测队这头引用，站网科编号不动；指派失败退回本侧重试。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, RefreshLeft, TopRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReconcileStore, type SectionRefView } from '@/stores/reconcileStore'
import { REF_STATUS_TONE } from '@/types/section'

const route = useRoute()
const router = useRouter()
const reconcileStore = useReconcileStore()

const activeTab = ref<'dangling' | 'pending' | 'matched' | 'ledger'>('dangling')
/** 每行选中的重新指派目标编号 + 批量指派目标 */
const targetBySection = ref<Record<string, string>>({})
const batchTarget = ref<string>('')
const selectedIds = ref<string[]>([])
const busy = ref(false)
const focusId = ref<string>(String(route.query.focus ?? ''))

onMounted(() => {
  reconcileStore.start()
  if (focusId.value) {
    // 深链带 focus：自动切到该测次所在队列
    queueWatch()
  }
})

watch(
  () => route.query.focus,
  (value) => {
    focusId.value = String(value ?? '')
    if (focusId.value) queueWatch()
  }
)

function queueWatch(): void {
  const view = reconcileStore.sectionViews.find((item) => item.section.id === focusId.value)
  if (!view) return
  if (view.section.refStatus === '悬空') activeTab.value = 'dangling'
  else if (view.section.refStatus === '待认领') activeTab.value = 'pending'
  else activeTab.value = 'matched'
}

const codeOptions = computed(() =>
  reconcileStore.activeCodes.map((ledger) => ({
    value: ledger.sectionCode,
    label: `${ledger.sectionCode} v${ledger.codeVersion} · ${ledger.stationName}（${ledger.river}）`
  }))
)

function targetOf(view: SectionRefView): string {
  // 并号走的测次默认建议并入目标编号（须仍现行）
  if (!targetBySection.value[view.section.id]) {
    const suggested = view.ledger?.mergedToCode
    if (suggested && reconcileStore.activeCodes.some((ledger) => ledger.sectionCode === suggested)) {
      targetBySection.value[view.section.id] = suggested
    } else {
      targetBySection.value[view.section.id] = batchTarget.value || codeOptions.value[0]?.value || ''
    }
  }
  return targetBySection.value[view.section.id]
}

function setTarget(view: SectionRefView, code: string): void {
  targetBySection.value[view.section.id] = code
}

/** 站网科重新指派：改巡测队引用；失败退回本侧重试（编号不动） */
async function reassign(view: SectionRefView): Promise<void> {
  const target = targetOf(view)
  if (!target) {
    ElMessage.warning('请先选择现行编号')
    return
  }
  busy.value = true
  try {
    const ok = await reconcileStore.reassignSection(view.section.id, target)
    if (ok) {
      ElMessage.success(`测次 ${view.section.measureNo} 已重新指派到 ${target}，恢复报量`)
    } else {
      ElMessage.error(`重新指派失败：${target} 已不是现行编号。已退回本侧重试，站网科编号未改动`)
      await reconcileStore.retryOnOurSide(view.section.id)
    }
  } finally {
    busy.value = false
  }
}

/** 待认领：人工认领旧测次到现存现行编号 */
async function claim(view: SectionRefView): Promise<void> {
  const target = targetOf(view)
  if (!target) {
    ElMessage.warning('请选择一个现存现行编号完成认领')
    return
  }
  busy.value = true
  try {
    const ok = await reconcileStore.claimLegacySection(view.section.id, target)
    if (ok) ElMessage.success(`旧测次 ${view.section.measureNo} 已认领到 ${target}，编号版本补齐`)
    else ElMessage.error('认领失败：目标编号不现行，已退回本侧重试')
  } finally {
    busy.value = false
  }
}

async function batchReassign(): Promise<void> {
  const target = batchTarget.value || codeOptions.value[0]?.value || ''
  if (!target) {
    ElMessage.warning('请选择批量指派的现行编号')
    return
  }
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要重新指派的测次')
    return
  }
  busy.value = true
  try {
    const result = await reconcileStore.reassignSections(selectedIds.value, target)
    ElMessage.success(`批量重新指派完成：成功 ${result.ok} 个，失败 ${result.fail} 个（失败的已退回重试）`)
    selectedIds.value = []
  } finally {
    busy.value = false
  }
}

async function retryAll(): Promise<void> {
  busy.value = true
  try {
    const result = await reconcileStore.reconcileAll()
    ElMessage.success(
      `重新对账：对账中 ${result.matched} 个、仍悬空 ${result.stillDangling} 个、待认领 ${result.pending} 个`
    )
  } finally {
    busy.value = false
  }
}

function rowClass({ row }: { row: SectionRefView }): string {
  if (row.section.id === focusId.value) return 'gb-row-focus'
  return row.section.refStatus === '对账中' ? '' : 'gb-row-held'
}

const tableViews = computed<SectionRefView[]>(() => {
  if (activeTab.value === 'dangling') return reconcileStore.danglingViews
  if (activeTab.value === 'pending') return reconcileStore.pendingViews
  if (activeTab.value === 'matched') return reconcileStore.matchedViews
  return []
})

function openVerticals(view: SectionRefView): void {
  void router.push(`/sections/${view.section.id}/verticals`)
}

function timeOf(iso: string): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—'
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">编号对账台</h2>
        <p class="gb-hint">
          站网科管河名、集水面积与断面编号，巡测队按「编号 + 版本」落测次。撤号 / 并号 / 换版后，
          引用它的测次悬空、流量先不报；先前报出去的按当时编号仍可查。重新指派只改巡测队引用，站网科编号不动。
        </p>
      </div>
      <el-button :icon="Refresh" :loading="busy" @click="retryAll">重新对账</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="对账中" :value="reconcileStore.summary.matched" suffix="次" tone="success" icon="Files" />
      <StatBadge label="悬空等指派" :value="reconcileStore.summary.dangling" suffix="次" tone="danger" icon="WarningFilled" />
      <StatBadge label="待人工认领" :value="reconcileStore.summary.pending" suffix="次" tone="warning" icon="Histogram" />
    </div>

    <el-tabs v-model="activeTab" class="recon-tabs">
      <el-tab-pane name="dangling">
        <template #label>
          悬空队列
          <el-badge v-if="reconcileStore.summary.dangling > 0" :value="reconcileStore.summary.dangling" class="recon-badge" />
        </template>
      </el-tab-pane>
      <el-tab-pane name="pending" :label="`待认领（${reconcileStore.summary.pending}）`" />
      <el-tab-pane name="matched" :label="`对账中（${reconcileStore.summary.matched}）`" />
      <el-tab-pane name="ledger" label="编号台账（站网科）" />
    </el-tabs>

    <!-- 悬空 / 待认领 / 对账中共用测次表 -->
    <template v-if="activeTab !== 'ledger'">
      <div v-if="activeTab !== 'matched' && tableViews.length > 0" class="recon-batch">
        <span class="recon-batch__label">批量指派到</span>
        <el-select v-model="batchTarget" placeholder="选择现行编号" style="width: 320px">
          <el-option v-for="option in codeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-button type="primary" plain :loading="busy" @click="batchReassign">
          批量{{ activeTab === 'pending' ? '认领 / ' : '' }}重新指派（{{ selectedIds.length }}）
        </el-button>
      </div>

      <EmptyPanel
        v-if="tableViews.length === 0"
        :title="activeTab === 'dangling' ? '没有悬空测次' : activeTab === 'pending' ? '没有待认领旧数据' : '暂无对账中的测次'"
        :description="
          activeTab === 'matched'
            ? '编号现行且版本一致的测次可正常报流量。'
            : '撤号 / 并号 / 换版后引用旧编号的测次会出现在这里，等站网科重新指派。'
        "
        secondary-text="去测站台账"
        @secondary="void $router.push('/stations')"
      />

      <el-table
        v-else
        :data="tableViews"
        border
        stripe
        class="gb-table-compact"
        :row-class-name="rowClass"
        @selection-change="(rows: SectionRefView[]) => (selectedIds = rows.map((item) => item.section.id))"
      >
        <el-table-column v-if="activeTab !== 'matched'" type="selection" width="46" />
        <el-table-column label="测次号 / 测法" min-width="170">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.section.measureNo }}</div>
            <span class="recon-sub">{{ row.section.method }} · {{ row.section.stageM.toFixed(2) }} m</span>
          </template>
        </el-table-column>
        <el-table-column label="录入归属" min-width="150">
          <template #default="{ row }">
            {{ row.ownerStation?.name ?? '（无归属 / 历史测次）' }}
          </template>
        </el-table-column>
        <el-table-column label="引用编号" min-width="180">
          <template #default="{ row }">
            <div class="recon-ref">
              <span class="gb-mono">{{ row.section.refCode || '—' }}</span>
              <el-tag size="small" type="info" effect="plain">
                        {{ row.section.refVersion === null ? '无版本' : `v${row.section.refVersion}` }}
              </el-tag>
              <el-tag size="small" :type="REF_STATUS_TONE[(row.section.refStatus as keyof typeof REF_STATUS_TONE)]" effect="dark">{{ row.section.refStatus }}</el-tag>
            </div>
            <span class="recon-sub">{{ row.statusText }}</span>
          </template>
        </el-table-column>
        <el-table-column label="流量上报" min-width="170">
          <template #default="{ row }">
            <el-tag v-if="row.section.reported" size="small" type="success" effect="plain">
              已报 {{ row.section.reportedFlowM3s?.toFixed(1) }} m³/s
            </el-tag>
            <el-tag v-else-if="row.canReport" size="small" type="info" effect="plain">未报（可报）</el-tag>
            <el-tag v-else size="small" type="warning" effect="plain">暂停报量</el-tag>
            <div v-if="row.section.reportedAt" class="recon-sub">报于 {{ timeOf(row.section.reportedAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="activeTab !== 'matched'" label="重新指派到" min-width="300">
          <template #default="{ row }">
            <el-select
              :model-value="targetOf(row)"
              placeholder="选择现行编号"
              style="width: 100%"
              @update:model-value="(value: string) => setTarget(row, value)"
            >
              <el-option v-for="option in codeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="TopRight" @click="openVerticals(row)">垂线/流量</el-button>
            <el-button
              v-if="activeTab === 'pending'"
              size="small"
              type="warning"
              :loading="busy"
              @click="claim(row)"
            >
              人工认领
            </el-button>
            <el-button
              v-else-if="activeTab === 'dangling'"
              size="small"
              type="primary"
              :loading="busy"
              @click="reassign(row)"
            >
              重新指派
            </el-button>
            <el-button v-if="activeTab !== 'matched'" size="small" :icon="RefreshLeft" @click="reconcileStore.retryOnOurSide(row.section.id)">
              退回重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 编号台账：站网科域的事件流 -->
    <template v-else>
      <EmptyPanel
        v-if="reconcileStore.ledgers.length === 0"
        title="编号台账为空"
        description="在测站台账新建测站后，站网科的指派 / 撤号 / 并号 / 换版动作会在此留痕。"
        secondary-text="去测站台账"
        @secondary="void $router.push('/stations')"
      />
      <el-row v-else :gutter="14">
        <el-col v-for="ledger in reconcileStore.ledgers" :key="ledger.sectionCode" :xs="24" :sm="12" :lg="8">
          <el-card shadow="hover" class="recon-ledger">
            <template #header>
              <div class="recon-ledger__head">
                <strong class="gb-mono">{{ ledger.sectionCode }}</strong>
                <el-tag size="small" type="info" effect="plain">v{{ ledger.codeVersion }}</el-tag>
                <el-tag
                  size="small"
                  :type="ledger.lifecycle === '现行' ? 'success' : ledger.lifecycle === '已撤' ? 'danger' : 'warning'"
                  effect="dark"
                >
                  {{ ledger.lifecycle }}
                </el-tag>
              </div>
            </template>
            <p class="recon-ledger__line">{{ ledger.stationName }} · {{ ledger.river }} · {{ ledger.catchmentKm2 }} km²</p>
            <p v-if="ledger.mergedToCode" class="recon-ledger__line">并入：<b class="gb-mono">{{ ledger.mergedToCode }}</b></p>
            <el-timeline class="recon-timeline">
              <el-timeline-item
                v-for="event in [...ledger.events].reverse()"
                :key="event.id"
                :timestamp="timeOf(event.occurredAt)"
                :type="event.eventType === '撤号' ? 'danger' : event.eventType === '并号' ? 'warning' : 'primary'"
              >
                <el-tag size="small" effect="plain">{{ event.eventType }}</el-tag>
                <span class="recon-sub">{{ event.reason || '—' }}</span>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.recon-badge {
  margin-left: 6px;
}

.recon-batch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #fff;
  border: 1px dashed #d8e4ec;
  border-radius: 10px;
}

.recon-batch__label {
  font-size: 13px;
  color: #5b6b78;
}

.recon-ref {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.recon-sub {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #8194a2;
}

.recon-ledger__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.recon-ledger__line {
  margin: 0 0 8px;
  font-size: 13px;
  color: #5b6b78;
}

.recon-timeline {
  margin-top: 8px;
  padding-left: 4px;
}

:deep(.gb-row-held td) {
  background-color: #fbf4ee !important;
  color: #8a6a55;
}

:deep(.gb-row-focus td) {
  background-color: #eef7ff !important;
}
</style>
