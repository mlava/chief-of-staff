# Chief of Staff

[English](./README.md) | 简体中文

这是 `Chief of Staff` 的简体中文说明文档。英文版 [README.md](./README.md) 仍然是权威版本；如果两者存在差异，请以英文版为准。

Chief of Staff 是一个嵌入在 Roam Research 中的 AI 助手。它可以把你的 Roam graph 连接到大语言模型（Anthropic、OpenAI、Google Gemini、Mistral），也可以通过 [Composio](https://composio.dev) 连接外部工具，让你无需离开 Roam 就能提问、搜索、管理任务，并跨应用编排动作。

https://www.loom.com/share/9aa3c07de0f147af971d2fc54fe65e4a

---

## 它能做什么

- **随时提问**：可以通过命令面板或常驻的浮动聊天面板使用。助手能够读取你的 graph、创建 block、调用外部工具；所有写操作都会先征求你的确认。常见请求（任务搜索、记忆保存、工具列表等）会直接走本地逻辑，不需要 LLM 调用。
- **多 LLM 提供商支持**：可将 Anthropic Claude、OpenAI GPT、Google Gemini 或 Mistral 设为主提供商。某个提供商不可用时，助手会自动切换到下一个已配置的提供商。
- **Better Tasks 集成**：可以直接用自然语言搜索、创建、修改 Better Tasks（父级为 TODO/DONE，子级带 `BT_attr*` 属性）。支持按截止日期、项目、状态和自由文本过滤。
- **持久记忆**：每次运行时都会把专用记忆页面内容加载到 system prompt 中。
- **技能路由**：读取 `Chief of Staff/Skills` 页面，把精简技能索引注入 prompt；需要时还能按名称调用具体技能。若技能声明了必需数据源，系统会先把数据收齐再写输出。
- **Inbox 输入通道**：把 block 丢到 `Chief of Staff/Inbox`，助手会自动以只读模式处理，并把响应挂在原 block 下，再移动到当日日记页。
- **Composio 工具连接**：可通过 Composio MCP 连接 Google Calendar、Gmail、Todoist 以及数百种其他应用。
- **本地 MCP 集成**：可连接运行在本机上的 MCP server，例如 Zotero、GitHub 或自定义工具。工具很多的 server 会走两阶段路由，降低 token 成本；连接失败也会自动重试。
- **远程 MCP 集成**：可连接任何支持 StreamableHTTP 或 SSE 的远程 MCP server。最多可配置 10 个远程 server，并支持自定义认证头，包括 OAuth Bearer token。
- **定时任务**：支持创建周期性任务、一次性任务和提醒任务。
- **工具调用自愈**：如果模型“声称自己做了某事”但实际没有发起工具调用，扩展会自动检测、纠偏、重试，并在需要时升级到更强模型。
- **三档模型自动路由**：默认走便宜快速的模型；消息尾部追加 `/power` 或 `/ludicrous` 可强制更强档位，也可以交给系统自动升级。
- **Dry-run 模式**：可以先模拟执行即将发生的写操作。
- **引导式 onboarding**：首次运行会带你完成 API Key、记忆页和聊天面板初始化。

---

## 依赖要求

| 依赖 | 说明 |
|---|---|
| 至少一个 LLM API Key（Anthropic、OpenAI、Gemini 或 Mistral） | 浏览器直接调用 API，费用按各自提供商计费 |
| Composio 账号 + API Key | 只有在你需要外部工具集成时才需要 |
| [Better Tasks](https://github.com/mlava/recurring-tasks) 扩展 | 只有在你要用 Better Tasks 深度任务集成时才需要 |

---

## 安装与配置

### 1. 配置你的 LLM

打开 **Settings > Chief of Staff**，填写以下内容：

- **Your Name**：助手称呼你的方式
- **Assistant Name**：聊天头部和 toast 中显示的名字，默认 `Chief of Staff`
- **LLM Provider**：`anthropic`（默认）、`openai`、`gemini` 或 `mistral`
- **API Keys**：每个 provider 都有单独字段。只配置你当前选中的 provider 也能用；如果想开启自动 failover，建议把多个 provider 一起配上。
  - Anthropic API Key（`sk-ant-...`）
  - OpenAI API Key（`sk-...`），语音转写（Whisper）也需要它
  - Google Gemini API Key（`AIza...`）
  - Mistral API Key
- **LLM Model**：留空表示使用默认模型；也可以手动填任意该 provider 支持的 model id
- **Response Verbosity**：控制回复长度和最大输出 token。`concise`（1,200 token，偏简洁）、`standard`（2,500 token，默认）、`detailed`（4,096 token，较详细）
- **Debug Logging**：打开后会输出更详细的调试日志
- **Dry Run**：一次性模拟下一次写操作，执行后会自动关闭
- **Ludicrous mode failover**：允许在 power-tier 全部失败后升级到最贵、最强的模型

默认模型分档如下：

| 档位 | Anthropic | OpenAI | Gemini | Mistral |
|---|---|---|---|---|
| Mini（默认） | claude-haiku-4-5 | gpt-5-mini | gemini-3.1-flash-lite-preview | mistral-small |
| Power（`/power`） | claude-sonnet-4-6 | gpt-4.1 | gemini-3-flash-preview | mistral-medium |
| Ludicrous（`/ludicrous`） | claude-opus-4-6 | gpt-5.4 | gemini-3.1-pro-preview-customtools | mistral-large |

#### 档位如何工作

默认情况下，请求会进入 **mini** 档，速度更快、成本更低。你也可以在聊天面板里把消息后缀写成 `/power` 或 `/ludicrous`，强制使用更强模型，例如：`summarise my week /power`。这个后缀会在真正发给模型前被剥离。

系统也支持自动升档。它会综合评估三个维度：需要多少工具（40% 权重）、提示复杂度（35%）、对话轨迹（25%）。总分超过 `0.45` 时会自动升级到 power。只要请求涉及“大型 MCP server 的路由调用”（也就是工具数超过 15），也会直接升到 power。

#### 自动故障切换

如果主 provider 出错或不可用，助手会自动尝试下一个已配置 provider。失败的 provider 会进入 60 秒冷却期；如果所有 power-tier provider 都失败，而且你开启了 **Ludicrous mode failover**，系统会继续升级到最强模型兜底。

> **安全说明：** API Key 存储在 Roam Depot 的 settings store（浏览器 IndexedDB）中。它们只会被直接发送到对应 LLM provider 的 API endpoint。不要在共享或公开的 Roam graph 中保存这些密钥。

### 2. 连接 Composio（可选）

Composio 让助手可以通过 MCP 调用外部 API，例如 Gmail、Google Calendar、Todoist 等。**如果你只需要 graph 和任务功能，这一节可以完全跳过。**

如果你确实要接外部工具，依赖链是这样的：

> **你想用外部工具**（Gmail、Calendar、Todoist……）
> → 你需要一个 **Composio account**
> → Composio 的 MCP endpoint 在浏览器里需要 **CORS proxy**
> → 这个 proxy 跑在 **Cloudflare Workers** 上

简化后就是：Cloudflare 账号 → 部署 proxy → Composio 账号 → 在扩展里配置 → 连接工具。

#### 2a. 部署 CORS proxy

由于 Roam 跑在浏览器里，跨域请求 Composio MCP endpoint 会被浏览器阻止。因此需要一个很小的 Cloudflare Worker 为它补上 CORS header。作者已经在单独仓库里提供了可直接部署的版本：[`roam-mcp-proxy`](https://github.com/mlava/roam-mcp-proxy)。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mlava/roam-mcp-proxy)

你也可以手动部署：

```bash
git clone https://github.com/mlava/roam-mcp-proxy.git
cd roam-mcp-proxy
npm install
npx wrangler login   # 首次登录 Cloudflare
npx wrangler deploy
```

Wrangler 会输出你的 worker URL，例如：`https://roam-mcp-proxy.<you>.workers.dev`。

#### 2b. 配置扩展

1. 创建 [Composio](https://composio.dev) 账号，并在后台复制 **API key**（形如 `ak_...`）
2. 在 **Settings > Chief of Staff** 中，把 **Composio Proxy URL** 设置为你的 proxy 基础 URL，不需要手动补路径：
   ```text
   https://roam-mcp-proxy.<you>.workers.dev
   ```
3. 在同一个设置面板中填入你的 **Composio API Key**
4. 从命令面板运行 **Chief of Staff: Connect Composio**
5. 再运行 **Chief of Staff: Install Composio Tool**，输入工具 slug，例如 `GOOGLECALENDAR`、`GMAIL`、`TODOIST`，然后在新标签页完成 OAuth 授权

### 3. 连接本地 MCP servers（可选）

本地 MCP server 让助手能调用你电脑上的工具，例如 Zotero、本地 GitHub MCP server 或自定义脚本。大多数 MCP server 是 `stdio` 通信，但浏览器扩展只能直接访问 HTTP。Chief of Staff 借助 [supergateway](https://github.com/supercorp-ai/supergateway) 自动把 stdio MCP 包成 SSE endpoint。

#### 一键配置流程

1. 打开命令面板，运行 **Chief of Staff: Generate Supergateway Script**
2. 粘贴你的 `mcpServers` JSON 配置。格式和 Claude Desktop、Cursor、Cline、Claude Code 等 MCP 客户端一致，只需要 `"mcpServers"` 里的 server 条目
3. 扩展会自动解析配置、分配端口（从 8100 开始），并生成平台对应的安装脚本：
   - **macOS**：生成 `launchd` plist，放在 `~/Library/LaunchAgents/`
   - **Linux**：生成 `systemd` user service
   - **Windows**：在 `\COS\` 下创建 Scheduled Tasks
4. 点击 **Download Script**。同时，端口分配也会自动保存到扩展设置里
5. 在终端执行这个脚本（macOS/Linux 记得先 `chmod +x`；Windows 用 PowerShell）
6. 回到 Roam，在配置弹窗里点击 **Connect**，或者运行 **Chief of Staff: Refresh Local MCP Servers**

常见配置文件位置：

| 客户端 | 配置文件 |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS） / `%APPDATA%\\Claude\\claude_desktop_config.json`（Windows） |
| Claude Code | 项目根目录下的 `.claude/settings.json` 或 `.mcp.json` |
| Cursor | `.cursor/mcp.json`（项目级）或 `~/.cursor/mcp.json`（全局） |
| VS Code (Copilot) | 项目根目录下 `.vscode/mcp.json` |
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

示例：

```json
{
  "zotero": {
    "command": "npx",
    "args": ["-y", "zotero-mcp"]
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
  }
}
```

#### 底层工作方式

- 扩展会连接每个 `localhost:{port}/sse` endpoint，使用浏览器原生 `EventSource`
- 工具会在连接时通过 `listTools()` 发现，并缓存在当前 session 中
- 如果某个 server 的工具数 **不超过 15**，会直接注册给模型调用
- 如果工具数 **超过 15**，会走两阶段路由：`LOCAL_MCP_ROUTE` 先选工具，`LOCAL_MCP_EXECUTE` 再执行
- 当 prompt 明确提到某个已连接 server（例如 Zotero、GitHub），请求会自动升档到 power
- 首次连接时会对 tool schema 做 SHA-256 pin；后续连接如果 schema 有漂移，会发出提示

更详细的手工 supergateway 说明可见 [`public/mcp-supergateway-playbook.md`](public/mcp-supergateway-playbook.md)。

### 4. 连接远程 MCP servers（可选）

远程 MCP server 让助手能直接调用互联网另一端托管的工具服务，例如个人知识库服务、生产力 API 或自定义云端工具。与 Composio 不同，它不需要本地进程；与本地 MCP 不同，它也不需要你自己跑 supergateway。

#### 配置方式

1. 在 **Settings > Chief of Staff** 中开启 **Show Integration Settings**
2. 把 **Remote MCP Servers** 设置成你要连接的数量（1 到 10）
3. 对每个 server，填写以下字段：

| 字段 | 是否必填 | 示例 |
|---|---|---|
| **URL** | 是 | `https://my-server.example.com/mcp` 或 `https://my-server.example.com/sse` |
| **Display name** | 否 | `Open Brain` |
| **Auth header name** | 否 | `x-brain-key`、`Authorization` |
| **Auth token** | 否 | API key 或 `Bearer <your-token>` |

4. 从命令面板运行 **Chief of Staff: Refresh Remote MCP Servers**，或者直接重载扩展

#### 底层工作方式

- 同时支持两种 transport：StreamableHTTP（优先）和 SSE
- 如果 SSE 连接失败，会自动退回到同主机的 StreamableHTTP（例如 `/sse` 改为 `/mcp`）
- 工具调用直接使用 JSON-RPC POST，兼容执行后立即关闭 SSE 的 stateless server
- 工具数不超过 15 时直接注册；超过 15 时走 `REMOTE_MCP_ROUTE` / `REMOTE_MCP_EXECUTE`
- Auth token 存在 Roam Depot（浏览器 IndexedDB）中，日志会自动脱敏
- 本地 MCP 的供应链安全策略在远程 MCP 上同样适用：扫描 tool description、schema pinning、连接记录等

#### OAuth Bearer Token 认证

像 Notion、Atlassian、Sentry 这样的服务通常要求 OAuth Bearer token。由于 Roam Research 本身没有 OAuth redirect URI，这类 token 需要在外部先拿到，再手工填回设置中：

1. 在目标服务的开发者控制台里创建 **Internal Integration**
2. 复制 integration token
3. 在 Roam Depot 设置里把 **Auth header name** 设成 `Authorization`，把 **Auth token** 设成 `Bearer <your-token>`

> **CORS 说明：** Roam 会优先通过内建的 CORS proxy（`corsAnywhereProxyUrl`）转发远程 MCP 请求；如果这个 proxy 不可用，扩展会回退为直连。

---

## 命令面板

| Command | 作用 |
|---|---|
| **Chief of Staff: Ask** | 打开输入框，让助手结合 LLM 与可用工具来回答你的问题 |
| **Chief of Staff: Toggle Chat Panel** | 显示或隐藏浮动聊天面板 |
| **Chief of Staff: Run Onboarding** | 启动首次引导流程 |
| **Chief of Staff: Bootstrap Memory Pages** | 创建缺失的记忆页 |
| **Chief of Staff: Bootstrap Skills Page** | 创建 `Chief of Staff/Skills` 示例页 |
| **Chief of Staff: Show Memory Snapshot** | 在浏览器控制台输出当前加载的记忆内容 |
| **Chief of Staff: Show Skills Snapshot** | 在控制台输出当前技能及注入的技能索引 |
| **Chief of Staff: Refresh Skills Cache** | 在编辑技能页后刷新技能缓存 |
| **Chief of Staff: Connect Composio** | 连接到 Composio MCP endpoint |
| **Chief of Staff: Disconnect Composio** | 断开当前 Composio 连接 |
| **Chief of Staff: Reconnect Composio** | 断开后重新连接 |
| **Chief of Staff: Install Composio Tool** | 输入 tool slug 并开始安装/授权流程 |
| **Chief of Staff: Deregister Composio Tool** | 从 Composio 和本地状态中移除某个工具 |
| **Chief of Staff: Test Composio Tool Connection** | 测试某个 Composio 工具当前是否可达 |
| **Chief of Staff: Refresh Tool Auth Status** | 重新检查等待 OAuth 完成的工具 |
| **Chief of Staff: Discover Toolkit Schemas** | 发现并缓存所有已连接 Composio toolkit 的 schema |
| **Chief of Staff: Show Schema Registry** | 在控制台输出当前 schema registry |
| **Chief of Staff: Clear Conversation Context** | 清空聊天上下文与历史 |
| **Chief of Staff: Generate Supergateway Script** | 根据 `mcpServers` JSON 生成本地 MCP 安装脚本 |
| **Chief of Staff: Refresh Local MCP Servers** | 重新连接所有本地 MCP server |
| **Chief of Staff: Refresh Remote MCP Servers** | 重新连接所有远程 MCP server |
| **Chief of Staff: Show Stored Tool Config** | 在控制台输出工具配置 |
| **Chief of Staff: Show Last Run Trace** | 输出最近一次 agent run 的迭代、工具调用与耗时 |
| **Chief of Staff: Debug Runtime Stats** | 输出当前运行时状态与缓存情况 |
| **Chief of Staff: Reset Token Usage Stats** | 重置本次会话的 token 统计与费用显示 |
| **Chief of Staff: Show Scheduled Jobs** | 在控制台输出当前所有定时任务 |

---

## 聊天面板

浮动聊天面板默认位于右下角，提供持续的会话体验。它支持拖动、缩放，并能跨 session 保留最多 80 条消息。你可以直接用它连续追问，而不必反复打开命令面板。

- 按 **Enter** 发送，按 **Shift+Enter** 换行
- **Arrow Up / Down** 可循环浏览历史输入，类似终端
- `/clear` 可清空上下文和历史
- 消息末尾追加 `/power` 或 `/ludicrous` 可为这次请求指定更强模型
- 头部的 **cost indicator** 会显示累计 API 花费；悬停时可查看更细的 token 和分模型成本拆解
- 每条助手消息右下角都有一个 pin 图标，可一键追加到当日日记页
- 回复里的 **[[Page references]]** 和 **((block references))** 都是可点击的
- 模型输出支持流式逐步渲染

面板打开时会抑制不必要的 toast，并在刷新后保留会话历史和位置。

### 主题自适应

聊天面板会自动识别并适配你当前的 Roam 主题，包括 Roam Studio 自定义主题和 Blueprint dark mode。它结合了 CSS class 标记（如 `.bp3-dark`）、系统 `prefers-color-scheme`、以及对实际渲染背景颜色亮度的实时采样，因此即使主题没有标准 dark-mode 标记，也能正确识别。

---

## 即时命令（不需要 LLM）

许多高频任务都会经过一个**确定性路由器**：它先匹配你的输入模式，再直接调用 Roam API，不需要 LLM 往返、不产生 API 成本、响应几乎即时。即便你没有配置任何 LLM API Key，这些功能也能正常使用。

### 快速记录

| 你输入 | 会发生什么 |
|---|---|
| `add "buy milk" to today` | 在今天的 daily page 创建一个 block |
| `note meeting at 3pm with Sarah` | 同样会记录到今天页面 |
| `add check quarterly numbers to today's page` | 引号不是必须的 |

### 搜索与读取

| 你输入 | 会发生什么 |
|---|---|
| `search project planning` | 全文搜索你的 graph |
| `find meeting notes` | 和 `search`、`look up` 类似 |
| `show me [[Project Plan]]` | 返回页面内容（前 4 层，最多约 3K 字符） |
| `what's on today's page` | 显示今日日记页内容 |

### 任务

| 你输入 | 会发生什么 |
|---|---|
| `show my todos` | 列出未完成 TODO（若安装 Better Tasks 会优先使用） |
| `pending tasks` | 与 `list todos`、`open tasks` 类似 |
| `show done tasks` | 列出已完成 DONE 项目 |

### 导航

| 你输入 | 会发生什么 |
|---|---|
| `open [[Project Plan]]` | 打开对应页面 |
| `go to today` | 打开今日日记页 |
| `go to yesterday` | 打开昨日日记页 |
| `open inbox` | 打开 `Chief of Staff/Inbox` |
| `open skills` | 打开 `Chief of Staff/Skills` |

### Graph 信息

| 你输入 | 会发生什么 |
|---|---|
| `graph stats` | 返回页面数、block 数和今日活动情况 |
| `what changed today` | 显示最近 24 小时变更过的页面 |
| `backlinks for [[Page]]` | 查看某页的 backlinks |
| `stats for [[Page]]` | 查看页面的创建/编辑时间、block 数、引用数等 |

### Sidebar 与界面

| 你输入 | 会发生什么 |
|---|---|
| `open sidebar` | 打开右侧栏 |
| `open left sidebar` | 打开左侧栏 |
| `close sidebar` | 关闭右侧栏 |
| `open [[Page]] in sidebar` | 在右侧栏打开某页面 |

### 工具类

| 你输入 | 会发生什么 |
|---|---|
| `undo` | 撤销最近一次 Roam 操作 |
| `redo` | 重做最近一次撤销 |
| `what time is it` | 显示当前时间和今天的日记页标题 |
| `help` | 返回与上下文相关的能力说明 |
| `tools` | 按类别列出所有可用工具 |
| `remember that X` | 保存到记忆中 |
| `run daily briefing` | 直接按名称触发一个技能 |

以上即时命令在聊天面板和命令面板里都能用，通常能在 100ms 内返回，因为没有 LLM 网络调用。

---

## 任务集成

Chief of Staff 能识别自然语言任务请求，并把常见任务查询交给专门的处理器，不需要 LLM：

- *“Find my better tasks due this week”*
- *“Show overdue tasks for Planning Committee”*
- *“Create a better task to review the budget due next Friday”*
- *“List my top 10 TODO tasks”*
- *“What's overdue?”*

这些请求由一个快速的确定性路由器处理，直接调用合适的 Roam 查询，因此速度快且不产生成本。

### 安装 Better Tasks 时

如果安装了 [Better Tasks](https://github.com/mlava/recurring-tasks) 扩展，任务查询会使用 `BT_attrDue`、`BT_attrProject` 等属性，支持按截止日期、项目、状态、优先级、精力、GTD context 和自由文本进行过滤。你也可以直接用自然语言创建 Better Task，助手会自动填好合适的属性。

已识别属性包括：`BT_attrProject`、`BT_attrDue`、`BT_attrStart`、`BT_attrDefer`、`BT_attrRepeat`、`BT_attrGTD`、`BT_attrWaitingFor`、`BT_attrContext`、`BT_attrPriority`、`BT_attrEnergy`

### 未安装 Better Tasks 时

普通的 `{{[[TODO]]}}` / `{{[[DONE]]}}` 搜索仍然可用。虽然这时不能按属性过滤（例如截止日期、项目等），但基础任务列表与搜索仍是完整可用的。该模式下，`Chief of Staff/Projects` 页面也会一并加载进记忆，为助手提供项目上下文。

---

## 记忆与学习

Chief of Staff 会在每次 LLM 运行前自动加载记忆内容，不需要显式工具调用。

安装 Better Tasks 时会加载这些页面：

- `Chief of Staff/Memory`
- `Chief of Staff/Inbox`
- `Chief of Staff/Decisions`
- `Chief of Staff/Lessons Learned`
- `Chief of Staff/Improvement Requests`

如果没安装 Better Tasks，还会额外加载 `Chief of Staff/Projects`。

记忆内容默认限制为每页最多 3,000 字符、总计最多 8,000 字符。页面通过 live pull watch 监控，更新后几秒内就会生效，无需重启扩展。

你可以在聊天中直接说“remember this...”“note this idea...”之类来保存记忆，也可以通过原生 `cos_update_memory` 工具路径写入。

### 记忆保护

因为记忆会进入每次 system prompt，所以它是 prompt injection 的高价值目标。为避免恶意内容长期污染未来对话，所有记忆写入都会经过 28 类模式扫描，包括指令式语言、绕过审批、隐藏式嵌入、数据外流、工具操控等。一旦命中，会在写入前直接阻止，并返回错误提示，要求重新表述。

---

## Inbox

`Chief of Staff/Inbox` 是一个半自动输入通道。只要把 block 放进这个页面，助手就会自动以**只读模式**处理它：可以搜索、读取、收集信息，但不能创建、更新、移动或删除任何 block，也不能发送邮件。处理结果会挂在原 block 下，然后该条目会被移动到今日日记页的 “Processed Chief of Staff items” 标题下面。

---

## Skills

Skills 是一组自定义说明，用来教助手执行特定工作流。它们存放在 graph 中的 `Chief of Staff/Skills` 页面，助手会自动加载并可随时调用。

### 页面结构

每个 skill 都是一个顶层 block（技能名），下面的子级 block 是说明内容。技能名尽量简短清晰，因为它们会以精简索引形式进入 system prompt。

```text
- Weekly Review
  - Objective: Conduct a weekly review for the past 7 days.
  - Sources: Chief of Staff/Projects, Chief of Staff/Decisions, Better Tasks.
  - Output: Top priorities, overdue items, next-week plan.
  - Write output to today's daily page under a "Weekly Review" heading.
```

```text
- Daily Briefing
  - Objective: Summarise today's calendar, overdue tasks, and recent decisions.
  - Sources: Google Calendar (today), Better Tasks (overdue + due today), Chief of Staff/Decisions.
  - Output: A concise briefing with calendar, tasks, and decision sections.
  - Write output to today's daily page.
```

```text
- Meeting Prep
  - Objective: Prepare a briefing for an upcoming meeting.
  - Input: The user will specify which meeting.
  - Sources: Google Calendar (meeting details + attendees), Better Tasks (related project tasks).
  - Output: Agenda summary, attendee context, relevant open tasks, and suggested talking points.
```

onboarding 时会默认安装 6 个技能；其他可选技能列表见 [`public/other_skills.md`](public/other_skills.md)。

### Skills 如何工作

当你编辑技能页时，系统会通过 live pull watch 自动重载。prompt 里只会收到一个精简技能索引（技能名 + 首行摘要），而完整的 skill 内容只有在你明确调用该技能时才会被加载。例如你可以说：“run my Weekly Review” 或 “do a Daily Briefing”。

如果技能在 **Sources** 中声明了必需数据源，系统会强制先把相关数据读全，再允许写结果。例如 Weekly Review 里声明了 Better Tasks，那么助手在生成评审前必须真的去查询 Better Tasks，不能跳过查询直接编造。

### 使用建议

- 单个 skill 说明尽量控制在 2,000 字符以内
- 尽量引用其他 Chief of Staff 页面作为数据源，让输出建立在你真实数据上
- 如果 skill 写了 “Write output to today's daily page”，结果会按结构写入今日日记页
- 也可以在 Sources 里直接写 Composio 工具名，例如 `Google Calendar`、`Gmail`

---

## 定时任务

助手支持创建周期性任务和一次性任务，并在后台自动执行。你可以直接用自然语言描述，例如：

- *“Run my Daily Briefing skill every morning at 8am”*
- *“Remind me to check my inbox every 30 minutes”*
- *“At 5pm today, summarise what I worked on”*
- *“Check my Open Brain stats every 2 hours between 8am and 6pm”*

支持的调度类型：

| 类型 | 调度格式 | 示例 |
|---|---|---|
| `cron` | 5 位 cron 表达式 + 时区 | `0 8 * * *` |
| `interval` | 每隔 N 分钟执行一次，全天候运行，最小 5 分钟 | `30` |
| `once` | 指定时间戳，仅执行一次 | 执行后自动禁用 |
| `reminder` | 指定时间戳，仅弹出 sticky toast | 不进入 agent loop |

仅在特定时间窗内重复执行时，系统会自动把自然语言翻译成 cron：

| 自然语言 | Cron 表达式 |
|---|---|
| Every 2 hours from 8am to 6pm | `0 8-18/2 * * *` |
| Every 30 minutes during business hours | `*/30 9-17 * * *` |
| 9am and 5pm on weekdays | `0 9,17 * * 1-5` |
| Weekdays at 8am | `0 8 * * 1-5` |

任务存储在扩展设置中，刷新后仍然存在。如果你同时打开多个 Roam 标签页，只有一个标签页会负责实际执行，系统会通过 leader election + heartbeat 防止重复运行。

---

## 安全

Chief of Staff 是一个可以读取你的 Roam graph，并可选连接 Gmail、Google Calendar 等外部服务的 AI agent，因此安全设计非常关键。项目文档说明它针对单用户浏览器扩展的真实威胁模型，参照了多套安全框架进行审视，包括 OWASP、Google Secure AI Agents、NIST AI Agent Standards Initiative 与 MITRE ATLAS。

相关安全参考文档：

- [`security/ai-agent-security-reference.md`](security/ai-agent-security-reference.md)
- [`security/ai-agent-security-reference-compliance.md`](security/ai-agent-security-reference-compliance.md)

### 扩展如何保护你的数据

**默认人在回路中。** 所有写操作都需要显式确认，包括创建、修改、删除 block，发送邮件，创建日历事件等。审批是按请求隔离的：每个新 prompt 都从空白状态开始，不会沿用上一次的许可。

**Inbox 只读。** 放入 `Chief of Staff/Inbox` 的内容只会在受限工具白名单下处理，助手可以读、查、收集信息，但不能改写 graph。

**Prompt injection 防护。** 外部来源内容（邮件、日历事件、MCP 工具结果、记忆页、Composio 响应）会被包裹在 `<untrusted>` 边界标签中，并带有明确指示，要求模型把它们视为数据而不是指令。系统还会用语义扫描器检查注入模式，并对可疑内容打警告标记。

**记忆污染防护。** 所有记忆写入都会经过 28 类模式检查，拦截持久化注入。

**System prompt 保密。** 输出会经过指纹短语扫描，遇到疑似泄露 system prompt 的回复时，会改为安全拒绝。

**PII 脱敏。** 一个默认开启的可选层会在 LLM 请求发出前，对邮箱、手机号、社保号、银行卡号、IBAN、Medicare、TFN、公开 IP 等做脱敏。

**“声称已执行”问题的三层缓解。** 一些模型会在没有真正调用工具时，生成“已经完成”的文本。Chief of Staff 通过检测、对话上下文清理和自动升档三层机制来纠正这个问题。

**凭证处理。** API Key 存在浏览器 IndexedDB 中，只发送到对应 provider 的 HTTPS endpoint。应用级日志会经过凭证脱敏层，不会明文输出 key。

**CORS proxy 加固。** 自带的 Cloudflare Worker proxy 只接受来自 `roamresearch.com` 的请求，只转发到白名单 upstream，并禁止不安全重定向。

**XSS 防护。** 用户可见 HTML 采用 escape 后再重插入的方式，随后还有 DOM sanitiser 再做一次危险标签和属性清洗。

### 哪些数据会离开浏览器

所有 LLM 请求都是由你的浏览器直接发往你配置的 provider。没有中间服务器，没有 telemetry，也没有 analytics。

- **聊天请求**：会发送你的消息、system prompt、最近最多 12 轮对话（截断后）、记忆页内容，以及运行中产生的工具结果
- **Inbox 处理**：会发送 inbox block 的内容、system prompt，以及只读工具结果
- **定时任务**：和普通聊天请求走同样的数据路径，只是由定时器触发
- **Composio 工具**：工具调用 payload 会通过 CORS proxy 发给 Composio MCP endpoint
- **本地 MCP**：请求只会发往你配置的 `localhost` 端口，不会离开本机
- **远程 MCP**：payload 会直接发往远程 server URL，认证 token 通过 header 发送，但只存储在本地

**不会发送的内容：** 你的完整 graph 不会被整体传走。助手只通过 Roam 本地 API 读取相关 block，把必要结果带进 LLM 上下文。

### 扩展不保护什么

- **用户自己批准的破坏性操作**：如果你确认了一次删除或发信，系统就会执行
- **高度对抗性的恶意内容**：模式检测不是万能的，足够精巧的 payload 仍可能绕过
- **本地静态存储中的 API Key**：它们以明文形式存于浏览器 IndexedDB，不适合共享电脑或不可信环境

### Dry-run 模式

如果你想先看助手“准备怎么做”，可以在设置里打开 **Dry Run**。下一次写操作会被模拟而非真实执行，用完后自动关闭。

### MCP 供应链安全

连接本地 MCP server 时，Chief of Staff 会把连接信息记录到 `[[Chief of Staff/MCP Servers]]` 页面，包括 server 名称、工具数、信任状态、schema hash 和最后连接时间。首次连接会 pin 住 schema，后续如发现工具增删改，会提醒你复查。

### AI Bill of Materials（AIBOM）

Chief of Staff 会生成 CycloneDX 1.6 格式的 AI Bill of Materials。CI 会产出静态构建产物 `artifacts/aibom-static.cdx.json`；运行时则会在 `[[Chief of Staff/AIBOM]]` 页面写入当前配置快照，包括启用的 LLM provider、模型、MCP server、Composio 工具和扩展工具注册信息。

### 报告安全问题

如果你发现了安全问题，请不要公开提 issue，以免泄露敏感信息。可以直接在 [Roam Research Slack channel](https://app.slack.com/client/TNEAEL9QW/dms) 中私信作者。

---

## 限制与性能注意事项

- **Graph 扫描**：任务搜索会扫描 graph 中匹配 TODO/DONE 的 block。大图谱（10 万 block 以上）可能需要 1 到 2 秒
- **Agent 迭代次数**：每次请求的推理循环次数有上限，用于防止 runaway API usage
- **对话上下文**：助手会保留最近最多 12 轮对话，并对长度做截断；单次 agent run 中若消息预算超限，工具结果也会被逐步裁剪
- **Composio 依赖**：外部工具能力需要有效的 Composio 连接；但 Roam graph 和任务功能不依赖 Composio
- **LLM API 成本**：所有调用都直接记到你自己的 API 账户上。多工具工作流、结构化简报和定时任务会比简单问答消耗更多 token
- **Prompt caching**：扩展的 prompt 结构经过设计，尽量提高各 provider 的 cache 命中率；开启缓存后，输入 token 成本会显著下降，因此输出 token 往往成为主要成本来源
- **定时任务执行条件**：至少需要一个 Roam 标签页保持打开，否则任务不会触发；同一时间只有一个标签页会负责执行
