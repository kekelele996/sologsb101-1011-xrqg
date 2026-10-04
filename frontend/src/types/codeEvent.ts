/**
 * 编号台账事件（站网科域）：河名、集水面积与断面编号归站网科定，
 * 巡测队只按编号引用，不直接改写。所有撤号 / 并号 / 换版动作都在该表留痕，
 * 供编号对账时判定引用是否悬空，以及「按当时编号仍可查」。
 */

/** 编号事件类型 */
export type CodeEventType = '指派' | '撤号' | '并号' | '换版'

/** 断面编号当前状态 */
export type CodeLifecycle = '现行' | '已撤' | '已并走'

export const CODE_LIFECYCLES: CodeLifecycle[] = ['现行', '已撤', '已并走']

/** 站网科编号台账事件流：一条编号一行当前态 + 历史动作 */
export interface CodeEvent {
  id: string
  /** 断面编号，如 CS-LM-01 */
  sectionCode: string
  /** 编号版本（整数，从 1 起；换版 +1） */
  codeVersion: number
  /** 当前生命周期：现行 / 已撤 / 已并走 */
  lifecycle: CodeLifecycle
  /** 事件类型 */
  eventType: CodeEventType
  /** 该编号当前（或撤并前）归属测站 */
  stationId: string
  /** 归属站名（冗余存档，测站删除后仍可按编号查历史） */
  stationName: string
  /** 河名（站网科定） */
  river: string
  /** 集水面积 km²（站网科定） */
  catchmentKm2: number
  /** 并号目标：撤号时为空；并号时指向并入的现行编号 */
  mergedToCode: string
  /** 经办说明 */
  reason: string
  /** 生效时间（ISO） */
  occurredAt: string
  createdAt: number
  updatedAt: number
}

/** 某条断面编号的台账视图：当前态 + 全部历史事件 */
export interface CodeLedgerView {
  sectionCode: string
  codeVersion: number
  lifecycle: CodeLifecycle
  stationId: string
  stationName: string
  river: string
  catchmentKm2: number
  mergedToCode: string
  events: CodeEvent[]
}

/** 构造一条编号事件的默认字段 */
export function buildCodeEventInit(
  partial: Partial<CodeEvent> & { sectionCode: string }
): Omit<CodeEvent, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    codeVersion: partial.codeVersion ?? 1,
    lifecycle: partial.lifecycle ?? '现行',
    eventType: partial.eventType ?? '指派',
    stationId: partial.stationId ?? '',
    stationName: partial.stationName ?? '',
    river: partial.river ?? '',
    catchmentKm2: partial.catchmentKm2 ?? 0,
    mergedToCode: partial.mergedToCode ?? '',
    reason: partial.reason ?? '',
    occurredAt: partial.occurredAt ?? new Date().toISOString(),
    sectionCode: partial.sectionCode
  }
}
