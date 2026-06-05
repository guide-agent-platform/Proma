/**
 * 一次性脚本：创建"向导弹性" workspace (slug: guide-elasticity)
 *
 * 为什么不直接 import createAgentWorkspace：
 * 1. createAgentWorkspace 的 slugify 对纯中文名会 fallback 成 workspace-{timestamp}，
 *    拿不到约定的 slug=guide-elasticity（后续 A2/B 任务依赖此命名）。
 * 2. 该模块是 Electron 主进程模块，bun 直接 import 会触发 monorepo / electron 解析问题。
 * 因此这里用 Node 内置 fs/path/os/crypto 复刻其行为（plugin.json 格式、索引结构
 * version=2 与 Proma 完全一致），不改任何 Proma 已有代码，仅新增本脚本。
 *
 * 用法（默认写入开发模式目录 ~/.proma-dev，匹配 `bun run dev:electron`）：
 *   bun run scripts/create-workspace.ts
 * 覆盖配置目录名（如写正式版 ~/.proma）：
 *   PROMA_DIR_NAME=.proma bun run scripts/create-workspace.ts
 *
 * 幂等：可重复运行，已存在则只补齐目录/plugin.json，不重复写索引。
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const NAME = '向导弹性'
const SLUG = 'guide-elasticity'
const INDEX_VERSION = 2

const dirName = process.env.PROMA_DIR_NAME ?? '.proma-dev'
const configDir = join(homedir(), dirName)
const workspacesDir = join(configDir, 'agent-workspaces')
const wsDir = join(workspacesDir, SLUG)
const indexPath = join(configDir, 'agent-workspaces.json')

interface Workspace {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}
interface Index {
  version: number
  workspaces: Workspace[]
}

function ensurePluginManifest(): void {
  const pluginDir = join(wsDir, '.claude-plugin')
  const manifestPath = join(pluginDir, 'plugin.json')
  if (existsSync(manifestPath)) return
  mkdirSync(pluginDir, { recursive: true })
  const manifest = { name: `proma-workspace-${SLUG}`, version: '1.0.0' }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`[create-workspace] 已写 plugin manifest: ${manifestPath}`)
}

const COPY_BLOCKLIST = new Set(['.git', '.DS_Store', 'node_modules', 'dist', '.next', '.cache', '.turbo', '__pycache__'])

function copyDefaultSkills(): void {
  const defaultDir = join(configDir, 'default-skills')
  const targetDir = join(wsDir, 'skills')
  mkdirSync(targetDir, { recursive: true })
  if (!existsSync(defaultDir)) {
    console.log(`[create-workspace] 无 default-skills（${defaultDir} 不存在），跳过复制（dev 首启后会自动 seed）`)
    return
  }
  let copied = 0
  for (const entry of readdirSync(defaultDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const target = join(targetDir, entry.name)
    if (existsSync(target)) continue
    cpSync(join(defaultDir, entry.name), target, { recursive: true, filter: (src) => !COPY_BLOCKLIST.has(basename(src)) })
    copied++
  }
  console.log(`[create-workspace] 已复制 ${copied} 个默认 skill 到 ${targetDir}`)
}

function main(): void {
  mkdirSync(wsDir, { recursive: true })
  ensurePluginManifest()
  copyDefaultSkills()

  let index: Index
  if (existsSync(indexPath)) {
    index = JSON.parse(readFileSync(indexPath, 'utf-8')) as Index
    if (!Array.isArray(index.workspaces)) index = { version: INDEX_VERSION, workspaces: [] }
  } else {
    index = { version: INDEX_VERSION, workspaces: [] }
  }

  const existing = index.workspaces.find((w) => w.slug === SLUG)
  if (existing) {
    console.log(`[create-workspace] 索引已存在 slug=${SLUG}，跳过写索引（幂等）`)
  } else {
    const now = Date.now()
    index.workspaces.unshift({ id: randomUUID(), name: NAME, slug: SLUG, createdAt: now, updatedAt: now })
    index.version = INDEX_VERSION
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    console.log(`[create-workspace] 已写入索引: ${indexPath}`)
  }

  console.log('\n=== 完成 ===')
  console.log('配置目录:', configDir)
  console.log('workspace 目录:', wsDir)
  console.log('索引条目:', JSON.stringify(index.workspaces.find((w) => w.slug === SLUG), null, 2))
}

main()
