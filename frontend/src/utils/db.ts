/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { CodeEvent, CodeLedgerView } from '@/types/codeEvent'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { buildCodeIndex, migrateLegacyRef } from '@/utils/reconcile'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  codeEvents: CodeEvent[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  /** 站网科编号台账事件流（指派 / 撤号 / 并号 / 换版） */
  codeEvents!: Table<CodeEvent, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：站网科编号版本化。新增 codeEvents 台账表；
    // 测站补编号版本 / 生命周期，测次补引用编号 / 对账状态 / 上报状态。
    // 旧数据没记编号版本：upgrade 中先按现存编号迁移，补不齐的置待认领带出。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, codeVersion, lifecycle, catchmentKm2, updatedAt',
        sections:
          'id, stationId, measureNo, refCode, refStatus, reported, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt',
        codeEvents: 'id, sectionCode, codeVersion, lifecycle, stationId, eventType, occurredAt'
      })
      .upgrade(async (tx) => {
        // 1) 历史数据补齐时间戳与 v2 默认字段（老用户从 v1/v2 直升 v3 同样适用）
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }

        // 2) 测站补站网科编号版本字段，并为每个现存编号补一条「指派」台账事件
        const stationRows: Station[] = await tx.table<Station, string>('stations').toArray()
        const now = Date.now()
        const seedLedgerEvents: CodeEvent[] = []
        await tx
          .table<Station, string>('stations')
          .toCollection()
          .modify((station) => {
            if (typeof station.codeVersion !== 'number') station.codeVersion = 1
            if (station.lifecycle !== '现行' && station.lifecycle !== '已撤' && station.lifecycle !== '已并走') {
              station.lifecycle = '现行'
            }
            if (typeof station.mergedToCode !== 'string') station.mergedToCode = ''
            const code = String(station.sectionCode ?? '')
            if (code) {
              seedLedgerEvents.push({
                id: `cev_${station.id}`,
                sectionCode: code,
                codeVersion: Number(station.codeVersion ?? 1),
                lifecycle: station.lifecycle,
                eventType: '指派',
                stationId: String(station.id),
                stationName: String(station.name ?? ''),
                river: String(station.river ?? ''),
                catchmentKm2: Number(station.catchmentKm2 ?? 0),
                mergedToCode: String(station.mergedToCode ?? ''),
                reason: '编号版本化迁移：按现存测站补建台账',
                occurredAt: new Date(Number(station.createdAt ?? now)).toISOString(),
                createdAt: now,
                updatedAt: now
              })
            }
          })
        if (seedLedgerEvents.length > 0) {
          await tx.table<CodeEvent, string>('codeEvents').bulkPut(seedLedgerEvents)
        }

        // 3) 测次补引用 / 上报字段；旧数据没记编号版本 → 先迁移到现存编号再启用，
        //    补不齐（编号已撤并或查不到）的置「待认领 / 悬空」交人认。
        const ledgers = buildLedgerViews(seedLedgerEvents)
        const codeIndex = buildCodeIndex(ledgers)
        await tx
          .table<Section, string>('sections')
          .toCollection()
          .modify((section) => {
            if (typeof section.refCode !== 'string') {
              const owner = stationRows.find((station) => station.id === section.stationId)
              section.refCode = owner?.sectionCode ?? ''
            }
            if (typeof section.refVersion !== 'number' && section.refVersion !== null) {
              section.refVersion = null
            }
            if (
              section.refStatus !== '对账中' &&
              section.refStatus !== '悬空' &&
              section.refStatus !== '待认领'
            ) {
              section.refStatus = '对账中'
            }
            if (typeof section.refNote !== 'string') section.refNote = ''
            if (typeof section.reported !== 'boolean') section.reported = false
            if (typeof section.reportedFlowM3s !== 'number' && section.reportedFlowM3s !== null) {
              section.reportedFlowM3s = null
            }
            if (typeof section.reportedAt !== 'string' && section.reportedAt !== null) {
              section.reportedAt = null
            }
            const patch = migrateLegacyRef(
              {
                stationId: String(section.stationId ?? ''),
                refCode: String(section.refCode ?? ''),
                refVersion: section.refVersion ?? null,
                refStatus: section.refStatus,
                refNote: String(section.refNote ?? '')
              },
              stationRows,
              codeIndex
            )
            Object.assign(section, patch)
          })
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 把编号事件流折叠成「每条编号一个当前态」的台账视图，
 * 同编号取版本号最大的事件为当前态，事件按时间升序保留为历史。
 */
export function buildLedgerViews(events: CodeEvent[]): CodeLedgerView[] {
  const grouped = new Map<string, CodeEvent[]>()
  events.forEach((event) => {
    const list = grouped.get(event.sectionCode) ?? []
    list.push(event)
    grouped.set(event.sectionCode, list)
  })
  const views: CodeLedgerView[] = []
  grouped.forEach((list, sectionCode) => {
    const ordered = [...list].sort((a, b) =>
      a.codeVersion === b.codeVersion ? a.createdAt - b.createdAt : a.codeVersion - b.codeVersion
    )
    const current = ordered.reduce<CodeEvent | null>((latest, event) => {
      if (!latest) return event
      return event.codeVersion >= latest.codeVersion ? event : latest
    }, null)
    if (!current) return
    views.push({
      sectionCode,
      codeVersion: current.codeVersion,
      lifecycle: current.lifecycle,
      stationId: current.stationId,
      stationName: current.stationName,
      river: current.river,
      catchmentKm2: current.catchmentKm2,
      mergedToCode: current.mergedToCode,
      events: ordered
    })
  })
  return views.sort((a, b) => a.sectionCode.localeCompare(b.sectionCode))
}

/** 读取编号台账视图（liveQuery / 对账台共用） */
export async function listCodeLedgerViews(): Promise<CodeLedgerView[]> {
  return buildLedgerViews(await db.codeEvents.toArray())
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/** 旧测次迁移演示：引用的编号在现存台账中查不到（模拟无版本的历史测次） */
interface SeedLegacyOrphan {
  section: Omit<Section, 'createdAt' | 'updatedAt'>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 * 编号对账另播种三类场景：
 * - 撤号：CS-FL-04 已撤，其测次悬空、暂停报量；
 * - 并号：白沙滩 CS-BS-03 已并入龙门 CS-LM-01，其测次悬空等重新指派；
 * - 旧数据：一个没记编号版本、编号已查不到的历史测次，首迁后落「待认领」。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        codeVersion: 1,
        lifecycle: '现行',
        mergedToCode: '',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          refCode: 'CS-LM-01',
          refVersion: 1,
          refStatus: '对账中',
          refNote: '编号 CS-LM-01 v1 对账一致',
          reported: true,
          reportedFlowM3s: 217.2,
          reportedAt: '2024-06-12T10:00:00.000Z',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          refCode: 'CS-LM-01',
          refVersion: 1,
          refStatus: '对账中',
          refNote: '编号 CS-LM-01 v1 对账一致',
          reported: false,
          reportedFlowM3s: null,
          reportedAt: null,
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        codeVersion: 1,
        lifecycle: '现行',
        mergedToCode: '',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          refCode: 'CS-QJ-02',
          refVersion: 1,
          refStatus: '对账中',
          refNote: '编号 CS-QJ-02 v1 对账一致',
          reported: true,
          reportedFlowM3s: 56.1,
          reportedAt: '2024-05-22T09:30:00.000Z',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          refCode: 'CS-QJ-02',
          refVersion: 1,
          refStatus: '对账中',
          refNote: '编号 CS-QJ-02 v1 对账一致',
          reported: false,
          reportedFlowM3s: null,
          reportedAt: null,
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        codeVersion: 1,
        // 演示「并号」：白沙滩断面编号已并走至龙门，编号本身不删，状态改已并走
        lifecycle: '已并走',
        mergedToCode: 'CS-LM-01',
        remark: '巡测断面，已并入龙门站断面编号，测次等重新指派'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          refCode: 'CS-BS-03',
          refVersion: 1,
          refStatus: '悬空',
          refNote: '编号 CS-BS-03 已并走（并入 CS-LM-01），等站网科重新指派',
          // 撤并前已报出的流量保留，按当时编号仍可查
          reported: true,
          reportedFlowM3s: 203.5,
          reportedAt: '2024-06-20T11:00:00.000Z',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  /**
   * 撤号演示测站：CS-FL-04 编号已撤（测站保留以承载历史），
   * 其测次引用已撤编号 → 悬空，期间流量先不报。
   */
  const withdrawnStation: Omit<Station, 'createdAt' | 'updatedAt'> = {
    id: 'stn_fl04',
    name: '枫林临时断面',
    river: '沅江',
    catchmentKm2: 960,
    sectionCode: 'CS-FL-04',
    codeVersion: 1,
    lifecycle: '已撤',
    mergedToCode: '',
    remark: '临时断面，编号已由站网科撤销，历史测次待重新指派'
  }
  const withdrawnSection: Omit<Section, 'createdAt' | 'updatedAt'> = {
    id: 'sec_fl_2404',
    stationId: 'stn_fl04',
    measureNo: '2024-04-009',
    refCode: 'CS-FL-04',
    refVersion: 1,
    refStatus: '悬空',
    refNote: '编号 CS-FL-04 已撤，等站网科重新指派',
    reported: false,
    reportedFlowM3s: null,
    reportedAt: null,
    startDistanceM: 9.0,
    stageM: 2.74,
    method: '浮标',
    measuredAt: '2024-04-16T08:20:00.000Z'
  }

  /**
   * 旧数据演示：更早的历史测次没记编号版本，且所引编号 CS-GD-99 已查不到，
   * 首次打开迁移补不齐 → 待人工认领（不挂测站，单独列在对账台）。
   */
  const legacyOrphanSections: SeedLegacyOrphan[] = [
    {
      section: {
        id: 'sec_legacy_99',
        stationId: '',
        measureNo: '2021-09-007',
        refCode: 'CS-GD-99',
        refVersion: null,
        refStatus: '待认领',
        refNote: '旧编号 CS-GD-99 现存台账查不到，待人工认领',
        reported: true,
        reportedFlowM3s: 38.4,
        reportedAt: '2021-09-05T09:00:00.000Z',
        startDistanceM: 5.0,
        stageM: 2.61,
        method: '流速仪',
        measuredAt: '2021-09-05T08:00:00.000Z'
      }
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  // 站网科编号台账事件：指派 + 撤号 + 并号
  const codeEventSeeds: Array<Omit<CodeEvent, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'cev_lm01',
      sectionCode: 'CS-LM-01',
      codeVersion: 1,
      lifecycle: '现行',
      eventType: '指派',
      stationId: 'stn_lh01',
      stationName: '龙门水文站',
      river: '澜沧江',
      catchmentKm2: 45200,
      mergedToCode: '',
      reason: '基本站编号指派',
      occurredAt: '2024-01-05T00:00:00.000Z'
    },
    {
      id: 'cev_qj02',
      sectionCode: 'CS-QJ-02',
      codeVersion: 1,
      lifecycle: '现行',
      eventType: '指派',
      stationId: 'stn_qj02',
      stationName: '青矶水位站',
      river: '沅江',
      catchmentKm2: 1860,
      mergedToCode: '',
      reason: '小河站编号指派',
      occurredAt: '2024-01-05T00:00:00.000Z'
    },
    {
      id: 'cev_bs03_assign',
      sectionCode: 'CS-BS-03',
      codeVersion: 1,
      lifecycle: '现行',
      eventType: '指派',
      stationId: 'stn_bs03',
      stationName: '白沙滩巡测站',
      river: '澜沧江',
      catchmentKm2: 51200,
      mergedToCode: '',
      reason: '巡测断面编号指派',
      occurredAt: '2024-01-06T00:00:00.000Z'
    },
    {
      id: 'cev_bs03_merge',
      sectionCode: 'CS-BS-03',
      codeVersion: 1,
      lifecycle: '已并走',
      eventType: '并号',
      stationId: 'stn_bs03',
      stationName: '白沙滩巡测站',
      river: '澜沧江',
      catchmentKm2: 51200,
      mergedToCode: 'CS-LM-01',
      reason: '站网科整编：白沙滩巡测断面并入龙门站断面编号',
      occurredAt: '2024-09-02T00:00:00.000Z'
    },
    {
      id: 'cev_fl04_withdraw',
      sectionCode: 'CS-FL-04',
      codeVersion: 1,
      lifecycle: '已撤',
      eventType: '撤号',
      stationId: 'stn_fl04',
      stationName: '枫林临时断面',
      river: '沅江',
      catchmentKm2: 960,
      mergedToCode: '',
      reason: '临时断面撤销，编号停用',
      occurredAt: '2024-05-01T00:00:00.000Z'
    }
  ]

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.codeEvents],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut([
        ...stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) })),
        { ...withdrawnStation, ...stamp(withdrawnStation) }
      ])
      await db.sections.bulkPut([
        ...stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        ),
        { ...withdrawnSection, ...stamp(withdrawnSection) },
        ...legacyOrphanSections.map((orphan) => ({ ...orphan.section, ...stamp(orphan.section) }))
      ])
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      await db.codeEvents.bulkPut(codeEventSeeds.map((event) => ({ ...event, ...stamp(event) })))
      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))

      // 比测记录：按定线拟合出曲线流量后计算偏差与判定，保证与页面展示一致
      const compares: Compare[] = []
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      ratingSeeds.forEach((rating) => {
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.stageM, flowM3s: rating.flowM3s })
        lineGroups.set(rating.lineNo, list)
      })
      ratingSeeds.forEach((rating) => {
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)
      if (compares.length === 0) {
        await db.compares.put({
          id: 'cmp_fallback',
          ratingId: 'rat_lh_a1',
          measuredFlow: 97.5,
          curveFlow: 100.2,
          deviationPct: calcDeviationPct(97.5, 100.2),
          verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
          operator: '林昭',
          comparedAt: iso,
          createdAt: now,
          updatedAt: now
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.codeEvents],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.codeEvents.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, codeEvents] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.codeEvents.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, codeEvents }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
