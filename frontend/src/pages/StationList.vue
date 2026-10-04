<script setup lang="ts">
/**
 * 模块 1：/stations 测站台账
 * 新建测站与断面编号、按河名与集水面积筛选；卡片回显测次总数、最新水位与合格率。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Cpu, Delete, Edit, Plus, Right, Warning } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useRatingStore } from '@/stores/ratingStore'
import { useReconcileStore } from '@/stores/reconcileStore'
import { CATCHMENT_BUCKETS, createEmptyStationFilter, type Station } from '@/types/station'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const ratingStore = useRatingStore()
const reconcileStore = useReconcileStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  name: '',
  river: '',
  catchmentKm2: 1000,
  sectionCode: '',
  remark: ''
})

/** 撤号弹窗 */
const withdrawVisible = ref(false)
const withdrawTarget = ref<Station | null>(null)
const withdrawReason = ref('')
/** 并号弹窗 */
const mergeVisible = ref(false)
const mergeTarget = ref<Station | null>(null)
const mergeCode = ref<string>('')
const mergeReason = ref('')
const codeBusy = ref(false)

const filterModel = computed<FilterModel>(() => ({
  keyword: stationStore.filter.keyword,
  rivers: stationStore.filter.rivers,
  minCatchmentKm2: stationStore.filter.minCatchmentKm2,
  maxCatchmentKm2: stationStore.filter.maxCatchmentKm2
}))

const riverSelectOptions = computed(() =>
  stationStore.riverOptions.map((river) => ({ label: river, value: river }))
)

/** 集水面积分档下拉：切换即写入上下限 */
const catchmentBucket = ref<string>('all')

const stationCards = computed(() =>
  stationStore.filteredStations.map((station) => {
    const stats = stationStore.sectionStats[station.id] ?? { count: 0, latestStageM: null, latestMeasuredAt: null }
    const ratings = ratingStore.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const compares = ratingStore.compares.filter((compare) => ratingIds.has(compare.ratingId))
    const overLimit = compares.filter((compare) => compare.verdict === '超限').length
    const heldCount = reconcileStore.sections
      .filter(
        (section) =>
          section.stationId === station.id &&
          (section.refCode === station.sectionCode || section.stationId === station.id)
      )
      .filter((section) => section.refStatus !== '对账中').length
    const qualifyRate =
      compares.length === 0 ? 0 : Number((((compares.length - overLimit) / compares.length) * 100).toFixed(0))
    return { station, stats, ratingCount: ratings.length, overLimit, qualifyRate, heldCount }
  })
)

/** 首次挂载：URL query 优先，其次用 store 现值 */
function applyQueryToFilter(): void {
  const query = route.query
  const toArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((item) => String(item))
    if (typeof value === 'string' && value.length > 0) return value.split(',')
    return []
  }
  const toNumber = (value: unknown): number | null => {
    const parsed = Number(value)
    return typeof value === 'string' && value.length > 0 && Number.isFinite(parsed) ? parsed : null
  }
  stationStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    rivers: toArray(query.rivers),
    minCatchmentKm2: toNumber(query.minArea),
    maxCatchmentKm2: toNumber(query.maxArea)
  })
}

async function syncQuery(): Promise<void> {
  const query: Record<string, string> = {}
  const filter = stationStore.filter
  if (filter.keyword.trim()) query.kw = filter.keyword.trim()
  if (filter.rivers.length) query.rivers = filter.rivers.join(',')
  if (filter.minCatchmentKm2 !== null) query.minArea = String(filter.minCatchmentKm2)
  if (filter.maxCatchmentKm2 !== null) query.maxArea = String(filter.maxCatchmentKm2)
  await router.replace({ query })
}

function handleFilterChange(): void {
  void syncQuery()
}

function handleBucketChange(value: string): void {
  const bucket = CATCHMENT_BUCKETS.find((item) => item.label === value)
  stationStore.patchFilter({
    minCatchmentKm2: bucket ? bucket.min : null,
    maxCatchmentKm2: bucket ? bucket.max : null
  })
  void syncQuery()
}

function handleReset(): void {
  stationStore.resetFilter()
  catchmentBucket.value = 'all'
  void syncQuery()
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.river = stationStore.riverOptions[0] ?? ''
  form.catchmentKm2 = 1000
  form.sectionCode = `CS-${String(stationStore.stations.length + 1).padStart(2, '0')}`
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(station: Station): void {
  editingId.value = station.id
  form.name = station.name
  form.river = station.river
  form.catchmentKm2 = station.catchmentKm2
  form.sectionCode = `${station.sectionCode} v${station.codeVersion}（${station.lifecycle}）`
  form.remark = station.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写测站名称')
    return
  }
  if (!form.river.trim()) {
    ElMessage.warning('请填写河名')
    return
  }
  if (!Number.isFinite(form.catchmentKm2) || form.catchmentKm2 <= 0) {
    ElMessage.warning('集水面积应为大于 0 的数字（km²）')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      // 河名 / 集水面积可由站网科更新；断面编号与版本不在此改（撤并/换版走专门动作）
      await stationStore.updateStation(editingId.value, {
        name: form.name,
        river: form.river,
        catchmentKm2: form.catchmentKm2,
        remark: form.remark
      })
      ElMessage.success('测站信息已更新（编号版本由站网科专门动作维护）')
    } else {
      const created = await stationStore.createStation({
        name: form.name,
        river: form.river,
        catchmentKm2: form.catchmentKm2,
        sectionCode: form.sectionCode,
        remark: form.remark,
        codeVersion: 1,
        lifecycle: '现行',
        mergedToCode: ''
      })
      await reconcileStore.appendCodeEvent({
        sectionCode: created.sectionCode,
        codeVersion: 1,
        lifecycle: '现行',
        eventType: '指派',
        station: created,
        reason: '新建测站，站网科指派编号'
      })
      stationStore.selectStation(created.id)
      ElMessage.success('测站已新建并登记编号台账，可进入断面测次录入')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeStation(station: Station): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除测站「${station.name}」将同时删除其断面测次、垂线、流速测点、关系点据与比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await stationStore.removeStation(station.id)
  ElMessage.success('测站及其下级数据已删除')
}

function gotoSections(station: Station): void {
  stationStore.selectStation(station.id)
  void router.push(`/stations/${station.id}/sections`)
}

function gotoReconcile(): void {
  void router.push('/reconcile')
}

function handleCodeAction(action: string, station: Station): void {
  if (action === 'withdraw') openWithdraw(station)
  else if (action === 'merge') openMerge(station)
  else if (action === 'bump') void bumpVersion(station)
}

/** 可并入的现行编号（排除自身与已撤并编号） */
const mergeCodeOptions = computed(() =>
  reconcileStore.activeCodes
    .filter((ledger) => ledger.sectionCode !== mergeTarget.value?.sectionCode)
    .map((ledger) => ({
      value: ledger.sectionCode,
      label: `${ledger.sectionCode} v${ledger.codeVersion} · ${ledger.stationName}（${ledger.river}）`
    }))
)

function openWithdraw(station: Station): void {
  withdrawTarget.value = station
  withdrawReason.value = ''
  withdrawVisible.value = true
}

async function confirmWithdraw(): Promise<void> {
  if (!withdrawTarget.value) return
  codeBusy.value = true
  try {
    const affected = await reconcileStore.withdrawCode(withdrawTarget.value, withdrawReason.value.trim())
    ElMessage.success(`编号 ${withdrawTarget.value.sectionCode} 已撤，${affected} 个测次悬空暂停报量`)
    withdrawVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '撤号失败')
  } finally {
    codeBusy.value = false
  }
}

function openMerge(station: Station): void {
  mergeTarget.value = station
  mergeCode.value = mergeCodeOptions.value[0]?.value ?? ''
  mergeReason.value = ''
  mergeVisible.value = true
}

async function confirmMerge(): Promise<void> {
  if (!mergeTarget.value) return
  if (!mergeCode.value) {
    ElMessage.warning('请选择并入的现行编号')
    return
  }
  codeBusy.value = true
  try {
    const affected = await reconcileStore.mergeCode(mergeTarget.value, mergeCode.value, mergeReason.value.trim())
    ElMessage.success(`编号 ${mergeTarget.value.sectionCode} 已并入 ${mergeCode.value}，${affected} 个测次悬空等重新指派`)
    mergeVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '并号失败')
  } finally {
    codeBusy.value = false
  }
}

async function bumpVersion(station: Station): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `编号 ${station.sectionCode} 换版到 v${station.codeVersion + 1} 后，引用旧版本的测次将悬空、暂停报量，等重新指派。确认换版？`,
      '编号换版',
      { type: 'warning', confirmButtonText: '换版', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const affected = await reconcileStore.bumpCodeVersion(station, '站网科编号换版')
  ElMessage.success(`已换版到 v${station.codeVersion + 1}，${affected} 个测次悬空等重新指派`)
}

async function reseed(): Promise<void> {
  await initDatabase()
  ElMessage.success('已按需补齐演示数据（幂等播种）')
}

onMounted(() => {
  applyQueryToFilter()
  reconcileStore.start()
  if (stationStore.stations.length === 0) void reseed()
})

watch(
  () => route.query,
  () => {
    if (route.path !== '/stations') return
    applyQueryToFilter()
  }
)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">测站台账</h2>
        <p class="gb-hint">
          维护测站基本信息与断面编号，卡片回显测次总数、最新水位与比测合格率。点击「断面测次」进入子页面。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建测站</el-button>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[{ key: 'rivers', label: '河名', options: riverSelectOptions }]"
      keyword-placeholder="搜索站名 / 断面编号 / 备注"
      @change="handleFilterChange"
      @reset="handleReset"
    >
      <template #extra>
        <div class="page__bucket">
          <span class="page__bucket-label">集水面积</span>
          <el-select :model-value="catchmentBucket" class="page__bucket-select" @change="handleBucketChange">
            <el-option v-for="bucket in CATCHMENT_BUCKETS" :key="bucket.label" :label="bucket.label" :value="bucket.label" />
          </el-select>
        </div>
      </template>
      <template #actions>
        <el-button size="small" :icon="Cpu" @click="reseed">补齐演示数据</el-button>
      </template>
    </FilterBar>

    <div class="gb-stats-row page__stats">
      <StatBadge label="筛选后测站" :value="stationCards.length" suffix="站" icon="Odometer" />
      <StatBadge
        label="合计集水面积"
        :value="stationStore.totalCatchmentKm2"
        suffix="km²"
        tone="info"
        icon="Histogram"
      />
      <StatBadge
        label="测次总数"
        :value="stationStore.sections.length"
        suffix="次"
        tone="success"
        icon="Files"
      />
      <StatBadge
        label="超限比测"
        :value="ratingStore.overLimitRows.length"
        suffix="条"
        :tone="ratingStore.overLimitRows.length > 0 ? 'danger' : 'success'"
        :icon="ratingStore.overLimitRows.length > 0 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <EmptyPanel
      v-if="stationCards.length === 0"
      :title="stationStore.hasFilter ? '没有符合条件的测站' : '还没有测站'"
      :description="
        stationStore.hasFilter
          ? '当前筛选条件（河名 / 集水面积 / 关键字）下没有测站，可重置条件或新建一个测站。'
          : '新建第一个测站后即可录入断面测次、布设垂线并录流速测点。'
      "
      action-text="新建测站"
      secondary-text="重置筛选"
      @action="openCreate"
      @secondary="handleReset"
    />

    <div v-else class="station-grid">
      <el-card v-for="card in stationCards" :key="card.station.id" shadow="hover" class="station-card">
        <template #header>
          <div class="station-card__head">
            <div>
              <strong class="station-card__name">{{ card.station.name }}</strong>
              <el-tag size="small" effect="plain" class="station-card__river">{{ card.station.river }}</el-tag>
            </div>
            <div class="station-card__codes">
              <el-tag size="small" type="info" effect="plain">
                {{ card.station.sectionCode }} v{{ card.station.codeVersion }}
              </el-tag>
              <el-tag
                size="small"
                :type="
                  card.station.lifecycle === '现行'
                    ? 'success'
                    : card.station.lifecycle === '已撤'
                      ? 'danger'
                      : 'warning'
                "
                effect="dark"
              >
                {{ card.station.lifecycle
                }}<template v-if="card.station.lifecycle === '已并走'"> → {{ card.station.mergedToCode }}</template>
              </el-tag>
            </div>
          </div>
        </template>

        <div class="station-card__stats">
          <StatBadge label="测次总数" :value="card.stats.count" suffix="次" size="small" icon="Files" />
          <StatBadge
            label="最新水位"
            :value="card.stats.latestStageM === null ? '—' : card.stats.latestStageM.toFixed(2)"
            suffix="m"
            size="small"
            tone="info"
            icon="Odometer"
          />
          <StatBadge
            label="比测合格率"
            :value="card.qualifyRate"
            suffix="%"
            size="small"
            :percent="card.qualifyRate"
            :tone="card.overLimit > 0 ? 'warning' : 'success'"
            :icon="card.overLimit > 0 ? 'WarningFilled' : 'DataLine'"
          />
        </div>

        <div class="station-card__meta">
          <span>集水面积 <b class="gb-mono">{{ card.station.catchmentKm2 }}</b> km²</span>
          <span>关系点据 <b class="gb-mono">{{ card.ratingCount }}</b> 个</span>
          <span v-if="card.heldCount > 0" class="station-card__alert" @click="gotoReconcile">
            <el-icon><Warning /></el-icon>
            <el-button text type="warning" size="small">{{ card.heldCount }} 个测次编号悬空 / 待认领</el-button>
          </span>
          <span v-else-if="card.overLimit > 0" class="station-card__alert">
            <el-icon><Warning /></el-icon> 超限 <b class="gb-mono">{{ card.overLimit }}</b> 条
          </span>
        </div>

        <p v-if="card.station.remark" class="station-card__remark">{{ card.station.remark }}</p>

        <div class="station-card__actions">
          <el-button type="primary" size="small" :icon="Right" @click="gotoSections(card.station)">
            断面测次
          </el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(card.station)">编辑</el-button>
          <el-dropdown
            v-if="card.station.lifecycle === '现行'"
            trigger="click"
            @command="(value: string) => handleCodeAction(value, card.station)"
          >
            <el-button size="small" type="warning" plain>编号操作<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="withdraw">撤掉编号</el-dropdown-item>
                <el-dropdown-item command="merge">并走到…</el-dropdown-item>
                <el-dropdown-item command="bump">换版 v{{ card.station.codeVersion + 1 }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeStation(card.station)">
            删除
          </el-button>
        </div>
      </el-card>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑测站' : '新建测站'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form label-width="96px" label-position="right">
        <el-form-item label="测站名称" required>
          <el-input v-model="form.name" placeholder="如：龙门水文站" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="河名" required>
          <el-input v-model="form.river" placeholder="如：澜沧江" maxlength="30">
            <template #append>
              <el-dropdown v-if="stationStore.riverOptions.length > 0" @command="(value: string) => (form.river = value)">
                <el-button>已有河名</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="river in stationStore.riverOptions" :key="river" :command="river">
                      {{ river }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="集水面积" required>
          <el-input-number v-model="form.catchmentKm2" :min="1" :max="2000000" :step="100" controls-position="right" />
          <span class="page__unit">km²</span>
        </el-form-item>
        <el-form-item label="断面编号" required>
          <el-input
            v-model="form.sectionCode"
            :placeholder="editingId ? '' : '如：CS-LM-01'"
            :disabled="!!editingId"
            maxlength="24"
          />
          <div v-if="editingId" class="gb-hint">断面编号与版本归站网科，撤号 / 并号 / 换版请用卡片上的「编号操作」。</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="测验方式、断面稳定性说明等" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新建并进入录入' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="withdrawVisible" title="站网科撤掉断面编号" width="520px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="撤号后，引用该编号的测次立即悬空、暂停报流量；先前报出去的流量按当时编号仍可查。"
        class="page__code-alert"
      />
      <el-form label-width="96px">
        <el-form-item label="断面编号">
          <el-tag type="danger" effect="plain">{{ withdrawTarget?.sectionCode }} v{{ withdrawTarget?.codeVersion }}</el-tag>
        </el-form-item>
        <el-form-item label="撤号原因">
          <el-input v-model="withdrawReason" type="textarea" :rows="2" maxlength="120" show-word-limit
            placeholder="如：临时断面撤销 / 测验断面取消" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="withdrawVisible = false">取消</el-button>
        <el-button type="danger" :loading="codeBusy" @click="confirmWithdraw">确认撤号</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeVisible" title="站网科并走断面编号" width="560px" :close-on-click-modal="false">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="并号后源编号置「已并走」，其测次悬空等重新指派；并入的目标（站网科）编号不动。"
        class="page__code-alert"
      />
      <el-form label-width="96px">
        <el-form-item label="源编号">
          <el-tag type="warning" effect="plain">{{ mergeTarget?.sectionCode }} v{{ mergeTarget?.codeVersion }}</el-tag>
        </el-form-item>
        <el-form-item label="并入编号">
          <el-select v-model="mergeCode" placeholder="选择现行编号" style="width: 100%">
            <el-option v-for="option in mergeCodeOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="并号说明">
          <el-input v-model="mergeReason" type="textarea" :rows="2" maxlength="120" show-word-limit
            placeholder="如：断面整编，两断面合并" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="warning" :loading="codeBusy" @click="confirmMerge">确认并号</el-button>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__stats {
  margin: 0;
}

.page__bucket {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__bucket-label {
  font-size: 13px;
  color: #5b6b78;
}

.page__bucket-select {
  width: 168px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.station-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}

.station-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.station-card__name {
  font-size: 16px;
  color: #16232e;
}

.station-card__river {
  margin-left: 8px;
}

.station-card__codes {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__code-alert {
  margin-bottom: 12px;
}

.station-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.station-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #5b6b78;
}

.station-card__alert {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #c0392b;
}

.station-card__remark {
  margin: 8px 0 0;
  font-size: 12px;
  color: #8194a2;
  line-height: 1.7;
}

.station-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
