import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { ConfigService } from './config'

export type SkillChatScope = 'all' | 'group' | 'private'

export interface SkillSummary {
  id: string
  name: string
  description: string
  tags: string[]
  chatScope: SkillChatScope
  tools: string[]
  builtinId?: string
}

export interface SkillDef extends SkillSummary {
  prompt: string
}

export interface BuiltinSkillInfo extends SkillSummary {
  imported: boolean
}

const SKILL_DEEP_TIMELINE_MD = `---
id: deep_timeline
name: 深度时间线追踪
description: 适合还原某段时间内发生了什么，强调事件顺序与证据引用。
tags:
  - timeline
  - evidence
chatScope: all
tools:
  - get_time_stats
  - search_sessions
  - get_recent_messages
  - search_messages
  - get_message_context
  - get_session_summaries
---
你是“深度时间线追踪”技能。
执行步骤：
1. 先按时间窗扫描活跃会话，必要时补关键词筛选候选会话。
2. 对候选会话先抽样，再拉取时间轴。
3. 对关键节点用 get_message_context 校对原文。
4. 最后输出“结论 + 关键节点 + 来源范围”。`

const SKILL_CONTACT_FOCUS_MD = `---
id: contact_focus
name: 联系人关系聚焦
description: 用于“我和谁聊得最多/关系变化”这类问题，强调联系人维度。
tags:
  - contacts
  - relation
chatScope: private
tools:
  - get_member_stats
  - get_chat_overview
  - get_recent_messages
  - search_messages
  - get_session_summaries
---
你是“联系人关系聚焦”技能。
执行步骤：
1. 优先调用 get_member_stats 得到候选联系人排名。
2. 针对 Top 联系人读取抽样消息并补充时间轴。
3. 如果用户问题涉及“变化趋势”，补 get_chat_overview。
4. 输出时必须给出对比口径（时间窗、样本范围、消息数量）。`

const SKILL_VOICE_AUDIT_MD = `---
id: voice_audit
name: 语音证据审计
description: 对语音消息进行“先列ID再转写再总结”的合规分析。
tags:
  - voice
  - audit
chatScope: all
tools:
  - ai_list_voice_messages
  - ai_transcribe_voice_messages
  - get_session_summaries
---
你是“语音证据审计”技能。
硬规则：
1. 必须先调用 ai_list_voice_messages 获取语音 ID 清单。
2. 仅能转写用户明确指定的 ID，单轮最多 5 条。
3. 未转写成功的语音不得作为事实。
4. 输出包含“已转写 / 失败 / 待确认”三段。`

const BUILTIN_SKILLS = [
  { id: 'deep_timeline', raw: SKILL_DEEP_TIMELINE_MD },
  { id: 'contact_focus', raw: SKILL_CONTACT_FOCUS_MD },
  { id: 'voice_audit', raw: SKILL_VOICE_AUDIT_MD }
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

function normalizeChatScope(value: unknown): SkillChatScope {
  const scope = normalizeText(value).toLowerCase()
  if (scope === 'group' || scope === 'private') return scope
  return 'all'
}

function parseSkillMarkdown(raw: string): SkillDef {
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
  const name = normalizeText(data.name, id || 'skill')
  const description = normalizeText(data.description)
  const tags = Array.isArray(data.tags)
    ? (data.tags as string[]).map((item) => item.trim()).filter(Boolean)
    : parseInlineList(String(data.tags || ''))
  const tools = Array.isArray(data.tools)
    ? (data.tools as string[]).map((item) => item.trim()).filter(Boolean)
    : parseInlineList(String(data.tools || ''))
  const chatScope = normalizeChatScope(data.chatScope)
  const builtinId = normalizeText(data.builtinId)

  return {
    id,
    name,
    description,
    tags,
    chatScope,
    tools,
    prompt: body,
    builtinId: builtinId || undefined
  }
}

function serializeSkillMarkdown(skill: SkillDef): string {
  const lines = [
    '---',
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `chatScope: ${skill.chatScope}`
  ]
  if (skill.builtinId) lines.push(`builtinId: ${skill.builtinId}`)
  if (skill.tags.length > 0) {
    lines.push('tags:')
    skill.tags.forEach((tag) => lines.push(`  - ${tag}`))
  }
  if (skill.tools.length > 0) {
    lines.push('tools:')
    skill.tools.forEach((tool) => lines.push(`  - ${tool}`))
  }
  lines.push('---')
  lines.push('')
  lines.push(skill.prompt || '')
  return lines.join('\n')
}

class AiSkillService {
  private readonly config = ConfigService.getInstance()
  private initialized = false
  private readonly cache = new Map<string, SkillDef>()

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

  private async getSkillsDir(): Promise<string> {
    const root = await this.getRootDir()
    const dir = join(root, 'skills')
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    const dir = await this.getSkillsDir()

    for (const builtin of BUILTIN_SKILLS) {
      const filePath = join(dir, `${builtin.id}.md`)
      if (!existsSync(filePath)) {
        const parsed = parseSkillMarkdown(builtin.raw)
        const config: SkillDef = {
          ...parsed,
          builtinId: parsed.id
        }
        await writeFile(filePath, serializeSkillMarkdown(config), 'utf8')
        continue
      }
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = parseSkillMarkdown(raw)
        if (!parsed.builtinId) {
          parsed.builtinId = builtin.id
          await writeFile(filePath, serializeSkillMarkdown(parsed), 'utf8')
        }
      } catch {
        // ignore broken file
      }
    }

    this.cache.clear()
    const files = await readdir(dir)
    for (const fileName of files) {
      if (!fileName.endsWith('.md')) continue
      const filePath = join(dir, fileName)
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed = parseSkillMarkdown(raw)
        if (!parsed.id) continue
        this.cache.set(parsed.id, parsed)
      } catch {
        // ignore broken file
      }
    }
    this.initialized = true
  }

  async getAll(): Promise<SkillSummary[]> {
    await this.ensureInitialized()
    return Array.from(this.cache.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: [...skill.tags],
        chatScope: skill.chatScope,
        tools: [...skill.tools],
        builtinId: skill.builtinId
      }))
  }

  async getConfig(id: string): Promise<SkillDef | null> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const value = this.cache.get(key)
    return value ? {
      ...value,
      tags: [...value.tags],
      tools: [...value.tools]
    } : null
  }

  async create(rawMd: string): Promise<{ success: boolean; id?: string; error?: string }> {
    await this.ensureInitialized()
    try {
      const parsed = parseSkillMarkdown(rawMd)
      if (!parsed.id) return { success: false, error: '缺少 id' }
      if (this.cache.has(parsed.id)) return { success: false, error: '技能 ID 已存在' }
      const dir = await this.getSkillsDir()
      await writeFile(join(dir, `${parsed.id}.md`), serializeSkillMarkdown(parsed), 'utf8')
      this.cache.set(parsed.id, parsed)
      return { success: true, id: parsed.id }
    } catch (error) {
      return { success: false, error: String((error as Error)?.message || error) }
    }
  }

  async update(id: string, rawMd: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const existing = this.cache.get(key)
    if (!existing) return { success: false, error: '技能不存在' }
    try {
      const parsed = parseSkillMarkdown(rawMd)
      parsed.id = key
      if (existing.builtinId && !parsed.builtinId) parsed.builtinId = existing.builtinId
      const dir = await this.getSkillsDir()
      await writeFile(join(dir, `${key}.md`), serializeSkillMarkdown(parsed), 'utf8')
      this.cache.set(key, parsed)
      return { success: true }
    } catch (error) {
      return { success: false, error: String((error as Error)?.message || error) }
    }
  }

  async delete(id: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized()
    const key = normalizeText(id)
    const dir = await this.getSkillsDir()
    const filePath = join(dir, `${key}.md`)
    if (existsSync(filePath)) {
      await rm(filePath, { force: true })
    }
    this.cache.delete(key)
    return { success: true }
  }

  async getBuiltinCatalog(): Promise<BuiltinSkillInfo[]> {
    await this.ensureInitialized()
    return BUILTIN_SKILLS.map((builtin) => {
      const parsed = parseSkillMarkdown(builtin.raw)
      const imported = Array.from(this.cache.values()).some((skill) => skill.builtinId === parsed.id || skill.id === parsed.id)
      return {
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        tags: parsed.tags,
        chatScope: parsed.chatScope,
        tools: parsed.tools,
        imported
      }
    })
  }

  async importFromMd(rawMd: string): Promise<{ success: boolean; id?: string; error?: string }> {
    return this.create(rawMd)
  }

  async getAutoSkillMenu(
    chatScope: SkillChatScope,
    allowedTools?: string[]
  ): Promise<string | null> {
    await this.ensureInitialized()
    const compatible = Array.from(this.cache.values()).filter((skill) => {
      if (skill.chatScope !== 'all' && skill.chatScope !== chatScope) return false
      if (!allowedTools || allowedTools.length === 0) return true
      return skill.tools.every((tool) => allowedTools.includes(tool))
    })
    if (compatible.length === 0) return null
    const lines = compatible.slice(0, 15).map((skill) => `- ${skill.id}: ${skill.name} - ${skill.description}`)
    return [
      '你可以按需调用工具 activate_skill 以激活对应技能。',
      '当用户问题明显匹配某个技能时，先调用 activate_skill 获取执行手册。',
      '若问题简单或不匹配技能，可直接回答。',
      '',
      ...lines
    ].join('\n')
  }
}

export const aiSkillService = new AiSkillService()
