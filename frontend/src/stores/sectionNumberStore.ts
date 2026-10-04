/**
 * 断面编号台账 store（站网科主数据）。
 * 维护断面编号的生命周期（在用 / 已撤 / 已并），并据此与巡测队测次对账：
 * 编号撤 / 并 → 引用测次悬空（流量暂停报出）；站网科重新指派失败时，巡测队退回本侧重试，编号不动。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { SectionNumber, SectionNumberStatus } from '@/types/sectionNumber'
import type { Section } from '@/types/section'

/** 改派发起方：站网科指派 / 巡测队重试（编号本身不动，只改测次引用） */
export type ReassignBy = 'network' | 'survey'

export const useSectionNumberStore = defineStore('sectionNumber', () => {
  const sectionNumbers = ref<SectionNumber[]>([])
  const sections = ref<Section[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  /** 台账筛选：状态 + 测站 */
  const filter = ref<{ statuses: SectionNumberStatus[]; stationId: string | null; keyword: string }>({
    statuses: [],
    stationId: null,
    keyword: ''
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SectionNumber>(() => db.sectionNumbers).subscribe((rows) => {
      sectionNumbers.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
  }

  /* ------------------------------- 派生 ------------------------------- */

  const numberById = computed<Map<string, SectionNumber>>(
    () => new Map(sectionNumbers.value.map((number) => [number.id, number]))
  )

  /** 某条编号下的测次 */
  function sectionsOfNumber(numberId: string): Section[] {
    return sections.value.filter((section) => section.sectionNumberId === numberId)
  }

  /** 悬空测次：引用已撤 / 已并编号，流量暂停报出，等重新指派 */
  const shelvedSections = computed<Section[]>(() =>
    sections.value.filter((section) => section.reconcileStatus === 'shelved')
  )

  /** 待认领测次：旧数据没记编号版本，迁移补不齐，交人认 */
  const unmatchedSections = computed<Section[]>(() =>
    sections.value.filter((section) => section.reconcileStatus === 'unmatched')
  )

  /** 已改派测次：悬空后重新指派到在用编号 */
  const reassignedSections = computed<Section[]>(() =>
    sections.value.filter((section) => section.reconcileStatus === 'reassigned')
  )

  /** 可报出门：测次引用的编号在用（已对账 / 已改派） */
  function isSectionReportable(section: Section | null | undefined): boolean {
    if (!section) return false
    if (section.reconcileStatus === 'shelved' || section.reconcileStatus === 'unmatched') return false
    const number = numberById.value.get(section.sectionNumberId)
    return !!number && number.status === 'active'
  }

  /** 在用编号（改派 / 认领时的可选目标） */
  const activeNumbers = computed<SectionNumber[]>(() =>
    sectionNumbers.value.filter((number) => number.status === 'active')
  )

  /** 台账筛选后的编号 */
  const filteredNumbers = computed<SectionNumber[]>(() =>
    sectionNumbers.value.filter((number) => {
      if (filter.value.statuses.length > 0 && !filter.value.statuses.includes(number.status)) return false
      if (filter.value.stationId && number.stationId !== filter.value.stationId) return false
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0 && !`${number.code}${number.remark}`.includes(keyword)) return false
      return true
    })
  )

  const stats = computed(() => ({
    active: sectionNumbers.value.filter((number) => number.status === 'active').length,
    revoked: sectionNumbers.value.filter((number) => number.status === 'revoked').length,
    merged: sectionNumbers.value.filter((number) => number.status === 'merged').length,
    shelved: shelvedSections.value.length,
    unmatched: unmatchedSections.value.length,
    reassigned: reassignedSections.value.length
  }))

  function patchFilter(patch: Partial<typeof filter.value>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = { statuses: [], stationId: null, keyword: '' }
  }

  /* --------------------------- 编号台账增删改 --------------------------- */

  async function createNumber(
    payload: Omit<SectionNumber, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'mergedIntoId' | 'effectiveTo'> & {
      status?: SectionNumberStatus
    }
  ): Promise<SectionNumber> {
    const now = Date.now()
    const row: SectionNumber = {
      ...payload,
      id: createId('sn'),
      status: payload.status ?? 'active',
      mergedIntoId: null,
      effectiveTo: null,
      createdAt: now,
      updatedAt: now
    }
    await db.sectionNumbers.put(row)
    return row
  }

  async function updateNumber(id: string, patch: Partial<SectionNumber>): Promise<void> {
    await db.sectionNumbers.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /**
   * 撤号：编号置为已撤，引用它的测次全部悬空（流量暂停报出），等站网科重新指派。
   */
  async function revokeNumber(id: string, remark = ''): Promise<void> {
    const now = Date.now()
    const number = numberById.value.get(id)
    if (!number) throw new Error('编号不存在')
    await db.transaction('rw', [db.sectionNumbers, db.sections], async () => {
      await db.sectionNumbers.update(id, {
        status: 'revoked',
        mergedIntoId: null,
        effectiveTo: new Date(now).toISOString(),
        remark: remark || number.remark,
        updatedAt: now
      } as never)
      await db.sections
        .where('sectionNumberId')
        .equals(id)
        .modify((section: Section) => {
          if (section.reconcileStatus !== 'reassigned') {
            section.reconcileStatus = 'shelved'
            section.updatedAt = now
          }
        })
    })
  }

  /**
   * 并号：把编号 A 并入 B。
   * B 在用 → 引用 A 的测次批量改派到 B（已改派）；B 不可用 → 测次悬空，由巡测队退回本侧重试。
   */
  async function mergeNumber(id: string, targetId: string, remark = ''): Promise<number> {
    if (id === targetId) throw new Error('不能并入同一编号')
    const source = numberById.value.get(id)
    const target = numberById.value.get(targetId)
    if (!source) throw new Error('源编号不存在')
    if (!target) throw new Error('目标编号不存在')
    const now = Date.now()
    let reassignedCount = 0
    await db.transaction('rw', [db.sectionNumbers, db.sections], async () => {
      await db.sectionNumbers.update(id, {
        status: 'merged',
        mergedIntoId: targetId,
        effectiveTo: new Date(now).toISOString(),
        remark: remark || source.remark,
        updatedAt: now
      } as never)
      const sections = await db.sections.where('sectionNumberId').equals(id).toArray()
      for (const section of sections) {
        if (target.status === 'active') {
          await db.sections.update(section.id, {
            sectionNumberId: targetId,
            sectionCodeSnapshot: target.code,
            reconcileStatus: 'reassigned',
            updatedAt: now
          } as never)
          reassignedCount += 1
        } else {
          await db.sections.update(section.id, {
            reconcileStatus: 'shelved',
            updatedAt: now
          } as never)
        }
      }
    })
    return reassignedCount
  }

  async function removeNumber(id: string): Promise<void> {
    const inUse = sections.value.some((section) => section.sectionNumberId === id)
    if (inUse) throw new Error('该编号仍有测次引用，不能删除（可撤号或并号）')
    await db.sectionNumbers.delete(id)
  }

  /* --------------------------- 对账 / 改派 / 认领 --------------------------- */

  /**
   * 重新指派：把悬空 / 待认领测次改派到一条在用编号。
   * 站网科指派（by='network'）失败时，UI 引导巡测队退回本侧重试（by='survey'），编号本身不动。
   */
  async function reassignSection(
    sectionId: string,
    targetNumberId: string,
    by: ReassignBy = 'network'
  ): Promise<Section> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) throw new Error('测次不存在')
    const target = numberById.value.get(targetNumberId)
    if (!target) {
      throw new Error(by === 'network' ? '指派失败：目标编号不存在，请巡测队退回本侧重试' : '重试失败：编号不存在')
    }
    if (target.status !== 'active') {
      throw new Error(
        by === 'network'
          ? `指派失败：编号 ${target.code} 已${target.status === 'revoked' ? '撤' : '并'}，请巡测队退回本侧重试`
          : `重试失败：编号 ${target.code} 已停用，请改选其他在用编号`
      )
    }
    const now = Date.now()
    const next: Section = {
      ...section,
      sectionNumberId: target.id,
      sectionCodeSnapshot: target.code,
      reconcileStatus: 'reassigned',
      updatedAt: now
    }
    await db.sections.put(next)
    return next
  }

  /** 待认领测次：旧数据补不齐编号版本，交人认领到一条在用编号（同 reassign，语义为认领） */
  async function claimSection(sectionId: string, targetNumberId: string): Promise<Section> {
    return reassignSection(sectionId, targetNumberId, 'survey')
  }

  /**
   * 全量对账：按当前编号状态重算测次对账状态（幂等安全网）。
   * 编号已撤 / 并的在用测次 → 悬空；编号恢复在用的悬空测次 → 已改派；其余保持。
   */
  async function reconcileAll(): Promise<{ shelved: number; restored: number }> {
    const now = Date.now()
    let shelved = 0
    let restored = 0
    await db.transaction('rw', [db.sections, db.sectionNumbers], async () => {
      for (const section of sections.value) {
        const number = numberById.value.get(section.sectionNumberId)
        const active = !!number && number.status === 'active'
        if (section.reconcileStatus === 'shelved' && active) {
          await db.sections.update(section.id, {
            sectionCodeSnapshot: number.code,
            reconcileStatus: 'reassigned',
            updatedAt: now
          } as never)
          restored += 1
        } else if (
          (section.reconcileStatus === 'matched' || section.reconcileStatus === 'reassigned') &&
          !active &&
          section.sectionNumberId
        ) {
          await db.sections.update(section.id, { reconcileStatus: 'shelved', updatedAt: now } as never)
          shelved += 1
        }
      }
    })
    return { shelved, restored }
  }

  return {
    sectionNumbers,
    sections,
    ready,
    error,
    filter,
    numberById,
    shelvedSections,
    unmatchedSections,
    reassignedSections,
    activeNumbers,
    filteredNumbers,
    stats,
    start,
    sectionsOfNumber,
    isSectionReportable,
    patchFilter,
    resetFilter,
    createNumber,
    updateNumber,
    revokeNumber,
    mergeNumber,
    removeNumber,
    reassignSection,
    claimSection,
    reconcileAll
  }
})
