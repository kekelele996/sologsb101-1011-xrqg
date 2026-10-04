/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

import type { ReconcileStatus } from './sectionNumber'

/**
 * 断面测次：一次完整的流量测验。
 * 测次引用站网科台账中的断面编号（sectionNumberId），并留存落编时的编号快照
 * （sectionCodeSnapshot）——编号撤 / 并后历史流量仍按当时编号可查。
 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 引用的断面编号（站网科台账 section_numbers.id）；旧数据迁移前可能为空 */
  sectionNumberId: string
  /** 落编时的编号快照（历史流量按当时编号可查） */
  sectionCodeSnapshot: string
  /** 对账状态：已对账 / 悬空待派 / 已改派 / 待认领 */
  reconcileStatus: ReconcileStatus
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 测流时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
