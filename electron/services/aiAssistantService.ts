import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { ConfigService } from './config'

export type AssistantChatType = 'group' | 'private'
export type AssistantToolCategory = 'core' | 'analysis'

export interface AssistantSummary {
  id: string
  name: string
  systemPrompt: string
  presetQuestions: string[]
  allowedBuiltinTools?: string[]
  builtinId?: string
  applicableChatTypes?: AssistantChatType[]
  supportedLocales?: string[]
}

export interface AssistantConfigFull extends AssistantSummary {}

export interface BuiltinAssistantInfo {
  id: string
  name: string
  systemPrompt: string
  applicableChatTypes?: AssistantChatType[]
  supportedLocales?: string[]
  imported: boolean
}

const GENERAL_CN_MD = `---
id: general_cn
name: 通用分析助手
supportedLocales:
  - zh
presetQuestions:
  - 最近都在聊什么？
  - 谁是最活跃的人？
  - 帮我总结一下最近一周的重要聊天
  - 帮我找一下关于“旅游”的讨论
allowedBuiltinTools:
  - get_time_stats
  - search_sessions
  - get_recent_messages
  - search_messages
  - get_message_context
  - ai_list_voice_messages
  - ai_transcribe_voice_messages
  - get_chat_overview
  - get_session_summaries
  - get_member_stats
---

你是 WeFlow 的全局聊天分析助手。请使用工具获取证据，给出简洁、准确、可执行的结论。

输出要求：
1. 先结论，再证据。
2. 若证据不足，明确说明不足并建议下一步。
3. 涉及语音内容时，必须先列语音 ID，再按 ID 转写。
4. 默认中文输出，除非用户明确指定其他语言。`

const GENERAL_EN_MD = `---
id: general_en
name: General Analysis Assistant
supportedLocales:
  - en
presetQuestions:
  - What have people been discussing recently?
  - Who are the most active contacts?
  - Summarize my key chat topics this week
allowedBuiltinTools:
  - get_time_stats
  - search_sessions
  - get_recent_messages
  - search_messages
  - get_message_context
  - ai_list_voice_messages
  - ai_transcribe_voice_messages
  - get_chat_overview
  - get_session_summaries
  - get_member_stats
---

You are WeFlow's global chat analysis assistant.
Always ground your answers in tool evidence, stay concise, and clearly call out uncertainty when data is insufficient.`

const GENERAL_JA_MD = `---
id: general_ja
name: 汎用分析アシスタント
supportedLocales:
  - ja
presetQuestions:
  - 最近どんな話題が多い？
  - 一番アクティブな相手は誰？
  - 今週の重要な会話を要約して
allowedBuiltinTools:
  - get_time_stats
  - search_sessions
  - get_recent_messages
  - search_messages
  - get_message_context
  - ai_list_voice_messages
  - ai_transcribe_voice_messages
  - get_chat_overview
  - get_session_summaries
  - get_member_stats
---

あなたは WeFlow のグローバルチャット分析アシスタントです。
ツールから得た根拠に基づき、簡潔かつ正確に回答してください。`

const BUILTIN_ASSISTANTS = [
  { id: 'general_cn', raw: GENERAL_CN_MD },
  { id: 'general_en', raw: GENERAL_EN_MD },
  { id: 'general_ja', raw: GENERAL_JA_MD }
] as const

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function parseInlineList(text: string): string[] {
  const raw = normalizeText(text)
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = String(raw || '')
  if (!normalized.startsWith('---')) {
    return { frontmatter: '', body: normalized.trim() }
  }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: '', body: normalized.trim() }
  return {
    frontmatter: normalized.slice(3, end).trim(),
    body: normalized.slice(end + 4).trim()
  }
}

function parseAssistantMarkdown(raw: string): AssistantConfigFull {
  const { frontmatter, body } = splitFrontmatter(raw)
  const lines = frontmatter ? frontmatter.split('\n') : []
  const data: Record<string, unknown> = {}
  let currentArrayKey = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const kv = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (kv) {
      const key = kv[1]
      const value = kv[2]
      if (!value) {
        data[key] = []
        currentArrayKey = key
      } else {
        data[key] = value
        currentArrayKey = ''
      }
      continue
    }
    const arr = trimmed.match(/^- (.+)$/)
    if (arr && currentArrayKey) {
      const next = Array.isArray(data[currentArrayKey]) ? data[currentArrayKey] as string[] : []
      next.push(arr[1].trim())
      data[currentArrayKey] = next
    }
  }

  const id = normalizeText(data.id)
  const name = normalizeText(data.name, id || 'assistant')
  const applicableChatTypes = Array.isArray(data.applicableChatTypes)
    ? (data.applicableChatTypes as string[]).filter((item): item is AssistantChatType => item === 'group' || item === 'private')
    : parseInlineList(String(data.applicableChatTypes || '')).filter((item): item is AssistantChatType => item === 'group' || item === 'private')
  const supportedLocales = Array.isArray(data.supportedLocales)
    ? (data.supportedLocales as string[]).map((item) => item.trim()).filter(Boolean)
    : parseInlineList(String(data.supportedLocales || ''))
  const presetQuestions = Array.isArray(data.presetQuestions)
    ? (data.presetQuestions as string[]).map((item) => item.trim()).filter(Boolean)
    : parseInlineList(String(data.presetQuestions || ''))
  const allowedBuiltinTools = Array.isArray(data.allowedBuiltinTools)
    ? (data.allowedBuiltinTools as string[]).map((item) => item.trim()).filter(Boolean)
    : parseInlineList(String(data.allowedBuiltinTools || ''))
  const builtinId = normalizeText(data.builtinId)

  return {
    id,
    name,
    systemPrompt: body,
    presetQuestions,
    allowedBuiltinTools,
    builtinId: builtinId || undefined,
    applicableChatTypes,
    supportedLocales
  }
}

function toMarkdown(config: AssistantConfigFull): string {
  const lines = [
    '---',
    `id: ${config.id}`,
    `name: ${config.name}`
  ]
  if (config.builtinId) lines.push(`builtinId: ${config.builtinId}`)
  if (config.supportedLocales && config.supportedLocales.length > 0) {
    lines.push('supportedLocales:')
    config.supportedLocales.forEach((item) => lines.push(`  - ${item}`))
  }
  if (config.applicableChatTypes && config.applicableChatTypes.length > 0) {
    lines.push('applicableChatTypes:')
    config.applicableChatTypes.forEach((item) => lines.push(`  - ${item}`))
  }
  if (config.presetQuestions && config.presetQuestions.length > 0) {
    lines.push('presetQuestions:')
    config.presetQuestions.forEach((item) => lines.push(`  - ${item}`))
  }
  if (config.allowedBuiltinTools && config.allowedBuiltinTools.length > 0) {
    lines.push('allowedBuiltinTools:')
    config.allowedBuiltinTools.forEach((item) => lines.push(`  - ${item}`))
  }
  lines.push('---')
  lines.push('')
  lines.push(config.systemPrompt || '')
  return lines.join('\n')
}

function defaultBuiltinToolCatalog(): Array<{ name: string; category: AssistantToolCategory }> {
  return [
    { name: 'get_time_stats', category: 'core' },
    { name: 'search_sessions', category: 'core' },
    { name: 'get_recent_messages', category: 'core' },
    { name: 'search_messages', category: 'core' },
    { name: 'get_message_context', category: 'core' },
    { name: 'ai_list_voice_messages', category: 'core' },
    { name: 'ai_transcribe_voice_messages', category: 'core' },
    { name: 'get_chat_overview', category: 'analysis' },
    { name: 'get_session_summaries', category: 'analysis' },
    { name: 'get_member_stats', category: 'analysis' },
    { name: 'activate_skill', category: 'analysis' }
  ]
}

class AiAssistantService {
  private readonly config = ConfigService.getInstance()
  private initialized = false
  private readonly cache = new Map<string, AssistantConfigFull>()

  private getRootDirCandidates(): string[] {
    const dbPath = normalizeText(this.config.get('dbPath'))
    const wxid = normalizeText(this.config.get('myWxid'))
    const roots: string[] = []
    if (dbPath && wxid) {
      roots.push(join(dbPath, wxid, 'db_storage', 'wf_ai_v2'))
      roots.push(join(dbPath, wxid, 'db_storage', 'wf_ai'))
    }
    roots.push(join(process.cwd(), 'data', 'wf_ai_v2'))
    return roots
  }

  private async getRootDir(): Promise<string> {
    const roots = this.getRootDirCandidates()
    const dir = roots[0]
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async getAssistantsDir(): Promise<string> {
    const root = await this.getRootDir()
    const dir = join(root, 'assistants')
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    const dir = await this.getAssistantsDir()

    for (const builtin of BUILTIN_ASSISTANTS) {
      const filePath = join(dir, `${builtin.id}.md`)
      if (!existsSync(filePath)) {
        const parsed = parseAssistantMarkdown(builtin.raw)
        const config: AssistantConfigFull = {
          ...parsed,
          builtinId: parsed.id
        }
        await writeFile(filePath, toMarkdown(config), 'utf8')
      }
    }

    this.cache.clear()
    const files = await readdir(dir)
    for (const fileName of files) {
      if (!fileName.endsWith('.md')) continue
      const filePath = join(dir, fileName)
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = parseAssistantMarkdown(raw)
        if (!parsed.id) continue
        this.cache.set(parsed.id, parsed)
      } catch {
        // ignore broken file
      }
    }
    this.initialized = true
  }

  async getAll(): Promise<AssistantSummary[]> {
    await this.ensureInitialized()
    return Array.from(this.cache.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((assistant) => ({ ...assistant }))
  }

  async getConfig(id: string): Promise<AssistantConfigFull | null> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const config = this.cache.get(key)
    return config ? { ...config } : null
  }

  async create(
    payload: Omit<AssistantConfigFull, 'id'> & { id?: string }
  ): Promise<{ success: boolean; id?: string; error?: string }> {
    await this.ensureInitialized()
    const id = normalizeText(payload.id, `custom_${randomUUID().replace(/-/g, '').slice(0, 12)}`)
    if (this.cache.has(id)) return { success: false, error: '助手 ID 已存在' }
    const config: AssistantConfigFull = {
      id,
      name: normalizeText(payload.name, '新助手'),
      systemPrompt: normalizeText(payload.systemPrompt),
      presetQuestions: Array.isArray(payload.presetQuestions) ? payload.presetQuestions.map((item) => normalizeText(item)).filter(Boolean) : [],
      allowedBuiltinTools: Array.isArray(payload.allowedBuiltinTools) ? payload.allowedBuiltinTools.map((item) => normalizeText(item)).filter(Boolean) : [],
      builtinId: normalizeText(payload.builtinId) || undefined,
      applicableChatTypes: Array.isArray(payload.applicableChatTypes) ? payload.applicableChatTypes : [],
      supportedLocales: Array.isArray(payload.supportedLocales) ? payload.supportedLocales.map((item) => normalizeText(item)).filter(Boolean) : []
    }
    const dir = await this.getAssistantsDir()
    await writeFile(join(dir, `${id}.md`), toMarkdown(config), 'utf8')
    this.cache.set(id, config)
    return { success: true, id }
  }

  async update(
    id: string,
    updates: Partial<AssistantConfigFull>
  ): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const existing = this.cache.get(key)
    if (!existing) return { success: false, error: '助手不存在' }
    const next: AssistantConfigFull = {
      ...existing,
      ...updates,
      id: key,
      name: normalizeText(updates.name, existing.name),
      systemPrompt: updates.systemPrompt == null ? existing.systemPrompt : normalizeText(updates.systemPrompt),
      presetQuestions: Array.isArray(updates.presetQuestions) ? updates.presetQuestions.map((item) => normalizeText(item)).filter(Boolean) : existing.presetQuestions,
      allowedBuiltinTools: Array.isArray(updates.allowedBuiltinTools) ? updates.allowedBuiltinTools.map((item) => normalizeText(item)).filter(Boolean) : existing.allowedBuiltinTools,
      applicableChatTypes: Array.isArray(updates.applicableChatTypes) ? updates.applicableChatTypes : existing.applicableChatTypes,
      supportedLocales: Array.isArray(updates.supportedLocales) ? updates.supportedLocales.map((item) => normalizeText(item)).filter(Boolean) : existing.supportedLocales
    }
    const dir = await this.getAssistantsDir()
    await writeFile(join(dir, `${key}.md`), toMarkdown(next), 'utf8')
    this.cache.set(key, next)
    return { success: true }
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    if (key === 'general_cn' || key === 'general_en' || key === 'general_ja') {
      return { success: false, error: '默认助手不可删除' }
    }
    const dir = await this.getAssistantsDir()
    const filePath = join(dir, `${key}.md`)
    if (existsSync(filePath)) {
      await rm(filePath, { force: true })
    }
    this.cache.delete(key)
    return { success: true }
  }

  async reset(id: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const existing = this.cache.get(key)
    if (!existing?.builtinId) {
      return { success: false, error: '该助手不支持重置' }
    }
    const builtin = BUILTIN_ASSISTANTS.find((item) => item.id === existing.builtinId)
    if (!builtin) return { success: false, error: '内置模板不存在' }
    const parsed = parseAssistantMarkdown(builtin.raw)
    const config: AssistantConfigFull = {
      ...parsed,
      id: key,
      builtinId: existing.builtinId
    }
    const dir = await this.getAssistantsDir()
    await writeFile(join(dir, `${key}.md`), toMarkdown(config), 'utf8')
    this.cache.set(key, config)
    return { success: true }
  }

  async getBuiltinCatalog(): Promise<BuiltinAssistantInfo[]> {
    await this.ensureInitialized()
    return BUILTIN_ASSISTANTS.map((builtin) => {
      const parsed = parseAssistantMarkdown(builtin.raw)
      const imported = Array.from(this.cache.values()).some((config) => config.builtinId === builtin.id || config.id === builtin.id)
      return {
        id: parsed.id,
        name: parsed.name,
        systemPrompt: parsed.systemPrompt,
        applicableChatTypes: parsed.applicableChatTypes,
        supportedLocales: parsed.supportedLocales,
        imported
      }
    })
  }

  async getBuiltinToolCatalog(): Promise<Array<{ name: string; category: AssistantToolCategory }>> {
    return defaultBuiltinToolCatalog()
  }

  async importFromMd(rawMd: string): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const parsed = parseAssistantMarkdown(rawMd)
      if (!parsed.id) return { success: false, error: '缺少 id' }
      if (this.cache.has(parsed.id)) return { success: false, error: '助手 ID 已存在' }
      const dir = await this.getAssistantsDir()
      await writeFile(join(dir, `${parsed.id}.md`), toMarkdown(parsed), 'utf8')
      this.cache.set(parsed.id, parsed)
      return { success: true, id: parsed.id }
    } catch (error) {
      return { success: false, error: String((error as Error)?.message || error) }
    }
  }
}

export const aiAssistantService = new AiAssistantService()
