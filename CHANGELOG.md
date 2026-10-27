# 更新日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

每条改动都带 `文件:行号` 锚点（行号对应 0.6.0 定稿时的 `src/`；若有漂移，用 `grep -n` 复核）。

## [未发布]

（暂无）

## [0.6.0] - 2026-10-27

主题：**契约不再静默猜、回执不再重复贴、台账不再存全文**。
行为改变集中在 8 处，其中 6 处是「旧版会静默给出错误结果」，新版一律报错或降级到文档承诺的默认值。

### 破坏性变更

- **`loop_collect` 回执不再内联整轮 digest**。旧版把每个任务的回报全文粘进回执；新版只给「每任务一行 + 索引路径 + 上下文文件路径」，全文落到 `_index.md` 的「## 本轮汇总」段与 `summaries/` 摘要文件。
  实测三任务轮回执 13,510 B → 1,773 B（−86.9%），代价是需要细节时多一次 `read`。
  锚点：`src/index.js:435-441`（回执拼装）、`src/index.js:437`（R9 注释）、`src/loop.js:820-822`（`task_lines`）、`src/loop.js:281-296`（`tidyLoop` 收 `digest` 折叠进 `_index.md`）、`src/render.js:301`（摘要文件独立承载 digest）。
  **回滚**：把 `src/index.js:440-441` 换回 `lines.push('', '## 本轮汇总', result.digest.trim())`；`result.digest` 仍在返回值里（`src/loop.js:818`），无需改引擎层。

- **`loop_status({brief: false})` 不再等价于 `full: true`**。旧表达式「明确说不」比「什么都没说」拿到更多内容；新版三态显式化：`brief:true` → brief，`full:true` → full，其余（含 `brief:false`、不传）→ brief。
  锚点：`src/loop.js:1066`（`statusOf` 签名）、`src/loop.js:1073-1075`（三分支）、`src/index.js:626`（工具描述写明「`brief:false` 不会给全量」）。
  **回滚**：把 `src/loop.js:1073-1075` 换回 `return { loop, text: full === true ? statusFull(loop) : brief === false ? statusFull(loop) : statusBrief(loop), view: … }`。

- **`loop_record` 的 `task_id` 与正文标记冲突时直接报错，不再静默挑一个**。旧的「`text` 定任务 / `report` 定正文」两套语义会把正文落到调用方没指的任务上；新版 `task_id` 权威，`text` 与 `report` 的 `TASK:` 首行互相矛盾也报错。
  锚点：`src/loop.js:630-676`（`resolveRecordTarget`，其中 `636-643` 两标记矛盾、`645-651` `task_id` 与标记冲突、`653-664` 未命中列现役 id）、`src/loop.js:713-719`（正文来源固化 `report ?? text`）、`src/loop.js:727`（调用点）、`src/index.js:367-374`（`loop_record` 描述与 `task_id`/`text` 参数描述）。
  **回滚**：删掉 `src/loop.js:636-651` 两个 `fail(...)` 分支，退回「`task_id` 优先，否则静默取 `textMarker ?? reportMarker`」。

- **`loop_plan({replace: true})` 后任务 id 顺延，不再复用**。旧版重排后新任务仍从 `t1-1` 编号，迟到的旧回执会命中同号新任务并静默写进去；新版从本轮**用过的最大序号**之后接着编（`t1-3`、`t1-4`），且 `findTask`/`findLiveTask` 命中归档即报错并列出归档候选。
  锚点：`src/loop.js:115-127`（`highestTaskIndex`，同时扫 `tasks` 与 `archivedTasks`）、`src/loop.js:387`（`idOffset`）、`src/loop.js:395`（`id: taskId(roundNumber, idOffset + index + 1)`）、`src/loop.js:606-619`（`findLiveTask` 拒写归档）、`src/store.js:162-187`（`findTask` 两遍扫描 + `archived: true` 标记）。
  **回滚**：`src/loop.js:387` 改回 `const idOffset = 0` 并删掉 `highestTaskIndex`；`src/store.js:173-187` 改回只遍历 `round.tasks`。

- **`loop_prune({keep: 0})` 不再被静默抬成 1**。`0` 现在就是「清空全部已收尾循环」；非整数/负数改为明确报错。
  锚点：`src/loop.js:1096-1109`（`pruneLedger` 入口校验 + `const max = … Math.trunc(Number(keep))`，其中 `1099` 校验、`1106-1107` 取值）、`src/index.js:657`（参数描述同步写「`keep: 0` = 清空全部已收尾循环」）。
  **回滚**：`src/loop.js:1106-1107` 改回 `Math.max(1, Math.trunc(Number(keep)))`。

- **`loop_list({status: 'bogus'})` 不再等同「台账里还没有循环」**。非法值改为明确报错并列出合法值。旧版把拼错的 status 当成「过滤后为空」，于是报「台账里还没有循环…」，让人误判台账丢了。
  锚点：`src/loop.js:1082`（`LOOP_STATUSES` 导出）、`src/loop.js:1084-1090`（先校验再过滤）、`src/index.js:643`（参数 `enum: LOOP_STATUSES`）。
  **回滚**：删掉 `src/loop.js:1087-1090` 的校验分支，并去掉 `src/index.js:643` 的 `enum`。

- **台账里 `task.report` 改为「300 字预览 + 自证截断后缀」，并新增 `reportFullChars` / `reportFile` 字段**。旧口径 2000 字裸切片没有任何标记，读者无法区分「短报告」与「被截断的报告」。下游若按「台账里的 report 就是全文」消费，需要改读 `reports/<task>_a<n>.md`。
  锚点：`src/common.js:32`（`reportKeepChars: 2000` → `300`）、`cordis.patch.yml:38`（patch 里显式钉 `300`；`src/index.js:97` 的 `clampInt` 让显式值优先，所以 patch 安装的 profile 也吃到 R1）、`src/loop.js:547`（写入 `task.reportFullChars`）、`src/loop.js:552-555`（截断 + 后缀）、`src/loop.js:556`（全文照旧写 `reports/`）、`src/loop.js:412-413`（新任务初始化 `reportFullChars: 0` / `reportFile: ''`）、`src/loop.js:526`（历史版本一并带 `reportFullChars`）、`src/render.js:422`（`loop_status(full)` 增「回报全文」指针）、`src/render.js:424-431`（每任务节选 600 → 300 字 + `reportFile` 指针）。
  **回滚**：`src/common.js:32` **与** `cordis.patch.yml:38` **两处必须同时改回 `2000`**（patch 显式值优先于 `DEFAULTS`，只改 common.js 会让按 patch 安装的 profile 卡在 300，R1 瘦身回不去）；`src/render.js:425-426` 的 `300` 改回 `600`（保留 `reportFullChars`/`reportFile` 字段不影响兼容）。

- **三个 JSON 写出口改为 compact 单行**（`loops.json` / `status.json` / `_manifest.json` 共用 `writeJson`）。内容等价、字节变少，但**任何按行 grep / diff 台账的脚本都会失效**。
  锚点：`src/common.js:196-198`（`JSON.stringify(value)`，去 `null, 2`）。`src/index.js:116` 的 `withPayload` 仍保留 pretty —— 那是给模型的回执 payload，与落盘无关。
  **回滚**：`src/common.js:196-198` 改回 `JSON.stringify(value, null, 2)`。

### 新增

- `task.reportFullChars`（原始回报字数）与 `task.reportFile`（全文副本路径）两个字段，让截断可自证。`src/loop.js:547`、`src/loop.js:412-413`、`src/loop.js:526`。
- `writeJsonIfChanged(file, value)`：先读盘逐字节比对，相同就不写。`src/common.js:206-215`。
- `clearScanCache()`：手动失效目录签名缓存，供「刚写完盘要立刻读」的调用方使用。`src/common.js:254`。
- `scanTree` 目录签名缓存（TTL 5 s、上限 4096 目录）。`src/common.js:249-250`、`src/common.js:258`（`readDirSignature`）、`src/common.js:273-337`（主体）、`src/common.js:339`（`dirMtimeMs`）、`src/common.js:347`（`safeStat`）。
- `LOOP_STATUSES` 导出，供 `loop_list` 参数 enum 与引擎层校验共用。`src/loop.js:1082`。
- `sortByUpdatedDesc(list)` 导出（原地排序，新→旧），统一四处列表排序。`src/store.js:142-145`。
- `SETTLED` 成为任务终态集合的**唯一定义点**，全仓不再出现 `'done', 'failed', 'blocked'` 字面量三元组。`src/store.js:140`。
- `taskArtifacts(task)` 局部 helper，统一三处 `Array.isArray(task.artifacts)` 判定。`src/render.js:20-23`。
- `loop_start` 回执新增「cwd 来源」一行（显式传入 / 会话 cwd / **回落进程 cwd 警告**）。`src/index.js:305-308`、`src/index.js:126-131`（`cwd` 解析只返回 `{ path, fallback }`）、`src/index.js:290-291`（`explicit` 在调用处合成）。
- `loop_plan` 的 `mode` 参数新增 `enum: ['parallel','serial']`。`src/index.js:323`、`src/loop.js:353-358`（引擎层二次校验）。

### 修复

1. **P0 · `findTask` 不查归档 → `replace:true` 后迟到回执静默写进现役任务**。`src/store.js:162-187`（两遍扫描、命中归档返回 `archived: true`）、`src/loop.js:606-619`（`findLiveTask` 拒写并列出归档候选）。同时是破坏性变更（见上「id 顺延」条）。
2. **P0 · `loop_record` 的 `text` 定任务 / `report` 定正文两套语义**。`src/loop.js:630-676`。同时是破坏性变更。
3. **P0 · `loop_status(brief:false)` 等价 `full:true`**。`src/loop.js:1073-1075`。同时是破坏性变更。
4. **`loop_plan.mode` 无 enum 校验 → `mode:'banana'` 会真的开一轮**。`src/index.js:323`、`src/loop.js:353-358`。
5. **`loop_choose` 的 `selection: null` 撞工具层 schema（报英文 `"selection" must be an array`）**。`src/index.js:480-483`（`answering` 判定补 `args.selection === null`）、`src/loop.js:930-950`（`[]` / `null` / 都没传 三种态各自措辞的报错）。
6. **`loop_choose` 有多个待答问题时未指定 `question_id` 会记到「最近一个」**（点旧卡落到新问题上）。`src/loop.js:900-912`（`open.length > 1` 直接报错并列出全部 `question_id`）、`src/index.js:476`。
7. **`loop_retry` 次数用尽时首行仍写「返工已开」**，把人引去找一次没发生的重启。`src/index.js:536-541`（按 `result` 是否真有任务重开分支，无 → 「没有任务被重开」）。
8. **`loop_list` 非法 `status` 报「台账里还没有循环」**。`src/loop.js:1084-1090`、`src/index.js:643`。同时是破坏性变更。
9. **`loop_prune({keep:0})` 被 `Math.max(1, …)` 静默抬成 1**。`src/loop.js:1096-1109`、`src/index.js:657`。同时是破坏性变更。
10. **`loop_start` 回落 `process.cwd()` 时不说明用了哪个目录**。`src/index.js:305-308`。
11. **五条最差错误文案改写**（一句话说清「哪里错 + 下一步怎么办」）：`src/loop.js:721-725`（record 缺正文）、`src/loop.js:653-664`（record 未命中，列现役 id）、`src/loop.js`（choose 缺 question，给出完整调用示例）、`src/loop.js:607-617`（归档命中）、`src/loop.js:979-985`（retry 未命中）。范本照 `src/loop.js:97`（找不到循环 → 直接说下一步）/ `src/loop.js:1089`（列出合法值 + 「要列全部就别传」）。
12. **四个高危工具描述重写 + 硬编码台账路径**：`src/index.js:277`（`~/.dsh/plugins/orchestrator-loop/loops.json` → `toPosix(storePaths(resolveHome()).file)`，按当前宿主实测解析）；`loop_plan`（`src/index.js:319`）、`loop_record`（`src/index.js:367`）、`loop_choose`（`src/index.js:463`）、`loop_status`（`src/index.js:626`）四条 description 重写。

### 性能

| 项 | 锚点 | 实测 |
| --- | --- | --- |
| **R1** 台账内 `task.report` 预览 2000 → 300 字 + 截断后缀 | `src/common.js:32`、`cordis.patch.yml:38`（必须与前者同值，回滚时同步）、`src/loop.js:547-556` | 带 report 的 82 条任务合计 171,382 B → 50,342 B（−70.6%） |
| **R2** `writeJson` compact 单行 | `src/common.js:196-198` | 真实台账 891,342 → 806,682 B（−9.5%）；pretty 口径白付 +10.50% |
| **R3** `round.context` memo cap 1200 → 400 字 | `src/loop.js:443-448` | `round.context` 合计 157,740 → 84,889 B（−46.2%） |
| **R4** `collectRound` 复用 `auditRound` 结果 | `src/loop.js:798-802`（调用点）、`src/loop.js:281`（`tidyLoop` 签名收 `precomputed`）、`src/loop.js:286`（`const audit = precomputed ?? auditRound(...)` 复用点） | `collectRound` 22.22 → 12.27 ms（−44.8%）；`tidyLoop` 12.81 → 4.98 ms（−61%） |
| **R5** `scanTree` 目录签名缓存 | `src/common.js:249-337` | 180 文件临时树 7.75 → 3.34 ms（2.3×） |
| **R7** `status.json` 按需写 | `src/common.js:206-215`、`src/store.js:20`、`src/store.js:110-111` | 跳过率 **0.0%**（`updatedAt` 每次都变，比对永不成立）—— 代码安全但收益为 0，见「已知限制」 |
| **R8** `loop_status(full)` 每任务节选 600 → 300 字 + `reportFile` 指针 | `src/render.js:422-431` | 全 12 循环 335,906 → 299,178 B（−10.9%） |
| **R9** `loop_collect` 回执不再内联 digest | `src/index.js:435-441`、`src/loop.js:820-822` | 回执 13,510 → 1,773 B（−86.9%） |
| **R11** `digestMarkdown` 只算一次 | `src/loop.js:790-794` | 每轮 digest 渲染 2 次 → 1 次（0.013 ms/次，随任务数线性） |

三项可叠加口径（R2+R1+R3，内容不变只换存法）：真实台账字节投影 806,335 → 508,960 B，**−36.88%**。
`task.report` 占台账体积 38.2% → 6.2%，`round.context` 19.6% → 10.5%。

### 内部重构

- **删 5 个零引用导出**：已删除符号 `normalizeRoot` / `fileSize`（`src/common.js`）、`REPORT_SECTIONS`（`src/loop.js`）、`versionLine` / `uniquePaths`（`src/render.js`）——符号已不存在，全仓 0 调用、`_probes/` 0 依赖，**无行号可指**（原行号随代码移动失效，故不再标注）。
- **删级联死 import 与两个浅包装**：`src/render.js:9-16` import 块 7 项收 4 项（删 `VERSION` / `displayPath` / `uniqueStrings`；随后内联 `displayPath` 又补入 `toPosix`，故现为 `common.js` 5 项 + `store.js` 1 项）；`displayPath(file)`（原 `src/common.js:127-129`，15 个调用点内联为 `toPosix(...)`）、`config0(loop)`（原 `src/render.js:373-375`，1 个调用点内联）。
- **`SETTLED` 全量归一**（逐字节零输出差异）：定义点 `src/store.js:140`；消费点 `src/loop.js` 四处（`678` / `776` / `780` / `1021`）、`src/index.js:38`、`src/render.js` 七处（`72` / `206` / `250` / `335` / `388` / `395` / `453`）。
- **四份重复排序归一** 到 `sortByUpdatedDesc`（`src/store.js:142-145`）：`src/loop.js:1077`（`statusOf` 内排序调用，函数自 `1066` 起）、`src/loop.js:1093`（`listLoops` 内排序调用，函数自 `1084` 起）、`src/loop.js:1109`（`pruneLedger` 内排序调用，函数自 `1096` 起）、`src/store.js:117`（`buildStatus` 内排序调用，函数自 `116` 起）。
- **三份 `Array.isArray(task.artifacts)` 归一** 到 `taskArtifacts`（`src/render.js:20-23`）：调用点 `src/render.js:30`、`src/render.js:76`、`src/render.js:191`。
- 净变化：`src/` 行数 2657 → 3017（+360）。分解：t2-1 契约修复 +391、t2-2 体积/性能 +0（同批注释与改写已在 391 内）、t2-3 瘦身 −31；t2-2 后续把 `common.js` 的注释块再并入 +11 → 终态 3017。
  说明：本版**不是**瘦身版，行数增长来自「报错文案写清下一步」与「代码注释交代为什么」——这两类行是契约层的实质内容。
  **行数口径**：以 `wc -l` 计换行数为准（`index.js` 697 + `loop.js` 1139 + `store.js` 199 + `render.js` 458 + `common.js` 524 = 3017）；node `fs.readFileSync(..., 'utf8').split('\n')` 会因每个文件末尾换行各多计 1 行（5 个文件共 +5，同一工作树读作 3022），两处口径不可混用。

### 已知限制

- **R5**：TTL 5 s 内**原地改写**文件不动目录 mtime，缓存仍返回旧 `size`。写后立即读的调用方应调 `clearScanCache()`（`src/common.js:254`）。
- **R7**：`saveLedger` 每次都刷新 `ledger.updatedAt`（`src/store.js:103`），`buildStatus` 把它原样抄进 `status.json`（`src/store.js:121`），于是逐字节比对永不成立，跳过率 0.0%。若把 `updatedAt` 排除在比较之外，同一串工作流有 45.5%（5/11）的写盘可跳——这是**语义决策**（`status.json` 的 `updatedAt` 从「最后保存时刻」变成「最后内容变化时刻」），未在本版改。
- **R1/R8 对历史任务**：`reportFullChars` / `reportFile` 是老任务没有的字段，**不回填**；R8 用 `task.reportFile ?? 'reportFile'` 兜底，R1 的后缀只在**新写入**时生成。旧任务的 2000 字裸切片保持旧行为。
- `boundary`：`loop_record` 的 `report` 与 `text` 双给且标记**一致**时仍静默接受（只在矛盾时报错）——按「体积策略」留待后续决定是否合并两参数。
- `findTask` 现为两遍全表扫描（rounds × tasks）；12 循环量级无感，若未来上台账分片可顺势加索引。

### 测试与探针

- `_probes/` 三处 fixture 因新契约调整（**属探针自身缺陷，不是引擎改动**）：`_probes/perf/_ledger-perf.mjs:39-42`、`_probes/perf/_scaling.mjs:20`（去掉 fixture 首行 `TASK: t1-1`，否则 `resolveRecordTarget` 会把「显式 `task_id` + 文本固有标记」判成冲突）；`_probes/perf/_scaling.mjs:91-118`（把副本台账里所有绝对 `workDir` 重指到 `replicaHome/wd/<loopId>`，否则 `tidyLoop` 会按台账里的绝对路径改写真实产物目录）；`_probes/smoke/_smoke.mjs:71-74`（自办回报的 `TASK:` 首行改成自身 id）。
- 回归：`node --check src/*.js` 5/5 OK；`_probes/once/` 9 个 smoke/e2e 探针 9/9 `exit=0`；`_probes/perf/_ledger-perf.mjs` 与 `_probes/perf/_scaling.mjs` 均 `rc=0`。
- t2-3 瘦身的等价性：`_smoke.mjs` 3111 B、`_smoke2.mjs` 2626 B、`_regression-probe.mjs` 2092 B，归一化（抹掉随机 loop id / 临时目录 / 时间戳）后**全部 IDENTICAL**。

### 回滚（整包）

```bash
cd /d/AI_Work/UNO/01_项目/dsh-tools/dsh-orchestrator-loop
cp -a _bak/src-20261027/*.js src/
sha256sum -c _bak/src-20261027/SHA256SUMS.txt
```

> 公开仓库**不含** `_bak/`（含真实台账副本，已在 `.gitignore` 排除）。从 GitHub 安装的用户没有这份回滚基线，请改用 `git checkout <你上次部署的 commit>` 或 `git reset --hard <旧 tag>`；`_bak/src-20261027/` 只存在于开发者本机。

单条回滚方法见上文「破坏性变更」各项末尾。**R7 与 R9 都是可回滚项**：R9 的回执语义只需改 `src/index.js:440-441` 一行（后端的 `digest` / `digest_file` / `task_lines` 字段都保留在返回值里）；R7 的写盘策略只需把 `src/store.js:110-111` 换回 `writeJson(paths.status, buildStatus(ledger))`。

## [0.5.2] - 2026-10-21

历史版本，未在本文件中逐条追溯（台账纪律与存储瘦身口径见 `_bak/src-20261021`）。

[0.6.0]: https://github.com/kkinasep-cloud/dsh-orchestrator-loop/releases/tag/v0.6.0
