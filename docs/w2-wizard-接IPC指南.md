# W2 向导三栏接 IPC 指南

> 用途：把 W1 搭好的 wizard 三栏骨架（mock 数据）切换为真实主进程消息流，端到端跑通「用户输入 → Agent 响应（按 SKILL 行为）→ 纠错写入文件」。
> 对象：前端同学 / 接手的 agent。
> 范围：**只改 `apps/electron/src/renderer/App.tsx` 一个文件，后端 0 改动**。
> 工时：半天（含 IPC 类型调试 + 手动端到端）。

---

## 1. 现状（W1 收尾时）

后端 PR #1（`ad143c0`）和前端 PR #2（`e98e725`）都已 merge 到 main，但**前后端故意断开**：

| 已有（可用） | 缺失 |
|---|---|
| `writeToWorkspace` IPC 注册 + preload 暴露 | 前端没调（App.tsx 完全无 `electronAPI` 引用） |
| `onAgentStreamEvent` / `Complete` / `Error` preload 暴露 | 前端没订阅，消息流还是 `INITIAL_MESSAGES` 5 条写死 |
| `listAgentWorkspaces` / `createAgentSession` | 前端没做 workspace 选择 |
| `sendAgentMessage` | 前端 `send()` 是 `setTimeout` 模拟 |

W1 演示版（mock 数据 + 写死 iframe HTML）跑得通，但**任何真实 agent 流程都没接**。本 PR 把这一刀拼上。

---

## 2. 范围

### 2.1 改什么

- `apps/electron/src/renderer/App.tsx`：替换 mock 数据流为真实 IPC

### 2.2 不改什么

- 后端任何文件（`agent-workspace-manager.ts` / `ipc.ts` / `agent-orchestrator.ts` 等）
- `preload/index.ts`（所需 IPC 已暴露）
- `packages/shared`（类型已就位）
- `main.tsx` / `index.html` / `globals.css`
- 右侧 iframe 内容（继续用 MOCK_HTML，W3 草图生成再说）
- 多 session 并存 / 切换（本 PR 单 session）
- workspace/channel 选择器 UI（本 PR 自动选第一个）
- 时间轴节点持久化

---

## 3. 前置依赖（已就位，无需再改）

下面这些 IPC preload 都已暴露，可直接调：

| IPC | preload 行号 | 用途 |
|---|---|---|
| `listAgentWorkspaces()` | 479 | 列出所有 workspace，找 `slug === 'guide-elasticity'` |
| `listChannels()` | — | 列出 channel 渠道（本 PR 取第一个） |
| `createAgentSession(title, channelId, workspaceId)` | 413 | 创建 session 并绑定向导弹性 workspace，返回 `AgentSessionMeta` |
| `sendAgentMessage(sessionId, text)` | — | 发送用户消息到 agent（**实际名字以 preload 为准，下面 §4.3 会核实**） |
| `onAgentStreamEvent(cb) => unsubscribe` | 556 | 订阅流式事件，载荷 `AgentStreamEvent`（`{ sessionId, payload: AgentStreamPayload, event? }`） |
| `onAgentStreamComplete(cb) => unsubscribe` | 559 | 订阅完成，载荷 `AgentStreamCompletePayload`（`{ sessionId, messages?, stoppedByUser?, startedAt?, resultSubtype? }`） |
| `onAgentStreamError(cb) => unsubscribe` | 562 | 订阅错误，载荷 `{ sessionId, error }` |
| `writeToWorkspace(slug, filePath, content)` | 494 | 写文件，返回 `{ success: true, filePath }` 或 `{ success: false, error }` |

### 3.1 类型参考

`AgentStreamEvent`（`packages/shared/src/types/agent.ts` 行 954）：

```ts
export interface AgentStreamEvent {
  sessionId: string
  payload: AgentStreamPayload  // 行 569，按 type 分发
  /** @deprecated 兼容旧格式 */
  event?: AgentEvent
}
```

`AgentStreamCompletePayload`（行 967）：

```ts
export interface AgentStreamCompletePayload {
  sessionId: string
  messages?: AgentMessage[]
  stoppedByUser?: boolean
  startedAt?: number
  resultSubtype?: string
}
```

> 调 IPC 前先 import 一下：
> ```ts
> import type { AgentStreamEvent, AgentStreamCompletePayload } from '@proma/shared'
> ```
> 但 Vite renderer 编译有时不允许直接 import shared，需要走 `window.electronAPI` 的类型声明（看 renderer 现有 import 风格）。

---

## 4. 改动方案

### 4.1 W2.1 启动时自动绑定向导弹性 session

新增 state + mount 时 effect：

```tsx
const [sessionId, setSessionId] = React.useState<string | null>(null)
const [bootError, setBootError] = React.useState<string | null>(null)
const [isStreaming, setIsStreaming] = React.useState(false)

React.useEffect(() => {
  let cancelled = false
  ;(async () => {
    try {
      const workspaces = await window.electronAPI.listAgentWorkspaces()
      const guide = workspaces.find(w => w.slug === 'guide-elasticity')
      if (!guide) {
        setBootError('向导弹性 workspace 未创建，请跑 scripts/create-workspace.ts')
        return
      }
      // 拿第一个可用 channel，没配就传 undefined 走默认
      const channels = await window.electronAPI.listChannels?.() ?? []
      const channelId = channels.find?.((c: { enabled?: boolean }) => c.enabled !== false)?.[0]?.id
        ?? channels?.[0]?.id
      const session = await window.electronAPI.createAgentSession(
        '向导弹性 · Wizard UI',
        channelId,
        guide.id,
      )
      if (!cancelled) setSessionId(session.id)
    } catch (e) {
      if (!cancelled) setBootError(`启动失败：${String(e)}`)
    }
  })()
  return () => { cancelled = true }
}, [])
```

`INITIAL_MESSAGES` 改为占位（保留 1 条欢迎语即可，避免空白启动屏）：

```tsx
const INITIAL_MESSAGES: Message[] = [
  { id: '0', role: 'system', text: '正在连接向导弹性 workspace…' },
]
```

启动后通过 `onAgentStreamEvent` 收到首条消息时再塞真消息。

### 4.2 W2.2 订阅 agent 流式事件

```tsx
React.useEffect(() => {
  if (!sessionId) return
  const offEvent = window.electronAPI.onAgentStreamEvent((evt: AgentStreamEvent) => {
    if (evt.sessionId !== sessionId) return
    // 按 evt.payload.type 分发到 messages / options / tool activity
    appendAgentEvent(evt.payload)
  })
  const offComplete = window.electronAPI.onAgentStreamComplete((data: AgentStreamCompletePayload) => {
    if (data.sessionId !== sessionId) return
    setIsStreaming(false)
  })
  const offError = window.electronAPI.onAgentStreamError((data: { sessionId: string; error: string }) => {
    if (data.sessionId !== sessionId) return
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString(), role: 'system', text: `❌ ${data.error}` },
    ])
    setIsStreaming(false)
  })
  return () => { offEvent(); offComplete(); offError() }
}, [sessionId])
```

**`appendAgentEvent(payload)` 骨架**（按 payload.type switch）：

```tsx
function appendAgentEvent(payload: AgentStreamPayload): void {
  // 实际 type 在 AgentStreamPayload union 里，先列最常见的几种：
  switch (payload.type) {
    case 'text_delta':
      // 流式文本追加到最后一条 system 消息
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last?.role === 'system' && last.streaming) {
          return [...prev.slice(0, -1), { ...last, text: last.text + payload.text }]
        }
        return [...prev, { id: cuid(), role: 'system', text: payload.text, streaming: true }]
      })
      break
    case 'message_complete':
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last?.streaming) return [...prev.slice(0, -1), { ...last, streaming: false }]
        return prev
      })
      break
    case 'tool_use':
      // 可选：在时间轴加节点
      break
    case 'ask_user_question':
      // 把问题+选项塞进 messages，最后一条 system 消息带 options
      setMessages(prev => [...prev, {
        id: cuid(), role: 'system', text: payload.question, options: payload.options,
      }])
      break
    // 其他 type 暂忽略，逐步补
  }
}
```

> ⚠️ `AgentStreamPayload` 的实际 type 集合比这里列的多（行 569）。**实现前先在 `packages/shared/src/types/agent.ts` 行 569 周围看完整 union**，按需补 switch 分支。上面只是骨架。

### 4.3 W2.3 send 替换为真实 IPC

```tsx
const send = async (): Promise<void> => {
  const text = inputValue.trim()
  if (!text || !sessionId) return
  setMessages(prev => [...prev, { id: cuid(), role: 'user', text }])
  setInputValue('')
  setIsStreaming(true)
  try {
    await window.electronAPI.sendAgentMessage(sessionId, text)
  } catch (e) {
    setMessages(prev => [...prev, {
      id: cuid(), role: 'system', text: `❌ 发送失败：${String(e)}`,
    }])
    setIsStreaming(false)
  }
}
```

> ⚠️ `sendAgentMessage` 是推测的方法名。**动手前先在 `preload/index.ts` 里 grep 一下**（关键词：`invoke.*AGENT_IPC_CHANNELS.SEND` 或 `sendMessage` / `sendUserMessage`），按实际名字来。命名风格跟 preload 已有的 `createAgentSession` / `updateAgentSessionTitle` 一致：动名词形式。

选项按钮点击也改成 send：

```tsx
<Button
  key={opt.value}
  variant="outline"
  size="sm"
  onClick={() => void send() /* 或者 send(opt.value)，看 agent 是否能区分消息类型 */}
>
  {opt.label}
</Button>
```

> 选项按钮的语义由 SKILL.md 决定。如果 SKILL 要求"用户选 A/B/C"和"用户输入文本"是同一种消息格式，直接调 `send()` 发 label 即可；如果是结构化问题回答，需要单独的 IPC（届时查 preload）。

### 4.4 W2.4 纠错反馈调 writeToWorkspace

```tsx
const closeCorrection = async (feedback: string | null): Promise<void> => {
  setCorrection(null)
  document.querySelector('iframe')?.contentWindow?.postMessage('clear-highlight', '*')
  if (!feedback || !sessionId) return

  const slug = 'guide-elasticity'  // W3 再做选择器
  const path = `corrections/${Date.now()}.json`
  const content = JSON.stringify({
    sessionId,
    element: correction,
    feedback,
    ts: new Date().toISOString(),
  }, null, 2)

  const r = await window.electronAPI.writeToWorkspace(slug, path, content)
  setMessages(prev => [...prev, {
    id: cuid(),
    role: 'user',
    text: r.success
      ? `🔧 纠错已记录 → ${path}`
      : `❌ 写入失败：${r.error}`,
  }])
}
```

### 4.5 工具函数

```tsx
// 替换原 Date.now().toString() 撞 id 的隐患
function cuid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
```

---

## 5. 验收

### 5.1 自动验收

```bash
bun run typecheck   # 4 包必须 0 错
bun test            # 不能挂 W1 已有 5 个用例
```

### 5.2 手动端到端（按 `docs/w1-验收操作指南.md` 风格）

1. `bun run dev:electron` 启动
2. DevTools 打开 → Console 标签留着
3. 三栏出现 → 左栏"正在连接向导弹性 workspace…"（500ms 内应消失）
4. 左栏顶显示 session id 或标题
5. 输入"帮我做一个 hello world 页面"→ 发送
   - ✅ 期望：Agent 按 SKILL 行为问 1-3 个问题（带可点选项）
   - ❌ 异常：发出去无响应 → §6 排查
6. 点击选项 → 继续对话
7. 在右侧 iframe 点任意元素 → 红色高亮 + 弹纠错弹窗
8. 弹窗填"这个颜色太深"→ 确认
9. 终端验证文件写出来了：
   ```bash
   find ~/.proma-dev/agent-workspaces/guide-elasticity -name '*.json' -newer ~/.proma-dev/agent-workspaces.json
   ```
   期望看到 `corrections/{timestamp}.json`，内容是 `{"sessionId":"...","element":{...},"feedback":"...","ts":"..."}`

### 5.3 验收对照表

| # | 验收项 | 验证 |
|---|---|---|
| 1 | typecheck 4 包 0 错 | 自动 |
| 2 | bun test 5/5 通过 | 自动 |
| 3 | 启动后 3 秒内 session 创建 | 手动 |
| 4 | 向导弹性 workspace 缺失时给提示 | 删 `~/.proma-dev/agent-workspaces/guide-elasticity` 后重启，看到红条 |
| 5 | 输入消息触发真实 Agent 响应 | DevTools Network 看 IPC；响应符合 SKILL 行为 |
| 6 | 选项按钮点击 → Agent 收到 | 同上 |
| 7 | iframe 元素点击 → 弹纠错 → 写入文件 | `find` 命令 |
| 8 | 写失败有错误码反馈 | 故意传越界路径（临时改 `path` 测一下），看到 `PATH_TRAVERSAL` 提示 |

---

## 6. 排查

| 现象 | 可能原因 | 怎么办 |
|---|---|---|
| 启动后左栏一直"正在连接…" | `listAgentWorkspaces` 抛错 / workspace 没建 | 看 DevTools Console；跑 `bun run scripts/create-workspace.ts` |
| session 创建了但 send 无响应 | `sendAgentMessage` 方法名拼错 / channelId 没传 | DevTools Console 看 invoke 调用；对照 preload 实际命名 |
| 收到事件但 `appendAgentEvent` 没渲染 | payload.type 没在 switch 里 / Message 没 `streaming` 字段 | 在 switch 顶部 `console.log('unhandled', payload.type)` 看缺什么 |
| 多 session 时收错事件 | sessionId 过滤漏了 | 三个 useEffect 的 callback 第一行都加 `if (data.sessionId !== sessionId) return` |
| writeToWorkspace 报 `NO_WORKSPACE` | slug 拼错 | 确认 `~/.proma-dev/agent-workspaces/guide-elasticity/` 存在 |
| writeToWorkspace 报 `PATH_TRAVERSAL` | 路径含 `..` 或绝对路径 | 检查 `corrections/${Date.now()}.json` 这种纯相对路径 |

---

## 7. 风险（提前说）

1. **`AgentStreamPayload` 类型多**（行 569）— `appendAgentEvent` 要按 `type` switch，初次集成要 1-2 轮调试。
2. **sessionId 过滤** — 三个 useEffect 都要过滤；本 PR 单 session，但代码要写对，省得 W3 改。
3. **channel 兜底** — 默认取第一个 enabled channel，没配时 SDK 启动会失败，要在 `bootError` 兜住。
4. **`sendAgentMessage` 命名** — §4.3 标注了，以 preload 实际为准，写之前先 grep。
5. **shared 类型 import** — Vite renderer 不一定能直接 `import from '@proma/shared'`，看 renderer 现有写法（多数场景走 `window.electronAPI` 类型声明，不直接 import）。

---

## 8. 不在本 PR 范围（明确）

- workspace/channel 选择器 UI（先用自动选第一个）
- 右侧 iframe 真实替换（继续 MOCK_HTML，W3 草图生成）
- 多 session 并存 / 切换
- 时间轴节点持久化
- 录屏 / 简报文档

---

## 9. 估计

| 项 | 行数 / 时长 |
|---|---|
| App.tsx 净增 | ~180 行 |
| 调试 IPC 类型 | 1-2 轮 |
| 手动端到端 | 30 分钟 |
| 总工时 | 半天 |

---

## 10. 相关文档

- W1 后端简报：`docs/w1-summary-backend.md`
- W1 验收指南：`docs/w1-验收操作指南.md`
- 后端实现：`apps/electron/src/main/lib/agent-workspace-manager.ts`（行 207-269，`writeToWorkspace`）
- 后端测试：`apps/electron/src/main/lib/agent-workspace-manager.test.ts`
- IPC 类型：`packages/shared/src/types/agent.ts`（`AgentStreamEvent` 行 954 / `AgentStreamPayload` 行 569）
- 暴露面：`apps/electron/src/preload/index.ts`（行 413/479/494/556-565）
