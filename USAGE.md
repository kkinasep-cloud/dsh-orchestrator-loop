# dsh-orchestrator-loop 使用手册（0.6.0）

> 面向使用者与 AI 主代理的**操作手册**。变更细节见 `CHANGELOG.md`，版本行为说明见 `README.md`。
> 本文件里的 `文件:行号` 锚点对应 0.6.0 定稿时的 `src/`，若有漂移用 `grep -n` 复核。

---

## 1. 这插件给你什么

11 个 `loop_*` 工具，串成一条**固定流水线**跑多轮编排：

```
start → plan →（子代理干活）→ record → collect → choose →（下一轮）… → finish
```

- 每个循环有独立工作目录：`<cwd>/.orchestrator-loop/<loopId>/{artifacts,reports,notes}/`
- 台账落在 `~/.dsh/plugins/orchestrator-loop/loops.json`（由 `resolveHome` 决定，随宿主配置变化）
- 一轮最多 **3 个子代理 + 1 个主代理自办**，默认 1 主 + 3 子 = 4 并发

---

## 2. 工具速查表

| 工具 | 一句话 | 必填参数 |
|---|---|---|
| `loop_start` | 开循环 + 建工作目录 | `goal` |
| `loop_plan` | 派新一轮任务 | `loop_id`、`tasks[]` |
| `loop_record` | 登记子代理回报 | `loop_id` +（`task_id` / `text` / `reports`） |
| `loop_collect` | 收齐本轮 + 生成索引 | `loop_id` |
| `loop_choose` | 给用户点选卡片 | `loop_id`（新建时还要 `question` + `options[]`） |
| `loop_retry` | 重开 failed/blocked | `loop_id`、`task_ids[]` |
| `loop_finish` | 收尾，写 `_final.md` | `loop_id` |
| `loop_status` | 看进度 | 无（`loop_id` 可省 = 最近循环） |
| `loop_list` | 列台账所有循环 | 无 |
| `loop_tidy` | 手动重刷索引 + 产物核对 | `loop_id` |
| `loop_prune` | 清旧台账（只删已收尾） | 无（默认 `dry_run: true`） |

---

## 3. 标准一轮（五步，顺序不能乱）

### 3.1 三步铁律

1. **一轮没集齐不 `loop_collect`，也不开下一轮。**
2. **`loop_plan` 返回的 `dispatches` 只是「参数」** —— 必须真的去调原生 `subagent`（同一条消息内并行），否则子代理根本不存在。
3. **派完就停** —— 发完 `subagent` 那条消息就结束，别顺手自己读文件或做别的任务。

### 3.2 时序

```
loop_start(goal, note)
   ↓  拿 loop_id
loop_plan(loop_id, tasks[...])
   ↓  返回 dispatches / self_tasks / waiting
subagent × N（同一条消息并行发，prompt 首行写 TASK: t1-1）
   ↓
loop_record(loop_id, ...)  × N（可以批量）
   ↓
loop_collect(loop_id)      ← complete=true 才继续
   ↓
loop_choose(loop_id, question, options)  → ask_user_question
   ↓
（下一轮 plan …）或 loop_finish(loop_id, outcome, summary)
```

---

## 4. 逐个工具

### 4.1 `loop_start`

```
loop_start(
  goal: "一句话写清这个循环要达成什么",     // 必填
  note: "验收标准/约束，会带给每个子代理",   // 可选，强烈建议写
  cwd:  "工作目录基准"                      // 可选，默认会话 cwd
)
```

- `note` 里写清「**不许做什么**」最有效（例如「严禁写真实台账」「不重启 dsh」），它会原样进每个子代理的 prompt。
- 回执里有一行「**cwd 来源**」：显式传入 / 会话 cwd / **回落进程 cwd 警告**。看到第三种要警惕，产物可能落歪。

### 4.2 `loop_plan`

```
loop_plan(
  loop_id,
  tasks: [{
    label:       "任务短名（一到两行内能看懂）",   // 必填
    brief:       "要产出什么、落到哪；写清验收口径", // 必填
    assignee:    "subagent" | "self",             // 默认 subagent
    depends_on:  ["t1-1"],                        // 只支持同轮内依赖
    agent_preset:"指定 agent preset（可省略）"
  }],
  mode:    "parallel" | "serial",   // 默认 parallel，非法值直接报错
  replace: false                    // true = 重排当前轮
)
```

- **单轮上限**：3 个 subagent + 1 个 self（主代理自办）。
- `replace: true` 会把旧任务移进 `archivedTasks`，**新 id 接着往后编、不复用**（0.6.0 起）。迟到的旧回执会报错并列出归档候选，不会静默写进同号新任务。
- `depends_on` **不支持跨轮依赖**。
- 返回三态：`dispatches`（要发的 subagent_args/resume_args）、`self_tasks`（自己办）、`waiting`（等前置）。
- 发子代理时：把 `dispatches[].subagent_args` 的 `description` + `prompt` 原样交给原生 `subagent`，**prompt 首行必须有 `TASK: <task_id>`**，否则后续 `loop_record` 定位不到。

### 4.3 `loop_record`

```
loop_record(
  loop_id,
  task_id:  "t1-1",          // 权威：与正文 TASK: 标记冲突会报错
  status:   "done",          // done / failed / blocked，默认 done
  report:   "六节原文",       // 整份回报
  text:     "含 TASK: 首行的整段原文",  // 没给 task_id 时用它定位
  summary:  "一句话结论",     // 不写则自动从「结论」节提取
  evidence: [...], commands: [...], artifacts: [...],
  agent_id: "子代理 id",      // 自办留空
  reports:  [ {...}, {...} ]  // 批量登记，一次登多条
)
```

- **六节最小要求**：结论 / 做了什么 / 产物 / 证据 / 未决问题 / 建议下一步。
- 缺节 → 返回 `missing_sections`；正文过短 → 标 `thin`。补齐后再登一次。
- 三种写法：单条（`task_id` + `report`）／整段（`text` 首行 `TASK:`）／批量（`reports` 数组）。
- 台账只留 **300 字预览** + 截断后缀，全文自动落 `reports/<task_id>_a<attempt>.md`。

### 4.4 `loop_collect`

```
loop_collect(loop_id)
```

- 返回 `counts`（total/done/failed/blocked/dispatched/pending/waiting）、`pending_ids`、`stale_ids`、`complete`。
- `complete = false` → **不要开下一轮**，按 `pending_ids` 等回报，或 `loop_retry`。
- 集齐后自动写 `_index.md`（含「本轮汇总」全文）与 `_manifest.json`，并给 `digest_file`。
- 回执是轻量的（每任务一行 + 索引路径 + 上下文文件路径），细节读文件。

### 4.5 `loop_choose`

```
loop_choose(
  loop_id,
  question: "一句话问清在什么之间选",
  options: [{ label: "动词开头的选项", description: "选了会发生什么" }]
)
→ 返回 request，原样交给原生 ask_user_question
```

用户答完要**再调一次登记**，四态严格区分：

| 传什么 | 含义 |
|---|---|
| 不传 `selection` 也不传 `custom` | **新建问题** |
| `selection: ["选项A"]` | 用户点了这些 |
| `selection: []` + `custom` | 一个选项都没点，答案在 custom |
| `selection: null` + `custom` | 明确不走选项，只听 custom |
| `selection: null` 无 `custom` | **报错**（null 是「不用选项作答」，答案必须给） |

- 选项 **2~8 个，第一个放推荐项**，label 用动词开头。
- 同一循环有多个待答问题（`q2-1`、`q2-2`…）时，登记**必须带 `question_id`**，否则报错并列出候选。

### 4.6 `loop_retry`

```
loop_retry(loop_id, task_ids: ["t1-2"], reason: "上次缺证据，这次补 rc 与字节数")
```

- 只对 `failed` / `blocked` 有效，`attempt + 1`。
- 超过 `maxRetries`（默认 2）进 `exhausted`，转为给用户做卡片选项。
- 任务原本有 `agentId` 的，会用 `send_message` **续跑同一个子代理**（省一次冷启动）。
- `reason` 会写进新 prompt，写具体点（「缺什么、补什么」）。

### 4.7 `loop_finish`

```
loop_finish(loop_id, outcome: "done", summary: "结论 + 产物清单 + 未决问题")
```

- **前提**：本轮所有任务都已登记（done/failed/blocked）。
- 写 `_final.md` 与 `_index.final.md`，循环转 `closed`。
- `summary` 建议自己分节写（结论 / 产物 / 未决），会原样进收尾文件。
- 收尾后想继续干，**新开一个循环**，别在 closed 循环上加轮次。

### 4.8 `loop_status`

```
loop_status()                     // 默认 brief：每轮一行简报
loop_status(loop_id)              // 指定循环
loop_status(loop_id, full: true)  // 完整台账：任务 / attempt / 产物 / 最近回报
```

- **`brief: false` 不给全量**（0.6.0 起的极性修正），要全量只能 `full: true`。
- `brief` 与 `full` 互斥，`brief: true` 优先。
- 不给 `loop_id` = 最近更新的那个循环。
- `full` 输出每任务只给 300 字节选 + 「回报全文」指针。

### 4.9 `loop_list`

```
loop_list()                  // 全部
loop_list(status: "active")  // 只列进行中
loop_list(status: "closed")  // 只列已收尾
```

- `status` 只接受 `'active'` / `'closed'`，**写错直接报错并列出合法值**（不会假装台账是空的）。

### 4.10 `loop_tidy`

```
loop_tidy(loop_id)
```

重建 `_index.md` / `_manifest.json` 并给产物核对：

- `artifacts_missing`：登记了但文件不在
- `unregistered_outputs`：工作目录里有文件但没登记（**台账外动手的审计痕迹**）
- `outside_artifacts`：产物落在工作目录之外

一轮里有人手工改过文件后跑一次。

### 4.11 `loop_prune`

```
loop_prune()                              // 默认 dry_run: true，只报告不删
loop_prune(keep: 50)                      // 保留最近 50 个 closed 循环
loop_prune(keep: 0, dry_run: false)       // ⚠ 真清空全部已收尾循环
```

- **只删 `closed` 循环**，进行中的永远不动。
- `dry_run` 默认 `true`：先预览，用户确认后再传 `false`。
- `keep: 0` 现在**真的是 0**（旧版会被 `Math.max(1, …)` 悄悄抬成 1）；非整数/负数报错。

---

## 5. 实战配方

### 5.1 并行取证（最常用）

```
loop_plan(tasks: [
  { label: "审计代码冗余与死代码",
    brief: "产出 artifacts/01_audit.md，每条结论必须带 文件:行号" },
  { label: "量化性能与台账体积",
    brief: "须给改动前后字节数与毫秒数，探针 rc 必须为 0" },
  { label: "审计工具契约与输出 token",
    brief: "须给可复现的最小调用与旧版实际返回" }
], mode: "parallel")
```

→ 同一条消息内发 3 个 `subagent` → 3 份回报逐个 `loop_record` → `loop_collect`

### 5.2 一批回报一次登记

```
loop_record(loop_id, reports: [
  { task_id: "t1-1", report: "...", artifacts: [...] },
  { task_id: "t1-2", report: "...", artifacts: [...] }
])
```

### 5.3 主代理自己也接一份

`tasks` 里写 `assignee: "self"`，单轮最多 1 个，返回在 `self_tasks` 里，主代理直接做。

### 5.4 返工

```
loop_retry(loop_id, task_ids: ["t2-1"], reason: "R7 收益实测 0%，需给出剔除 updatedAt 后的跳写率")
```

### 5.5 收尾

```
loop_finish(loop_id, outcome: "done",
  summary: "## 结论\n…\n## 产物\n…\n## 未决\n…")
```

---

## 6. 会影响用法的 6 个坑（0.6.0 定的）

| 坑 | 说明 |
|---|---|
| 台账不能按行 `grep` / `diff` | `loops.json` / `status.json` / `_manifest.json` 现在是 compact 单行，用 `node -e` 读 |
| 台账里 `report` 只是 300 字预览 | 末尾带「已截断，全文 N 字见 reportFile」，全文去 `reports/` 或 `loop_status(full)` |
| `loop_prune({keep: 0})` 真清空 | 旧版被静默抬成 1，脚本行为会变 |
| `brief: false` 不再等于全量 | 要全量传 `full: true` |
| `loop_choose` 多问题时必须带 `question_id` | 否则直接报错 |
| `loop_plan` 的 `replace` 后 id 顺延 | 别再硬编码假设 `t1-1` 就是重排后的第一个 |

**已知误报**：`loop_collect` 的 `artifacts_missing` 只认**文件**——产物若是**目录**（如 `notes/perf-after/` 下 83 个文件）会被误判为缺失。`ls` 核实即可。

---

## 7. 配置

位置：`cordis.patch.yml`。12 个键与 `src/common.js` 的 `DEFAULTS` **必须逐键同值**，有门禁 `_probes/smoke/_patch-parity.mjs` 卡着（rc=1 即拦截）。

| 键 | 默认 | 作用 |
|---|---|---|
| `maxTasksPerRound` | 3 | 单轮子代理上限 |
| `maxSelfTasksPerRound` | 1 | 单轮主代理自办上限 |
| `reportKeepChars` | 300 | 台账里回报预览字数 |
| `taskHistoryKeep` | 5 | 每任务保留几次 attempt |
| `minReportChars` | 400 | 低于此判 `thin` |
| `staleMinutes` | 120 | 多久没动静算 stale |
| `maxRetries` | 2 | 返工上限 |
| `contextMode` | memo | 上下文摘要模式 |
| `resumeAgents` | true | 返工是否续跑同一子代理 |
| `workRoot` | 空 | 空则用 `<cwd>/.orchestrator-loop/` |
| `tidyMaxFiles` | 2000 | 索引扫描文件上限 |
| `budgetMinutes` | 0 | 0 = 不限时 |

**`reportKeepChars` 双份存储**：`src/common.js:32`（DEFAULTS）与 `cordis.patch.yml:38`（patch 钉值）各一份，`src/index.js:97` 的 `clampInt` 让**显式值优先**。改必须两处同改，只改一处会打架。

---

## 8. 怎么触发

不用背工具名，说人话即可：

- 「**用循环做**」「一轮一轮推进」
- 「分批派子代理，每轮让我选下一步」
- 「这个活要落盘、可恢复」
- 「长时间多轮任务，中途要能返工」

会自动命中 `orchestrator-loop` 技能，按上面那套流程走。

---

## 9. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `loop_record` 报「与 TASK: 标记冲突」 | `task_id` 与正文首行不一致 | 二选一，别都给；`task_id` 权威 |
| `loop_record` 报「命中归档」 | 任务已被 `replace` 归档 | 用报错里列出的现役 id 重新登记 |
| `loop_collect` 一直 `complete: false` | 有任务没回报 | 看 `pending_ids`，等或 `loop_retry` |
| `artifacts_missing` 报目录不存在 | 产物是目录，判据只认文件 | `ls` 核实，属误报 |
| `loop_list(status: "xxx")` 报错 | 0.6.0 起非法值不再静默 | 用 `active` / `closed` |
| `loop_choose` 报「需要 question_id」 | 同循环有多个待答问题 | 带上报错列出的那个 id |
| 产物落到奇怪目录 | `loop_start` 回落了进程 cwd | 重开循环并显式传 `cwd` |
| 探针报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `--import` 只吃 URL | 用 `file:///D:/…` 而不是 `D:/…` |

---

## 10. 相关文件

| 文件 | 内容 |
|---|---|
| `README.md` | 面向安装者的说明、配置表、故障速查 |
| `CHANGELOG.md` | 0.6.0 逐条变更 + 每条的单条回滚方法 |
| `_probes/smoke/_patch-parity.mjs` | patch 与 DEFAULTS 的 12 键一致性门禁 |
| `_probes/smoke/` 其余 | `_smoke` / `_smoke2` / `_regression-probe` / `_load-probe` / `_e2e-probe` 基线探针 |
| `_probes/perf/` | `_ledger-perf` 台账体积、`_scaling` scanTree 伸缩性 |
| `_bak/src-20261027/` | 0.6.0 前的源码备份（整包回滚基线，含 `SHA256SUMS.txt`） |

> `_probes/` 与 `_bak/` 是本机开发资产，已在 `.gitignore` 中排除，**不在公开仓库里**；表中的探针与回滚基线需本地自备。
