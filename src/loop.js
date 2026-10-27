/**
 * dsh-orchestrator-loop — the engine.
 *
 * Pure domain logic over the ledger: no tools, no host services. Every exported
 * operation mutates the ledger in place and returns a plain payload the tool
 * layer renders. Persistence is the caller's job (saveLedger after success).
 */

import { join } from 'node:path'
import {
  AUDIT_EXEMPT_DIRS,
  DEFAULTS,
  LoopError,
  SUBDIRS,
  asArray,
  deriveSummary,
  dirExists,
  ensureDir,
  extractArtifacts,
  fileExists,
  isInside,
  minutesBetween,
  newLoopId,
  nowIso,
  parseSections,
  parseTaskMarker,
  readJson,
  relativeTo,
  resolveArtifact,
  resolveHome,
  scanTree,
  storePaths,
  toPosix,
  uniqueStrings,
  writeJson,
  writeText,
} from './common.js'
import { SETTLED, allTasks, currentRound, findTask, sortByUpdatedDesc, summaryFile, writeSummary } from './store.js'
import {
  digestMarkdown,
  dispatchPrompt,
  finalMarkdown,
  indexMarkdown,
  memoText,
  planContextMarkdown,
  selfInstruction,
  statusBrief,
  statusFull,
  taskLine,
} from './render.js'

/* ---------------------------------------------------------------- errors -- */

/** A user-facing failure: the message is shown verbatim to the model. */
export { LoopError }

const fail = (message) => {
  throw new LoopError(message)
}

/* -------------------------------------------------------------- helpers -- */

/** `<workRoot>/<loopId>` or `<cwd>/.orchestrator-loop/<loopId>`. */
export function loopFolder(config, loop) {
  const root = String(config.workRoot ?? '').trim()
  return root.length > 0 ? join(root, loop.id) : join(loop.cwd, '.orchestrator-loop', loop.id)
}

/**
 * Create (or backfill) the loop folder and its three sub-folders.
 *
 * `strict` is used after a loop already exists: a folder that vanished means the
 * evidence chain is gone, so we refuse instead of silently rebuilding an empty
 * shell that would make every artifact look "missing" without explanation.
 */
export function ensureWorkDir(config, loop, { strict = false, purpose = '继续这个循环' } = {}) {
  if (!loop.workDir || loop.workDir.length === 0) {
    loop.workDir = loopFolder(config, loop)
    loop.workDirCreatedAt = loop.workDirCreatedAt ?? nowIso()
  }
  if (strict && !fileExists(loop.workDir)) {
    fail([
      `工作目录已不存在：${toPosix(loop.workDir)}`,
      `它本该存着这个循环的全部产物与 _index.md。现在${purpose}会把目录重建成空的、让产物核对全部报 missing。`,
      '要么把目录恢复回来（备份/回收站/其它机器），要么重新 loop_start 一个新循环并在 note 里写明旧循环作废。',
    ].join('\n'))
  }
  for (const sub of Object.values(SUBDIRS)) ensureDir(join(loop.workDir, sub))
  loop.workDirs = [loop.workDir, ...Object.values(SUBDIRS).map((sub) => join(loop.workDir, sub))]
  return loop.workDir
}

export function requireLoop(ledger, loopId) {
  const id = String(loopId ?? '').trim()
  if (id.length === 0) fail('缺 loop_id。先 loop_start 拿一个，或用 loop_list 查。')
  const loop = ledger.loops[id]
  if (loop === undefined) fail(`找不到循环 ${id}。用 loop_list 看现有循环。`)
  return loop
}

function touch(loop) {
  loop.updatedAt = nowIso()
  return loop
}

function taskId(round, index) {
  return `t${round}-${index}`
}

/**
 * Highest `t<round>-<n>` ordinal already spent inside one round — live tasks
 * and archived ones alike. Ids are reused verbatim on `replace: true`, so the
 * next plan has to start past this number to keep the id → task mapping unique.
 */
function highestTaskIndex(round, roundNumber) {
  const prefix = `t${roundNumber}-`
  let highest = 0
  for (const task of [...(round?.tasks ?? []), ...(round?.archivedTasks ?? [])]) {
    const id = String(task?.id ?? '')
    if (!id.startsWith(prefix)) continue
    const suffix = Number.parseInt(id.slice(prefix.length), 10)
    if (Number.isFinite(suffix) && suffix > highest) highest = suffix
  }
  return highest
}

/** Same-round dependency validation: unknown id, self-reference, cycles. */
function validateDependencies(tasks) {
  const ids = new Set(tasks.map((task) => task.id))
  const byId = new Map(tasks.map((task) => [task.id, task]))
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (dep === task.id) fail(`${task.id} 依赖了自己。depends_on 只能指向同轮的其它任务。`)
      if (!ids.has(dep)) fail(`${task.id} 依赖的 ${dep} 不存在。depends_on 只限同一轮内的任务 id。`)
      if (byId.get(dep)?.assignee === 'self' && task.assignee !== 'self') {
        // Allowed: a subagent task may wait for a self task. Nothing to reject.
      }
    }
  }
  const state = new Map()
  const visit = (id, trail) => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'open') fail(`depends_on 成环：${[...trail, id].join(' → ')}。`)
    state.set(id, 'open')
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id])
    state.set(id, 'done')
  }
  for (const id of ids) visit(id, [])
}

function dependenciesMet(round, task) {
  if (!task.dependsOn || task.dependsOn.length === 0) return true
  return task.dependsOn.every((dep) => {
    const found = (round.tasks ?? []).find((candidate) => candidate.id === dep)
    return found !== undefined && found.status === 'done'
  })
}

/** The unit the main agent dispatches: subagent_args, or resume_args when reusing an agent. */
export function dispatchUnit(config, loop, round, task, { retry = false } = {}) {
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '派发任务' })
  round.workDir ??= workDir
  const prompt = dispatchPrompt({
    loop,
    round,
    task,
    config,
    workDir,
    digestFile: round.contextFile,
    retry,
  })
  const base = { task_id: task.id, label: task.label, prompt }
  if (task.agentPreset) base.agentPreset = task.agentPreset
  if (config.resumeAgents && task.agentId) {
    return { ...base, resume_args: { target: task.agentId, message: prompt } }
  }
  return {
    ...base,
    subagent_args: {
      description: `[${loop.id} ${task.id}] ${task.label}`,
      prompt,
    },
  }
}

function selfUnit(config, loop, round, task) {
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '派发自办任务' })
  round.workDir ??= workDir
  return {
    task_id: task.id,
    label: task.label,
    assignee: 'self',
    attempt: task.attempt ?? 1,
    instruction: selfInstruction({ loop, round, task, config, workDir, digestFile: round.contextFile }),
    note: '这份由主代理自己做，做完 loop_record（agent_id 留空，回报首行写 TASK）。',
  }
}

/* ----------------------------------------------------------------- audit -- */

/** Compare what the folder holds against what the ledger claims. */
export function auditRound(config, loop, round) {
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '做产物核对' })
  const { files, overflow } = scanTree(workDir, config.tidyMaxFiles)
  const present = new Set(files.map((entry) => entry.path))
  const registered = new Set()
  const artifactsMissing = []
  const outsideArtifacts = []

  for (const entry of loop.rounds ?? []) {
    // Archived tasks keep their claims: a same-round replan must not turn
    // already-registered files into "unregistered" noise.
    const claims = [...(entry.tasks ?? []), ...(entry.archivedTasks ?? [])]
    for (const task of claims) {
      for (const reported of task.artifacts ?? []) {
        const absolute = resolveArtifact(workDir, reported)
        if (!isInside(workDir, absolute)) {
          outsideArtifacts.push({ task_id: task.id, path: toPosix(absolute) })
          continue
        }
        const rel = relativeTo(workDir, absolute)
        registered.add(rel)
        if (!present.has(rel)) artifactsMissing.push({ task_id: task.id, path: rel })
      }
    }
  }

  const unregisteredOutputs = files
    .map((entry) => entry.path)
    .filter((path) => !registered.has(path))
    .filter((path) => !path.split('/').some((segment) => AUDIT_EXEMPT_DIRS.includes(segment)))
    .filter((path) => !path.startsWith('_'))

  return {
    workDir,
    files,
    overflow,
    artifactsMissing,
    outsideArtifacts,
    unregisteredOutputs,
    strayFiles: unregisteredOutputs,
  }
}

function writeManifest(config, loop, round, audit) {
  const workDir = audit.workDir
  const manifest = {
    loop_id: loop.id,
    round: round.round,
    goal: loop.goal,
    workDir: toPosix(workDir),
    generatedAt: nowIso(),
    files: audit.files,
    tasks: (round.tasks ?? []).map((task) => ({
      id: task.id,
      label: task.label,
      status: task.status,
      assignee: task.assignee ?? 'subagent',
      summary: task.summary ?? '',
      artifacts: task.artifacts ?? [],
      report_file: task.reportFile ?? '',
    })),
    artifacts_missing: audit.artifactsMissing,
    outside_artifacts: audit.outsideArtifacts,
    unregistered_outputs: audit.unregisteredOutputs,
  }
  const file = join(workDir, '_manifest.json')
  writeJson(file, manifest)
  return file
}

/**
 * Rebuild `_index.md` + `_manifest.json` for the loop's current round.
 *
 * R4: `precomputed` lets a caller that just ran `auditRound` on the same round
 * reuse that walk — `collectRound` was scanning the folder twice back to back.
 * `digest` (also R9) folds the round summary into `_index.md` so the collect
 *回执 only has to name the index file instead of pasting the whole digest.
 */
export function tidyLoop(config, ledger, loop, precomputed, digest = '') {
  const round = currentRound(loop)
  if (round === undefined) fail(`循环 ${loop.id} 还没有任务，先 loop_plan。`)
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '重建 _index.md' })
  round.workDir = workDir
  const audit = precomputed ?? auditRound(config, loop, round)
  // The previous tree is read back from the manifest this folder already holds:
  // a full copy inside loops.json cost ~65 KB per tidy and only fed the
  // "new / gone" columns of _index.md.
  const manifestPath = join(workDir, '_manifest.json')
  const previousDoc = readJson(manifestPath, undefined) ?? readJson(join(workDir, '_snapshot.json'), undefined)
  const previous = Array.isArray(previousDoc?.files) ? previousDoc.files : undefined
  const indexFile = join(workDir, '_index.md')
  writeText(indexFile, `${indexMarkdown({ loop, round, files: audit.files, previous, audit, overflow: audit.overflow, digest }).trimEnd()}\n`)
  const manifestFile = writeManifest(config, loop, round, audit)
  round.tidiedAt = nowIso()
  round.indexFile = indexFile
  round.manifestFile = manifestFile
  loop.indexFile = indexFile
  loop.tidyCount = (Number.isFinite(loop.tidyCount) ? loop.tidyCount : 0) + 1
  loop.lastTidyAt = nowIso()
  touch(loop)
  return { audit, indexFile, manifestFile, previous, workDir }
}

/* ------------------------------------------------------------ loop_start -- */

export function startLoop(config, ledger, { goal, note, cwd, agentId }) {
  const text = String(goal ?? '').trim()
  if (text.length === 0) fail('loop_start 需要 goal：一句话写清这轮循环要达成什么。')
  const base = String(cwd ?? '').trim()
  if (base.length === 0) fail('无法确定工作目录：本次调用没有会话 cwd，也没有给 cwd 参数。')
  if (!dirExists(base)) {
    fail(`工作目录不存在：${toPosix(base)}\n产物要落在它下面的 .orchestrator-loop/<loop_id>/，先确认路径（会话可能在被删掉的分支/临时目录里）。`)
  }
  const createdAt = nowIso()
  let id = newLoopId()
  while (ledger.loops[id] !== undefined) id = `${id}x`
  const loop = {
    id,
    goal: text,
    note: String(note ?? '').trim(),
    cwd: toPosix(base),
    workDir: '',
    agentId: agentId ?? '',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    round: 0,
    rounds: [],
    decisions: [],
  }
  ensureWorkDir(config, loop)
  loop.ledgerFile = toPosix(ledger.paths.file)
  ledger.loops[id] = loop
  return {
    loop,
    loop_id: id,
    workdir: toPosix(loop.workDir),
    context_file: '',
    created: ['artifacts', 'reports', 'notes'],
  }
}

/* ------------------------------------------------------------- loop_plan -- */

export function planRound(config, ledger, { loopId, tasks, mode, replace }) {
  const loop = requireLoop(ledger, loopId)
  if (loop.status !== 'active') fail(`循环 ${loop.id} 已 ${loop.status}，不能重开一轮。要续做请 loop_start 新循环。`)
  const incoming = asArray(tasks)
  if (incoming.length === 0) fail('loop_plan 需要 tasks：至少一个 { label, brief }。')

  const PLAN_MODES = ['parallel', 'serial']
  if (mode !== undefined && mode !== null && String(mode).trim().length > 0) {
    const wanted = String(mode).trim()
    if (!PLAN_MODES.includes(wanted)) {
      fail(`mode 只接受 ${PLAN_MODES.join(' / ')}，收到 ${JSON.stringify(mode)}。不传就按 parallel 派。`)
    }
  }

  const isSelf = (entry) => {
    const assignee = String(entry.assignee ?? 'subagent').toLowerCase()
    if (assignee === 'self' || assignee === 'main') return true
    if (assignee === 'subagent' || assignee === '') return false
    fail(`assignee 只接受 'subagent'（默认）、'self'/'main'（主代理自办），收到 ${JSON.stringify(entry.assignee)}。`)
  }

  const selfCount = incoming.filter(isSelf).length
  const subCount = incoming.length - selfCount
  if (subCount > config.maxTasksPerRound) {
    fail(`单轮最多 ${config.maxTasksPerRound} 个子代理任务，这批有 ${subCount} 个。拆成两轮，或把 maxTasksPerRound 调大（上限 32）。`)
  }
  if (selfCount > 0 && config.maxSelfTasksPerRound === 0) {
    fail('自办已关：maxSelfTasksPerRound 是 0。去掉 assignee: \'self\'，或把该键调到 1~32。')
  }
  if (selfCount > config.maxSelfTasksPerRound) {
    fail(`单轮最多 ${config.maxSelfTasksPerRound} 个自办任务，这批有 ${selfCount} 个。其余改成子代理任务（它们占 maxTasksPerRound）。`)
  }

  const rebuilding = replace === true && currentRound(loop) !== undefined
  const roundNumber = rebuilding ? loop.round : loop.round + 1
  let round = rebuilding ? currentRound(loop) : undefined
  // Ids are positional (`tN-1`, `tN-2`, …), so a re-plan would hand the retired
  // tasks' ids straight to the new ones — and a late report carrying an old id
  // would then be filed against a brand-new task, silently. Keep numbering past
  // every id this round has ever used, archived ones included.
  const idOffset = rebuilding ? highestTaskIndex(round, roundNumber) : 0

  const normalized = incoming.map((entry, index) => {
    const label = String(entry.label ?? '').trim()
    const brief = String(entry.brief ?? '').trim()
    if (label.length === 0) fail(`第 ${index + 1} 个任务缺 label。`)
    if (brief.length === 0) fail(`任务「${label}」缺 brief：写清要产出什么、落到哪。`)
    return {
      id: taskId(roundNumber, idOffset + index + 1),
      label,
      brief,
      agentPreset: String(entry.agent_preset ?? entry.agentPreset ?? '').trim(),
      assignee: isSelf(entry) ? 'self' : 'subagent',
      dependsOn: uniqueStrings(asArray(entry.depends_on ?? entry.dependsOn)),
      status: 'pending',
      agentId: '',
      summary: '',
      lastSummary: '',
      artifacts: [],
      attempt: 1,
      attempts: [],
      retryNote: '',
      createdAt: nowIso(),
      reportedAt: '',
      report: '',
      reportFullChars: 0,
      reportFile: '',
      history: [],
    }
  })
  validateDependencies(normalized)

  if (rebuilding) {
    round.archivedTasks = [...(round.archivedTasks ?? []), ...(round.tasks ?? [])]
    round.tasks = normalized
    round.replannedAt = nowIso()
    round.createdAt = round.createdAt ?? nowIso()
  } else {
    round = {
      round: roundNumber,
      mode: String(mode ?? 'parallel'),
      createdAt: nowIso(),
      contextMode: config.contextMode,
      workDir: '',
      tasks: normalized,
      decisions: [],
    }
    loop.rounds.push(round)
    loop.round = roundNumber
  }

  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '开新一轮' })
  round.workDir = workDir
  // Pre-dispatch context: one summaries file per round, a capped memo for the
  // prompts, and the tail that points subagents at the file for details.
  const paths = ledger?.paths ?? storePaths(resolveHome())
  // R3: the memo is a door-knocker, not the briefing — 400 chars keep the
  // prompts small while the full picture stays in the context file just below.
  const memoFull = memoText(loop, roundNumber, Number.MAX_SAFE_INTEGER)
  const memo = memoFull.length > 400 ? `${memoFull.slice(0, 400)}…（上下文已截断，全文见下方文件）` : memoFull
  round.contextFile = toPosix(writeSummary(paths, loop.id, roundNumber, planContextMarkdown(loop, round)))
  round.context = `${memo}\n\n完整上下文文件：${round.contextFile}（需要细节时用 read 工具读取它，不要索取全文粘贴）`.trim()

  const dispatches = []
  const selfTasks = []
  const waiting = []
  const released = []

  for (const task of round.tasks) {
    if (!dependenciesMet(round, task)) {
      task.status = 'waiting'
      task.waitingOn = (task.dependsOn ?? []).filter((dep) => {
        const found = round.tasks.find((candidate) => candidate.id === dep)
        return found === undefined || found.status !== 'done'
      })
      waiting.push({ task_id: task.id, waiting_on: task.waitingOn })
      continue
    }
    task.status = 'dispatched'
    task.releasedAt = nowIso()
    if (task.assignee === 'self') selfTasks.push(selfUnit(config, loop, round, task))
    else dispatches.push(dispatchUnit(config, loop, round, task))
    released.push(task.id)
  }

  // Failures left over from earlier rounds that nobody settled.
  const unsettledFailures = allTasks(loop)
    .filter((task) => !round.tasks.includes(task))
    .filter((task) => task.status === 'failed' || task.status === 'blocked')
    .map((task) => ({ task_id: task.id, label: task.label, status: task.status, attempt: task.attempt }))

  touch(loop)
  return {
    loop,
    loop_id: loop.id,
    round: roundNumber,
    mode: round.mode,
    workdir: toPosix(workDir),
    dispatches,
    self_tasks: selfTasks,
    waiting,
    released,
    unsettled_failures: unsettledFailures,
    context_file: toPosix(round.contextFile ?? ''),
    dispatcher_rule: dispatches.length > 0
      ? [
          `这条消息只发这 ${dispatches.length} 个调用，然后停。`,
          '不要自己读文件、跑命令或顺手看一眼；回报会作为消息回来。',
          selfTasks.length > 0 ? `发完之后立刻动手做 self_tasks 里那 ${selfTasks.length} 份，照 instruction 的章节模板。` : '',
        ].filter(Boolean)
      : [],
  }
}

/* ----------------------------------------------------------- loop_record -- */

function writeReportFile(config, loop, round, task, report) {
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '写回报原文' })
  const file = join(workDir, SUBDIRS.reports, `${task.id}_a${task.attempt}.md`)
  writeText(file, report)
  task.reportFile = file
  return file
}

function settleTask(config, loop, round, task, entry, released) {
  const report = String(entry.report ?? '').trim()
  const status = String(entry.status ?? 'done').trim()
  if (!['done', 'failed', 'blocked'].includes(status)) {
    fail(`status 只接受 done / failed / blocked，收到 ${JSON.stringify(entry.status)}。`)
  }

  const previousSnapshot = {
    attempt: task.attempt,
    status: task.status,
    summary: task.summary ?? '',
    // Only the length survives: the full text already sits in
    // reports/<task>_a<attempt>.md, and copying it here made one task cost
    // taskHistoryKeep × reportKeepChars inside loops.json.
    reportChars: (task.report ?? '').length,
    reportFullChars: task.reportFullChars ?? 0,
    artifacts: [...(task.artifacts ?? [])],
    reportedAt: task.reportedAt ?? '',
  }
  const hadReport = (task.report ?? '').length > 0 || (task.status !== 'dispatched' && task.status !== 'pending')

  const fallbackSummary = String(entry.summary ?? '').trim()
  const summary = fallbackSummary.length > 0 ? fallbackSummary : deriveSummary(report, task.label)
  const sections = parseSections(report)
  const reportChars = report.length
  const thin = reportChars > 0 && reportChars < config.minReportChars

  if (hadReport) {
    task.history = [...(task.history ?? []), previousSnapshot].slice(-Math.max(1, config.taskHistoryKeep))
  }

  task.lastSummary = task.summary && task.summary.length > 0 ? task.summary : task.lastSummary ?? ''
  task.summary = summary
  task.status = status
  task.reportedAt = nowIso()
  task.agentId = String(entry.agent_id ?? entry.agentId ?? task.agentId ?? '').trim()
  task.reportFullChars = reportChars
  // R1: the ledger keeps a preview only — the full report is always the
  // `reports/<task>_a<n>.md` file next door. The suffix is load-bearing: without
  // it a later reader (or the model re-reading the ledger) cannot tell a short
  // report from a clipped one.
  const keepChars = Math.max(0, config.reportKeepChars)
  task.report = reportChars > keepChars
    ? `${report.slice(0, keepChars).trimEnd()}…（预览已截断，全文 ${reportChars} 字，见 reportFile）`
    : report.slice(0, keepChars)
  if (reportChars > 0) writeReportFile(config, loop, round, task, report)

  const givenArtifacts = uniqueStrings(asArray(entry.artifacts))
  task.artifacts = givenArtifacts.length > 0 ? givenArtifacts : extractArtifacts(report)
  task.evidence = uniqueStrings(asArray(entry.evidence))
  task.commands = uniqueStrings(asArray(entry.commands))
  task.attempts = [...(task.attempts ?? []), { attempt: task.attempt, status, at: task.reportedAt, reportChars }]

  // Release dependents whose last prerequisite just landed.
  if (status === 'done') {
    for (const candidate of round.tasks ?? []) {
      if (candidate.status !== 'waiting') continue
      if (!dependenciesMet(round, candidate)) continue
      candidate.status = 'dispatched'
      candidate.releasedAt = nowIso()
      candidate.waitingOn = []
      released.push({
        task_id: candidate.id,
        label: candidate.label,
        waiting_on: [],
        ...(candidate.assignee === 'self'
          ? { self: selfUnit(config, loop, round, candidate) }
          : dispatchUnit(config, loop, round, candidate)),
      })
    }
  }

  return {
    task_id: task.id,
    status,
    summary,
    report_chars: reportChars,
    report_kept_chars: task.report.length,
    report_file: toPosix(task.reportFile ?? ''),
    missing_sections: sections.missing,
    thin,
    artifacts: task.artifacts,
    history: task.history?.length ?? 0,
    assignee: task.assignee ?? 'subagent',
  }
}

/**
 * findTask, but a hit inside `archivedTasks` is refused instead of returned.
 *
 * `loop_plan({ replace: true })` pushes the old tasks into `archivedTasks` and
 * re-issues ids from `tN-1` for the same round number, so an id can name both a
 * retired task and a live one. Writing to a retired task loses the report; the
 * caller gets the archived ids to pick from instead.
 */
function findLiveTask(loop, taskId, where) {
  const found = findTask(loop, taskId)
  if (found === undefined) return undefined
  if (found.archived === true) {
    const siblings = (found.round.archivedTasks ?? []).map((task) => task.id)
    fail(
      `tasks ${taskId} 已被 replace:true 归档（第 ${found.round.round} 轮），不能再${where}。`
      + `归档里的旧任务：${siblings.length > 0 ? siblings.join('、') : '（空）'}。`
      + '要登记旧任务请用现役 id；要找回旧任务就用 loop_status(full:true) 读它的历史，'
      + '或让子代理按当前轮的任务重发。',
    )
  }
  return found
}

/**
 * Which task a report belongs to.
 *
 * Two inputs can name it — `task_id` and a `TASK: <id>` marker — and they do
 * different jobs: `task_id` is authoritative, the marker is the fallback for a
 * verbatim subagent transcript. When both are present they must agree; a
 * mismatch used to be resolved silently in favour of one of them, which filed
 * the report against a task the caller never meant.
 */
function resolveRecordTarget(loop, round, entry) {
  const explicit = String(entry.task_id ?? entry.taskId ?? '').trim()
  const textMarker = parseTaskMarker(entry.text)
  const reportMarker = parseTaskMarker(entry.report)
  // `text` locates the task, `report` supplies the body. If the two markers
  // disagree, the old code took the `text` one and filed the `report` body
  // against it — the report landed on a task nobody named.
  if (textMarker !== undefined && reportMarker !== undefined && textMarker !== reportMarker) {
    fail(
      `同一条回报里两个 TASK 首行互相矛盾：text 说 TASK: ${textMarker}，report 说 TASK: ${reportMarker}。`
      + 'text 用来定任务、report 用来定正文，两者必须指同一条。'
      + `只留一个标记再登一次（推荐删掉 text 的 TASK 首行、只留 report 的 TASK: ${reportMarker}），`
      + `或显式传 task_id=${reportMarker} 覆盖标记。`,
    )
  }
  const marker = textMarker ?? reportMarker
  if (explicit.length > 0 && marker !== undefined && marker !== explicit) {
    fail(
      `task_id 与正文里的 TASK 标记冲突：task_id=${explicit}，正文首行是 TASK: ${marker}。`
      + '以哪个为准都不要猜——把这两个改成同一个再登一次：'
      + `要登记 ${explicit} 就删掉正文的 TASK 首行（或改成 TASK: ${explicit}）；要登记 ${marker} 就把 task_id 改成 ${marker}。`,
    )
  }
  if (explicit.length > 0) {
    const found = findLiveTask(loop, explicit, '登记回报')
    if (found === undefined) {
      const live = (round.tasks ?? []).map((task) => task.id)
      fail(
        `台账里没有任务 ${explicit}。本轮现役 id：${live.length > 0 ? live.join(' / ') : '（无）'}。`
        + '先 loop_status({ loop_id, full: true }) 查全部 task_id；'
        + '也可能它已被 replace:true 归档——归档任务不能再登记，按现役 id 重发。',
      )
    }
    return found
  }
  if (marker !== undefined) {
    const found = findLiveTask(loop, marker, '登记回报')
    if (found === undefined) {
      const live = (round.tasks ?? []).map((task) => task.id)
      fail(
        `回报里的 TASK: ${marker} 在本轮找不到。本轮现役 id：${live.length > 0 ? live.join(' / ') : '（无）'}。`
        + '若是上一轮或被 replace:true 归档的 id，把首行改成现役 id 再发，'
        + '或显式传 task_id 指向要登记的那条；查旧 id 用 loop_status({ full: true })。',
      )
    }
    return found
  }
  // Last resort: the only outstanding task of the current round.
  const outstanding = (round.tasks ?? []).filter((task) => !SETTLED.has(task.status))
  if (outstanding.length === 1) return { task: outstanding[0], round }
  const open = outstanding.length === 0
    ? '本轮没有未登记的任务'
    : `本轮有 ${outstanding.length} 个未登记任务（${outstanding.map((task) => task.id).join('、')}）`
  fail(`${open}，而这段回报既没有 task_id 也没有 \`TASK: <task_id>\` 首行，无法对号入座。补一个 task_id，或让子智能体按模板重发。`)
}

export function recordReports(config, ledger, input) {
  const loop = requireLoop(ledger, input.loopId)
  if (loop.status !== 'active') fail(`循环 ${loop.id} 已 ${loop.status}，不能再登记回报。`)
  const round = currentRound(loop)
  if (round === undefined) fail(`循环 ${loop.id} 还没有派过任务，先 loop_plan。`)

  const batch = asArray(input.reports)
  const entries = batch.length > 0
    ? batch.map((entry) => ({
        ...entry,
        loop_id: loop.id,
        text: entry.text ?? entry.report,
      }))
    : [{
        loop_id: loop.id,
        task_id: input.taskId,
        text: input.text,
        status: input.status,
        summary: input.summary,
        report: input.report,
        evidence: input.evidence,
        commands: input.commands,
        artifacts: input.artifacts,
        agent_id: input.agentId,
      }]

  const released = []
  const records = []
  for (const entry of entries) {
    // Body source, in order: `report` (the report itself) then `text` (a
    // verbatim transcript already located by its TASK marker). The task is
    // chosen by `resolveRecordTarget` from `task_id` first, markers second —
    // so the body always belongs to the task that was located.
    const report = String(entry.report ?? entry.text ?? '').trim()
    if (report.length === 0) {
      fail(
        'loop_record 缺少可登记的正文：给 report（六节原文）或 text（首行 TASK: <task_id> 的整段回报）。'
        + '两者都没有 `TASK: <task_id>` 首行时，还必须显式给 task_id——'
        + '本轮有多个未登记任务时不会替你猜。',
      )
    }
    const target = resolveRecordTarget(loop, round, entry)
    if (target.round !== round) {
      // Registering into an older round is legitimate (late report); just use its round.
      if (target.round.tasks === undefined) {
        fail(
          `台账里任务 ${target.task.id} 所在第 ${target.round.round} 轮没有 tasks 数组（结构损坏，多为旧版本台账写出）。`
          + '先 loop_status({ loop_id, full: true }) 把现场抄下来备份，再 loop_tidy 重刷索引；'
          + '若仍坏，把这条回报登到现役任务，旧台账用 loop_prune 归档。',
        )
      }
    }
    records.push(settleTask(config, loop, target.round, target.task, { ...entry, report }, released))
  }

  const missing = uniqueStrings(records.flatMap((record) => record.missing_sections))
  const anyThin = records.some((record) => record.thin)
  const chars = records.reduce((sum, record) => sum + record.report_chars, 0)
  touch(loop)

  return {
    loop,
    loop_id: loop.id,
    count: records.length,
    records,
    report_chars: chars,
    missing_sections: missing,
    thin: anyThin,
    released,
    prompts_rule: released.length > 0 ? 'released 里的派发单元照发（subagent_args 走 subagent，resume_args 走 send_message）。' : '',
  }
}

/* ---------------------------------------------------------- loop_collect -- */

export function collectRound(config, ledger, loopId) {
  const loop = requireLoop(ledger, loopId)
  const round = currentRound(loop)
  if (round === undefined) fail(`循环 ${loop.id} 还没有派过任务，先 loop_plan。`)

  const tasks = round.tasks ?? []
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    dispatched: tasks.filter((task) => task.status === 'dispatched').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    waiting: tasks.filter((task) => task.status === 'waiting').length,
  }
  const pendingIds = tasks.filter((task) => !SETTLED.has(task.status)).map((task) => task.id)
  const settled = pendingIds.length === 0
  const now = Date.now()
  const staleIds = tasks
    .filter((task) => !SETTLED.has(task.status))
    .filter((task) => {
      const since = Date.parse(task.releasedAt ?? task.createdAt ?? '')
      if (!Number.isFinite(since)) return false
      return (now - since) / 60000 >= config.staleMinutes
    })
    .map((task) => task.id)

  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '收本轮回报' })
  round.workDir = workDir
  // R11: one digest, computed once — it used to be rendered a second time for
  // the return value, which doubled the per-task report slicing.
  const digest = digestMarkdown(loop, round, loop.rounds.length, config.reportKeepChars)
  const digestFile = writeSummary(ledger.paths, loop.id, round.round, digest)
  round.digestFile = digestFile
  if (settled && round.collectedAt === undefined) round.collectedAt = nowIso()
  if (!settled) round.collectedAt = undefined

  // R4: audit once, hand the tree to tidy when the round just settled. tidy
  // used to re-walk the whole folder right after this scan.
  const audit = auditRound(config, loop, round)
  let index = { audit, indexFile: round.indexFile ?? '', manifestFile: round.manifestFile ?? '' }
  if (settled) index = tidyLoop(config, ledger, loop, audit, digest)

  const elapsed = minutesBetween(round.createdAt, round.collectedAt)
  const budgetWarning = config.budgetMinutes > 0 && elapsed > config.budgetMinutes
    ? `本轮已耗时 ${elapsed} 分钟，超过 budgetMinutes=${config.budgetMinutes}。`
    : ''

  touch(loop)
  return {
    loop,
    loop_id: loop.id,
    round: round.round,
    complete: settled,
    counts,
    pending_ids: pendingIds,
    stale_ids: staleIds,
    digest,
    digest_file: toPosix(digestFile),
    // R9: the receipt gets one line per task; the full digest is on disk.
    task_lines: tasks.map((task) => taskLine(task)),
    artifacts_missing: index.audit.artifactsMissing,
    stray_files: index.audit.strayFiles,
    unregistered_outputs: index.audit.unregisteredOutputs,
    outside_artifacts: index.audit.outsideArtifacts,
    index_file: toPosix(index.indexFile ?? ''),
    elapsed_minutes: elapsed,
    budget_warning: budgetWarning,
  }
}

/* ----------------------------------------------------------- loop_choose -- */

function nextQuestionId(loop, round) {
  const count = (loop.decisions ?? []).filter((entry) => entry.round === round.round).length
  return `q${round.round}-${count + 1}`
}

/** Register the question (and its options) ahead of asking the user. */
export function prepareQuestion(config, ledger, { loopId, question, options }) {
  const loop = requireLoop(ledger, loopId)
  const round = currentRound(loop)
  if (round === undefined) fail(`循环 ${loop.id} 还没有任务，先 loop_plan。`)
  const text = String(question ?? '').trim()
  if (text.length === 0) {
    fail(
      'loop_choose 少了 question：卡片上要显示的那一句话没给，用户看到的就是一张空白卡。'
      + '改用 loop_choose({ loop_id, question: \'下一步先做哪个？\', options: [...] }) 重调一次；'
      + '这句话要写成「让用户在什么之间选」，不是「要不要继续」。',
    )
  }
  const list = asArray(options).map((entry) => ({
    label: String(entry?.label ?? '').trim(),
    description: String(entry?.description ?? '').trim(),
  })).filter((entry) => entry.label.length > 0)
  if (list.length < 2) {
    fail(
      `loop_choose 至少要 2 个选项，这次只收到 ${list.length} 个有效 label——一个选项的卡片等于替用户做决定。`
      + '补到 2~8 个，第一个放你推荐的那条（label 用动词开头，description 一句话说清选它会怎样）。',
    )
  }
  if (list.length > 8) {
    fail(`loop_choose 最多 8 个选项，这次收到 ${list.length} 个。把相近的合并，或先只留这轮真要决策的 8 条以内。`)
  }

  tidyLoop(config, ledger, loop)
  const questionId = nextQuestionId(loop, round)
  const decision = {
    round: round.round,
    question: text,
    questionId,
    options: list,
    selected: [],
    custom: '',
    state: 'pending',
    at: nowIso(),
  }
  loop.decisions = [...(loop.decisions ?? []), decision]
  touch(loop)
  return {
    loop,
    loop_id: loop.id,
    question_id: questionId,
    request: {
      questions: [{
        id: questionId,
        question: text,
        header: `第 ${round.round} 轮完成，下一步？`,
        options: list,
      }],
    },
    decision,
  }
}

/** Record the user's choice (either from the card or supplied directly). */
export function applySelection(ledger, { loopId, selection, custom, questionId }) {
  const loop = requireLoop(ledger, loopId)
  const decisions = loop.decisions ?? []
  // Two pending questions used to be resolved by "most recent unanswered", so a
  // click on the older card landed on the newer question. With more than one
  // open question the caller must say which one it means.
  const open = decisions.filter((entry) => entry.state !== 'answered')
  const scoped = questionId === undefined
    ? open
    : open.filter((entry) => entry.questionId === questionId)
  if (open.length > 1 && questionId === undefined) {
    fail(
      `这个循环有 ${open.length} 个待答问题（${open.map((entry) => entry.questionId).join('、')}），`
      + '不指定 question_id 就不知道该记到哪个上。把 question_id 一起传进来（就是 loop_choose 回执里的那个）。',
    )
  }
  const pending = [...scoped].reverse()[0]
  if (pending === undefined) {
    const known = decisions.map((entry) => entry.questionId)
    fail(
      questionId !== undefined
        ? `没有待答的 ${questionId}。已有的问题：${known.length > 0 ? known.join('、') : '（无）'}；可能已经答过了，用 loop_status 看。`
        : `循环 ${loop.id} 现在没有待答的问题，selection 无处可记。先 loop_choose 提问并弹卡片，等用户答完再回来登记；`
          + '已经答过就不用再登记——直接 loop_plan 派下一轮。',
    )
  }
  const chosen = uniqueStrings(asArray(selection))
  const labels = (pending.options ?? []).map((option) => option.label)
  for (const value of chosen) {
    if (!labels.includes(value)) {
      fail(`选项 ${JSON.stringify(value)} 不在这次的问题里。可选：${labels.join(' / ')}`)
    }
  }
  // Three states, spelled out (they used to be one fuzzy "selection 为空"):
  //   [labels] — picked these options;
  //   []       — answered, picked zero options, so custom text carries the answer;
  //   null     — answered, explicitly not via options, so custom text carries it;
  //   undefined— not answering this way at all (no selection argument passed).
  // The last two states differ only in what the caller chose to say, so the
  // failure message has to name the one that is actually missing.
  const customText = String(custom ?? '').trim()
  if (chosen.length === 0 && customText.length === 0) {
    const state = selection === null
      ? 'selection 传了 null（明确不用选项作答）'
      : Array.isArray(selection)
        ? 'selection 是空数组 []（一个选项都没选）'
        : '既没传 selection 也没传 custom'
    fail(
      `${state}，又没有 custom 文本——这样登记不了任何决定。`
      + `下一次登记必须二选一：① 传 selection: [选项 label]（可选：${labels.join(' / ')}）；`
      + '② 传 custom: \'用户的原话\'。'
      + '只想把这题挂起不动，就别调 loop_choose；想推到下一轮就直接 loop_plan。',
    )
  }
  pending.selected = chosen
  pending.custom = customText
  pending.state = 'answered'
  pending.answeredAt = nowIso()
  touch(loop)
  return { loop, loop_id: loop.id, decision: pending, answered: true, question_id: pending.questionId }
}

/* ------------------------------------------------------------- loop_retry -- */

export function retryTasks(config, ledger, { loopId, taskIds, reason }) {
  const loop = requireLoop(ledger, loopId)
  if (loop.status !== 'active') {
    fail(
      `循环 ${loop.id} 已 ${loop.status}，不能返工。`
      + '要续做请 loop_start 开新循环（旧台账可用 loop_prune 归档）；'
      + '只想改结论就 loop_record 重登一次；只想看进度用 loop_status。',
    )
  }
  const ids = uniqueStrings(asArray(taskIds))
  if (ids.length === 0) fail('loop_retry 需要 task_ids：写清要重开哪个任务。')
  const dispatches = []
  const selfTasks = []
  const exhausted = []

  for (const id of ids) {
    const found = findLiveTask(loop, id, '返工')
    if (found === undefined) {
      const live = allTasks(loop).filter((task) => task.status !== 'done').map((task) => task.id)
      fail(
        `台账里没有任务 ${id}。可返工的现役 id：${live.length > 0 ? live.join(' / ') : '（无，都已 done 或未派发）'}。`
        + '先 loop_status({ loop_id, full: true }) 查现有 task_id；'
        + '也可能是它已被 replace:true 归档——归档任务不能返工，按现役 id 重派或用 loop_plan 重新派。',
      )
    }
    const { task, round } = found
    if (task.status === 'done') fail(`${id} 已经 done，不用返工。要改结论就 loop_record 重登一次。`)
    const maxAttempts = Math.max(1, config.maxRetries) + 1
    if (task.attempt >= maxAttempts) {
      exhausted.push({ task_id: task.id, label: task.label, attempts: task.attempt, max_attempts: maxAttempts })
      continue
    }
    task.attempt += 1
    task.status = 'dispatched'
    task.retryNote = String(reason ?? '').trim()
    task.releasedAt = nowIso()
    task.lastSummary = task.summary ?? task.lastSummary ?? ''
    task.summary = ''
    if (task.assignee === 'self') selfTasks.push(selfUnit(config, loop, round, task))
    else dispatches.push(dispatchUnit(config, loop, round, task, { retry: true }))
  }

  touch(loop)
  return {
    loop,
    loop_id: loop.id,
    dispatches,
    self_tasks: selfTasks,
    exhausted,
    reason: String(reason ?? '').trim(),
  }
}

/* ------------------------------------------------------------ loop_finish -- */

export function finishLoop(config, ledger, { loopId, outcome, summary }) {
  const loop = requireLoop(ledger, loopId)
  if (loop.status !== 'active') fail(`循环 ${loop.id} 已经 ${loop.status}。`)
  const round = currentRound(loop)
  if (round !== undefined) {
    const outstanding = (round.tasks ?? []).filter((task) => !SETTLED.has(task.status))
    if (outstanding.length > 0) {
      fail(`还有 ${outstanding.length} 个任务没登记（${outstanding.map((task) => task.id).join('、')}）。先 loop_collect 看齐，或把它们登记成 failed/blocked 再收尾。`)
    }
  }
  const audit = round === undefined
    ? { audit: { files: [], artifactsMissing: [], outsideArtifacts: [], unregisteredOutputs: [] } }
    : tidyLoop(config, ledger, loop)

  loop.status = 'closed'
  loop.outcome = String(outcome ?? 'done')
  loop.finalSummary = String(summary ?? '').trim()
  loop.closedAt = nowIso()
  loop.ledgerFile = toPosix(ledger.paths.file)
  const workDir = ensureWorkDir(config, loop, { strict: true, purpose: '收尾写 _final.md' })
  const finalFile = join(workDir, '_final.md')
  writeText(finalFile, `${finalMarkdown({ loop, audit: audit.audit }).trimEnd()}\n`)
  const indexFile = join(workDir, '_index.md')
  const finalIndex = join(workDir, '_index.final.md')
  if (fileExists(indexFile)) writeText(finalIndex, `${indexMarkdown({
    loop,
    round: round ?? { round: 0, tasks: [] },
    files: audit.audit.files ?? [],
    previous: undefined,
    audit: audit.audit,
    overflow: audit.audit.overflow,
  }).trimEnd()}\n`)
  loop.finalFile = finalFile
  loop.finalIndex = finalIndex
  loop.finalIndexFile = finalIndex
  touch(loop)
  return {
    loop,
    loop_id: loop.id,
    outcome: loop.outcome,
    final_file: toPosix(finalFile),
    final_index: toPosix(finalIndex),
    workdir: toPosix(workDir),
    unregistered_outputs: audit.audit.unregisteredOutputs ?? [],
    outside_artifacts: audit.audit.outsideArtifacts ?? [],
  }
}

/* -------------------------------------------------- status / list / prune -- */

export function statusOf(ledger, { loopId, brief, full }) {
  if (loopId !== undefined && String(loopId).trim().length > 0) {
    const loop = requireLoop(ledger, loopId)
    // Three separate states, spelled out: brief wins when asked for, otherwise
    // an explicit full:true gives the long form, otherwise — and this is the
    // documented default — brief. `brief:false` used to mean full, which made
    // an omitted argument and a "no" argument behave differently.
    if (brief === true) return { loop, text: statusBrief(loop), view: 'brief' }
    if (full === true) return { loop, text: statusFull(loop), view: 'full' }
    return { loop, text: statusBrief(loop), view: 'brief' }
  }
  const loops = sortByUpdatedDesc(Object.values(ledger.loops))
  if (loops.length === 0) return { loop: undefined, text: '还没有任何循环。用 loop_start 开一个。' }
  return { loop: loops[0], text: statusBrief(loops[0]), view: 'brief' }
}

export const LOOP_STATUSES = ['active', 'closed']

export function listLoops(ledger, { status }) {
  let loops = Object.values(ledger.loops)
  const wanted = String(status ?? '').trim()
  if (wanted.length > 0) {
    if (!LOOP_STATUSES.includes(wanted)) {
      fail(`status 只接受 ${LOOP_STATUSES.join(' / ')}，收到 ${JSON.stringify(wanted)}。要列全部循环就别传 status。`)
    }
    loops = loops.filter((loop) => loop.status === wanted)
  }
  return { loops: sortByUpdatedDesc(loops), total: loops.length }
}

export function pruneLedger(config, ledger, { keep, dryRun }) {
  if (keep !== undefined && keep !== null && String(keep).trim().length > 0) {
    const parsed = Number(keep)
    if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed || parsed < 0) {
      fail(`keep 要是 ≥ 0 的整数，收到 ${JSON.stringify(keep)}。想清空已收尾循环就写 keep: 0。`)
    }
  }
  // keep: 0 is a legitimate "drop every closed loop" request and used to be
  // silently rounded up to 1, which kept one loop the caller asked to delete.
  const max = keep === undefined || keep === null || String(keep).trim().length === 0
    ? 50
    : Math.trunc(Number(keep))
  const loops = Object.values(ledger.loops)
  const closed = sortByUpdatedDesc(loops.filter((loop) => loop.status === 'closed'))
  const doomed = closed.slice(max)
  const ids = doomed.map((loop) => loop.id)
  // Deleting the ledger entry leaves the folder and its summaries behind, so
  // report the disk paths too — the operator decides, we never unlink evidence.
  const orphanWorkDirs = uniqueStrings(doomed.map((loop) => String(loop.workDir ?? '').trim()).filter((dir) => dir.length > 0))
  const orphanSummaries = []
  for (const loop of doomed) {
    for (const round of loop.rounds ?? []) {
      const file = String(round.contextFile ?? '').trim()
      if (file.length > 0) orphanSummaries.push(file)
      else orphanSummaries.push(toPosix(summaryFile(ledger.paths, loop.id, round.round)))
    }
  }
  if (dryRun !== true) for (const id of ids) delete ledger.loops[id]
  return {
    total: loops.length,
    closed: closed.length,
    kept: loops.length - ids.length,
    removed: dryRun === true ? [] : ids,
    would_remove: ids,
    orphan_work_dirs: orphanWorkDirs,
    orphan_summaries: uniqueStrings(orphanSummaries),
    dry_run: dryRun === true,
    keep: max,
  }
}

/* ------------------------------------------------------------- misc glue -- */

export const CONFIG_DEFAULTS = DEFAULTS
