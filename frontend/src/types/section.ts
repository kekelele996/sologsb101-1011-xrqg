/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/**
 * 巡测队引用站网科编号的对账状态：
 * - 对账中：编号现行且版本一致，可正常落测次、报流量
 * - 悬空：引用的编号已撤或已并走，测次先搁着，期间不报流量
 * - 待认领：旧数据没记编号版本，首次打开自动迁移没补齐，单列交人认
 */
export type RefStatus = '对账中' | '悬空' | '待认领'

export const REF_STATUSES: RefStatus[] = ['对账中', '悬空', '待认领']

/** 编号对账状态标签配色（列表页 / 对账台共用） */
export const REF_STATUS_TONE: Record<RefStatus, 'success' | 'danger' | 'warning'> = {
  对账中: 'success',
  悬空: 'danger',
  待认领: 'warning'
}

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站（录入时的当前归属，撤并后保留，流量按当时编号仍可查） */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 引用的断面编号（落测次时照抄站网科编号） */
  refCode: string
  /** 引用的编号版本（旧数据迁移前为空） */
  refVersion: number | null
  /** 编号对账状态 */
  refStatus: RefStatus
  /** 最近一次对账 / 重新指派结果说明 */
  refNote: string
  /** 流量上报状态：对账中可报；悬空 / 待认领期间先不报 */
  reported: boolean
  /** 已上报流量（m³/s）：报出时冻结，撤并后仍按当时编号可查 */
  reportedFlowM3s: number | null
  /** 上报时间（ISO） */
  reportedAt: string | null
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
