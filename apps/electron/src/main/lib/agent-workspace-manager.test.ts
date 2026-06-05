import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { listAgentWorkspaces, writeToWorkspace } from './agent-workspace-manager'
import { getAgentWorkspacePath } from './config-paths'

const slug = listAgentWorkspaces()[0]?.slug ?? 'default'
const TEST_DIR = '__sandbox_test__'

afterAll(() => {
  try {
    rmSync(join(getAgentWorkspacePath(slug), TEST_DIR), { recursive: true, force: true })
  } catch {
    // 清理失败忽略
  }
})

describe('writeToWorkspace 薄沙箱', () => {
  test('Given 合法相对路径与 .txt When 写入 Then 成功', async () => {
    const r = await writeToWorkspace(slug, `${TEST_DIR}/ok.txt`, 'hello world')
    expect(r.success).toBe(true)
  })

  test('Given 路径含 ../ 越界 When 写入 Then 拒绝 PATH_TRAVERSAL', async () => {
    const r = await writeToWorkspace(slug, '../../etc/passwd', 'x')
    expect(r).toEqual({ success: false, error: 'PATH_TRAVERSAL' })
  })

  test('Given 超过 10MB 内容 When 写入 Then 拒绝 FILE_TOO_LARGE', async () => {
    const big = 'a'.repeat(10 * 1024 * 1024 + 1)
    const r = await writeToWorkspace(slug, `${TEST_DIR}/big.txt`, big)
    expect(r).toEqual({ success: false, error: 'FILE_TOO_LARGE' })
  })

  test('Given .exe 危险扩展名 When 写入 Then 拒绝 EXT_NOT_ALLOWED', async () => {
    const r = await writeToWorkspace(slug, `${TEST_DIR}/evil.exe`, 'x')
    expect(r).toEqual({ success: false, error: 'EXT_NOT_ALLOWED' })
  })

  test('Given 不存在的 workspace When 写入 Then 拒绝 NO_WORKSPACE', async () => {
    const r = await writeToWorkspace('___nonexistent___', `${TEST_DIR}/x.txt`, 'x')
    expect(r).toEqual({ success: false, error: 'NO_WORKSPACE' })
  })
})
