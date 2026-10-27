/**
 * dsh-orchestrator-loop — ledger persistence.
 *
 * One JSON document under ~/.dsh/plugins/orchestrator-loop/ holds every loop
 * (`loops.json`). `status.json` is a cheap projection the UI can read without
 * parsing the whole ledger; `summaries/` holds the per-round digest files.
 */

import { join } from 'node:path'
import {
  LoopError,
  VERSION,
  backupFile,
  ensureDir,
  fileExists,
  nowIso,
  readJsonStrict,
  storePaths,
  writeJson,
  writeJsonIfChanged,
  writeText,
} from './common.js'

const EMPTY_LEDGER = () => ({ version: 1, createdAt: nowIso(), updatedAt: nowIso(), loops: {} })

/**
 * Load the ledger.
 *
 * A missing file is a fresh start; a file that exists but cannot be parsed is
 * NOT — treating it as empty would silently erase every loop on the next save.
 * Damage is copied aside once (`loops.json.corrupt-<ts>`), then reported so the
 * caller refuses to write.
 */
export function loadLedger(home) {
  const paths = storePaths(home)
  const read = readJsonStrict(paths.file)

  if (read.status === 'missing') return { ...EMPTY_LEDGER(), paths }

  if (read.status === 'corrupt') {
    const backup = fileExists(paths.file) ? backupFile(paths.file, 'corrupt') : ''
    throw new LoopError([
      `台账损坏，已拒绝读写以免覆盖历史：${paths.file}`,
      `原因：${read.error}`,
      backup.length > 0 ? `原文已备份到：${backup}` : '',
      '修好或挪走该文件后重试；确认要放弃历史时，手工把它删除再重新 loop_start。',
    ].filter((line) => line.length > 0).join('\n'))
  }

  const raw = read.value
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const backup = backupFile(paths.file, 'corrupt')
    throw new LoopError(`台账结构不对（顶层不是对象），已拒绝读写以免覆盖历史：${paths.file}\n原文已备份到：${backup}`)
  }
  const loops = raw.loops && typeof raw.loops === 'object' && !Array.isArray(raw.loops) ? raw.loops : {}
  return {
    version: 1,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    loops,
    paths,
  }
}

/**
 * Drop keys the current version no longer writes.
 *
 * Old ledgers carry `loop.manifest` (a full tree copy nothing ever read) and
 * `round.fileSnapshot`/`round.memo`; the tree now lives in `_manifest.json` on
 * disk, and the memo is folded into `round.context` at write time — so they are
 * removed on the next write instead of being shipped forward forever.
 */
export function pruneLegacyFields(loop) {
  let dropped = 0
  if (Object.hasOwn(loop, 'manifest')) {
    delete loop.manifest
    dropped += 1
  }
  for (const round of loop.rounds ?? []) {
    for (const key of ['fileSnapshot', 'memo']) {
      if (Object.hasOwn(round, key)) {
        delete round[key]
        dropped += 1
      }
    }
    for (const task of [...(round.tasks ?? []), ...(round.archivedTasks ?? [])]) {
      for (const entry of task.history ?? []) {
        if (Object.hasOwn(entry, 'report')) {
          delete entry.report
          dropped += 1
        }
      }
    }
  }
  return dropped
}

/** Persist the ledger plus the status projection. */
export function saveLedger(ledger) {
  const paths = ledger.paths ?? storePaths()
  ensureDir(paths.dir)
  for (const loop of Object.values(ledger.loops ?? {})) pruneLegacyFields(loop)
  ledger.updatedAt = nowIso()
  writeJson(paths.file, {
    version: 1,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    loops: ledger.loops,
  })
  // R7: loops.json always changes (updatedAt), status.json usually does not.
  writeJsonIfChanged(paths.status, buildStatus(ledger))
  return ledger
}

/** Cheap per-loop projection: round, task tally, decision tally, timestamps. */
export function buildStatus(ledger) {
  const entries = sortByUpdatedDesc(Object.values(ledger.loops ?? {}))
  return {
    version: VERSION,
    storeFile: (ledger.paths ?? storePaths()).file,
    updatedAt: ledger.updatedAt ?? nowIso(),
    loopCount: entries.length,
    loops: entries.map((loop) => {
      const tasks = allTasks(loop)
      const settled = tasks.filter((task) => SETTLED.has(task.status)).length
      return {
        id: loop.id,
        goal: loop.goal,
        status: loop.status,
        round: loop.round ?? 0,
        tasks: tasks.length,
        settled,
        decisions: Array.isArray(loop.decisions) ? loop.decisions.length : 0,
        updatedAt: loop.updatedAt,
      }
    }),
  }
}

export const SETTLED = new Set(['done', 'failed', 'blocked'])

/** Newest first by updatedAt — the single ordering every listing shares. */
export function sortByUpdatedDesc(list) {
  return list.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

/** Every task across every round, flattened. */
export function allTasks(loop) {
  const out = []
  for (const round of loop?.rounds ?? []) {
    for (const task of round.tasks ?? []) out.push(task)
  }
  return out
}

/** Tasks of the most recent round. */
export function currentRound(loop) {
  const rounds = loop?.rounds ?? []
  return rounds.length > 0 ? rounds[rounds.length - 1] : undefined
}

/**
 * Look a task id up. Live tasks win; a hit inside `round.archivedTasks` comes
 * back flagged `archived: true`.
 *
 * The flag matters because `loop_plan({ replace: true })` retires the current
 * tasks into `archivedTasks` while the round number — and therefore the
 * `tN-1…` id space — stays the same. Before this, a report carrying a retired
 * id resolved to nothing and either failed loudly or, when the new plan reused
 * the id, silently overwrote the wrong task. Callers must not write to an
 * archived hit; they should report the candidates instead.
 */
export function findTask(loop, taskId) {
  const id = String(taskId ?? '').trim()
  if (id.length === 0) return undefined
  for (const round of loop?.rounds ?? []) {
    for (const task of round.tasks ?? []) {
      if (task.id === id) return { task, round }
    }
  }
  for (const round of loop?.rounds ?? []) {
    for (const task of round.archivedTasks ?? []) {
      if (task.id === id) return { task, round, archived: true }
    }
  }
  return undefined
}

export function summaryFile(paths, loopId, round) {
  return join(paths.summaries, `_loop_${loopId}_r${round}_context.md`)
}

/** Write one round digest file; returns its absolute path. */
export function writeSummary(paths, loopId, round, text) {
  ensureDir(paths.summaries)
  const file = summaryFile(paths, loopId, round)
  writeText(file, `${text.trimEnd()}\n`)
  return file
}
