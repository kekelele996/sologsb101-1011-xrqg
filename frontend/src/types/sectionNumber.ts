/**
 * 断面编号台账（站网科主管的主数据）。
 * 测站的河名、集水面积与断面编号归站网科定，巡测队按这套编号落测次、记垂线测深、算流量。
 * 编号有生命周期：在用 / 已撤 / 已并；撤掉或并走后，引用它的测次即悬空，需重新指派。
 */

/** 断面编号状态（站网科台账生命周期） */
export type SectionNumberStatus = 'active' | 'revoked' | 'merged'

export const SECTION_NUMBER_STATUS_META: Record<
  SectionNumberStatus,
  { label: string; type: 'success' | 'danger' | 'warning'; tagType: 'success' | 'danger' | 'warning' }
> = {
  active: { label: '在用', type: 'success', tagType: 'success' },
  revoked: { label: '已撤', type: 'danger', tagType: 'danger' },
  merged: { label: '已并', type: 'warning', tagType: 'warning' }
}

export const SECTION_NUMBER_STATUSES: Array<{ value: SectionNumberStatus; label: string }> = [
  { value: 'active', label: '在用' },
  { value: 'revoked', label: '已撤' },
  { value: 'merged', label: '已并' }
]

/** 测次对账状态（巡测队侧） */
export type ReconcileStatus = 'matched' | 'shelved' | 'reassigned' | 'unmatched'

export const RECONCILE_STATUS_META: Record<
  ReconcileStatus,
  { label: string; type: 'success' | 'danger' | 'warning' | 'info'; tagType: 'success' | 'danger' | 'warning' | 'info' }
> = {
  matched: { label: '已对账', type: 'success', tagType: 'success' },
  shelved: { label: '悬空待派', type: 'danger', tagType: 'danger' },
  reassigned: { label: '已改派', type: 'warning', tagType: 'warning' },
  unmatched: { label: '待认领', type: 'info', tagType: 'info' }
}

/** 断面编号台账：站网科统一管理的断面编号（河名、集水面积随测站落档） */
export interface SectionNumber {
  id: string
  /** 断面编号，如 CS-LM-01 */
  code: string
  /** 所属测站 */
  stationId: string
  /** 河名（站网科认定，冗余快照便于对账） */
  river: string
  /** 集水面积（km²，站网科认定） */
  catchmentKm2: number
  /** 在用 / 已撤 / 已并 */
  status: SectionNumberStatus
  /** 被合并到的断面编号 id（status=merged 时有效） */
  mergedIntoId: string | null
  /** 启用时间（编号版本生效起点） */
  effectiveFrom: string
  /** 停用时间（撤 / 并时间，null 表示仍在用） */
  effectiveTo: string | null
  /** 撤并文号 / 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 判断编号是否仍可引用（在用） */
export function isNumberActive(number: SectionNumber | null | undefined): boolean {
  return !!number && number.status === 'active'
}

/** 编号展示文案：编号 + 状态角标语义由页面拼接 */
export function numberLabel(number: SectionNumber | null | undefined): string {
  return number ? number.code : '（未指派编号）'
}

/** 新建编号入参 */
export type NewSectionNumberPayload = Omit<SectionNumber, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'mergedIntoId' | 'effectiveTo'> & {
  status?: SectionNumberStatus
}
