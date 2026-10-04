/**
 * 编号对账纯逻辑：站网科管测站 / 河名 / 集水面积 / 断面编号，
 * 巡测队管测次 / 垂线 / 测点 / 流量，两边按「编号 + 版本」对账。
 *
 * 规则：
 * - 编号现行且版本一致 → 对账中，可报流量；
 * - 编号已撤 / 已并走，或引用版本落后于台账 → 悬空：测次先搁着、流量先不报；
 * - 旧数据没记编号版本（refVersion 为空）→ 首次打开先按现存编号自动迁移，
 *   能对上现存且现行的编号则补齐版本并启用；补不齐的置为待认领，单列交人认。
 * 纯函数，不触碰 Dexie，便于被 db 迁移与 store 动作共用同一套判定。
 */
import type { Station } from '@/types/station'
import type { RefStatus, Section } from '@/types/section'
import type { CodeLedgerView } from '@/types/codeEvent'

/** 对账结果说明 */
export interface ReconcileResult {
  status: RefStatus
  note: string
}

/** 编号索引：sectionCode → 编号台账视图（同编号只保留版本最大的当前态） */
export function buildCodeIndex(ledgers: CodeLedgerView[]): Map<string, CodeLedgerView> {
  const map = new Map<string, CodeLedgerView>()
  ledgers.forEach((ledger) => {
    const existing = map.get(ledger.sectionCode)
    if (!existing || ledger.codeVersion > existing.codeVersion) map.set(ledger.sectionCode, ledger)
  })
  return map
}

/** 由测站表构造现行 / 历史编号的查找索引（撤并前的旧编号也可命中，用于查历史） */
export function buildStationCodeIndex(stations: Station[]): Map<string, Station> {
  const map = new Map<string, Station>()
  stations.forEach((station) => {
    if (!station.sectionCode) return
    const existing = map.get(station.sectionCode)
    if (!existing || station.codeVersion > existing.codeVersion) map.set(station.sectionCode, station)
  })
  return map
}

/**
 * 对单个测次按编号索引对账。
 * @param section 测次（含引用编号与版本）
 * @param codeIndex 站网科当前编号索引
 */
export function reconcileSection(
  section: Pick<Section, 'refCode' | 'refVersion' | 'refStatus'>,
  codeIndex: Map<string, CodeLedgerView>
): ReconcileResult {
  if (section.refStatus === '待认领') {
    return { status: '待认领', note: '旧编号版本补不齐，待人工认领' }
  }
  if (!section.refCode) {
    return { status: '待认领', note: '测次未记引用编号，待人工认领' }
  }
  const ledger = codeIndex.get(section.refCode)
  if (!ledger) {
    return { status: '待认领', note: `编号 ${section.refCode} 在现存编号中找不到，待人工认领` }
  }
  if (ledger.lifecycle === '已撤') {
    return { status: '悬空', note: `编号 ${section.refCode} 已撤，等站网科重新指派` }
  }
  if (ledger.lifecycle === '已并走') {
    const target = ledger.mergedToCode ? `（并入 ${ledger.mergedToCode}）` : ''
    return { status: '悬空', note: `编号 ${section.refCode} 已并走${target}，等站网科重新指派` }
  }
  if (section.refVersion !== null && section.refVersion < ledger.codeVersion) {
    return {
      status: '悬空',
      note: `引用版本 v${section.refVersion} 已换版为 v${ledger.codeVersion}，等重新指派`
    }
  }
  return {
    status: '对账中',
    note:
      section.refVersion === ledger.codeVersion
        ? `编号 ${section.refCode} v${ledger.codeVersion} 对账一致`
        : `已按现存编号 ${section.refCode} v${ledger.codeVersion} 启用`
  }
}

/**
 * 旧数据首次打开迁移：没记编号版本的测次，先对现存编号。
 * - 能对上现行编号：补 refVersion、置对账中；
 * - 编号已撤 / 已并走：直接置悬空，等重新指派；
 * - 现存编号查不到：置待认领，单列交人认。
 * 返回迁移后的字段补丁（不修改入参）。
 */
export function migrateLegacyRef(
  section: Pick<Section, 'stationId' | 'refCode' | 'refVersion' | 'refStatus' | 'refNote'>,
  stations: Station[],
  codeIndex: Map<string, CodeLedgerView>
): Partial<Section> {
  // 已有版本信息的不是旧数据，不在首迁范围内
  if (section.refVersion !== null) return {}

  const refCode =
    section.refCode || stations.find((station) => station.id === section.stationId)?.sectionCode || ''
  if (!refCode) {
    return { refCode, refVersion: null, refStatus: '待认领', refNote: '旧测次无编号可对，待人工认领' }
  }
  const ledger = codeIndex.get(refCode)
  if (!ledger) {
    return {
      refCode,
      refVersion: null,
      refStatus: '待认领',
      refNote: `旧编号 ${refCode} 现存台账查不到，待人工认领`
    }
  }
  if (ledger.lifecycle !== '现行') {
    return {
      refCode,
      refVersion: ledger.codeVersion,
      refStatus: '悬空',
      refNote: `旧测次迁移时编号 ${refCode} 已${ledger.lifecycle === '已撤' ? '撤' : '并走'}，等重新指派`
    }
  }
  return {
    refCode,
    refVersion: ledger.codeVersion,
    refStatus: '对账中',
    refNote: `旧数据已迁移到现存编号 ${refCode} v${ledger.codeVersion}`
  }
}

/**
 * 站网科重新指派：把悬空测次改指到现行编号。
 * 站网科编号本身不动，只改巡测队这头的引用。
 * 成功返回补丁；目标编号不现行则返回 null（重新指派失败，退回本侧重试）。
 */
export function reassignRef(
  section: Pick<Section, 'refCode' | 'refVersion'>,
  targetCode: string,
  codeIndex: Map<string, CodeLedgerView>
): (Partial<Section> & { refCode: string; refVersion: number; refStatus: RefStatus }) | null {
  const target = codeIndex.get(targetCode)
  if (!target || target.lifecycle !== '现行') return null
  return {
    refCode: target.sectionCode,
    refVersion: target.codeVersion,
    refStatus: '对账中',
    stationId: target.stationId,
    refNote: `已由 ${section.refCode || '空编号'}${
      section.refVersion !== null ? ` v${section.refVersion}` : ''
    } 重新指派到 ${target.sectionCode} v${target.codeVersion}`
  }
}

/** 是否允许报流量：仅对账中测次可报，悬空 / 待认领期间先不报 */
export function canReportFlow(status: RefStatus): boolean {
  return status === '对账中'
}

/** 汇总对账队列计数（对账台徽标 / 导航共用） */
export function summarizeRefs(sections: Array<Pick<Section, 'refStatus'>>): {
  matched: number
  dangling: number
  pending: number
} {
  const summary = { matched: 0, dangling: 0, pending: 0 }
  sections.forEach((section) => {
    if (section.refStatus === '对账中') summary.matched += 1
    else if (section.refStatus === '悬空') summary.dangling += 1
    else summary.pending += 1
  })
  return summary
}
