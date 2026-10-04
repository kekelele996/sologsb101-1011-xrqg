/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { CodeEvent } from '@/types/codeEvent'
import type { Section, RefStatus } from '@/types/section'
import { buildCodeIndex, migrateLegacyRef } from '@/utils/reconcile'
import { buildLedgerViews } from '@/utils/db'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'stations',
  'sections',
  'verticals',
  'points',
  'ratings',
  'compares',
  'codeEvents'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, sections, verticals, points, ratings, compares, codeEvents] = await Promise.all([
    db.stations.toArray(),
    db.sections.toArray(),
    db.verticals.toArray(),
    db.points.toArray(),
    db.ratings.toArray(),
    db.compares.toArray(),
    db.codeEvents.toArray()
  ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    sections,
    verticals,
    points,
    ratings,
    compares,
    codeEvents
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  // 六张业务表为必需；codeEvents 为 v3 新增，旧备份缺失时按空台账兼容导入
  const requiredKeys = BACKUP_KEYS.filter((key) => key !== 'codeEvents')
  for (const key of requiredKeys) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    sections: obj.sections ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings: obj.ratings ?? [],
    compares: obj.compares ?? [],
    codeEvents: Array.isArray(obj.codeEvents) ? (obj.codeEvents as CodeEvent[]) : []
  }
  normalizePayloadToV3(payload)
  return { ok: true, errors, payload }
}

/**
 * 旧版备份（v2 及以前）归一化到当前结构：
 * 测站补编号版本字段并按现存编号补台账；旧测次没记版本的先迁到现存编号再启用，
 * 补不齐的置「待认领」，与首次打开数据库的迁移口径一致。
 */
export function normalizePayloadToV3(payload: BackupPayload): void {
  const now = Date.now()
  const seenLedger = new Set(payload.codeEvents.map((event) => event.sectionCode))
  payload.stations.forEach((station, index) => {
    if (typeof station.codeVersion !== 'number') station.codeVersion = 1
    if (station.lifecycle !== '现行' && station.lifecycle !== '已撤' && station.lifecycle !== '已并走') {
      station.lifecycle = '现行'
    }
    if (typeof station.mergedToCode !== 'string') station.mergedToCode = ''
    if (station.sectionCode && !seenLedger.has(station.sectionCode)) {
      seenLedger.add(station.sectionCode)
      payload.codeEvents.push({
        id: `cev_import_${station.id}_${index}`,
        sectionCode: station.sectionCode,
        codeVersion: station.codeVersion,
        lifecycle: station.lifecycle,
        eventType: '指派',
        stationId: station.id,
        stationName: station.name,
        river: station.river,
        catchmentKm2: station.catchmentKm2,
        mergedToCode: station.mergedToCode,
        reason: '旧备份导入：按现存测站补建编号台账',
        occurredAt: new Date(station.createdAt ?? now).toISOString(),
        createdAt: now,
        updatedAt: now
      })
    }
  })

  const codeIndex = buildCodeIndex(buildLedgerViews(payload.codeEvents))
  payload.sections.forEach((section) => {
    if (typeof section.refCode !== 'string') section.refCode = ''
    const hasVersion = typeof section.refVersion === 'number'
    if (!hasVersion) section.refVersion = null
    const validStatus: RefStatus[] = ['对账中', '悬空', '待认领']
    if (!validStatus.includes(section.refStatus)) section.refStatus = '对账中'
    if (typeof section.refNote !== 'string') section.refNote = ''
    if (typeof section.reported !== 'boolean') section.reported = false
    if (typeof section.reportedFlowM3s !== 'number') section.reportedFlowM3s = null
    if (typeof section.reportedAt !== 'string') section.reportedAt = null
    if (!hasVersion) {
      const patch = migrateLegacyRef(
        {
          stationId: section.stationId,
          refCode: section.refCode,
          refVersion: null,
          refStatus: section.refStatus,
          refNote: section.refNote
        },
        payload.stations,
        codeIndex
      )
      Object.assign(section, patch)
    }
  })
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    ratings: payload.ratings.length,
    compares: payload.compares.length,
    codeEvents: payload.codeEvents.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.codeEvents],
    async () => {
      await db.stations.bulkPut(payload.stations)
      await db.sections.bulkPut(payload.sections)
      await db.verticals.bulkPut(payload.verticals)
      await db.points.bulkPut(payload.points)
      await db.ratings.bulkPut(payload.ratings)
      await db.compares.bulkPut(payload.compares)
      await db.codeEvents.bulkPut(payload.codeEvents)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return { ...section, id, stationId: stationMap.get(section.stationId) ?? section.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => ({
    ...point,
    id: createId('pnt'),
    verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
  }))
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return { ...rating, id, stationId: stationMap.get(rating.stationId) ?? rating.stationId }
  })
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId
  }))
  // 编号台账事件也重排主键；事件内的 stationId 跟随映射，编号文本（sectionCode）保持不动
  const codeEvents = payload.codeEvents.map((event) => ({
    ...event,
    id: createId('cev'),
    stationId: stationMap.get(event.stationId) ?? event.stationId
  }))
  return { ...payload, stations, sections, verticals, points, ratings, compares, codeEvents }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、定线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const latest = sections.reduce<number | null>((acc, section) => {
      if (acc === null) return section.stageM
      return section.stageM > acc ? section.stageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const lines = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lines.map((lineNo) => {
      const fit = fits.find((item) => item.lineNo === lineNo)
      if (!fit || !fit.valid) return `${lineNo} 线未定线`
      return `${lineNo} 线 Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
