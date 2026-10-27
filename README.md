# dsh-orchestrator-loop

给 DeepSeek Harness 用的**多轮编排循环**插件：主代理按轮派发子智能体、收回报、整理产物、给用户 2~8 个下一步选项，再派发下一轮，直到目标达成。

- 版本：0.6.0（契约拒绝静默猜、回执不再重复贴、台账不再存全文；**8 条破坏性变更见 `CHANGELOG.md` 与本文「0.6.0 破坏性变更」**）
- 包名：`dsh-orchestrator-loop`（桌面 profile 以 `link:` 依赖引用本目录）
- 配套技能：`~/.dsh/skills/orchestrator-loop/SKILL.md`（使用规约与故障表，模型侧按它驱动）

> **从 0.5.x 升级到 0.6.0 只需看一节**：本 README 末尾的「0.6.0 破坏性变更」。旧版有 6 处会**静默给出错误结果**（回执贴全文、`brief:false` 反而给全量、`task_id` 与正文标记冲突时随便挑一个、重排后 id 复用、`keep:0` 被抬成 1、非法 `status` 报「台账里还没有循环」），新版一律报错或回到文档承诺的默认值。

## 安装（从 GitHub）

本包**不发布到 npm**：它依赖的 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 必须由你的 DSH 安装提供，只能走源码 + `link:` 引用。

```bash
git clone https://github.com/kkinasep-cloud/dsh-orchestrator-loop.git
```

然后在 DSH profile 的 `package.json` 里加依赖，并把包名加进 bundles：

```jsonc
{
  "dependencies": {
    "dsh-orchestrator-loop": "link:/绝对路径/dsh-orchestrator-loop"
  },
  "dsh": { "profile": { "bundles": ["dsh-orchestrator-loop"] } }
}
```

- 改 `package.json`（依赖 / bundles）由 `dsh-hmr` 监听并热生效
- 改 `src/*.js` **不在**监听范围，必须重启 dsh

> **前置条件**：`@deepseek-ai/cordis >= 4.0.0` 与 `@deepseek-ai/dsh-tools >= 0.2.1-rc.1` 必须能从你的 DSH 安装里解析到（见下文「`peerDependencies` 是解析开关，不是兼容性声明」）。缺任一条会 `ERR_MODULE_NOT_FOUND`。

> **仓库内容**：只含 `src/`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`USAGE.md`、`LICENSE`。`_probes/`（基线探针）与 `_bak/`（历史源码 / 台账备份）是本机开发资产，已在 `.gitignore` 中排除，**不在公开仓库里**——下文「自检」列出的探针命令、以及「0.6.0 破坏性变更」提到的 `_bak/src-20261027/` 回滚基线，需要本地自备。


## 装配位置

| 事项 | 位置 |
| --- | --- |
| bundle patch（把插件插进 cordis 树） | 本包 `cordis.patch.yml`，由 `package.json` 的 `dsh.bundle.patch` 声明 |
| 插件入口 | `src/index.js`（`export { apply, inject, name }`） |
| 台账（跨会话持久） | `<DSH_HOME>/plugins/orchestrator-loop/loops.json`、`status.json`、`summaries/` |
| 任务产物目录 | `<workRoot>/<loop_id>/`（`workRoot` 为空时用 `<cwd>/.orchestrator-loop/<loop_id>/`），内含 `artifacts/`、`reports/`、`notes/` |
| dispatcher 预设 | **不在本包**：`~/.dsh/profiles/desktop/cordis.patch.yml` 已有 `id: dispatcher` 的 `@deepseek-ai/dsh-agent-preset` 行；本包只负责提供它要挂的 `loop_*` 工具 |

> desktop profile 另需把本包名加入 `package.json` 的 `dsh.profile.bundles`，否则只加载依赖、不插入 cordis 树。
> 改 `package.json`（bundles / 依赖）由 `dsh-hmr` 监听并热生效；改 `src/*.js` **不在**监听范围内，必须重启 dsh。

## 十一个工具

| 工具 | 语义 | 主要参数 |
| --- | --- | --- |
| `loop_start` | 建循环 + 建任务文件夹 | `goal`（必填）、`note`（验收标准）、`cwd` |
| `loop_plan` | 派发一轮 | `loop_id`、`tasks[{label,brief,assignee?,depends_on?,agent_preset?}]`、`mode`（只收 `parallel`/`serial`，写错直接报错）、`replace`（`true` 重排本轮，**新任务 id 从本轮用过的最大序号之后顺延，不复用**） |
| `loop_record` | 登记回报（三条路：整段文本 / 单条结构化 / 批量） | `loop_id`、`text` 或 `task_id+status+summary+report…` 或 `reports[]`。**`task_id` 是权威**：`text` 与 `report` 各带 `TASK:` 首行且互相矛盾 → 直接报错；`task_id` 与正文标记冲突 → 直接报错；命中 `archivedTasks` 里已归档的 id → 报错并列出归档候选 |
| `loop_collect` | 收齐本轮、算缺口、出 index | `loop_id`。回执只给**每任务一行 + 索引路径 + 上下文文件路径**，整轮汇总全文在 `_index.md` 的「## 本轮汇总」段 |
| `loop_choose` | 三态：出卡片（`pending:true`）/ 登记选择（`selection:[…]`，空数组合法）/ 明确不选（`selection:null` + `custom`） | `loop_id`、`question`+`options[]` 或 `selection[]`+`custom`+`question_id`（**同时有多个待答问题时必填**） |
| `loop_retry` | 返工失败任务（attempt+1） | `loop_id`、`task_ids[]`、`reason` |
| `loop_finish` | 收尾，写 `_final.md` + `_index.final.md` | `loop_id`、`outcome`、`summary` |
| `loop_tidy` | 手动整理任务文件夹 | `loop_id` |
| `loop_status` | 看状态，**三态**：`brief:true` → 每轮一行；`full:true` → 详情；**其余（含 `brief:false`、什么都不传）→ 每轮一行**。`brief:false` 不再等价 `full:true` | `loop_id`、`brief`、`full` |
| `loop_list` | 列所有循环 | `status`（只接受 `'active'` / `'closed'`，写错**直接报错**，不再假装台账是空的） |
| `loop_prune` | 清掉已收尾循环的台账条目（默认 dry-run；**不动磁盘文件**，只回列 `orphan_work_dirs` / `orphan_summaries` 供手工清理） | `keep`（`keep:0` = 清空全部已收尾循环，**不再被抬成 1**；负数/小数直接报错）、`dry_run` |

## 八步循环

1. `loop_start{goal, note}` → 拿 `loop_id`。
2. `loop_plan{loop_id, tasks}` → 返回 `dispatches[]`（子代理）/`self_tasks[]`（主代理自办）/`waiting[]`（等前序）。
3. 按 `dispatches[i].subagent_args` 原样调宿主原生 `subagent`（或 `resume_args` 走 `send_message`），同一条消息里并发。
4. 子代理回报后 `loop_record` 登记。**`task_id` 权威**：给了 `task_id` 就以它为准，此时正文首行的 `TASK:` 标记只是校验位——与 `task_id` 不一致会直接报错（旧版会静默落到其中一个）。不给 `task_id` 时才靠回报首行 `TASK: <id>` 对号；两个标记都没有就报「缺正文 / 缺 id」并给出完整调用示例。
5. 全部登记完 `loop_collect` → 缺口、摘要文件、索引。**回执不再内联整轮汇报全文**，只给每任务一行 + 两个路径；要看全文去读 `_index.md` 的「## 本轮汇总」段或上下文文件。
6. `loop_choose{question, options}` 出卡片交给原生 `ask_user_question`；用户点完 `loop_choose{selection}` 登记。
7. 有失败/不合格 → `loop_retry`；否则回第 2 步派下一轮。
8. 目标达成 `loop_finish` → `_final.md`、`_index.final.md`。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxTasksPerRound` | 3 | 单轮子代理任务上限（1–32） |
| `maxSelfTasksPerRound` | 1 | 单轮自办任务上限（0–32，0 = 关闭自办） |
| `reportKeepChars` | 300 | 台账里 `task.report` 保留字数。超出即截断，并在末尾追加 `…（预览已截断，全文 N 字，见 reportFile）` 的自证后缀；全文照旧写 `<workDir>/reports/`。**0.5.x 是 2000，0.6.0 收到 300**（台账里 82 条回报合计 −70.6% 字节）。⚠️ 这个键在 `src/common.js:32`（`DEFAULTS`）与 `cordis.patch.yml:38`（patch 里显式钉值）**各存一份**，`src/index.js:97` 的 `clampInt` 让显式值优先 —— 回滚 R1 时两处必须同时改回 2000 |
| `taskHistoryKeep` | 5 | 每任务保留几版历史回报 |
| `minReportChars` | 400 | 低于此字数标 `thin` |
| `staleMinutes` | 120 | 派发超时未回报视为 stale |
| `budgetMinutes` | 0 | 单轮耗时预算，0 = 关闭警告 |
| `maxRetries` | 2 | 单任务最多返工次数 |
| `contextMode` | `memo` | `memo` 只带摘要窗口，`full` 带全文 |
| `resumeAgents` | `true` | 有 `agent_id` 时走 `resume_args` 续聊而非新开 |
| `workRoot` | `''` | 空 = `<cwd>/.orchestrator-loop/` |
| `tidyMaxFiles` | 2000 | 整理时扫描文件上限，超出标 overflow |

与 `reportKeepChars` 配套的两个**台账字段**（不是配置键，`loop_status(full)` 与 `loop_record` 回执里都能看到）：

- `task.reportFullChars`：该任务回报的原始字数。`report.length < reportFullChars` 就说明台账里存的是预览。
- `task.reportFile`：完整回报副本的路径（`<workDir>/reports/<taskId>_a<attempt>.md`）。`loop_status(full)` 会多出一行 `- 回报全文：<path>`。

> 0.5.x 写下的老任务没有这两个字段，**不回填**：`reportFile` 用 `reportFile ?? 'reportFile'` 兜底，`reportFullChars` 缺省按 0 处理，截断后缀只在新写入时生成。老任务的 2000 字裸切片保持旧样。

## 每轮落盘物

- `<summaries>/_loop_<id>_r<n>_context.md`：派发前是「派发前的完整上下文」，`loop_collect` 后覆盖为「回报全文」。
- `<workDir>/_index.md` + `_manifest.json`：每轮整理产物（文件树、产物核对 ✓✗、未入账文件）。`_index.md` 的
  「## 本轮汇总」段是整轮回报全文的**唯一权威副本**（`loop_collect` 回执只指路、不重复贴）。`_manifest.json`
  同时是「上一轮文件树」的唯一基线——新增/消失列用它对比，台账里不再存副本。
- `<workDir>/_final.md` + `_index.final.md`：`loop_finish` 收尾。
- `<workDir>/reports/<taskId>_a<attempt>.md`：单个任务的完整回报副本。

## 台账纪律

| 规矩 | 行为 |
| --- | --- |
| 台账损坏 | `loadLedger` 把原文备份成 `loops.json.corrupt-<时间戳>` 再抛 `⚠️`；**绝不**当成空台账覆盖 |
| 只读工具 | `loop_status` / `loop_list` / `loop_prune`（未加 `dry_run:false`）不写盘 |
| 工作目录消失 | 派发 / 核对 / 索引 / 收尾一律报 `工作目录已不存在`，不会静默重建空骨架 |
| cwd 不存在 | `loop_start` 直接拒绝，不 mkdir 造目录 |
| 台账体积 | 不再写 `loop.manifest`、`round.fileSnapshot`、`round.memo`、`history[*].report`；旧台账下次写盘时自动清掉 |
| 产物识别 | `v2.3`、`12.5` 这类版本号不当路径；只认已知扩展名或带目录分隔符的相对路径 |
| 同轮重排 | `archivedTasks` 里已登记的产物仍计入核对，不报成未入账；**归档任务的 id 不会被新任务复用**，迟到的旧回执会被拒（报错并列出归档候选），不会静默写进同号新任务 |
| 登记歧义 | `task_id` 权威。`text` 与 `report` 的 `TASK:` 首行互相矛盾、或 `task_id` 与正文标记冲突，一律报错——**不再替调用方挑一个** |
| 落盘格式 | `loops.json` / `status.json` / `_manifest.json` 三个出口都是 **compact 单行 JSON**（0.5.x 是 2 空格缩进）。内容等价、字节更少；但按行 `grep` / `diff` 台账的脚本会失效，改用 `node -e` 或 `jq` |
| 只写有变化的 | `status.json` 走 `writeJsonIfChanged` 逐字节比对。已知限制：`ledger.updatedAt` 每次都刷新，所以当前跳过率为 0（安全但无收益） |
| config 拼错 | 未知键发 `## ⚠️ 配置告警` 并指名近似键（`maxTaskPerRound → maxTasksPerRound`） |
| prune | 只删台账条目，磁盘目录与 summaries 只列不删（`orphan_work_dirs` / `orphan_summaries`） |

## 自检

> 下列探针与 `_bak/` 属本机开发资产，**不在公开仓库中**（见 `.gitignore`）；从 GitHub 装的人可跳过本节。

```bash
node --check src/index.js                    # 及 src/{common,loop,render,store}.js
node _probes/smoke/_regression-probe.mjs     # 25 条断言：损坏台账 / 只读不写盘 / 存储形态 / prune
node _probes/smoke/_smoke.mjs                # 单轮闭环：start→plan→record→collect→choose→finish
node _probes/smoke/_smoke2.mjs               # 多轮上下文、_final.md 与 _index.final.md
node _probes/smoke/_load-probe.mjs           # cordis 加载后 11 个工具是否齐全
node _probes/smoke/_e2e-probe.mjs            # 真跑工具链（临时 DSH_HOME）
node _probes/smoke/_boot-probe4.mjs          # 走 dsh-app-boot 的完整引导 + 兼容性 preflight
node _probes/smoke/_availability-probe.mjs   # 插件管理页的 availability 判定链（包不可用的复现）
node _probes/smoke/_compose-probe.mjs        # profile 组合树里本插件恰好一行、disabled=false
node _probes/smoke/_index-diff-check.mjs     # _index.md 的新增/消失列仍由 _manifest.json 提供
node _probes/perf/_ledger-perf.mjs           # 台账字节投影与 collectRound / statusFull 体积·耗时
node _probes/perf/_scaling.mjs               # scanTree / tidyLoop 随文件数与任务数的伸缩
```

除 `_probes/once/_ledger-probe.mjs`（只读真实台账）外，全部用 `mkdtemp` 造临时 `DSH_HOME`，跑完自动删除。

`_probes/once/` 存一次性取证脚本（缺陷复现、体积/耗时量化、早期 boot 探针），跑过一次即完成使命，
保留只为留下证据；`_probes/smoke/` 才是可反复跑的基线。

## `peerDependencies` 是解析开关，不是兼容性声明

桌面 profile 用 `link:` 依赖本目录。`dsh-app-boot` 的 `ResolutionRouter.routeLinked` 只有在
**插件包自身 `package.json` 的 `peerDependencies` 列出了宿主包名**时，才把该 `import` 路由到
dsh 安装树；没有这两行，`import '@deepseek-ai/dsh-tools'` 会直接 `ERR_MODULE_NOT_FOUND`。

```json
"peerDependencies": {
  "@deepseek-ai/cordis": ">=4.0.0",
  "@deepseek-ai/dsh-tools": ">=0.2.1-rc.1"
}
```

版本号有 semver 坑：`0.2.1-rc.2` 是预发布版，`^0.2.0-rc.2`、`>=0.2.0-rc.2`、`*` **都不满足**，
只有 `>=0.2.1-rc.1` / `^0.2.1-rc.2` / `~0.2.1-rc.2` 满足。`evaluatePluginCompatibility` 只校验
`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`，当前写法在该门禁下返回 `undefined`（通过）。

## 0.6.0 破坏性变更

八条，逐条给 before / after 与回滚位置（完整回滚脚本见 `CHANGELOG.md`「回滚（整包）」；基线在 `_bak/src-20261027/`，含 `SHA256SUMS.txt`）。

| # | 项 | 0.5.x（before） | 0.6.0（after） | 回滚 |
| --- | --- | --- | --- | --- |
| 1 | `loop_collect` 回执 | 内联整轮 digest 全文（三任务轮 13,510 B） | 每任务一行 + 索引/上下文路径（1,773 B，−86.9%） | `src/index.js:440-441` 换回 `lines.push('', '## 本轮汇总', result.digest.trim())`；`digest` 仍在返回值里（`src/loop.js:818`） |
| 2 | `loop_status({brief:false})` | 等价 `full:true`（明确说「不」反而拿到更多） | brief。三态显式：`brief:true`→brief、`full:true`→full、其余→brief | `src/loop.js:1073-1075` |
| 3 | `loop_record` 标记矛盾 | `text` 定任务 / `report` 定正文两套语义，冲突时静默挑一个 | 报错（`resolveRecordTarget`） | 删 `src/loop.js:636-651` 两个 `fail(...)` |
| 4 | `replace:true` 后任务 id | 从 `t1-1` 重新编号，迟到旧回执静默写进同号新任务 | 从本轮最大序号之后顺延（`t1-3`、`t1-4`），归档命中即报错 | `src/loop.js:387` 改回 `const idOffset = 0` |
| 5 | `loop_prune({keep:0})` | 被 `Math.max(1, …)` 静默抬成 1 | `0` 就是清空全部已收尾循环；负数/小数报错 | `src/loop.js:1106-1107` |
| 6 | `loop_list` 非法 `status` | 报「台账里还没有循环…」（看起来像台账丢了） | 明确报错并列出合法值（`src/loop.js:1088-1089`） | 删 `src/loop.js:1087-1090` 与 `src/index.js:643` 的 `enum` |
| 7 | 台账里 `task.report` | 2000 字裸切片，无任何截断标记 | 300 字 + 自证后缀 + `reportFullChars` / `reportFile` | `src/common.js:32` **与** `cordis.patch.yml:38` **两处必须同时改回 2000**（patch 显式值优先于 `DEFAULTS`，只改 common.js 会让按 patch 安装的 profile 卡在 300，R1 等于没回滚）；R8 的 300 在 `src/render.js:426` |
| 8 | 三个 JSON 出口 | 2 空格缩进 pretty | compact 单行（内容等价，字节更少；按行 diff 的脚本会失效） | `src/common.js:196-198` 改回 `JSON.stringify(value, null, 2)` |

**两条已裁决为「按现状保留、不新增开关」的可回滚项**：

- **R9（回执语义，第 1 条）**：如需退回全文内联，只改 `src/index.js:440-441` 一行——后端返回体里 `digest`（`src/loop.js:818`）、`digest_file`（`src/loop.js:819`）、`task_lines`（`src/loop.js:821`）三个字段都还在，无需动引擎层。
- **R7（`status.json` 按需写，见「台账纪律·只写有变化的」）**：当前跳过率实测 **0.0%**（`ledger.updatedAt` 每次都变，比对永不成立），代码安全、收益为 0。退回无条件写盘：把 `src/store.js:110-111` 换回 `writeJson(paths.status, buildStatus(ledger))`。若要把收益做实，需接受语义变更（`status.json` 的 `updatedAt` 从「最后保存时刻」变成「最后内容变化时刻」），同一串工作流可跳 5/11 次写盘——这是待决策项，本版**未改**。

### 0.6.0 收益（实测，同一 fixtures）

| 口径 | before | after | Δ |
| --- | --- | --- | --- |
| 台账字节投影（内容不变，只换存法 R1+R2+R3） | 806,335 B | 508,960 B | **−36.88%** |
| `loop_collect` 回执 | 13,510 B | 1,773 B | −86.9% |
| `collectRound` 耗时 | 22.22 ms | 12.27 ms | −44.8% |
| `tidyLoop` 耗时 | 12.81 ms | 4.98 ms | −61% |
| `scanTree`（180 文件树） | 7.75 ms | 3.34 ms | 2.3× |
| `loop_status(full)` 全 12 循环 | 335,906 B | 299,178 B | −10.9% |
| `loop_plan` 轮开销 | — | — | −63.5% |
| `src/` 行数 | 2657 | 3017 | +360（报错文案与注释，不是功能膨胀） |

> 行数口径：以 `wc -l` 计换行数为准（`index.js` 697 + `loop.js` 1139 + `store.js` 199 + `render.js` 458 + `common.js` 524 = 3017）；node `readFileSync(..., 'utf8').split('\n')` 因每个文件末尾换行各多计 1 行（5 个文件共 +5，同树读作 3022），勿混用。

`task.report` 占台账体积 38.2% → 6.2%，`round.context` 19.6% → 10.5%。

## 故障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `loop_*` 工具不存在 | 没重启 dsh，或 profile `dsh.profile.bundles` 里没有本包 | 重启；补 bundles |
| `dsh: skipping profile bundle ...` | 本目录缺 `package.json` 或 `main` 指向的文件不存在 | 检查 `package.json`、`src/index.js` |
| `dsh: cannot resolve profile bundle` | profile 的 `link:` 目标目录不存在或没 `package.json` | 恢复目录与 `package.json` |
| 卡片不弹 | `loop_choose` 只返回卡片描述 | 用原生 `ask_user_question` 按 `request` 弹，再回填 `selection` |
| `thin: true` | 回报字数 < `minReportChars` | 让子代理补全六节，或调小阈值 |
| `unregistered_outputs` 非空 | 产物没登记进 `artifacts` | 补登记或挪进 `reports/`、`notes/` |
| `task_id` 与正文 `TASK:` 标记不一致 | 0.6.0 起不再替你挑一个 | 二者改一致；子代理回报首行就是 `<task_id>` 时可整个省掉 `task_id` |
| `该 id 属于已归档任务` | `replace:true` 重排后，旧 id 被归档 | 看报错列出的归档候选；确认是旧回报就丢弃，要复用内容请重新派发 |
| `status 只接受 active / closed` | 拼错了过滤值（旧版会报「台账里还没有循环」） | 改正，或整个省掉 `status` 列全部 |
| `keep 必须是非负整数` | 传了负值/小数 | 传整数；要清空已收尾循环就传 `keep: 0` |
