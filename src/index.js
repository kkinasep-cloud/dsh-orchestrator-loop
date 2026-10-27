/**
 * dsh-orchestrator-loop — the tool surface.
 *
 * Eleven `loop_*` tools over the ledger engine in `loop.js`. Every tool loads
 * the ledger, runs one engine operation, and persists the result. Engine
 * failures (`LoopError`) come back as a `⚠️ …` text so the model can read the
 * reason instead of crashing the turn; nothing is written in that case.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULTS, SECTIONS, clampInt, resolveHome, storePaths, toPosix } from './common.js'
import { SETTLED, loadLedger, saveLedger } from './store.js'
import {
  LoopError,
  applySelection,
  collectRound,
  finishLoop,
  listLoops,
  planRound,
  prepareQuestion,
  pruneLedger,
  recordReports,
  requireLoop,
  retryTasks,
  startLoop,
  statusOf,
  tidyLoop,
  LOOP_STATUSES,
} from './loop.js'
import { listTable } from './render.js'

/* ------------------------------------------------------------- metadata -- */

const name = 'orchestrator-loop'
const inject = ['tools']

const CONTEXT_MODES = ['memo', 'full']
const TASK_STATUSES = [...SETTLED]

/* --------------------------------------------------------------- config -- */

/** Levenshtein distance, capped — enough to spot `maxTaskPerRound` → `maxTasksPerRound`. */
function editDistance(a, b) {
  const left = [...a.toLowerCase()]
  const right = [...b.toLowerCase()]
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/** Closest known config key, if the typo is close enough to be worth naming. */
function suggestConfigKey(key) {
  const known = Object.keys(DEFAULTS)
  const lower = key.toLowerCase()
  const exact = known.find((name) => name.toLowerCase() === lower)
  if (exact !== undefined) return exact
  let best
  let bestScore = Number.POSITIVE_INFINITY
  for (const name of known) {
    const score = editDistance(lower, name.toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = name
    }
  }
  const limit = Math.max(2, Math.floor(key.length / 3))
  return bestScore <= limit ? best : undefined
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = String(input.contextMode ?? DEFAULTS.contextMode)
  const warnings = []
  // No Config schema is exported (cordis then passes config through verbatim),
  // so a typo would otherwise fall back to the default silently and look like a
  // config that "did not take". Report unknown keys instead of hiding them.
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(DEFAULTS, key)) continue
    const guess = suggestConfigKey(key)
    warnings.push(guess === undefined
      ? `未知配置键 \`${key}\`，已忽略（可用键：${Object.keys(DEFAULTS).join(' / ')}）`
      : `配置键 \`${key}\` 拼错了，应为 \`${guess}\`；本次按默认值 ${JSON.stringify(DEFAULTS[guess])} 处理`)
  }
  if (input.contextMode !== undefined && !CONTEXT_MODES.includes(mode)) {
    warnings.push(`contextMode=${JSON.stringify(input.contextMode)} 不认识，只接受 ${CONTEXT_MODES.join(' / ')}；已退回 '${DEFAULTS.contextMode}'`)
  }
  return {
    maxTasksPerRound: clampInt(input.maxTasksPerRound, DEFAULTS.maxTasksPerRound, 1, 32),
    maxSelfTasksPerRound: clampInt(input.maxSelfTasksPerRound, DEFAULTS.maxSelfTasksPerRound, 0, 32),
    reportKeepChars: clampInt(input.reportKeepChars, DEFAULTS.reportKeepChars, 0, 200000),
    taskHistoryKeep: clampInt(input.taskHistoryKeep, DEFAULTS.taskHistoryKeep, 1, 50),
    minReportChars: clampInt(input.minReportChars, DEFAULTS.minReportChars, 0, 100000),
    staleMinutes: clampInt(input.staleMinutes, DEFAULTS.staleMinutes, 1, 100000),
    budgetMinutes: clampInt(input.budgetMinutes, DEFAULTS.budgetMinutes, 0, 100000),
    maxRetries: clampInt(input.maxRetries, DEFAULTS.maxRetries, 0, 20),
    contextMode: CONTEXT_MODES.includes(mode) ? mode : DEFAULTS.contextMode,
    resumeAgents: input.resumeAgents === undefined ? DEFAULTS.resumeAgents : input.resumeAgents !== false,
    workRoot: String(input.workRoot ?? DEFAULTS.workRoot).trim(),
    tidyMaxFiles: clampInt(input.tidyMaxFiles, DEFAULTS.tidyMaxFiles, 10, 100000),
    warnings,
  }
}

/* ---------------------------------------------------------------- utils -- */

/** Fenced JSON block that survives prompts containing their own fences. */
function withPayload(text, payload) {
  if (payload === undefined) return String(text).trimEnd()
  const json = JSON.stringify(payload, null, 2)
  return `${String(text).trimEnd()}\n\n\`\`\`\`json\n${json}\n\`\`\`\``
}

function sessionDirectory(ctx, exec) {
  const directories = ctx.get === undefined ? undefined : ctx.get('workingDirectory')
  const session = exec?.agent?.session
  if (directories !== undefined && session !== undefined) {
    try {
      const current = directories.get(session)
      if (typeof current === 'string' && current.length > 0) return { path: current, fallback: false }
    } catch {
      // Fall through to the process directory.
    }
  }
  return { path: process.cwd(), fallback: true }
}

function callerAgentId(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' ? id : ''
}

/** One line per dispatch unit telling the model which call to make. */
function dispatchLine(unit) {
  if (unit.assignee === 'self' || unit.self !== undefined) {
    return `- \`${unit.task_id}\` ${unit.label} → 自办：照 self_tasks 里的 instruction 做，做完 loop_record`
  }
  if (unit.resume_args !== undefined) {
    return `- \`${unit.task_id}\` ${unit.label} → send_message(target: \`${unit.resume_args.target}\`, message: resume_args.message)`
  }
  return `- \`${unit.task_id}\` ${unit.label} → subagent(subagent_args)`
}

function dispatchSection(dispatches) {
  if (dispatches.length === 0) return []
  const lines = ['## 派发单元（原样取 JSON 里的参数）']
  for (const unit of dispatches) lines.push(dispatchLine(unit))
  return lines
}

function selfSection(selfTasks) {
  if (selfTasks.length === 0) return []
  const lines = ['## 自办任务（你自己做）']
  for (const unit of selfTasks) {
    lines.push(`- \`${unit.task_id}\` ${unit.label} → 照下方 JSON 里该单元的 instruction 做，做完立刻 loop_record`)
  }
  return lines
}

function waitingSection(waiting) {
  if (waiting.length === 0) return []
  const lines = ['## 等前置（本轮不派）']
  for (const entry of waiting) lines.push(`- \`${entry.task_id}\` 等 ${entry.waiting_on.join('、')} 先落地`)
  return lines
}

function auditLines(audit) {
  const lines = []
  const missing = audit.artifacts_missing ?? []
  const stray = audit.unregistered_outputs ?? audit.stray_files ?? []
  const outside = audit.outside_artifacts ?? []
  if (missing.length > 0) {
    lines.push(`- 产物缺文件 ${missing.length} 个：${missing.map((entry) => `${entry.task_id}:${entry.path}`).join('、')}`)
  }
  if (stray.length > 0) {
    lines.push(`- 未入账文件 ${stray.length} 个：${stray.slice(0, 12).join('、')}${stray.length > 12 ? ' …' : ''}（补登记或挪进 reports//notes/）`)
  }
  if (outside.length > 0) {
    lines.push(`- 落在工作目录外的产物 ${outside.length} 个：${outside.map((entry) => `${entry.task_id}:${entry.path}`).join('、')}`)
  }
  if (lines.length === 0) lines.push('- 产物核对：全部入账，没有杂散文件')
  return lines
}

/* --------------------------------------------------------- tool factory -- */

/**
 * Build the executor wrapper for one plugin instance.
 *
 * `build` receives `{args, exec, config, ledger}` and returns `{text, payload}`
 * or throws. The ledger is loaded before and saved after a successful run; a
 * `LoopError` is reported as text and leaves the ledger untouched.
 *
 * Read-only tools pass `{write:false}`: they still load the ledger, but they do
 * not save it — otherwise every `loop_status` would bump `updatedAt` and rewrite
 * `status.json` for nothing (and make the file look modified to any watcher).
 */
function makeRunner(pluginConfig) {
  return (build, options = {}) => async (args, exec) => {
    const config = pluginConfig
    let ledger
    try {
      ledger = loadLedger(resolveHome())
      const output = await build({ args, exec, config, ledger })
      const write = typeof options.write === 'function' ? options.write(args, output) : options.write !== false
      if (write) saveLedger(ledger)
      const warnings = [...(config.warnings ?? []), ...(output.warnings ?? [])]
      const text = warnings.length === 0
        ? output.text
        : `${output.text}\n\n## ⚠️ 配置告警\n${warnings.map((line) => `- ${line}`).join('\n')}`
      return withPayload(text, output.payload)
    } catch (error) {
      if (error instanceof LoopError) return `⚠️ ${error.message}`
      throw error
    }
  }
}

/* -------------------------------------------------------------- schemas -- */

const taskSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true, description: '任务短名（一到两行内能看懂）' },
    brief: { type: 'string', required: true, description: '要产出什么、落到哪；写清验收口径' },
    assignee: { type: 'string', description: "'subagent'（默认）或 'self'/'main'（主代理自办）" },
    depends_on: {
      type: 'array',
      description: '同轮内必须先完成的任务 id；跨轮依赖不支持',
      items: { type: 'string' },
    },
    agent_preset: { type: 'string', description: '给子代理指定的 agent preset（可省略）' },
  },
}

const reportSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '整段回报原文（首行 `TASK: <task_id>`）' },
    task_id: { type: 'string', description: '回报对应的 task_id' },
    status: { type: 'string', enum: TASK_STATUSES, description: 'done / failed / blocked，默认 done' },
    summary: { type: 'string', description: '一句话结论（不写则自动从「结论」节提取）' },
    report: { type: 'string', description: '与 text 等价，保留兼容' },
    evidence: { type: 'array', items: { type: 'string' }, description: '证据行（命令输出、行号、URL）' },
    commands: { type: 'array', items: { type: 'string' }, description: '跑过的关键命令' },
    artifacts: { type: 'array', items: { type: 'string' }, description: '相对工作目录的产物路径' },
    agent_id: { type: 'string', description: '子代理 id（自办留空）' },
  },
}

const optionSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true, description: '选项文字，动词开头' },
    description: { type: 'string', description: '一句话说明这条选了会发生什么' },
  },
}

const sectionHint = `回报六节：${SECTIONS.join(' / ')}`

/* ----------------------------------------------------------------- apply -- */

function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const run = makeRunner(config)
  // The ledger path depends on the resolved home directory, so printing a fixed
  // `~/.dsh/...` string in the tool description lied on every non-default host.
  const ledgerFile = toPosix(storePaths(resolveHome()).file)

  ctx.tools.register(defineTool({
    name: 'loop_start',
    description: `开一个编排循环并建工作目录（artifacts/ reports/ notes/）。之后每轮：loop_plan 派任务 → 子代理回报 → loop_record 登记 → loop_collect 收齐 → loop_choose 给用户点选。台账落在 ${ledgerFile}（由 resolveHome 决定，随宿主配置变化）。${sectionHint}。`,
    parameters: {
      goal: { type: 'string', required: true, description: '一句话写清这个循环要达成什么' },
      note: { type: 'string', description: '验收标准/约束，会带给每个子代理' },
      cwd: { type: 'string', description: '工作目录基准（默认取会话 cwd）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, exec, config: cfg, ledger }) => {
      const picked = String(args.cwd ?? '').trim().length > 0
        ? { path: String(args.cwd).trim(), fallback: false, explicit: true }
        : { ...sessionDirectory(ctx, exec), explicit: false }
      const cwd = picked.path
      const result = startLoop(cfg, ledger, {
        goal: args.goal,
        note: args.note,
        cwd,
        agentId: callerAgentId(exec),
      })
      const lines = [
        `已开循环 \`${result.loop_id}\``,
        '',
        `目标：${result.loop.goal}`,
        `工作目录：${result.workdir}（已建 artifacts/ reports/ notes/）`,
        picked.fallback
          ? `cwd 来源：会话 cwd 取不到，**回落到了进程 cwd** \`${cwd}\`——如果这不是你要的工作区，把 cwd 显式传给 loop_start。`
          : picked.explicit
            ? 'cwd 来源：本次调用显式传入的 cwd。'
            : 'cwd 来源：会话当前工作目录。',
        `台账：${result.loop.ledgerFile}`,
        '',
        `下一步：loop_plan 派第 1 轮（单轮最多 ${cfg.maxTasksPerRound} 个子代理任务、${cfg.maxSelfTasksPerRound} 个自办）。`,
      ]
      return { text: lines.join('\n'), payload: { loop_id: result.loop_id, workdir: result.workdir, ledger_file: result.loop.ledgerFile } }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_plan',
    description: `派新一轮任务。返回 dispatches（subagent_args / resume_args，原样传参）、self_tasks（主代理自办）、waiting（等前置）。**派完就停**：这条消息只发返回的这几个调用，不要自己读文件或顺手做别的任务；子代理的回报要用 loop_record 登记，不是写在本消息里。同轮重排用 replace:true（旧任务进 archivedTasks，新任务 id 接着往后编，不会复用旧 id）。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: 'loop_start 返回的 loop_id' },
      tasks: { type: 'array', required: true, description: `本批任务，单轮最多 ${config.maxTasksPerRound} 个 subagent + ${config.maxSelfTasksPerRound} 个 self`, items: taskSpec },
      mode: { type: 'string', enum: ['parallel', 'serial'], description: "调度提示，默认 'parallel'；非法值直接报错" },
      replace: { type: 'boolean', description: 'true = 重排当前轮（不新建轮次，旧任务转归档）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const result = planRound(cfg, ledger, {
        loopId: args.loop_id,
        tasks: args.tasks,
        mode: args.mode,
        replace: args.replace === true,
      })
      const lines = [
        `第 ${result.round} 轮已开（${result.mode}）· 循环 \`${result.loop_id}\``,
        `工作目录：${result.workdir}`,
        `派发 ${result.dispatches.length} 个 · 自办 ${result.self_tasks.length} 个 · 等前置 ${result.waiting.length} 个`,
        '',
        ...dispatchSection(result.dispatches),
        ...selfSection(result.self_tasks),
        ...waitingSection(result.waiting),
      ]
      if (result.dispatcher_rule.length > 0) {
        lines.push('', '## 规则', ...result.dispatcher_rule.map((rule) => `- ${rule}`))
      }
      if (result.unsettled_failures.length > 0) {
        lines.push('', '## 上一轮遗留未收口', ...result.unsettled_failures.map((entry) => `- \`${entry.task_id}\` ${entry.label} 仍 ${entry.status}（第 ${entry.attempt} 次）→ 用 loop_retry 或登记成 failed/blocked`))
      }
      return {
        text: lines.join('\n'),
        payload: {
          loop_id: result.loop_id,
          round: result.round,
          workdir: result.workdir,
          dispatches: result.dispatches,
          self_tasks: result.self_tasks,
          waiting: result.waiting,
          released: result.released,
          unsettled_failures: result.unsettled_failures,
        },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_record',
    description: `把一个子代理的整段回报登记进台账（三节最小要求：summary/report/artifacts）。三种写法：单条（task_id + report）、整段（text，首行 \`TASK: <task_id>\`）、批量（reports 数组）。定位规则：task_id 优先，没给就看正文首行的 \`TASK:\` 标记；两者都给且不一致时**直接报错**（不会替你挑一个）。旧任务的 id 已被 replace 归档时也会报错并列出归档里的候选。缺节或正文过短会提示 thin / missing_sections，要补齐后再登一次。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
      task_id: { type: 'string', description: '任务 id（权威；与正文 TASK: 标记冲突会报错）' },
      status: { type: 'string', enum: TASK_STATUSES, description: 'done / failed / blocked，默认 done' },
      summary: { type: 'string', description: '一句话结论' },
      report: { type: 'string', description: '整份回报原文（六节写全）' },
      text: { type: 'string', description: '含 `TASK: <task_id>` 首行的整段回报（没给 task_id 时用它定位）' },
      evidence: { type: 'array', items: { type: 'string' }, description: '证据行' },
      commands: { type: 'array', items: { type: 'string' }, description: '关键命令' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '相对工作目录的产物路径' },
      agent_id: { type: 'string', description: '子代理 id（自办留空）' },
      reports: { type: 'array', description: '批量登记（每个元素同单条参数）', items: reportSpec },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const result = recordReports(cfg, ledger, {
        loopId: args.loop_id,
        taskId: args.task_id,
        status: args.status,
        summary: args.summary,
        report: args.report,
        text: args.text,
        evidence: args.evidence,
        commands: args.commands,
        artifacts: args.artifacts,
        agentId: args.agent_id,
        reports: args.reports,
      })
      const lines = [`已登记 ${result.count} 条 · 循环 \`${result.loop_id}\``, '']
      for (const record of result.records) {
        lines.push(`- \`${record.task_id}\` ${record.status} · ${record.report_chars} 字${record.report_kept_chars < record.report_chars ? `（台账留前 ${record.report_kept_chars} 字，全文 ${record.report_file}）` : ''}`)
        lines.push(`  结论：${record.summary || '（空）'}`)
        if (record.artifacts.length > 0) lines.push(`  产物：${record.artifacts.join('、')}`)
        if (record.missing_sections.length > 0) lines.push(`  ⚠️ 缺节：${record.missing_sections.join('、')} → 补齐后重登一次`)
        if (record.thin) lines.push(`  ⚠️ 正文短于 ${cfg.minReportChars} 字（thin）→ 让它按六节补写`)
      }
      if (result.prompts_rule.length > 0) lines.push('', result.prompts_rule)
      if (result.released.length > 0) {
        lines.push('', '## 前置已满足，可以派了')
        for (const unit of result.released) lines.push(dispatchLine(unit))
      }
      return {
        text: lines.join('\n'),
        payload: { loop_id: result.loop_id, records: result.records, released: result.released },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_collect',
    description: `收齐本轮：给 counts / pending_ids / stale_ids，集齐后自动整理出 _index.md 与 manifest。complete=false 时不要开下一轮，先按 pending_ids 等回报或 loop_retry。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const result = collectRound(cfg, ledger, args.loop_id)
      const counts = result.counts
      const lines = [
        `第 ${result.round} 轮：${result.complete ? '已集齐' : '未集齐'}（done ${counts.done} / failed ${counts.failed} / blocked ${counts.blocked} / 在跑 ${counts.dispatched} / 等前置 ${counts.waiting}）`,
        `耗时 ${result.elapsed_minutes} 分钟${result.budget_warning.length > 0 ? ` · ⚠️ ${result.budget_warning}` : ''}`,
      ]
      if (result.pending_ids.length > 0) {
        lines.push('', `## 还没登记：${result.pending_ids.join('、')}`)
        if (result.stale_ids.length > 0) lines.push(`- 超过 ${cfg.staleMinutes} 分钟没回报：${result.stale_ids.join('、')} → 先 list_agents 核对，再 loop_retry 或登记成 failed`)
      }
      lines.push('', '## 产物核对', ...auditLines(result))
      if (result.index_file.length > 0) lines.push(`- 索引：${result.index_file}（含本轮汇总全文）`)
      lines.push(`- 上下文文件：${result.digest_file}`)
      // R9: the digest used to be pasted here in full — 96% of this receipt on a
      // three-task round. One line per task plus the durable file is enough; the
      // complete text is in _index.md ("本轮汇总") and in the summary file.
      lines.push('', '## 本轮汇总（每任务一行；全文见索引与摘要文件）')
      for (const task of result.task_lines) lines.push(task)
      return {
        text: lines.join('\n'),
        payload: {
          loop_id: result.loop_id,
          round: result.round,
          complete: result.complete,
          counts,
          pending_ids: result.pending_ids,
          stale_ids: result.stale_ids,
          digest_file: result.digest_file,
          index_file: result.index_file,
          artifacts_missing: result.artifacts_missing,
          unregistered_outputs: result.unregistered_outputs,
          outside_artifacts: result.outside_artifacts,
        },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_choose',
    description: `把「下一步选什么」做成让用户点选的卡片：返回 request（直接交给原生 ask_user_question，2~8 个选项，第一个是你推荐的那条，动词开头）。用户答完后用同一个 question_id 调本工具登记选择。三态要分清：不传 selection 也不传 custom = 新建问题；selection:[...] = 用户点了这些选项；selection: [] = 用户一个选项都没点、答案在 custom 里；selection: null = 明确不走选项、答案在 custom 里。[] 和 null 都算「已作答」，不是「新建」。同一循环有多个待答问题时必须带 question_id，否则报错并列出候选。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
      question: { type: 'string', description: '一句话问清在什么之间选' },
      options: { type: 'array', description: '2~8 个选项，第一个放推荐项', items: optionSpec },
      selection: {
        oneOf: [
          { type: 'array', items: { type: 'string' }, description: '用户已经选了哪些选项 label' },
          { type: 'null', description: 'null = 明确「不用选项作答，只听 custom」' },
        ],
        description: '登记用。[] = 一个选项都没选（配 custom）；null = 不用选项作答（也必须配 custom）；不传 = 不登记选择',
      },
      custom: { type: 'string', description: '用户自己写的答案（登记用）' },
      question_id: { type: 'string', description: '登记时指定问题 id；有多个待答问题时必填' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const answering = Array.isArray(args.selection)
        || args.selection === null
        || String(args.custom ?? '').trim().length > 0
      if (!answering) {
        const result = prepareQuestion(cfg, ledger, {
          loopId: args.loop_id,
          question: args.question,
          options: args.options,
        })
        const lines = [
          `已挂问题 \`${result.question_id}\`（第 ${result.decision.round} 轮）`,
          '',
          `问题：${result.decision.question}`,
          '',
          '## 选项',
          ...result.decision.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
          '',
          '下一步：把 JSON 里的 request 原样交给 ask_user_question 弹卡片。卡片还挂着的时候要告诉用户（pending: true）。',
          '用户答完后调 loop_choose（loop_id + question_id + selection/custom）登记选择，再 loop_plan 派下一轮。',
        ]
        return {
          text: lines.join('\n'),
          payload: { loop_id: result.loop_id, question_id: result.question_id, request: result.request, pending: true },
        }
      }
      const result = applySelection(ledger, {
        loopId: args.loop_id,
        selection: args.selection,
        custom: args.custom,
        questionId: args.question_id,
      })
      const chosen = result.decision.selected.length > 0 ? result.decision.selected.join('、') : result.decision.custom
      return {
        text: `已登记选择（${result.question_id}）：${chosen}\n\n下一步：loop_plan 照这个方向派下一轮。`,
        payload: { loop_id: result.loop_id, question_id: result.question_id, selected: result.decision.selected, custom: result.decision.custom },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_retry',
    description: `返工：把 failed/blocked 的任务重开一次（attempt+1，prompt 里带上重试说明）。超过 maxRetries 的任务进 exhausted，改为给用户做卡片选项。有 agentId 时给 resume_args（用 send_message 续跑同一子代理）。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
      task_ids: { type: 'array', required: true, items: { type: 'string' }, description: '要重开的任务 id' },
      reason: { type: 'string', description: '重试说明（会写进新 prompt）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const result = retryTasks(cfg, ledger, {
        loopId: args.loop_id,
        taskIds: args.task_ids,
        reason: args.reason,
      })
      const lines = []
      if (result.dispatches.length > 0 || result.self_tasks.length > 0) {
        lines.push(`返工已开 · 循环 \`${result.loop_id}\``)
      } else {
        // Nothing was re-dispatched: every requested task had already used up
        // its attempts. Claiming "返工已开" here sent the caller looking for
        // dispatches that do not exist.
        lines.push(`没有任务被重开 · 循环 \`${result.loop_id}\``)
      }
      if (result.reason.length > 0) lines.push(`说明：${result.reason}`)
      const sections = [...dispatchSection(result.dispatches), ...selfSection(result.self_tasks)]
      if (sections.length > 0) lines.push('', ...sections)
      if (result.exhausted.length > 0) {
        lines.push('', '## 重试次数用完')
        for (const entry of result.exhausted) {
          lines.push(`- \`${entry.task_id}\` ${entry.label}：已 ${entry.attempts}/${entry.max_attempts} 次 → 改做卡片选项（放弃 / 换写法 / 换人）或用 loop_record 登记成 failed`)
        }
      }
      return {
        text: lines.join('\n'),
        payload: { loop_id: result.loop_id, dispatches: result.dispatches, self_tasks: result.self_tasks, exhausted: result.exhausted },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_finish',
    description: `收尾：目标达成才调。要求本轮所有任务都已登记（done/failed/blocked），写明 outcome 与总结；会写 _final.md 与 _index.final.md。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
      outcome: { type: 'string', description: "结果标记，默认 'done'" },
      summary: { type: 'string', description: '整段收尾总结（结论 + 产物清单 + 未决问题）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const result = finishLoop(cfg, ledger, {
        loopId: args.loop_id,
        outcome: args.outcome,
        summary: args.summary,
      })
      const lines = [
        `循环 \`${result.loop_id}\` 已收尾（${result.outcome}）`,
        '',
        `收尾报告：${result.final_file}`,
        `索引快照：${result.final_index}`,
        `工作目录：${result.workdir}`,
      ]
      const audit = { artifacts_missing: [], unregistered_outputs: result.unregistered_outputs, outside_artifacts: result.outside_artifacts }
      lines.push('', '## 收尾核对', ...auditLines(audit))
      if (result.unregistered_outputs.length > 0 || result.outside_artifacts.length > 0) {
        lines.push('', '这些要在最终答复里写成未决，或补登记后重跑 loop_tidy。')
      }
      return {
        text: lines.join('\n'),
        payload: { loop_id: result.loop_id, outcome: result.outcome, final_file: result.final_file, final_index: result.final_index },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_tidy',
    description: `手动重刷索引：重建当前轮的 _index.md / _manifest.json 并给出产物核对（artifacts 缺文件、未入账文件、落在工作目录外的产物）。`,
    parameters: {
      loop_id: { type: 'string', required: true, description: '循环 id' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const loop = requireLoop(ledger, args.loop_id)
      const result = tidyLoop(cfg, ledger, loop)
      const lines = [
        `已重刷索引 · 循环 \`${loop.id}\``,
        '',
        `索引：${toPosix(result.indexFile)}`,
        `清单：${toPosix(result.manifestFile)}`,
        `文件数：${result.audit.files.length}${result.audit.overflow ? `（超过 tidyMaxFiles=${cfg.tidyMaxFiles}，只扫了一部分）` : ''}`,
        '',
        '## 产物核对',
        ...auditLines({
          artifacts_missing: result.audit.artifactsMissing,
          unregistered_outputs: result.audit.unregisteredOutputs,
          outside_artifacts: result.audit.outsideArtifacts,
        }),
      ]
      return {
        text: lines.join('\n'),
        payload: { loop_id: loop.id, index_file: toPosix(result.indexFile), manifest_file: toPosix(result.manifestFile) },
      }
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_status',
    description: `看进度。默认 brief：每轮一行的简报（每轮结束时贴给用户）。full:true 给完整台账（任务、attempt、产物、最近回报）。brief 与 full 互斥，brief:true 优先；brief:false 不会给全量（旧版的极性反直觉，已改）。不给 loop_id 时取最近更新的循环。`,
    parameters: {
      loop_id: { type: 'string', description: '循环 id（可省略）' },
      brief: { type: 'boolean', description: 'true = 每轮一行简报（默认）；false 无特殊含义，要全量请用 full:true' },
      full: { type: 'boolean', description: 'true = 完整台账' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, ledger }) => {
      const result = statusOf(ledger, { loopId: args.loop_id, brief: args.brief, full: args.full })
      return { text: result.text, payload: undefined }
    }, { write: false }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_list',
    description: `列出循环台账（id / 状态 / 轮次 / 任务数 / 更新时间），可按状态过滤。status 只接受 'active' / 'closed'，写错会直接报错（不会假装台账是空的）。`,
    parameters: {
      status: { type: 'string', enum: LOOP_STATUSES, description: "只列某个状态：'active' 或 'closed'" },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, ledger }) => {
      const result = listLoops(ledger, { status: args.status })
      if (result.total === 0) return { text: '台账里还没有循环。用 loop_start 开一个。', payload: undefined }
      return { text: `共 ${result.total} 个循环\n\n${listTable(result.loops)}`, payload: undefined }
    }, { write: false }),
  }))

  ctx.tools.register(defineTool({
    name: 'loop_prune',
    description: `清理旧台账：只删已收尾（closed）的循环，保留最近 keep 个。先 dry_run:true 看会删哪些，用户确认后再跑一次 dry_run:false。`,
    parameters: {
      keep: { type: 'integer', description: '保留多少个 closed 循环（默认 50；keep: 0 = 清空全部已收尾循环）' },
      dry_run: { type: 'boolean', description: 'true = 只报告不删（默认 true）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: run(async ({ args, config: cfg, ledger }) => {
      const dryRun = args.dry_run !== false
      const result = pruneLedger(cfg, ledger, { keep: args.keep, dryRun })
      const lines = [
        `台账共 ${result.total} 个循环，其中 closed ${result.closed} 个，保留最近 ${result.keep} 个`,
        dryRun ? `预览：会删 ${result.would_remove.length} 个` : `已删 ${result.removed.length} 个`,
      ]
      if (result.would_remove.length > 0) {
        lines.push('', ...result.would_remove.map((id) => `- ${id}`))
        if (dryRun) lines.push('', '确认后调 loop_prune({ keep, dry_run: false }) 真正删除。')
      }
      if (result.orphan_work_dirs.length > 0 || result.orphan_summaries.length > 0) {
        lines.push(
          '',
          '## 磁盘上还留着（本工具只删台账条目，不动文件）',
          ...result.orphan_work_dirs.map((dir) => `- 工作目录：${dir}`),
          ...result.orphan_summaries.map((file) => `- 上下文：${file}`),
          '- 确认这些不再需要时再手工删除；要留证据就忽略这一节。',
        )
      }
      return {
        text: lines.join('\n'),
        payload: {
          total: result.total,
          closed: result.closed,
          kept: result.kept,
          dry_run: dryRun,
          removed: dryRun ? result.would_remove : result.removed,
          orphan_work_dirs: result.orphan_work_dirs,
          orphan_summaries: result.orphan_summaries,
        },
      }
    }, { write: (args) => args.dry_run === false }),
  }))
}

export { apply, inject, name }
