/**
 * dsh-orchestrator-loop — text renderers.
 *
 * Everything the model reads: dispatch prompts, self-task instructions, the
 * per-round digest, `_index.md`, `_final.md`, and the two status views. Pure
 * string building — no IO, no state mutation.
 */

import {
  SECTIONS,
  bulletList,
  formatBytes,
  minutesBetween,
  toPosix,
} from './common.js'
import { SETTLED } from './store.js'

const SECTION_TEMPLATE = SECTIONS.map((section) => `### ${section}`).join('\n')

/** Task artifacts as a clean string list; absent or malformed means empty. */
function taskArtifacts(task) {
  return Array.isArray(task.artifacts) ? task.artifacts.filter(Boolean) : []
}

/** One line describing a task's outcome, used by memos and digests. */
export function taskLine(task) {
  const label = task.label ?? task.id
  const summary = (task.summary ?? task.lastSummary ?? '').trim()
  const head = `- [${task.status}] ${label}（${task.id}）：${summary.length > 0 ? summary : '（无结论）'}`
  const artifacts = taskArtifacts(task)
  if (artifacts.length === 0) return head
  return `${head}\n  位置：${artifacts.join('、')}`
}

/** User's most recent answered decision, as one readable line. */
export function lastChoice(loop) {
  const answered = (loop.decisions ?? []).filter((entry) => entry.state === 'answered')
  if (answered.length === 0) return ''
  const latest = answered[answered.length - 1]
  const chosen = Array.isArray(latest.selected) && latest.selected.length > 0
    ? latest.selected.join('、')
    : (latest.custom ?? '').trim()
  if (chosen.length === 0) return ''
  return `用户上次选择（第 ${latest.round} 轮）：${chosen}`
}

/** Cap one summary to `limit` characters, marking the cut. */
function clip(text, limit) {
  const value = String(text ?? '').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 8))}…(已截断)`
}

/**
 * The compact memo carried into every dispatch prompt: the user's last choice
 * plus one line per task from the previous three rounds, hard-capped at
 * `limit` characters (the historical 0.5.1 cap is 1200).
 */
export function memoText(loop, beforeRound, limit = 1200) {
  const lines = []
  const answered = (loop.decisions ?? []).filter((entry) => entry.state === 'answered')
  const latest = answered.length > 0 ? answered[answered.length - 1] : undefined
  if (latest !== undefined) {
    const chosen = Array.isArray(latest.selected) && latest.selected.length > 0
      ? latest.selected.join(' / ')
      : (latest.custom ?? '').trim()
    if (chosen.length > 0) lines.push(`用户在第 ${latest.round} 轮之后的选择：${chosen}`)
  }
  const rounds = (loop.rounds ?? []).filter((entry) => entry.round < beforeRound).slice(-3)
  for (const entry of rounds) {
    const tasks = entry.tasks ?? []
    const settledCount = tasks.filter((task) => SETTLED.has(task.status)).length
    lines.push(`第 ${entry.round} 轮（${settledCount}/${tasks.length} 已登记）：`)
    for (const task of tasks) {
      const head = `- [${task.status}] ${task.label ?? task.id}（${task.id}）：${clip(task.summary ?? task.lastSummary, 300) || '（无结论）'}`
      const artifacts = taskArtifacts(task)
      lines.push(artifacts.length === 0 ? head : `${head}｜产物：${artifacts.join(' , ')}`)
    }
  }
  const text = lines.join('\n').trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

/**
 * The pre-dispatch context file written to `summaries/` before a round is
 * handed out. Deliberately plainer than the memo: no task ids, no artifact
 * lists — the round headings and one line per task.
 */
export function planContextMarkdown(loop, round) {
  const lines = []
  lines.push(`# 循环 ${loop.id} · 第 ${round.round} 轮派发前的完整上下文`)
  lines.push(`循环：${loop.id} · 轮次：${round.round} · 生成于 ${new Date().toISOString()}`)
  lines.push('')
  const answered = (loop.decisions ?? []).filter((entry) => entry.state === 'answered')
  const latest = answered.length > 0 ? answered[answered.length - 1] : undefined
  if (latest !== undefined) {
    const chosen = Array.isArray(latest.selected) && latest.selected.length > 0
      ? latest.selected.join(' / ')
      : (latest.custom ?? '').trim()
    if (chosen.length > 0) lines.push(`用户在第 ${latest.round} 轮之后的选择：${chosen}`)
    const asked = String(latest.question ?? '').trim()
    if (asked.length > 0) lines.push(`当时问的是：${asked}`)
  }
  const rounds = (loop.rounds ?? []).filter((entry) => entry.round < round.round).slice(-3)
  for (const entry of rounds) {
    lines.push(`第 ${entry.round} 轮结果：`)
    for (const task of entry.tasks ?? []) {
      const summary = clip(task.summary ?? task.lastSummary, 300)
      lines.push(`- [${task.status}] ${task.label ?? task.id}：${summary || '（无结论）'}`)
    }
  }
  return lines.join('\n')
}

/**
 * Context block handed to subagents. `memo` stays small on purpose: the last
 * choice, one line per task from the previous three rounds, artifact paths, and
 * where the full digest lives.
 */
export function contextBlock(loop, round, digestFile) {
  const prepared = String(round?.context ?? '').trim()
  if (prepared.length > 0) return prepared
  const lines = []
  const choice = lastChoice(loop)
  if (choice.length > 0) lines.push(choice)

  const rounds = (loop.rounds ?? []).filter((entry) => entry.round < round.round).slice(-3)
  if (rounds.length > 0) {
    lines.push('', '最近轮次（每任务一行）：')
    for (const entry of rounds) {
      lines.push(`第 ${entry.round} 轮：`)
      for (const task of entry.tasks ?? []) lines.push(taskLine(task))
    }
  } else {
    lines.push('', '这是第一轮，没有历史回报。')
  }

  if (digestFile) lines.push('', `上下文文件（需要细节自己 read）：${toPosix(digestFile)}`)
  if (loop.note) lines.push('', `验收标准：${loop.note}`)
  return lines.join('\n').trim()
}

/** The full dispatch prompt for one subagent task. */
export function dispatchPrompt({ loop, round, task, config, workDir, digestFile, retry }) {
  const sections = []

  sections.push(`# 循环 ${loop.id} · 第 ${round.round} 轮`)
  sections.push(`## 工作目录\n\n${toPosix(workDir)}\n\n产物一律写进 \`artifacts/\`，过程记录写进 \`notes/\`，回报副本写进 \`reports/\`。回报里的产物用相对该目录的路径。`)
  sections.push(`## 循环目标\n\n${loop.goal}`)

  const context = contextBlock(loop, round, digestFile)
  if (context.length > 0) sections.push(`## 上下文\n\n${context}`)

  const attemptNote = retry
    ? `\n\n这是第 ${task.attempt} 次派发。上一版结论：${(task.lastSummary ?? '（无）').trim()}\n重试说明：${(task.retryNote ?? '（未给出）').trim()}`
    : ''

  sections.push(`## 任务 TASK: ${task.id}\n\n标签：${task.label}\n\n${task.brief}${attemptNote}`)

  sections.push(`## 回报要求\n\n回报必须按下面六节写全，一节不删；正文不少于 ${config.minReportChars} 字。第一行就写 \`TASK: ${task.id}\`，这样主代理可以整段入账。\n\n\`\`\`text\nTASK: ${task.id}\n${SECTION_TEMPLATE}\n\`\`\`\n\n「产物」节写落地文件的相对路径；「证据」节写命令输出、行号、URL；「未决问题」没有就写「无」。`)

  if (task.dependsOn?.length) {
    sections.push(`## 前置\n\n本任务依赖：${task.dependsOn.join('、')}（已满足后才派给你）。`)
  }

  sections.push(`## 硬规定\n\n这条消息只发这 1 个调用，然后停：不要读别的文件、不要顺手做别的任务。做完按上面模板回报。`)

  return sections.join('\n\n')
}

/** The instruction the MAIN agent follows for an `assignee: 'self'` task. */
export function selfInstruction({ loop, round, task, config, workDir, digestFile }) {
  const sections = []
  sections.push(`# 自办任务 TASK: ${task.id}（第 ${round.round} 轮）`)
  sections.push(`## 工作目录\n\n${toPosix(workDir)}`)
  sections.push(`## 循环目标\n\n${loop.goal}`)
  const context = contextBlock(loop, round, digestFile)
  if (context.length > 0) sections.push(`## 上下文\n\n${context}`)
  sections.push(`## 要做什么\n\n${task.label}\n\n${task.brief}`)
  sections.push(`## 回报要求\n\n这份由你自己做，但回报标准与子代理相同：六节写全，正文不少于 ${config.minReportChars} 字。做完立刻 \`loop_record\`：给 \`task_id: '${task.id}'\`、\`status: 'done'\`、\`summary\`、\`report\`、\`evidence\`、\`commands\`，\`agent_id\` 留空，回报首行写 \`TASK: ${task.id}\`。\n\n\`\`\`text\nTASK: ${task.id}\n${SECTION_TEMPLATE}\n\`\`\``)
  sections.push('## 三条收尾动作\n\n1. 产物落到 `artifacts/`（相对路径写进「产物」节）。\n2. `loop_record` 登记，别让 `loop_collect` 一直显示没集齐。\n3. 做这件事的时候不接别的活；做完再看子代理回来的消息。')
  return sections.join('\n\n')
}

/** One task's block inside the per-round digest file. */
function digestTaskBlock(task, reportChars = 2000) {
  const lines = []
  const summary = (task.summary ?? task.lastSummary ?? '').trim()
  lines.push(`- [${task.status}] ${task.label ?? task.id}（${task.id}）：`)
  lines.push(`  ${summary.length > 0 ? summary : '（无结论）'}`)
  const artifacts = taskArtifacts(task)
  if (artifacts.length > 0) lines.push(`  附件/位置：${artifacts.join(' , ')}`)
  const evidence = Array.isArray(task.evidence) ? task.evidence.filter(Boolean) : []
  if (evidence.length > 0) lines.push(`  证据 ${evidence.length} 条：${evidence.join(' | ')}`)
  const report = String(task.report ?? '').trim()
  if (report.length > 0) {
    lines.push(`  详细回报（节选 ${reportChars} 字，全文见汇总文件）：`)
    for (const line of report.slice(0, reportChars).split('\n')) lines.push(line)
  }
  return lines.join('\n')
}

/** The per-round digest written to `summaries/`. */
export function digestMarkdown(loop, round, totalRounds, reportChars = 2000) {
  const tasks = round.tasks ?? []
  const settled = tasks.filter((task) => SETTLED.has(task.status))
  const lines = []
  lines.push(`# 循环 ${loop.id} · 第 ${round.round} 轮回报全文`)
  lines.push('')
  lines.push(`循环：${loop.id} · 轮次：${round.round} · 生成于 ${new Date().toISOString()}`)
  lines.push('')
  lines.push(`# 第 ${round.round} 轮回报汇总（${settled.length}/${tasks.length} 已登记）`)
  lines.push('')
  for (const task of tasks) lines.push(digestTaskBlock(task, reportChars))
  const previous = (loop.rounds ?? []).filter((entry) => entry.round < round.round)
  if (previous.length > 0) {
    lines.push('')
    lines.push('## 前序轮次（每任务一行）')
    for (const entry of previous.slice(-3)) {
      lines.push(`第 ${entry.round} 轮结果：`)
      for (const task of entry.tasks ?? []) lines.push(taskLine(task))
    }
  }
  if (totalRounds !== undefined) {
    lines.push('')
    lines.push(`总轮次：${totalRounds}`)
  }
  return lines.join('\n')
}

function fileTree(files) {
  if (!files || files.length === 0) return '- （空）'
  return files.map((entry) => `- \`${entry.path}\` · ${formatBytes(entry.size)}`).join('\n')
}

/** `_index.md` — the round's file tree plus audit sections. */
export function indexMarkdown({ loop, round, files, previous, audit, overflow, digest = '' }) {
  const lines = []
  lines.push(`# 循环 ${loop.id} · 任务索引`)
  lines.push('')
  lines.push(`- 目标：${loop.goal}`)
  lines.push(`- 工作目录：${toPosix(round.workDir ?? '')}`)
  lines.push(`- 当前轮次：第 ${round.round} 轮（${round.mode ?? 'parallel'}）`)
  lines.push(`- 生成于：${new Date().toISOString()}`)
  lines.push('')
  lines.push('## 各轮进度')
  lines.push('')
  for (const entry of loop.rounds ?? []) {
    const tasks = entry.tasks ?? []
    const settled = tasks.filter((task) => SETTLED.has(task.status)).length
    const elapsed = minutesBetween(entry.createdAt, entry.collectedAt)
    lines.push(`- 第 ${entry.round} 轮 · ${settled}/${tasks.length} 已登记${elapsed > 0 ? ` · 耗时 ${elapsed} 分钟` : ''}`)
    for (const task of tasks) lines.push(`  ${taskLine(task).replace(/^- /, '- ')}`)
  }
  lines.push('')
  lines.push('## 文件树')
  lines.push('')
  lines.push(fileTree(files))
  if (overflow) lines.push('', '> 文件数超过 `tidyMaxFiles`，本节已截断。')

  lines.push('')
  lines.push('## 新增 / 更新 / 消失')
  lines.push('')
  if (!previous) {
    lines.push('- 首次整理，无对比基线。')
  } else {
    const before = new Map(previous.map((entry) => [entry.path, entry]))
    const after = new Map((files ?? []).map((entry) => [entry.path, entry]))
    const added = [...after.keys()].filter((key) => !before.has(key))
    const removed = [...before.keys()].filter((key) => !after.has(key))
    const updated = [...after.entries()]
      .filter(([key, entry]) => before.has(key) && (before.get(key).size !== entry.size || before.get(key).mtime !== entry.mtime))
      .map(([key]) => key)
    lines.push(`- 新增 ${added.length}：${added.length > 0 ? added.join('、') : '无'}`)
    lines.push(`- 更新 ${updated.length}：${updated.length > 0 ? updated.join('、') : '无'}`)
    lines.push(`- 消失 ${removed.length}：${removed.length > 0 ? removed.join('、') : '无'}`)
  }

  lines.push('')
  lines.push('## 产物核对')
  lines.push('')
  const claimed = (round.tasks ?? []).flatMap((task) => (task.artifacts ?? []).map((artifact) => ({ task, artifact })))
  if (claimed.length === 0) {
    lines.push('- 本轮没有登记产物。')
  } else {
    for (const entry of claimed) {
      const missing = (audit.artifactsMissing ?? []).some((item) => item.task_id === entry.task.id && item.path === entry.artifact)
      lines.push(`- [${missing ? '✗' : '✓'}] ${entry.task.id} · ${entry.artifact}`)
    }
  }
  if ((audit.outsideArtifacts ?? []).length > 0) {
    lines.push('')
    lines.push('越过任务文件夹的产物：')
    for (const item of audit.outsideArtifacts) lines.push(`- ${item.task_id} · ${item.path}`)
  }
  if ((audit.unregisteredOutputs ?? []).length > 0) {
    lines.push('')
    lines.push('未入账文件（目录里有、台账没人登记，`reports/` `notes/` 与隐藏文件不算）：')
    for (const path of audit.unregisteredOutputs) lines.push(`- ${path}`)
  }
  // R9: the round digest normally lives in its own summaries/ file; carrying a
  // copy here gives loop_collect a single durable place to point the model at.
  if (digest.trim().length > 0) {
    lines.push('')
    lines.push('## 本轮汇总')
    lines.push('')
    lines.push(digest.trim())
  }
  return lines.join('\n')
}

/** `_final.md` — the transferable deliverable written by loop_finish. */
export function finalMarkdown({ loop, audit }) {
  const lines = []
  lines.push(`# 循环 ${loop.id} · 交付`)
  lines.push('')
  lines.push(`- 目标：${loop.goal}`)
  if (loop.note) lines.push(`- 验收标准：${loop.note}`)
  lines.push(`- 结果：${loop.outcome ?? 'done'}`)
  lines.push(`- 轮次：${loop.rounds?.length ?? 0}`)
  lines.push(`- 工作目录：${toPosix(loop.workDir ?? '')}`)
  lines.push(`- 收尾时间：${loop.closedAt ?? new Date().toISOString()}`)
  if (loop.finalSummary) {
    lines.push('')
    lines.push('## 结论')
    lines.push('')
    lines.push(loop.finalSummary)
  }

  lines.push('')
  lines.push('## 各轮一览')
  lines.push('')
  for (const round of loop.rounds ?? []) {
    const tasks = round.tasks ?? []
    const settled = tasks.filter((task) => SETTLED.has(task.status)).length
    const elapsed = minutesBetween(round.createdAt, round.collectedAt)
    lines.push(`### 第 ${round.round} 轮 · ${settled}/${tasks.length} 已登记${elapsed > 0 ? ` · ${elapsed} 分钟` : ''}`)
    lines.push('')
    for (const task of tasks) lines.push(taskLine(task))
    lines.push('')
  }

  lines.push('## 产物清单')
  lines.push('')
  const artifacts = []
  for (const round of loop.rounds ?? []) {
    for (const task of round.tasks ?? []) {
      for (const artifact of task.artifacts ?? []) artifacts.push(`${task.id} · \`${artifact}\``)
    }
  }
  lines.push(bulletList(artifacts, '本轮没有登记产物。'))

  lines.push('')
  lines.push('## 未决问题')
  lines.push('')
  const open = []
  for (const round of loop.rounds ?? []) {
    for (const task of round.tasks ?? []) {
      if (task.status === 'failed' || task.status === 'blocked') open.push(`${task.id}（${task.label}）${task.status}：${(task.summary ?? '').trim() || '无结论'}`)
    }
  }
  lines.push(bulletList(open, '无。'))

  lines.push('')
  lines.push('## 未入账产物')
  lines.push('')
  const strays = []
  if ((audit.unregisteredOutputs ?? []).length > 0) for (const path of audit.unregisteredOutputs) strays.push(`目录未登记：${path}`)
  if ((audit.outsideArtifacts ?? []).length > 0) for (const item of audit.outsideArtifacts) strays.push(`跳出工作目录：${item.task_id} · ${item.path}`)
  if ((audit.artifactsMissing ?? []).length > 0) for (const item of audit.artifactsMissing) strays.push(`声称未落盘：${item.task_id} · ${item.path}`)
  lines.push(bulletList(strays, '无。'))

  lines.push('')
  lines.push('## 路径索引')
  lines.push('')
  lines.push(`- 任务文件夹：${toPosix(loop.workDir ?? '')}`)
  lines.push(`- 索引：${toPosix(`${loop.workDir ?? ''}/_index.md`)}`)
  lines.push(`- 索引快照：${toPosix(`${loop.workDir ?? ''}/_index.final.md`)}`)
  lines.push(`- 清单：${toPosix(`${loop.workDir ?? ''}/_manifest.json`)}`)
  lines.push(`- 台账：${toPosix(loop.ledgerFile ?? '')}`)
  return lines.join('\n')
}

/** `loop_status` brief: one line per round. */
export function statusBrief(loop) {
  const lines = []
  const tasks = (loop.rounds ?? []).flatMap((round) => round.tasks ?? [])
  const settled = tasks.filter((task) => SETTLED.has(task.status)).length
  lines.push(`循环 ${loop.id} · ${loop.status} · 第 ${loop.round ?? 0} 轮 · 任务 ${settled}/${tasks.length} 已登记`)
  lines.push(`目标：${loop.goal}`)
  if (loop.workDir) lines.push(`工作目录：${toPosix(loop.workDir)}`)
  lines.push('')
  for (const round of loop.rounds ?? []) {
    const items = round.tasks ?? []
    const done = items.filter((task) => SETTLED.has(task.status)).length
    const list = items.map((task) => `${task.id} ${task.status}${task.assignee === 'self' ? ' · 自办' : ''}`).join(' | ')
    const elapsed = minutesBetween(round.createdAt, round.collectedAt)
    lines.push(`第 ${round.round} 轮 · ${round.mode ?? 'parallel'} · ${done}/${items.length} 已登记${elapsed > 0 ? ` · ${elapsed} 分钟` : ''} · ${list}`)
  }
  return lines.join('\n')
}

/** `loop_status` full: every task with its artifacts and history depth. */
export function statusFull(loop) {
  const lines = [statusBrief(loop)]
  for (const round of loop.rounds ?? []) {
    lines.push('')
    lines.push(`## 第 ${round.round} 轮（${round.mode ?? 'parallel'}）`)
    if (round.contextFile) lines.push(`- 上下文文件：${toPosix(round.contextFile)}`)
    if (round.digestFile) lines.push(`- 摘要文件：${toPosix(round.digestFile)}`)
    if (round.indexFile) lines.push(`- 索引：${toPosix(round.indexFile)}`)
    for (const task of round.tasks ?? []) {
      lines.push('')
      lines.push(`### ${task.id} · ${task.label} · ${task.status}${task.assignee === 'self' ? ' · 自办' : ''}`)
      lines.push(`- 派发：${task.brief}`)
      if (task.agentId) lines.push(`- agent：${task.agentId}`)
      if (task.dependsOn?.length) lines.push(`- 前置：${task.dependsOn.join('、')}`)
      if (task.attempt > 1) lines.push(`- 第 ${task.attempt} 次派发`)
      if (Array.isArray(task.history) && task.history.length > 0) lines.push(`- 历史 ${task.history.length} 版`)
      if (task.summary) lines.push(`- 结论：${task.summary}`)
      if (task.artifacts?.length) lines.push(`- 产物：${task.artifacts.join('、')}`)
      if (task.reportFile) lines.push(`- 回报全文：${toPosix(task.reportFile)}`)
      if (task.report) {
        // R8: a full-status dump repeats every report in every round, so each
        // task shows a 300-char head and points at the file instead of pasting.
        const head = task.report.slice(0, 300)
        const clipped = task.report.length > 300
          ? `${head}…（已截断，全文见 ${toPosix(task.reportFile ?? 'reportFile')}）`
          : head
        lines.push('', '```text', clipped, '```')
      }
    }
  }
  if ((loop.decisions ?? []).length > 0) {
    lines.push('')
    lines.push('## 决策记录')
    for (const decision of loop.decisions) {
      const chosen = decision.state === 'answered'
        ? (decision.selected?.length ? decision.selected.join('、') : decision.custom ?? '')
        : '（未答）'
      lines.push(`- 第 ${decision.round} 轮 · ${decision.questionId} · ${decision.question} → ${chosen}`)
    }
  }
  return lines.join('\n')
}

/** `loop_list` table. */
export function listTable(loops) {
  if (loops.length === 0) return '没有符合条件的循环。'
  const lines = ['| 循环 | 状态 | 轮次 | 任务 | 目标 | 更新 |', '| --- | --- | --- | --- | --- | --- |']
  for (const loop of loops) {
    const tasks = (loop.rounds ?? []).flatMap((round) => round.tasks ?? [])
    const settled = tasks.filter((task) => SETTLED.has(task.status)).length
    const goal = String(loop.goal ?? '').replaceAll('|', '\\|')
    lines.push(`| ${loop.id} | ${loop.status} | ${loop.round ?? 0} | ${settled}/${tasks.length} | ${goal.length > 40 ? `${goal.slice(0, 40)}…` : goal} | ${loop.updatedAt ?? ''} |`)
  }
  return lines.join('\n')
}
