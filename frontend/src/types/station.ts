/** 水位流量关系点据的定线编号（可多条并存，用于区分不同年份的绳套曲线） */
export const LINE_NOS = ['A', 'B', 'C'] as const

import type { CodeLifecycle } from '@/types/codeEvent'

/** 测站：水文测验的基本单元（河名、集水面积、断面编号归站网科定） */
export interface Station {
  id: string
  /** 站名 */
  name: string
  /** 河名 */
  river: string
  /** 集水面积（km²） */
  catchmentKm2: number
  /** 断面编号，如 CS-01 */
  sectionCode: string
  /** 断面编号版本（站网科换版时 +1，巡测队按「编号 + 版本」引用） */
  codeVersion: number
  /** 编号生命周期：现行 / 已撤 / 已并走，撤并后引用它的测次悬空 */
  lifecycle: CodeLifecycle
  /** 并号目标编号（已并走时指向并入的现行编号） */
  mergedToCode: string
  /** 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 测站台账的筛选条件（存于 stationStore，并同步 URL query） */
export interface StationFilterState {
  keyword: string
  /** 河名多选 */
  rivers: string[]
  /** 集水面积下限（km²） */
  minCatchmentKm2: number | null
  /** 集水面积上限（km²） */
  maxCatchmentKm2: number | null
}

export function createEmptyStationFilter(): StationFilterState {
  return {
    keyword: '',
    rivers: [],
    minCatchmentKm2: null,
    maxCatchmentKm2: null
  }
}

/** 集水面积默认分档，供筛选下拉使用 */
export const CATCHMENT_BUCKETS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: '全部集水面积', min: null, max: null },
  { label: '小于 500 km²', min: null, max: 500 },
  { label: '500 ~ 2000 km²', min: 500, max: 2000 },
  { label: '2000 ~ 10000 km²', min: 2000, max: 10000 },
  { label: '大于 10000 km²', min: 10000, max: null }
]
