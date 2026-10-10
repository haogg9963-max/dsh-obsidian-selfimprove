# dsh-obsidian-selfimprove
DSH 自改进循环 + Obsidian 跨对话记忆库。由 self-improving-agent 桥接驱动：提议 → 人工批准 → 自动开 draft PR。

> 本仓库是 DSH（DeepSeek Harness）的**自改进目标仓库**。Agent 对自己的配置（提示词、skill、
> 工具描述）提出改动，经人工明确批准后，由宿主自动建分支、提交、推送并开 **draft PR**。
> 本 README 本身就是该闭环的产物：它由一次自改进提案生成，经人工批准后以 draft PR 提交。

## 它解决什么问题

Agent 的失败往往是**可重复**的：跳过某个步骤、提示词含糊、用错工具。传统做法是人工去改提示词，
改完就散了，下次换个会话又忘。本闭环把「用户对 Agent 的反馈」变成**可评审的代码改动**：

- 改动走 GitHub review 流程，不是悄悄改本地文件
- 每次改动都有理由（reason）与风险等级（risk）
- 未经人工明确批准，绝不推送

## 闭环怎么运作

```
提议 publish ──► 人工批准 request ──► 应用 apply ──► draft PR
（只写本地记录）  （签发一次性令牌）    （校验令牌）     （人工再决定合不合）
```

1. **publish** — Agent 读取目标文件，构造一个**最小片段替换**（`originalSnippet` →
   `proposedSnippet`），并附上理由与风险等级。此步**不碰远端**，只在本地落一条提案记录。
2. **request** — 用户明确批准后，宿主签发**一次性随机令牌**（只存 SHA-256）。这是真正的批准闸门：
   令牌之所以存在，只因为用户在批准之后触发了这一步。
3. **apply** — 回传令牌校验通过后，才建分支、提交、推送，并通过 GitHub REST API 开 **draft PR**。

`apply` 会硬性拒绝以下情况：片段出现 0 次、出现多于 1 次（歧义）、文件不存在、令牌错误或已被消费。

## 安全设计

| 机制 | 作用 |
|---|---|
| 一次性批准令牌 | 防止「模型自称已获批准」；令牌一次性消费 |
| 片段唯一性校验 | 不接受歧义 diff，避免改错位置 |
| 默认开 draft PR | 不直接影响主干，人工复核后才合并 |
| fine-grained PAT | 权限锁定在这一个仓库，仅 `Contents:rw` + `Pull requests:rw` |
| 令牌只走环境变量 | 不写入任何文件；认证只在单次调用内有效 |
| 记忆库强制脱敏 | 派生记忆中不放凭据（GitHub PAT、`sk-`、AWS、JWT、私钥块等） |

## 依赖与前置条件

- **Node.js** ≥ 18
- **git** 在 PATH 上（用于克隆工作副本与推送分支）
- 一个 **fine-grained PAT**，权限为 `Contents: Read and write` + `Pull requests: Read and write`，
  Repository access 仅勾选本仓库

## 环境变量

| 变量 | 说明 |
|---|---|
| `SELF_IMPROVING_AGENT_REPO` | `owner/name`，必填 |
| `SELF_IMPROVING_AGENT_GITHUB_TOKEN` | PAT，仅 `apply` 需要 |
| `SELF_IMPROVING_AGENT_BASE_BRANCH` | 默认 `main` |
| `SELF_IMPROVING_AGENT_CACHE_DIR` | 工作副本位置 |
| `SELF_IMPROVING_AGENT_PROPOSALS_DIR` | 提案记录位置 |

## 已知陷阱

- **`core.autocrlf=true` 会静默破坏片段匹配。** 工作区被改写成 CRLF 后，用 `\n` 书写的多行片段
  匹配 **0 次**，报错只说 "found 0"，完全不提示根因是换行符。务必设 `core.autocrlf=false`。
- **上游默认忽略自定义提案目录。** 不显式传 `proposalsDir` 时记录会写到 `./runs/improvements`，
  与读取路径不一致，出现「找不到刚创建的提案」。
- **Windows PowerShell 5.1 会把含中文的引号字符串解析崩。** 报错位置与真实原因可能相差几十行。
  脚本应保持纯 ASCII，本地化文本交给 Node。

## 相关

- 上游项目：[BerriAI/self-improving-agent](https://github.com/BerriAI/self-improving-agent)（MIT）
