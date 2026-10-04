<script setup lang="ts">
/**
 * 模块 8：/reconcile 对账中心
 * 站网科按编号与巡测队对账：悬空测次（编号已撤 / 并）重新指派、待认领测次（旧数据无编号版本）交人认。
 * 站网科指派失败时，巡测队退回本侧重试，编号本身不动。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSectionNumberStore, type ReassignBy } from '@/stores/sectionNumberStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useStationStore } from '@/stores/stationStore'
import { RECONCILE_STATUS_META, type ReconcileStatus } from '@/types/sectionNumber'
import type { Section } from '@/types/section'
import { initDatabase } from '@/utils/db'

const numberStore = useSectionNumberStore()
const sectionStore = useSectionStore()
const stationStore = useStationStore()

const activeTab = ref<'shelved' | 'unmatched' | 'reassigned'>('shelved')
const dialogVisible = ref(false)
const targetSection = ref<Section | null>(null)
const targetNumberId = ref('')
const mode = ref<ReassignBy>('network')
const submitting = ref(false)

const stationNameOf = (stationId: string): string =>
  stationStore.stationById(stationId)?.name ?? '未知测站'

const numberCodeOf = (numberId: string): string => numberStore.numberById.get(numberId)?.code ?? '—'

const verticalCountOf = (sectionId: string): number => sectionStore.sectionVerticalCounts[sectionId] ?? 0

const shelvedRows = computed(() =>
  numberStore.shelvedSections.map((section) => ({
    section,
    stationName: stationNameOf(section.stationId),
    numberCode: numberCodeOf(section.sectionNumberId)
  }))
)

const unmatchedRows = computed(() =>
  numberStore.unmatchedSections.map((section) => ({
    section,
    stationName: stationNameOf(section.stationId),
    numberCode: section.sectionCodeSnapshot || '（未记录）'
  }))
)

const reassignedRows = computed(() =>
  numberStore.reassignedSections.map((section) => ({
    section,
    stationName: stationNameOf(section.stationId),
    numberCode: numberCodeOf(section.sectionNumberId)
  }))
)

const pausedFlowCount = computed(
  () => numberStore.shelvedSections.length + numberStore.unmatchedSections.length
)

const reconcileMeta = (status: ReconcileStatus) => RECONCILE_STATUS_META[status]

function openReassign(section: Section, by: ReassignBy): void {
  targetSection.value = section
  targetNumberId.value = ''
  mode.value = by
  dialogVisible.value = true
}

async function confirmReassign(): Promise<void> {
  if (!targetSection.value) return
  if (!targetNumberId.value) {
    ElMessage.warning('请选择要改派到的在用编号')
    return
  }
  submitting.value = true
  try {
    await numberStore.reassignSection(targetSection.value.id, targetNumberId.value, mode.value)
    ElMessage.success(
      mode.value === 'network'
        ? `已由站网科指派到 ${numberCodeOf(targetNumberId.value)}`
        : `巡测队已改派到 ${numberCodeOf(targetNumberId.value)}（站网科编号未动）`
    )
    dialogVisible.value = false
  } catch (err) {
    const message = err instanceof Error ? err.message : '指派失败'
    if (mode.value === 'network') {
      // 站网科指派失败 → 巡测队退回本侧重试（编号不动，只改测次引用）
      try {
        await ElMessageBox.confirm(
          `${message}。\n\n是否由巡测队退回本侧重试？从现有在用编号中选一条改派，站网科编号台账不变。`,
          '指派失败 · 巡测队重试',
          { type: 'warning', confirmButtonText: '巡测队重试', cancelButtonText: '取消' }
        )
        mode.value = 'survey'
        targetNumberId.value = ''
      } catch {
        dialogVisible.value = false
      }
    } else {
      ElMessage.error(message)
    }
  } finally {
    submitting.value = false
  }
}

async function reconcileAll(): Promise<void> {
  const result = await numberStore.reconcileAll()
  ElMessage.success(`对账完成：新悬空 ${result.shelved} 条，恢复 ${result.restored} 条`)
}

onMounted(() => {
  numberStore.start()
  sectionStore.start()
  stationStore.start()
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">对账中心</h2>
        <p class="gb-hint">
          站网科按编号与巡测队对账：编号已撤 / 并的测次先搁着，等重新指派，这期间流量先不报；
          先前报出去的按当时编号还查得到。旧数据没记编号版本，补不齐的单列出来交人认。
        </p>
      </div>
      <el-button :icon="Refresh" @click="reconcileAll">全量对账</el-button>
    </div>

    <div class="gb-stats-row">
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
      <StatBadge label="已改派" :value="numberStore.stats.reassigned" suffix="条" tone="info" icon="Sort" />
      <StatBadge
        label="暂停报出流量"
        :value="pausedFlowCount"
        suffix="测次"
        :tone="pausedFlowCount > 0 ? 'warning' : 'success'"
        icon="VideoPause"
      />
    </div>

    <el-tabs v-model="activeTab" class="page__tabs">
      <el-tab-pane name="shelved">
        <template #label>
          <span>悬空待派 <el-tag v-if="shelvedRows.length > 0" type="danger" size="small">{{ shelvedRows.length }}</el-tag></span>
        </template>
        <EmptyPanel
          v-if="shelvedRows.length === 0"
          title="没有悬空测次"
          description="所有测次引用的断面编号均在用。编号撤 / 并后，引用它的测次会出现在这里。"
          compact
        />
        <el-table v-else :data="shelvedRows" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.measureNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="所属测站" min-width="140">
            <template #default="{ row }">{{ row.stationName }}</template>
          </el-table-column>
          <el-table-column label="原引用编号" width="140">
            <template #default="{ row }">
              <span class="gb-mono page__old-code">{{ row.numberCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测法" width="90">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.section.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="垂线" width="80" align="center">
            <template #default="{ row }">{{ verticalCountOf(row.section.id) }} 条</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" type="danger" effect="plain">
                {{ reconcileMeta(row.section.reconcileStatus).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="openReassign(row.section, 'network')">重新指派</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="unmatched">
        <template #label>
          <span>待认领 <el-tag v-if="unmatchedRows.length > 0" type="warning" size="small">{{ unmatchedRows.length }}</el-tag></span>
        </template>
        <EmptyPanel
          v-if="unmatchedRows.length === 0"
          title="没有待认领测次"
          description="旧数据已全部迁移到现存编号。补不齐编号版本的测次会单列在这里交人认。"
          compact
        />
        <el-table v-else :data="unmatchedRows" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.measureNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="所属测站" min-width="140">
            <template #default="{ row }">{{ row.stationName }}</template>
          </el-table-column>
          <el-table-column label="原记录编号" width="140">
            <template #default="{ row }">
              <span class="gb-mono page__old-code">{{ row.numberCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测法" width="90">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.section.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" type="info" effect="plain">
                {{ reconcileMeta(row.section.reconcileStatus).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="warning" @click="openReassign(row.section, 'survey')">认领编号</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="reassigned">
        <template #label>
          <span>已改派记录 <el-tag v-if="reassignedRows.length > 0" type="info" size="small">{{ reassignedRows.length }}</el-tag></span>
        </template>
        <EmptyPanel
          v-if="reassignedRows.length === 0"
          title="还没有改派记录"
          description="悬空测次重新指派后会记录在这里，改派后的测次恢复报出。"
          compact
        />
        <el-table v-else :data="reassignedRows" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.measureNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="所属测站" min-width="140">
            <template #default="{ row }">{{ row.stationName }}</template>
          </el-table-column>
          <el-table-column label="改派到编号" width="140">
            <template #default="{ row }">
              <span class="gb-mono page__new-code">{{ row.numberCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.section.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" type="warning" effect="plain">
                {{ reconcileMeta(row.section.reconcileStatus).label }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="dialogVisible"
      :title="mode === 'network' ? '站网科指派：改派到在用编号' : '巡测队退回本侧重试：改派到在用编号'"
      width="500px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="mode === 'survey'"
        type="warning"
        show-icon
        :closable="false"
        title="站网科指派未完成，由巡测队从现有在用编号中改派；站网科编号台账不做改动。"
        class="page__alert"
      />
      <p class="gb-hint">
        测次 <b class="gb-mono">{{ targetSection?.measureNo }}</b>（{{ stationNameOf(targetSection?.stationId ?? '') }}）
        当前引用编号 <b class="gb-mono">{{ numberCodeOf(targetSection?.sectionNumberId ?? '') }}</b>。
      </p>
      <el-select v-model="targetNumberId" class="page__full" placeholder="选择在用目标编号">
        <el-option
          v-for="number in numberStore.activeNumbers"
          :key="number.id"
          :label="`${number.code}（${stationNameOf(number.stationId)}）`"
          :value="number.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmReassign">
          {{ mode === 'network' ? '确认指派' : '确认改派' }}
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__tabs {
  background: #ffffff;
  border: 1px solid #d8e4ec;
  border-radius: 10px;
  padding: 0 14px;
}

.page__old-code {
  color: #c0392b;
  text-decoration: line-through;
}

.page__new-code {
  color: #1e8449;
  font-weight: 600;
}

.page__full {
  width: 100%;
}

.page__alert {
  margin-bottom: 12px;
}
</style>
