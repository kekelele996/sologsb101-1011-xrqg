/**
 * 编号对账 store：站网科与巡测队的边界全部收在这里。
 * - 站网科域：撤号 / 并号 / 换版，改编号台账（codeEvents）与测站编号态，不碰巡测队数据；
 * - 巡测队域：按「编号 + 版本」引用；撤并后测次悬空、暂停报量；
 *   站网科重新指派只改巡测队这头引用，编号不动；指派失败退回本侧重试。
 * 页面只读 store，所有写动作走本文件。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable, buildLedgerViews } from '@/utils/db'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { CodeEvent, CodeEventType, CodeLifecycle, CodeLedgerView } from '@/types/codeEvent'
import {
  buildCodeIndex,
  canReportFlow,
  reconcileSection,
  reassignRef,
  summarizeRefs
} from '@/utils/reconcile'

export interface SectionRefView {
  section: Section
  /** 录入时归属测站（撤并后可能已不在现行测站表） */
  ownerStation: Station | null
  ledger: CodeLedgerView | null
  statusText: string
  canReport: boolean
}

export const useReconcileStore = defineStore('reconcile', () => {
  const stations = ref<Station[]>([])
  const sections = ref<Section[]>([])
  const codeEvents = ref<CodeEvent[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<CodeEvent>(() => db.codeEvents).subscribe((rows) => {
      codeEvents.value = rows
    })
  }

  /** 台账视图：编号 → 当前态 + 历史事件 */
  const ledgers = computed<CodeLedgerView[]>(() => buildLedgerViews(codeEvents.value))

  /** 当前编号索引（对账纯逻辑消费） */
  const codeIndex = computed<Map<string, CodeLedgerView>>(() => buildCodeIndex(ledgers.value))

  /** 现行编号（重新指派下拉只可取现行编号） */
  const activeCodes = computed<CodeLedgerView[]>(() =>
    ledgers.value.filter((ledger) => ledger.lifecycle === '现行')
  )

  const stationById = (id: string): Station | null =>
    stations.value.find((station) => station.id === id) ?? null

  /** 巡测队全部测次的对账视图 */
  const sectionViews = computed<SectionRefView[]>(() =>
    sections.value
      .map((section) => {
        const result = reconcileSection(section, codeIndex.value)
        return {
          section,
          ownerStation: stationById(section.stationId),
          ledger: codeIndex.value.get(section.refCode) ?? null,
          statusText: result.note,
          canReport: canReportFlow(section.refStatus)
        }
      })
      .sort((a, b) => Date.parse(b.section.measuredAt) - Date.parse(a.section.measuredAt))
  )

  const danglingViews = computed<SectionRefView[]>(() =>
    sectionViews.value.filter((view) => view.section.refStatus === '悬空')
  )
  const pendingViews = computed<SectionRefView[]>(() =>
    sectionViews.value.filter((view) => view.section.refStatus === '待认领')
  )
  const matchedViews = computed<SectionRefView[]>(() =>
    sectionViews.value.filter((view) => view.section.refStatus === '对账中')
  )

  const summary = computed(() => summarizeRefs(sections.value))

  function ledgerOfCode(code: string): CodeLedgerView | null {
    return codeIndex.value.get(code) ?? null
  }

  /** 记一条编号台账事件（站网科动作统一留痕） */
  async function appendCodeEvent(input: {
    sectionCode: string
    codeVersion: number
    lifecycle: CodeLifecycle
    eventType: CodeEventType
    station: Pick<Station, 'id' | 'name' | 'river' | 'catchmentKm2'>
    mergedToCode?: string
    reason: string
    occurredAt?: string
  }): Promise<void> {
    const now = Date.now()
    const event: CodeEvent = {
      id: createId('cev'),
      sectionCode: input.sectionCode,
      codeVersion: input.codeVersion,
      lifecycle: input.lifecycle,
      eventType: input.eventType,
      stationId: input.station.id,
      stationName: input.station.name,
      river: input.station.river,
      catchmentKm2: input.station.catchmentKm2,
      mergedToCode: input.mergedToCode ?? '',
      reason: input.reason,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      createdAt: now,
      updatedAt: now
    }
    await db.codeEvents.put(event)
  }

  /**
   * 站网科撤号：编号置「已撤」，引用它的未撤测次全部悬空，流量暂停报。
   * 已报出的流量与历史记录不动（按当时编号仍可查）。
   */
  async function withdrawCode(station: Station, reason: string): Promise<number> {
    const now = Date.now()
    let affected = 0
    await db.transaction('rw', [db.stations, db.sections, db.codeEvents], async () => {
      await appendCodeEvent({
        sectionCode: station.sectionCode,
        codeVersion: station.codeVersion,
        lifecycle: '已撤',
        eventType: '撤号',
        station,
        reason
      })
      await db.stations.update(station.id, {
        lifecycle: '已撤',
        mergedToCode: '',
        remark: reason ? `${station.remark}${station.remark ? '；' : ''}撤号：${reason}` : station.remark,
        updatedAt: now
      } as never)
      const linked = await db.sections
        .where('refCode')
        .equals(station.sectionCode)
        .filter((section) => section.refStatus !== '待认领')
        .toArray()
      for (const section of linked) {
        await db.sections.update(section.id, {
          refStatus: '悬空',
          refNote: `编号 ${station.sectionCode} 已撤，等站网科重新指派`,
          updatedAt: now
        } as never)
        affected += 1
      }
    })
    return affected
  }

  /**
   * 站网科并号：源编号置「已并走」指向目标编号，源编号引用全部悬空等重新指派。
   * 目标（站网科）编号本身不动。
   */
  async function mergeCode(source: Station, targetCode: string, reason: string): Promise<number> {
    const target = ledgerOfCode(targetCode)
    if (!target || target.lifecycle !== '现行') {
      throw new Error(`目标编号 ${targetCode} 不处于现行状态，不能作为并入目标`)
    }
    if (source.sectionCode === targetCode) throw new Error('不能并入编号自身')
    const now = Date.now()
    let affected = 0
    await db.transaction('rw', [db.stations, db.sections, db.codeEvents], async () => {
      await appendCodeEvent({
        sectionCode: source.sectionCode,
        codeVersion: source.codeVersion,
        lifecycle: '已并走',
        eventType: '并号',
        station: source,
        mergedToCode: targetCode,
        reason
      })
      await db.stations.update(source.id, {
        lifecycle: '已并走',
        mergedToCode: targetCode,
        updatedAt: now
      } as never)
      const linked = await db.sections
        .where('refCode')
        .equals(source.sectionCode)
        .filter((section) => section.refStatus !== '待认领')
        .toArray()
      for (const section of linked) {
        await db.sections.update(section.id, {
          refStatus: '悬空',
          refNote: `编号 ${source.sectionCode} 已并走（并入 ${targetCode}），等站网科重新指派`,
          updatedAt: now
        } as never)
        affected += 1
      }
    })
    return affected
  }

  /**
   * 站网科换版：编号文本不变、版本 +1，旧版本引用悬空等重新指派。
   */
  async function bumpCodeVersion(station: Station, reason: string): Promise<number> {
    const nextVersion = station.codeVersion + 1
    const now = Date.now()
    let affected = 0
    await db.transaction('rw', [db.stations, db.sections, db.codeEvents], async () => {
      await appendCodeEvent({
        sectionCode: station.sectionCode,
        codeVersion: nextVersion,
        lifecycle: '现行',
        eventType: '换版',
        station,
        reason
      })
      await db.stations.update(station.id, { codeVersion: nextVersion, updatedAt: now } as never)
      const linked = await db.sections
        .where('refCode')
        .equals(station.sectionCode)
        .filter((section) => section.refStatus !== '待认领')
        .toArray()
      for (const section of linked) {
        if (section.refVersion !== null && section.refVersion < nextVersion) {
          await db.sections.update(section.id, {
            refStatus: '悬空',
            refNote: `引用版本 v${section.refVersion} 已换版为 v${nextVersion}，等重新指派`,
            updatedAt: now
          } as never)
          affected += 1
        }
      }
    })
    return affected
  }

  /**
   * 巡测队重新指派：悬空 / 待认领测次改指到现行编号。
   * 站网科编号不动；目标不现行 → 返回 false（重新指派失败，退回本侧重试）。
   */
  async function reassignSection(sectionId: string, targetCode: string): Promise<boolean> {
    const section = await db.sections.get(sectionId)
    if (!section) return false
    const patch = reassignRef(section, targetCode, codeIndex.value)
    if (!patch) return false
    await db.sections.update(sectionId, { ...patch, updatedAt: Date.now() } as never)
    return true
  }

  /** 批量重新指派到同一现行编号（悬空队列常用） */
  async function reassignSections(sectionIds: string[], targetCode: string): Promise<{ ok: number; fail: number }> {
    let ok = 0
    let fail = 0
    for (const id of sectionIds) {
      const success = await reassignSection(id, targetCode)
      if (success) ok += 1
      else fail += 1
    }
    return { ok, fail }
  }

  /**
   * 巡测队认领旧测次：人工指定现存现行编号（补不齐的单列清单走此动作）。
   * 与重新指派同一路径，成功后转对账中。
   */
  async function claimLegacySection(sectionId: string, targetCode: string): Promise<boolean> {
    return reassignSection(sectionId, targetCode)
  }

  /**
   * 退回本侧重试：重新指派失败后，站网科编号不动，
   * 巡测队把测次退回引用原状（悬空 / 待认领），仅刷新对账说明。
   */
  async function retryOnOurSide(sectionId: string): Promise<void> {
    const section = await db.sections.get(sectionId)
    if (!section) return
    const result = reconcileSection(section, codeIndex.value)
    await db.sections.update(sectionId, {
      refStatus: result.status,
      refNote: `${result.note}（已退回本侧重试，站网科编号未改动）`,
      updatedAt: Date.now()
    } as never)
  }

  /** 报流量：仅对账中测次可报；撤并 / 待认领期间先不报。返回是否受理 */
  async function reportFlow(sectionId: string, flowM3s: number): Promise<boolean> {
    const section = await db.sections.get(sectionId)
    if (!section || !canReportFlow(section.refStatus)) return false
    await db.sections.update(sectionId, {
      reported: true,
      reportedFlowM3s: flowM3s,
      reportedAt: new Date().toISOString(),
      updatedAt: Date.now()
    } as never)
    return true
  }

  /** 重新对账：编号恢复 / 并号目标现行后，把悬空测次按当前编号重算一遍 */
  async function reconcileAll(): Promise<{ matched: number; stillDangling: number; pending: number }> {
    const now = Date.now()
    let matched = 0
    let stillDangling = 0
    let pending = 0
    const index = codeIndex.value
    await db.transaction('rw', [db.sections], async () => {
      const all = await db.sections.toArray()
      for (const section of all) {
        if (section.refStatus === '待认领') {
          pending += 1
          continue
        }
        const result = reconcileSection(section, index)
        if (result.status !== section.refStatus || section.refNote !== result.note) {
          await db.sections.update(section.id, {
            refStatus: result.status,
            refNote: result.note,
            updatedAt: now
          } as never)
        }
        if (result.status === '对账中') matched += 1
        else if (result.status === '悬空') stillDangling += 1
      }
    })
    return { matched, stillDangling, pending }
  }

  return {
    stations,
    sections,
    codeEvents,
    ready,
    error,
    ledgers,
    codeIndex,
    activeCodes,
    sectionViews,
    danglingViews,
    pendingViews,
    matchedViews,
    summary,
    start,
    ledgerOfCode,
    stationById,
    appendCodeEvent,
    withdrawCode,
    mergeCode,
    bumpCodeVersion,
    reassignSection,
    reassignSections,
    claimLegacySection,
    retryOnOurSide,
    reportFlow,
    reconcileAll
  }
})
