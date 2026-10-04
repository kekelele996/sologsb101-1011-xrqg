<script setup lang="ts">
/**
 * 模块 2：/stations/:id/sections 断面测次列表与测法标记
 * 新增测次后回显当前水位；深链访问时若测站不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Timer } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useReconcileStore } from '@/stores/reconcileStore'
import { calcSectionDischarge, calcMeanVelocity } from '@/utils/flow'
import { MEASURE_METHODS, REF_STATUS_TONE, type MeasureMethod, type Section } from '@/types/section'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const reconcileStore = useReconcileStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  stageM: 0,
  method: '流速仪' as MeasureMethod,
  measuredAt: new Date().toISOString().slice(0, 16)
})

const sectionRows = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  return list.filter((section) => {
    const keyword = sectionStore.filter.keyword.trim()
    if (keyword.length > 0 && !`${section.measureNo}${section.method}`.includes(keyword)) return false
    if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
    if (sectionStore.filter.minStageM !== null && section.stageM < sectionStore.filter.minStageM) return false
    return true
  })
})

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.filter.keyword,
  methods: sectionStore.filter.methods,
  minStageM: sectionStore.filter.minStageM
}))

const stats = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  const stages = list.map((section) => section.stageM)
  const verticalCount = list.reduce(
    (sum, section) => sum + (sectionStore.sectionVerticalCounts[section.id] ?? 0),
    0
  )
  return {
    count: list.length,
    maxStageM: stages.length ? Math.max(...stages) : null,
    minStageM: stages.length ? Math.min(...stages) : null,
    latest: list.reduce<Section | null>((acc, section) => {
      if (!acc) return section
      return Date.parse(section.measuredAt) > Date.parse(acc.measuredAt) ? section : acc
    }, null),
    verticalCount,
    currentStageM: list.length ? list[0].stageM : null
  }
})

/** 取测次对账视图（编号状态 / 说明） */
function refViewOf(section: Section) {
  return reconcileStore.sectionViews.find((view) => view.section.id === section.id) ?? null
}

/** 实时计算某测次断面流量（垂线部分面积法），供「报流量」使用 */
function liveDischargeOf(section: Section): number {
  const verticals = sectionStore.verticalsOfSection(section.id)
  const slices = verticals.map((vertical) => {
    const points = sectionStore.pointsOfVertical(vertical.id)
    return {
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs: calcMeanVelocity(
        points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
      )
    }
  })
  return calcSectionDischarge(slices).flowM3s
}

/** 悬空 / 待认领测次数（含提示条统计） */
const heldCount = computed(
  () => sectionRows.value.filter((section) => section.refStatus !== '对账中').length
)

async function reportSectionFlow(section: Section): Promise<void> {
  if (section.refStatus !== '对账中') {
    ElMessage.warning('编号已撤或并走，该测次先搁着，这期间流量先不报')
    return
  }
  const flowM3s = liveDischargeOf(section)
  if (!(flowM3s > 0)) {
    ElMessage.warning('该测次尚无有效垂线测点，算不出断面流量')
    return
  }
  const accepted = await reconcileStore.reportFlow(section.id, flowM3s)
  if (accepted) ElMessage.success(`流量 ${flowM3s.toFixed(2)} m³/s 已按编号 ${section.refCode} 报出`)
  else ElMessage.error('报量失败：编号对账状态已变化，请刷新后重试')
}

function gotoReconcile(section?: Section): void {
  void router.push({ path: '/reconcile', query: section ? { focus: section.id } : {} })
}

/** 悬空 / 待认领测次整行置灰，提示先搁着 */
function sectionRowClass({ row }: { row: Section }): string {
  return row.refStatus === '对账中' ? '' : 'gb-row-held'
}

function openCreate(): void {
  editingId.value = null
  form.measureNo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
    stats.value.count + 1
  ).padStart(3, '0')}`
  form.startDistanceM = stats.value.latest?.startDistanceM ?? 0
  form.stageM = stats.value.latest?.stageM ?? 0
  form.method = '流速仪'
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(section: Section): void {
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.stageM = section.stageM
  form.method = section.method
  form.measuredAt = section.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.measureNo.trim()) {
    ElMessage.warning('请填写测次号')
    return
  }
  if (!Number.isFinite(form.stageM) || form.stageM <= -50 || form.stageM > 200) {
    ElMessage.warning('水位应在 -50 ~ 200 m 之间')
    return
  }
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  if (!form.measuredAt) {
    ElMessage.warning('请选择测流时间')
    return
  }
  submitting.value = true
  const owner = station.value
  if (!owner) {
    ElMessage.warning('测站不存在，无法落测次')
    submitting.value = false
    return
  }
  const payload = {
    stationId: stationId.value,
    measureNo: form.measureNo.trim(),
    startDistanceM: form.startDistanceM,
    stageM: form.stageM,
    method: form.method,
    measuredAt: new Date(form.measuredAt).toISOString()
  }
  try {
    if (editingId.value) {
      await sectionStore.updateSection(editingId.value, payload)
      ElMessage.success('测次已更新')
    } else {
      // 落测次即引用站网科当前编号 + 版本；编号已撤/并走时新测次置悬空、暂停报量
      const created = await sectionStore.createSection({
        ...payload,
        refCode: owner.sectionCode,
        refVersion: owner.codeVersion,
        refStatus: owner.lifecycle === '现行' ? '对账中' : '悬空',
        refNote:
          owner.lifecycle === '现行'
            ? `落测次引用编号 ${owner.sectionCode} v${owner.codeVersion}`
            : `落测次时编号 ${owner.sectionCode} 已${owner.lifecycle === '已撤' ? '撤' : '并走'}，等重新指派`,
        reported: false,
        reportedFlowM3s: null,
        reportedAt: null
      })
      sectionStore.selectSection(created.id)
      ElMessage.success(`测次已新增，当前水位 ${created.stageM.toFixed(2)} m`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSection(section: Section): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除测次「${section.measureNo}」将同时删除其垂线、流速测点与相关计算，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeSection(section.id)
  ElMessage.success('测次及其垂线测点已删除')
}

function gotoVerticals(section: Section): void {
  sectionStore.selectSection(section.id)
  void router.push(`/sections/${section.id}/verticals`)
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(sectionStore.filter.keyword.trim() ? { kw: sectionStore.filter.keyword.trim() } : {}),
      ...(sectionStore.filter.methods.length ? { methods: sectionStore.filter.methods.join(',') } : {}),
      ...(sectionStore.filter.minStageM !== null ? { minStage: String(sectionStore.filter.minStageM) } : {})
    }
  })
}

function handleReset(): void {
  sectionStore.resetFilter()
  void router.replace({ query: {} })
}

function reseedIfEmpty(): void {
  if (stationStore.stations.length === 0) void initDatabase()
}

onMounted(() => {
  reseedIfEmpty()
  reconcileStore.start()
  const query = route.query
  sectionStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    methods: typeof query.methods === 'string' ? (query.methods.split(',') as MeasureMethod[]) : [],
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的测次`,
          path: `/stations/${item.id}/sections`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>断面测次</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 断面测次
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }} v{{ station.codeVersion }}</el-tag>
            <el-tag
              size="small"
              :type="station.lifecycle === '现行' ? 'success' : station.lifecycle === '已撤' ? 'danger' : 'warning'"
              effect="plain"
            >
              编号{{ station.lifecycle }}
            </el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            集水面积 {{ station.catchmentKm2 }} km²。河名、集水面积与断面编号归站网科定；巡测队按「编号 + 版本」落测次。
            编号撤号 / 并号期间，相关测次先搁着、流量先不报，到编号对账台等重新指派。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge
          label="当前水位"
          :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
        <StatBadge
          label="水位变幅"
          :value="stats.minStageM === null ? '—' : `${stats.minStageM.toFixed(2)} ~ ${stats.maxStageM?.toFixed(2)}`"
          suffix="m"
          tone="warning"
          icon="TrendCharts"
        />
        <StatBadge label="垂线合计" :value="stats.verticalCount" suffix="条" tone="success" icon="Histogram" />
      </div>

      <el-alert
        v-if="heldCount > 0"
        type="warning"
        show-icon
        :closable="false"
        class="page__held-alert"
        title="该站有测次的编号已撤或并走（或旧编号待认领）：测次先搁着，这期间流量先不报，先前报出去的按当时编号仍可查。"
      >
        <div class="page__held-actions">
          <el-button size="small" type="primary" @click="gotoReconcile()">前往编号对账台</el-button>
        </div>
      </el-alert>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
        ]"
        :number-ranges="[{ key: 'minStageM', label: '水位不低于', placeholder: '不限', unit: 'm' }]"
        keyword-placeholder="搜索测次号 / 测法"
        @change="handleFilterChange"
        @reset="handleReset"
      >
        <template #extra>
          <el-tag v-if="stats.latest" type="success" effect="plain">
            最新测次 {{ stats.latest.measureNo }} · 水位 {{ stats.latest.stageM.toFixed(2) }} m
          </el-tag>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="sectionRows.length === 0"
        :title="sectionStore.sectionsOfStation(stationId).length === 0 ? '该测站还没有测次' : '没有符合条件的测次'"
        description="新增一次流量测验后，即可布设垂线、录入测深与流速测点。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact" :row-class-name="sectionRowClass">
        <el-table-column prop="measureNo" label="测次号" min-width="150" />
        <el-table-column label="引用编号" min-width="150">
          <template #default="{ row }">
            <div class="page__ref-cell">
              <span class="gb-mono">{{ row.refCode || '—' }}</span>
              <el-tag size="small" :type="REF_STATUS_TONE[row.refStatus as keyof typeof REF_STATUS_TONE]" effect="plain">
                {{ row.refStatus }}
              </el-tag>
            </div>
            <span v-if="refViewOf(row)?.statusText" class="page__ref-note">{{ refViewOf(row)?.statusText }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测法" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.method === 'ADCP' ? 'success' : row.method === '浮标' ? 'warning' : 'primary'" effect="plain">
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="流量上报" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.reported" size="small" type="success" effect="plain">
              已报 {{ row.reportedFlowM3s?.toFixed(1) }} m³/s
            </el-tag>
            <el-tag v-else-if="row.refStatus === '对账中'" size="small" type="info" effect="plain">未报</el-tag>
            <el-tooltip v-else content="编号撤并 / 待认领期间流量先不报" placement="top">
              <el-tag size="small" type="warning" effect="plain">暂停报量</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="垂线条数" width="100" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.id] ?? 0 }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="测流时间" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">垂线</el-button>
            <el-button
              size="small"
              type="success"
              plain
              :disabled="row.refStatus !== '对账中' || row.reported"
              @click="reportSectionFlow(row)"
            >
              报流量
            </el-button>
            <el-button
              v-if="row.refStatus !== '对账中'"
              size="small"
              type="warning"
              plain
              @click="gotoReconcile(row)"
            >
              对账
            </el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSection(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无测次" description="点击右上角「新增测次」开始录入。" compact />
        </template>
      </el-table>

      <p class="gb-hint">
        <el-icon><Timer /></el-icon>
        提示：测次的水位将参与水位流量关系点据定线；同一测次下的垂线按起点距升序参与部分面积法流量计算。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次' : '新增断面测次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="2000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测流时间" required>
          <el-date-picker v-model="form.measuredAt" type="datetime" placeholder="选择测流时间" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并布设垂线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__tag {
  font-weight: 400;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__held-alert {
  align-items: center;
}

.page__held-actions {
  margin-top: 6px;
}

.page__ref-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__ref-note {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #8194a2;
}

:deep(.gb-row-held) {
  --el-table-row-hover-bg-color: #fdf3ec;
}

:deep(.gb-row-held td) {
  background-color: #fbf4ee !important;
  color: #8a6a55;
}
</style>
