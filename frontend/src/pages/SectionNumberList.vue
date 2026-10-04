<script setup lang="ts">
/**
 * 模块 7：/section-numbers 断面编号台账（站网科主数据）
 * 维护断面编号的生命周期：新建、撤号、并号；编号撤 / 并后引用测次悬空，可在对账中心重新指派。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Warning } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSectionNumberStore } from '@/stores/sectionNumberStore'
import { useStationStore } from '@/stores/stationStore'
import {
  SECTION_NUMBER_STATUS_META,
  SECTION_NUMBER_STATUSES,
  type SectionNumber,
  type SectionNumberStatus
} from '@/types/sectionNumber'
import { initDatabase } from '@/utils/db'

const numberStore = useSectionNumberStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  code: '',
  stationId: '',
  river: '',
  catchmentKm2: 1000,
  effectiveFrom: new Date().toISOString().slice(0, 10),
  remark: ''
})

const mergeDialogVisible = ref(false)
const mergingSource = ref<SectionNumber | null>(null)
const mergeTargetId = ref('')

const filterModel = computed<FilterModel>(() => ({
  keyword: numberStore.filter.keyword,
  statuses: numberStore.filter.statuses,
  stationId: numberStore.filter.stationId
}))

const stationNameOf = (stationId: string): string =>
  stationStore.stationById(stationId)?.name ?? '未知测站'

const referencedCount = (numberId: string): number => numberStore.sectionsOfNumber(numberId).length

const statusTagType = (status: SectionNumberStatus) => SECTION_NUMBER_STATUS_META[status].tagType

const statusMeta = (status: SectionNumberStatus) => SECTION_NUMBER_STATUS_META[status]

function openCreate(): void {
  editingId.value = null
  form.code = ''
  form.stationId = stationStore.stations[0]?.id ?? ''
  form.river = stationStore.stationById(form.stationId)?.river ?? ''
  form.catchmentKm2 = stationStore.stationById(form.stationId)?.catchmentKm2 ?? 1000
  form.effectiveFrom = new Date().toISOString().slice(0, 10)
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(number: SectionNumber): void {
  editingId.value = number.id
  form.code = number.code
  form.stationId = number.stationId
  form.river = number.river
  form.catchmentKm2 = number.catchmentKm2
  form.effectiveFrom = number.effectiveFrom.slice(0, 10)
  form.remark = number.remark
  dialogVisible.value = true
}

function onStationChange(stationId: string): void {
  const station = stationStore.stationById(stationId)
  if (station) {
    form.river = station.river
    form.catchmentKm2 = station.catchmentKm2
  }
}

async function submitForm(): Promise<void> {
  if (!form.code.trim()) {
    ElMessage.warning('请填写断面编号')
    return
  }
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  submitting.value = true
  try {
    const payload = {
      code: form.code.trim(),
      stationId: form.stationId,
      river: form.river.trim(),
      catchmentKm2: form.catchmentKm2,
      effectiveFrom: new Date(form.effectiveFrom).toISOString(),
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await numberStore.updateNumber(editingId.value, payload)
      ElMessage.success('编号已更新')
    } else {
      await numberStore.createNumber(payload)
      ElMessage.success('编号已建档（在用）')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function revoke(number: SectionNumber): Promise<void> {
  const count = referencedCount(number.id)
  try {
    await ElMessageBox.confirm(
      `撤掉编号「${number.code}」后，引用它的 ${count} 条测次将悬空、流量暂停报出，需站网科重新指派。确认撤号？`,
      '撤号确认',
      { type: 'warning', confirmButtonText: '确认撤号', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await numberStore.revokeNumber(number.id, `撤号：${new Date().toISOString().slice(0, 10)}`)
  ElMessage.success(`编号 ${number.code} 已撤，${count} 条测次悬空待派`)
}

function openMerge(number: SectionNumber): void {
  mergingSource.value = number
  mergeTargetId.value = ''
  mergeDialogVisible.value = true
}

async function submitMerge(): Promise<void> {
  if (!mergingSource.value) return
  if (!mergeTargetId.value) {
    ElMessage.warning('请选择并入的目标编号')
    return
  }
  if (mergeTargetId.value === mergingSource.value.id) {
    ElMessage.warning('不能并入同一编号')
    return
  }
  submitting.value = true
  try {
    const count = await numberStore.mergeNumber(mergingSource.value.id, mergeTargetId.value)
    const target = numberStore.numberById.get(mergeTargetId.value)
    ElMessage.success(`已并入 ${target?.code}，${count} 条测次改派，其余悬空待派`)
    mergeDialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function remove(number: SectionNumber): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除编号「${number.code}」？仅无测次引用的编号可删除。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await numberStore.removeNumber(number.id)
    ElMessage.success('编号已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

function handleFilterChange(): void {
  // 筛选条件已写入 store，liveQuery 自动刷新列表
}

function handleReset(): void {
  numberStore.resetFilter()
}

onMounted(() => {
  numberStore.start()
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">断面编号台账</h2>
        <p class="gb-hint">
          河名、集水面积与断面编号归站网科定；编号撤 / 并后，引用它的测次悬空、流量暂停报出，需在对账中心重新指派。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建编号</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="在用编号" :value="numberStore.stats.active" suffix="条" tone="success" icon="CircleCheck" />
      <StatBadge label="已撤编号" :value="numberStore.stats.revoked" suffix="条" tone="danger" icon="CircleClose" />
      <StatBadge label="已并编号" :value="numberStore.stats.merged" suffix="条" tone="warning" icon="Link" />
      <StatBadge
        label="悬空测次"
        :value="numberStore.stats.shelved"
        suffix="条"
        :tone="numberStore.stats.shelved > 0 ? 'danger' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge
        label="待认领测次"
        :value="numberStore.stats.unmatched"
        suffix="条"
        :tone="numberStore.stats.unmatched > 0 ? 'warning' : 'success'"
        icon="QuestionFilled"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'statuses',
          label: '状态',
          options: SECTION_NUMBER_STATUSES.map((item) => ({ label: item.label, value: item.value }))
        },
        {
          key: 'stationId',
          label: '测站',
          multiple: false,
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        }
      ]"
      keyword-placeholder="搜索编号 / 文号备注"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <EmptyPanel
      v-if="numberStore.filteredNumbers.length === 0"
      title="还没有断面编号"
      description="新建第一条断面编号后，巡测队即可按这套编号落测次、算流量。"
      action-text="新建编号"
      @action="openCreate"
    />

    <el-table v-else :data="numberStore.filteredNumbers" border stripe class="gb-table-compact">
      <el-table-column prop="code" label="断面编号" width="140">
        <template #default="{ row }">
          <span class="gb-mono page__code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="所属测站" min-width="140">
        <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
      </el-table-column>
      <el-table-column prop="river" label="河名" width="110" />
      <el-table-column label="集水面积 (km²)" width="130" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.catchmentKm2 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTagType(row.status)" effect="plain">
            {{ statusMeta(row.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="并入编号" width="140">
        <template #default="{ row }">
          <span v-if="row.mergedIntoId" class="gb-mono">{{ numberStore.numberById.get(row.mergedIntoId)?.code ?? '—' }}</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="引用测次" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ referencedCount(row.id) }} 条</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="启用时间" width="120">
        <template #default="{ row }">
          <span class="gb-mono">{{ new Date(row.effectiveFrom).toLocaleDateString('zh-CN') }}</span>
        </template>
      </el-table-column>
      <el-table-column label="停用时间" width="120">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.effectiveTo ? new Date(row.effectiveTo).toLocaleDateString('zh-CN') : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="文号 / 备注" min-width="160" show-overflow-tooltip />
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
          <el-button
            v-if="row.status === 'active'"
            size="small"
            type="warning"
            plain
            :icon="Refresh"
            @click="openMerge(row)"
          >
            并号
          </el-button>
          <el-button
            v-if="row.status === 'active'"
            size="small"
            type="danger"
            plain
            :icon="Warning"
            @click="revoke(row)"
          >
            撤号
          </el-button>
          <el-button size="small" type="danger" text :icon="Delete" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑断面编号' : '新建断面编号'" width="520px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="断面编号" required>
          <el-input v-model="form.code" placeholder="如：CS-LM-02" maxlength="24" />
        </el-form-item>
        <el-form-item label="所属测站" required>
          <el-select
            :model-value="form.stationId"
            class="page__full"
            placeholder="选择测站"
            @change="(value: string) => { form.stationId = value; onStationChange(value) }"
          >
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="河名">
          <el-input v-model="form.river" placeholder="由测站带出，可修改" maxlength="30" />
        </el-form-item>
        <el-form-item label="集水面积">
          <el-input-number v-model="form.catchmentKm2" :min="1" :max="2000000" :step="100" controls-position="right" />
          <span class="page__unit">km²</span>
        </el-form-item>
        <el-form-item label="启用时间">
          <el-date-picker v-model="form.effectiveFrom" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="文号 / 备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="撤并依据、文号等" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '确认建档' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeDialogVisible" title="并号：选择并入的目标编号" width="480px" :close-on-click-modal="false">
      <p class="gb-hint">
        将编号 <b class="gb-mono">{{ mergingSource?.code }}</b> 并入目标编号。目标在用时，引用测次批量改派到目标编号；
        目标不可用时测次悬空，由巡测队退回本侧重试。
      </p>
      <el-select v-model="mergeTargetId" class="page__full" placeholder="选择在用目标编号">
        <el-option
          v-for="number in numberStore.activeNumbers.filter((item) => item.id !== mergingSource?.id)"
          :key="number.id"
          :label="`${number.code}（${stationNameOf(number.stationId)}）`"
          :value="number.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="mergeDialogVisible = false">取消</el-button>
        <el-button type="warning" :loading="submitting" @click="submitMerge">确认并号</el-button>
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

.page__code {
  font-weight: 600;
  color: #0f4c75;
}

.page__full {
  width: 100%;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}
</style>
