import http from 'http'
import https from 'https'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { URL } from 'url'
import { chatService } from './chatService'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'
import { aiAssistantService } from './aiAssistantService'
import { aiSkillService } from './aiSkillService'

type AiIntentType = 'query' | 'summary' | 'analysis' | 'timeline_recall'

type AiToolStatus = 'ok' | 'error' | 'aborted'

interface AiToolCallTrace {
  toolName: string
  args: Record<string, unknown>
  status: AiToolStatus
  durationMs: number
  error?: string
}

interface AiRunState {
  runId: string
  conversationId: string
  aborted: boolean
}

interface AiResultComponentBase {
  type: 'timeline' | 'summary' | 'source'
}

interface TimelineComponent extends AiResultComponentBase {
  type: 'timeline'
  items: Array<{
    ts: number
    sessionId: string
    sessionName: string
    sender: string
    snippet: string
    localId: number
    createTime: number
  }>
}

interface SummaryComponent extends AiResultComponentBase {
  type: 'summary'
  title: string
  bullets: string[]
  conclusion: string
}

interface SourceComponent extends AiResultComponentBase {
  type: 'source'
  range: { begin: number; end: number }
  sessionCount: number
  messageCount: number
  dbRefs: string[]
}

type AiResultComponent = TimelineComponent | SummaryComponent | SourceComponent

interface SendMessageResult {
  conversationId: string
  messageId: string
  assistantText: string
  components: AiResultComponent[]
  toolTrace: AiToolCallTrace[]
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  error?: string
  createdAt: number
}

type AiRunEventStage =
  | 'run_started'
  | 'intent_identified'
  | 'llm_round_started'
  | 'llm_round_result'
  | 'tool_start'
  | 'tool_done'
  | 'tool_error'
  | 'assembling'
  | 'completed'
  | 'aborted'
  | 'error'

export interface AiAnalysisRunEvent {
  runId: string
  conversationId: string
  stage: AiRunEventStage
  ts: number
  message: string
  intent?: AiIntentType
  round?: number
  toolName?: string
  status?: AiToolStatus
  durationMs?: number
  data?: Record<string, unknown>
}

interface LlmResponse {
  content: string
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

interface ToolBundle {
  activeSessions: any[]
  sessionGlimpses: any[]
  sessionCandidates: any[]
  timelineRows: any[]
  topicStats: any
  sourceRefs: any
  topContacts: any[]
  messageBriefs: any[]
  voiceCatalog: any[]
  voiceTranscripts: any[]
}

type ToolCategory = 'core' | 'analysis'

type AssistantChatType = 'group' | 'private'

interface SendMessageOptions {
  parentMessageId?: string
  persistUserMessage?: boolean
  assistantId?: string
  activeSkillId?: string
  chatScope?: AssistantChatType
}

const TOOL_CANONICAL_TO_LEGACY: Record<string, string> = {
  get_chat_overview: 'ai_query_topic_stats',
  search_messages: 'ai_query_timeline',
  deep_search_messages: 'ai_query_timeline',
  get_recent_messages: 'ai_query_session_glimpse',
  get_message_context: 'ai_fetch_message_briefs',
  search_sessions: 'ai_query_session_candidates',
  get_session_messages: 'ai_query_session_glimpse',
  get_members: 'ai_query_top_contacts',
  get_member_stats: 'ai_query_top_contacts',
  get_time_stats: 'ai_query_time_window_activity',
  get_member_name_history: 'ai_query_top_contacts',
  get_conversation_between: 'ai_query_timeline',
  get_session_summaries: 'ai_query_source_refs',
  response_time_analysis: 'ai_query_topic_stats',
  keyword_frequency: 'ai_query_topic_stats',
  ai_list_voice_messages: 'ai_list_voice_messages',
  ai_transcribe_voice_messages: 'ai_transcribe_voice_messages',
  activate_skill: 'activate_skill'
}

const TOOL_LEGACY_TO_CANONICAL: Record<string, string> = {
  ai_query_time_window_activity: 'get_time_stats',
  ai_query_session_glimpse: 'get_recent_messages',
  ai_query_session_candidates: 'search_sessions',
  ai_query_timeline: 'search_messages',
  ai_query_topic_stats: 'get_chat_overview',
  ai_query_source_refs: 'get_session_summaries',
  ai_query_top_contacts: 'get_member_stats',
  ai_fetch_message_briefs: 'get_message_context',
  ai_list_voice_messages: 'ai_list_voice_messages',
  ai_transcribe_voice_messages: 'ai_transcribe_voice_messages',
  activate_skill: 'activate_skill'
}

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  get_chat_overview: 'core',
  search_messages: 'core',
  deep_search_messages: 'core',
  get_recent_messages: 'core',
  get_message_context: 'core',
  search_sessions: 'core',
  get_session_messages: 'core',
  get_members: 'core',
  get_member_stats: 'analysis',
  get_time_stats: 'analysis',
  get_member_name_history: 'analysis',
  get_conversation_between: 'analysis',
  get_session_summaries: 'analysis',
  response_time_analysis: 'analysis',
  keyword_frequency: 'analysis',
  ai_list_voice_messages: 'core',
  ai_transcribe_voice_messages: 'core',
  activate_skill: 'analysis'
}

const CORE_TOOL_NAMES = Object.entries(TOOL_CATEGORY_MAP)
  .filter(([, category]) => category === 'core')
  .map(([name]) => name)

type SkillKey =
  | 'base'
  | 'context_compression'
  | 'tool_time_window_activity'
  | 'tool_session_glimpse'
  | 'tool_session_candidates'
  | 'tool_timeline'
  | 'tool_topic_stats'
  | 'tool_source_refs'
  | 'tool_top_contacts'
  | 'tool_message_briefs'
  | 'tool_voice_list'
  | 'tool_voice_transcribe'

const AI_MODEL_TIMEOUT_MS = 45_000
const MAX_TOOL_LOOPS = 100
const FINAL_DONE_MARKER = '[[WF_DONE]]'
const CONTEXT_RECENT_LIMIT = 14
const CONTEXT_COMPRESS_TRIGGER_COUNT = 34
const CONTEXT_KEEP_AFTER_COMPRESS = 26
const MAX_TOOL_RESULT_ROWS = 120
const MIN_Glimpse_SESSIONS = 3
const CONTEXT_SUMMARY_MAX_CHARS = 6_000
const CONTEXT_RECENT_MAX_CHARS = 12_000
const VOICE_TRANSCRIBE_BATCH_LIMIT = 5

type ToolResultDetailLevel = 'minimal' | 'standard' | 'full'

function escSql(value: string): string {
  return String(value || '').replace(/'/g, "''")
}

function parseIntSafe(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

function parseOptionalInt(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : undefined
}

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function toCanonicalToolName(value: unknown): string {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  return TOOL_LEGACY_TO_CANONICAL[normalized] || normalized
}

function toLegacyToolName(value: unknown): string {
  const canonical = toCanonicalToolName(value)
  if (!canonical) return ''
  return TOOL_CANONICAL_TO_LEGACY[canonical] || canonical
}

function parseStoredToolStep(content: string): null | {
  toolName: string
  status: string
  durationMs: number
  result: Record<string, unknown>
} {
  const raw = normalizeText(content)
  if (!raw.startsWith('__wf_tool_step__')) return null
  try {
    const payload = JSON.parse(raw.slice('__wf_tool_step__'.length))
    return {
      toolName: normalizeText(payload?.toolName),
      status: normalizeText(payload?.status),
      durationMs: parseIntSafe(payload?.durationMs),
      result: payload?.result && typeof payload.result === 'object' ? payload.result : {}
    }
  } catch {
    return null
  }
}

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function defaultIntentType(): AiIntentType {
  return 'analysis'
}

function extractJsonStringField(json: string, key: string): string {
  const needle = `"${key}"`
  let pos = json.indexOf(needle)
  if (pos < 0) return ''
  pos = json.indexOf(':', pos + needle.length)
  if (pos < 0) return ''
  pos = json.indexOf('"', pos + 1)
  if (pos < 0) return ''
  pos += 1
  let out = ''
  let escaped = false
  for (; pos < json.length; pos += 1) {
    const ch = json[pos]
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

function resolveDetailLevel(args: Record<string, any>): ToolResultDetailLevel {
  const detailLevel = normalizeText(args.detailLevel).toLowerCase()
  if (detailLevel === 'full') return 'full'
  if (detailLevel === 'standard') return 'standard'
  if (args.verbose === true) return 'full'
  return 'minimal'
}

function normalizeTimestampSeconds(value: unknown): number {
  const numeric = Number(value || 0)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric)
}

function resolveNamedTimeWindow(period: string): { begin: number; end: number } | null {
  const now = new Date()
  const lower = normalizeText(period).toLowerCase()
  const mkSec = (d: Date) => Math.floor(d.getTime() / 1000)

  if (!lower || lower === 'custom') return null
  if (lower === 'today_dawn' || lower === '凌晨') {
    const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0)
    return { begin: mkSec(begin), end: mkSec(end) }
  }
  if (lower === 'today') {
    const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    return { begin: mkSec(begin), end: mkSec(end) }
  }
  if (lower === 'yesterday') {
    const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0)
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
    return { begin: mkSec(begin), end: mkSec(end) }
  }
  if (lower === 'last_7_days') {
    const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0)
    return { begin: mkSec(begin), end: mkSec(now) }
  }
  return null
}

function isTimeWindowIntent(input: string): boolean {
  const text = normalizeText(input)
  return /(凌晨|昨晚|今天|昨日|昨夜|最近|本周|这周|这个月|时间段)/.test(text)
}

function isContactRecallIntent(input: string): boolean {
  const text = normalizeText(input)
  if (!text) return false
  return /(我和|跟).{0,24}(聊了什么|都聊了什么|说了什么|最近聊|聊啥|聊过什么)/.test(text)
}

function resolveImplicitRecentRange(input: string): { beginTimestamp: number; endTimestamp: number } | null {
  const text = normalizeText(input).toLowerCase()
  const now = Math.floor(Date.now() / 1000)
  if (/(最近|近期|lately|recent)/i.test(text)) {
    return { beginTimestamp: now - 30 * 86400, endTimestamp: now }
  }
  if (/(今天|today)/i.test(text)) {
    const d = new Date()
    const begin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
    return { beginTimestamp: Math.floor(begin.getTime() / 1000), endTimestamp: now }
  }
  if (/(昨晚|昨天|yesterday)/i.test(text)) {
    const d = new Date()
    const begin = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 0, 0, 0, 0)
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 23, 59, 59, 999)
    return { beginTimestamp: Math.floor(begin.getTime() / 1000), endTimestamp: Math.floor(end.getTime() / 1000) }
  }
  return null
}

function extractContactHint(input: string): string {
  const text = normalizeText(input)
  if (!text) return ''
  const match = text.match(/(?:我和|跟)\s*([^\s，。！？?,]{1,24})/)
  const explicit = normalizeText(match?.[1])
  if (explicit) return explicit
  if (/^[\u4e00-\u9fa5a-zA-Z0-9_]{1,16}$/.test(text)) return text
  return ''
}

function normalizeLookupToken(value: unknown): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s_\-.@]/g, '')
}

function getLatinInitials(value: unknown): string {
  const text = normalizeText(value).toLowerCase()
  if (!text) return ''
  const parts = text.match(/[a-z0-9]+/g) || []
  return parts.map((part) => part[0]).join('')
}

function isLikelyContactOnlyInput(input: string): boolean {
  const text = normalizeText(input)
  if (!text) return false
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{1,16}$/.test(text)) return false
  return !/(聊|什么|怎么|为何|为什么|是否|吗|呢|？|\?)/.test(text)
}

class AiAnalysisService {
  private readonly config = ConfigService.getInstance()
  private readonly activeRuns = new Map<string, AiRunState>()
  private readonly skillCache = new Map<SkillKey, string>()

  private getSharedModelConfig(): { apiBaseUrl: string; apiKey: string; model: string } {
    const apiBaseUrl = normalizeText(this.config.get('aiModelApiBaseUrl'))
    const apiKey = normalizeText(this.config.get('aiModelApiKey'))
    const model = normalizeText(this.config.get('aiModelApiModel'), 'gpt-4o-mini')
    return { apiBaseUrl, apiKey, model }
  }

  private getSkillDirCandidates(): string[] {
    return [
      join(__dirname, 'aiAnalysisSkills'),
      join(process.cwd(), 'electron', 'services', 'aiAnalysisSkills'),
      join(process.cwd(), 'dist-electron', 'services', 'aiAnalysisSkills')
    ]
  }

  private getBuiltinSkill(skill: SkillKey): string {
    const builtin: Record<SkillKey, string> = {
      base: [
        '你是 WeFlow 的 AI 分析助手。',
        '优先使用本地工具获得事实，禁止编造数据。',
        '输出简洁中文，结论与证据一致。',
        '当 get_member_stats 返回非空 items 时，必须直接给出“前N名+消息数”的明确结论，不得回复“未命中”。',
        '除非用户明确提到“群/群聊/公众号”，联系人排行默认按个人联系人口径（排除群聊与公众号）。',
        '用户提到“最近/近期/lately/recent”但未给时间窗时，默认按近30天口径检索并在结论中写明口径。',
        '默认优先调用 detailLevel=minimal，证据不足时再升级到 standard/full。',
        '当用户目标不够清晰时，先做小规模探索，再主动提出 1 个澄清问题继续多轮对话。',
        '面对“看一下凌晨聊天/今天记录”这类请求，先扫描时间窗活跃会话，再按会话逐个抽样阅读，不要只调用一次工具就结束。',
        '在证据不足时先说明不足，再建议下一步。',
        '语音消息必须先请求“语音ID列表”，再指定ID进行转写，不可臆测语音内容。',
        `结束协议：仅在任务完成时输出 ${FINAL_DONE_MARKER}，并附带 <final_answer>最终回答</final_answer>。`,
        '若未完成，请继续调用工具，不要提前结束。'
      ].join('\n'),
      context_compression: [
        '你会收到 conversation_summary 作为历史压缩摘要。',
        '当摘要与最近消息冲突时，以最近消息为准。',
        '若用户追问很早历史，可主动调用工具重新检索，不依赖陈旧记忆。'
      ].join('\n'),
      tool_time_window_activity: [
        '工具 get_time_stats 用于按时间窗找活跃会话。',
        '处理“今天凌晨/昨晚/本周”时优先调用，先拿候选会话池。',
        '默认 minimal，小范围快速扫描；需要时再增大 scanLimit。'
      ].join('\n'),
      tool_session_glimpse: [
        '工具 get_recent_messages 用于按会话抽样阅读消息。',
        '拿到活跃会话后，逐个会话先读 6~20 条快速建立上下文。',
        '若抽样后仍不确定用户目标，先追问 1 个关键澄清问题。'
      ].join('\n'),
      tool_session_candidates: [
        '工具 search_sessions 用于先缩小会话范围。',
        '默认先查候选会话，再查时间轴，能明显减少 token 和耗时。',
        '如果用户已给出明确联系人/会话，可跳过候选直接查时间轴。'
      ].join('\n'),
      tool_timeline: [
        '工具 search_messages 返回按时间倒序的消息事件。',
        '需要回忆经过、做时间轴时优先调用。',
        '默认返回精简字段；只有用户明确要细节时才请求 verbose。'
      ].join('\n'),
      tool_topic_stats: [
        '工具 get_chat_overview 提供跨会话统计聚合。',
        '适合回答“多少、趋势、占比、对比”问题。',
        '若只是复盘事件，不要先做重统计。'
      ].join('\n'),
      tool_source_refs: [
        '工具 get_session_summaries 用于生成可解释来源卡。',
        '总结/分析完成后补一次来源引用即可。',
        '优先返回范围、会话数、消息数和数据库引用。'
      ].join('\n'),
      tool_top_contacts: [
        '工具 get_member_stats 用于回答“谁联系最密切/谁聊得最多”。',
        '这是该类问题的首选工具，优先于时间轴检索。',
        '默认 minimal 即可得到排名；需要更多字段再升 detailLevel。'
      ].join('\n'),
      tool_message_briefs: [
        '工具 get_message_context 按 sessionId+localId 精确读取消息。',
        '用于核对关键原文证据，避免大范围全文拉取。',
        '默认最小字段，只有需要时才请求 full 明细。'
      ].join('\n'),
      tool_voice_list: [
        '工具 ai_list_voice_messages 用于语音清单检索。',
        '先列出可用语音ID，再让你决定转写哪几条。',
        '默认只返回 IDs，减少 token；需要详情再提升 detailLevel。'
      ].join('\n'),
      tool_voice_transcribe: [
        '工具 ai_transcribe_voice_messages 根据语音ID进行自动解密并转写。',
        '只能转写你明确指定的ID，单次最多 5 条。',
        '若用户未点名具体ID，先调用语音清单工具返回 ID 再继续。',
        '收到转写后再做总结，禁止未转写先下结论。'
      ].join('\n')
    }
    return builtin[skill]
  }

  private async loadSkill(skill: SkillKey): Promise<string> {
    const cached = this.skillCache.get(skill)
    if (cached) return cached

    const fileName = `${skill}.md`
    for (const dir of this.getSkillDirCandidates()) {
      const filePath = join(dir, fileName)
      if (!existsSync(filePath)) continue
      try {
        const content = (await readFile(filePath, 'utf8')).trim()
        if (content) {
          this.skillCache.set(skill, content)
          return content
        }
      } catch {
        // ignore and fallback
      }
    }

    const fallback = this.getBuiltinSkill(skill)
    this.skillCache.set(skill, fallback)
    return fallback
  }

  private resolveAllowedToolNames(allowedBuiltinTools?: string[]): string[] {
    const whitelist = Array.isArray(allowedBuiltinTools)
      ? allowedBuiltinTools.map((item) => toCanonicalToolName(item)).filter(Boolean)
      : []
    const allowedSet = new Set<string>(CORE_TOOL_NAMES)
    if (whitelist.length === 0) {
      for (const [name, category] of Object.entries(TOOL_CATEGORY_MAP)) {
        if (category === 'analysis') allowedSet.add(name)
      }
    } else {
      for (const toolName of whitelist) {
        if (TOOL_CATEGORY_MAP[toolName]) allowedSet.add(toolName)
      }
    }
    allowedSet.add('activate_skill')
    return Array.from(allowedSet)
  }

  private resolveChatType(options?: SendMessageOptions): AssistantChatType {
    if (options?.chatScope === 'group' || options?.chatScope === 'private') return options.chatScope
    return 'private'
  }

  async getToolCatalog(): Promise<Array<{ name: string; category: ToolCategory; description: string; parameters: any }>> {
    return this.getToolDefinitions().map((entry) => {
      const toolName = normalizeText(entry?.function?.name)
      return {
        name: toolName,
        category: TOOL_CATEGORY_MAP[toolName] || 'analysis',
        description: normalizeText(entry?.function?.description),
        parameters: entry?.function?.parameters || {}
      }
    })
  }

  async executeTool(
    name: string,
    args: Record<string, any>
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      const toolName = toCanonicalToolName(name)
      if (!toolName) return { success: false, error: '缺少工具名' }
      const result = await this.runTool(toolName, args || {})
      return { success: true, result }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async cancelToolTest(_taskId?: string): Promise<{ success: boolean }> {
    return { success: true }
  }

  private async ensureAiDbPath(): Promise<{ dbPath: string; wxid: string }> {
    const dbRoot = normalizeText(this.config.get('dbPath'))
    const wxid = normalizeText(this.config.get('myWxid'))
    if (!dbRoot) throw new Error('未配置数据库路径，请先在设置中完成数据库连接')
    if (!wxid) throw new Error('未识别当前账号，请先完成账号配置')
    const aiDir = join(dbRoot, wxid, 'db_storage', 'wf_ai_v2')
    await mkdir(aiDir, { recursive: true })
    const markerPath = join(aiDir, '.storage_v2_initialized')
    const dbPath = join(aiDir, 'ai_analysis_v2.db')
    if (!existsSync(markerPath)) {
      try {
        await rm(dbPath, { force: true })
      } catch {
        // ignore
      }
      try {
        await rm(join(dbRoot, wxid, 'db_storage', 'wf_ai', 'ai_analysis.db'), { force: true })
      } catch {
        // ignore
      }
      await writeFile(markerPath, JSON.stringify({ version: 2, initializedAt: Date.now() }), 'utf8')
    }
    return {
      dbPath,
      wxid
    }
  }

  private async ensureConnected(): Promise<void> {
    const connected = await chatService.connect()
    if (!connected.success) {
      throw new Error(connected.error || '数据库连接失败')
    }
  }

  private async ensureSchema(aiDbPath: string): Promise<void> {
    const sqlList = [
      `CREATE TABLE IF NOT EXISTS ai_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        summary_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        intent_type TEXT NOT NULL DEFAULT '',
        components_json TEXT NOT NULL DEFAULT '[]',
        tool_trace_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        parent_message_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_tool_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_args_json TEXT NOT NULL DEFAULT '{}',
        tool_result_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'ok',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created ON ai_messages(conversation_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_ai_tool_runs_run_id ON ai_tool_runs(run_id)'
    ]

    for (const sql of sqlList) {
      const result = await wcdbService.execQuery('biz', aiDbPath, sql)
      if (!result.success) {
        throw new Error(result.error || 'AI 分析数据库初始化失败')
      }
    }

    // 兼容旧表结构
    await wcdbService.execQuery('biz', aiDbPath, `ALTER TABLE ai_conversations ADD COLUMN summary_text TEXT NOT NULL DEFAULT ''`)
  }

  private async ensureReady(): Promise<{ dbPath: string; wxid: string }> {
    await this.ensureConnected()
    const aiInfo = await this.ensureAiDbPath()
    await this.ensureSchema(aiInfo.dbPath)
    return aiInfo
  }

  private async queryRows(aiDbPath: string, sql: string): Promise<any[]> {
    const result = await wcdbService.execQuery('biz', aiDbPath, sql)
    if (!result.success) throw new Error(result.error || '查询失败')
    return Array.isArray(result.rows) ? result.rows : []
  }

  private async callModel(payload: any, apiBaseUrl: string, apiKey: string): Promise<any> {
    const endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
    const body = JSON.stringify(payload)
    const urlObj = new URL(endpoint)
    return new Promise((resolve, reject) => {
      const requestFn = urlObj.protocol === 'https:' ? https.request : http.request
      const req = requestFn({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          Authorization: `Bearer ${apiKey}`
        }
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += String(chunk) })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data || '{}'))
          } catch (error) {
            reject(new Error(`AI 响应解析失败: ${String(error)}`))
          }
        })
      })

      req.setTimeout(AI_MODEL_TIMEOUT_MS, () => {
        req.destroy()
        reject(new Error('AI 请求超时'))
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private getToolDefinitions(allowedToolNames?: string[]) {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_chat_overview',
          description: '获取聊天总体概览（总量、分布、活跃会话）',
          parameters: {
            type: 'object',
            properties: {
              session_ids: { type: 'array', items: { type: 'string' } },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_messages',
          description: '按关键词搜索消息（可带上下文）',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              keywords: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } }
                ]
              },
              keyword: { type: 'string' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              contextBefore: { type: 'number' },
              contextAfter: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'deep_search_messages',
          description: '深度关键词搜索（跨会话候选 + 上下文扩展）',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              keywords: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } }
                ]
              },
              keyword: { type: 'string' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              contextBefore: { type: 'number' },
              contextAfter: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_recent_messages',
          description: '获取最近消息（按时间窗或数量）',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              limit: { type: 'number' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_message_context',
          description: '按消息 ID 获取上下文',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              message_ids: { type: 'array', items: { type: 'number' } },
              context_size: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            },
            required: ['message_ids']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_sessions',
          description: '搜索会话并返回预览',
          parameters: {
            type: 'object',
            properties: {
              keywords: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } }
                ]
              },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              limit: { type: 'number' },
              previewCount: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_session_messages',
          description: '读取指定会话的消息',
          parameters: {
            type: 'object',
            properties: {
              session_id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              limit: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            },
            required: ['session_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_members',
          description: '获取成员列表（支持搜索）',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'number' },
              search: { type: 'string' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_member_stats',
          description: '成员活跃度排行',
          parameters: {
            type: 'object',
            properties: {
              top_n: { type: 'number' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_time_stats',
          description: '按时间维度统计活跃情况',
          parameters: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'day|hour|week|month' },
              period: { type: 'string', description: 'today_dawn|today|yesterday|last_7_days|custom' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_member_name_history',
          description: '成员名称历史查询',
          parameters: {
            type: 'object',
            properties: {
              member_id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              limit: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            },
            required: ['member_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_conversation_between',
          description: '获取两名成员之间的对话',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              member_id1: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              member_id2: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              limit: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            },
            required: ['member_id1', 'member_id2']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_session_summaries',
          description: '批量获取会话摘要',
          parameters: {
            type: 'object',
            properties: {
              session_ids: { type: 'array', items: { type: 'string' } },
              limit: { type: 'number' },
              previewCount: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'response_time_analysis',
          description: '响应时延分析',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'keyword_frequency',
          description: '关键词频率统计',
          parameters: {
            type: 'object',
            properties: {
              keywords: { type: 'array', items: { type: 'string' } },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              limit: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'ai_list_voice_messages',
          description: '列出语音消息ID清单（先拿ID，再点名转写）',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string' },
              beginTimestamp: { type: 'number' },
              endTimestamp: { type: 'number' },
              limit: { type: 'number' },
              offset: { type: 'number' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'ai_transcribe_voice_messages',
          description: '根据语音ID列表执行自动解密+转写，返回文本',
          parameters: {
            type: 'object',
            properties: {
              ids: {
                type: 'array',
                items: { type: 'string' },
                description: '格式 sessionId:localId[:createTime]'
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string' },
                    localId: { type: 'number' },
                    createTime: { type: 'number' }
                  },
                  required: ['sessionId', 'localId']
                }
              },
              verbose: { type: 'boolean' },
              detailLevel: { type: 'string', enum: ['minimal', 'standard', 'full'] }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'activate_skill',
          description: '激活一个技能并返回技能手册内容',
          parameters: {
            type: 'object',
            properties: {
              skill_id: { type: 'string', description: '技能 ID' }
            },
            required: ['skill_id']
          }
        }
      }
    ]
    if (!allowedToolNames || allowedToolNames.length === 0) return tools
    const whitelist = new Set(allowedToolNames)
    return tools.filter((entry: any) => whitelist.has(normalizeText(entry?.function?.name)))
  }

  private async requestLlmStep(
    messages: any[],
    model: string,
    apiBaseUrl: string,
    apiKey: string,
    allowedToolNames?: string[]
  ): Promise<LlmResponse> {
    const res = await this.callModel({
      model,
      messages,
      tools: this.getToolDefinitions(allowedToolNames),
      tool_choice: 'auto',
      temperature: 0.2,
      stream: false
    }, apiBaseUrl, apiKey)

    const choice = res?.choices?.[0]?.message || {}
    const toolCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map((item: any) => ({
          id: String(item?.id || randomUUID()),
          name: String(item?.function?.name || ''),
          argumentsJson: String(item?.function?.arguments || '{}')
        }))
      : []
    return {
      content: normalizeText(choice?.content),
      toolCalls: toolCalls.filter((t: any) => t.name),
      usage: {
        promptTokens: parseOptionalInt(res?.usage?.prompt_tokens),
        completionTokens: parseOptionalInt(res?.usage?.completion_tokens),
        totalTokens: parseOptionalInt(res?.usage?.total_tokens)
      }
    }
  }

  private parseFinalDelivery(content: string): { done: boolean; answer: string } {
    const raw = normalizeText(content)
    if (!raw) return { done: false, answer: '' }
    if (!raw.includes(FINAL_DONE_MARKER)) return { done: false, answer: '' }

    const afterMarker = raw.slice(raw.indexOf(FINAL_DONE_MARKER) + FINAL_DONE_MARKER.length).trim()
    const tagMatch = afterMarker.match(/<final_answer>([\s\S]*?)<\/final_answer>/i)
    if (!tagMatch) return { done: true, answer: '' }
    const answer = normalizeText(tagMatch[1])
    return { done: true, answer }
  }

  private stripFinalMarker(content: string): string {
    const raw = normalizeText(content)
    if (!raw) return ''
    return normalizeText(
      raw
        .replace(FINAL_DONE_MARKER, '')
        .replace(/<\/?final_answer>/ig, '')
    )
  }

  private compactRows(rows: any[], detailLevel: ToolResultDetailLevel = 'minimal'): any[] {
    if (detailLevel === 'full') return rows.slice(0, MAX_TOOL_RESULT_ROWS)
    if (detailLevel === 'standard') {
      return rows.slice(0, MAX_TOOL_RESULT_ROWS).map((row) => ({
        _session_id: normalizeText(row._session_id),
        local_id: parseIntSafe(row.local_id),
        create_time: parseIntSafe(row.create_time),
        sender_username: normalizeText(row.sender_username),
        local_type: parseIntSafe(row.local_type),
        content: normalizeText(row.content || row.parsedContent).slice(0, 320)
      }))
    }
    return rows.slice(0, MAX_TOOL_RESULT_ROWS).map((row) => {
      const content = normalizeText(row.content || row.parsedContent)
      return {
        _session_id: normalizeText(row._session_id),
        local_id: parseIntSafe(row.local_id),
        create_time: parseIntSafe(row.create_time),
        sender_username: normalizeText(row.sender_username),
        content: content.slice(0, 160)
      }
    })
  }

  private compactStats(stats: any, detailLevel: ToolResultDetailLevel = 'minimal'): any {
    if (detailLevel === 'full') return stats
    if (!stats || typeof stats !== 'object') return {}
    if (detailLevel === 'standard') {
      return {
        total: parseIntSafe(stats.total),
        sent: parseIntSafe(stats.sent),
        received: parseIntSafe(stats.received),
        firstTime: parseIntSafe(stats.firstTime),
        lastTime: parseIntSafe(stats.lastTime),
        typeCounts: stats.typeCounts || {},
        sessions: stats.sessions || {}
      }
    }
    return {
      total: parseIntSafe(stats.total),
      sent: parseIntSafe(stats.sent),
      received: parseIntSafe(stats.received),
      firstTime: parseIntSafe(stats.firstTime),
      lastTime: parseIntSafe(stats.lastTime),
      typeCounts: stats.typeCounts || {},
      topSessions: (() => {
        const sessions = stats.sessions && typeof stats.sessions === 'object' ? stats.sessions : {}
        const arr = Object.entries(sessions).map(([sessionId, val]: any) => ({
          sessionId,
          total: parseIntSafe(val?.total),
          sent: parseIntSafe(val?.sent),
          received: parseIntSafe(val?.received),
          lastTime: parseIntSafe(val?.lastTime)
        }))
        arr.sort((a, b) => b.total - a.total)
        return arr.slice(0, 12)
      })()
    }
  }

  private parseVoiceIds(ids: string[]): Array<{ sessionId: string; localId: number; createTime?: number }> {
    const requests: Array<{ sessionId: string; localId: number; createTime?: number }> = []
    for (const id of ids || []) {
      const raw = normalizeText(id)
      if (!raw) continue
      const parts = raw.split(':')
      if (parts.length < 2) continue
      const sessionId = normalizeText(parts[0])
      const localId = parseIntSafe(parts[1])
      const createTime = parts.length >= 3 ? parseIntSafe(parts[2]) : 0
      if (!sessionId || localId <= 0) continue
      requests.push({ sessionId, localId, createTime: createTime > 0 ? createTime : undefined })
    }
    return requests
  }

  private async runTool(name: string, args: Record<string, any>, context?: { userInput?: string }): Promise<any> {
    const canonicalName = toCanonicalToolName(name)
    const legacyName = toLegacyToolName(canonicalName)
    const detailLevel = resolveDetailLevel(args)
    const maxMessagesPerRequest = Math.max(
      20,
      Math.min(500, parseIntSafe(this.config.get('aiAgentMaxMessagesPerRequest'), 120))
    )

    const beginTimestamp = normalizeTimestampSeconds(args.beginTimestamp ?? args.startTs)
    const endTimestamp = normalizeTimestampSeconds(args.endTimestamp ?? args.endTs)
    const readSessionId = () => normalizeText(args.sessionId || args.session_id)
    const mapAiMessage = (message: any) => ({
      id: parseIntSafe(message.id ?? message.localId),
      localId: parseIntSafe(message.localId ?? message.id),
      sessionId: normalizeText(message.sessionId || message._session_id || message.session_id),
      senderName: normalizeText(message.senderName || message.sender_username || message.sender),
      senderPlatformId: normalizeText(message.senderPlatformId || message.sender_username),
      senderUsername: normalizeText(message.senderUsername || message.sender_username),
      content: normalizeText(message.content || message.snippet),
      timestamp: parseIntSafe(message.timestamp || message.createTime || message.create_time),
      type: parseIntSafe(message.type || message.localType || message.local_type)
    })
    const parseKeywordList = () => {
      if (Array.isArray(args.keywords)) {
        return args.keywords.map((item: any) => normalizeText(item)).filter(Boolean)
      }
      const keyword = normalizeText(args.keyword || args.keywords)
      return keyword ? [keyword] : []
    }

    if (canonicalName === 'search_messages' || canonicalName === 'deep_search_messages') {
      const keywordList = parseKeywordList()
      const keyword = keywordList.join(' ').trim()
      if (!keyword) return { success: false, error: 'keywords 不能为空' }
      const sessionId = readSessionId()
      const limit = Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 60)))
      const offset = Math.max(0, parseIntSafe(args.offset, 0))
      const searchResult = await chatService.searchMessages(
        keyword,
        sessionId || undefined,
        limit,
        offset,
        beginTimestamp,
        endTimestamp
      )
      if (!searchResult.success) {
        return { success: false, error: searchResult.error || '搜索失败' }
      }
      const hitMessages = (searchResult.messages || []).map(mapAiMessage)
      if (canonicalName === 'deep_search_messages' && sessionId && hitMessages.length > 0) {
        const before = Math.max(0, Math.min(20, parseIntSafe(args.contextBefore, 2)))
        const after = Math.max(0, Math.min(20, parseIntSafe(args.contextAfter, 2)))
        const contextRows = await chatService.getSearchMessageContextForAI(
          sessionId,
          hitMessages.map((item) => item.id).filter((id) => id > 0),
          before,
          after
        )
        return {
          success: true,
          total: hitMessages.length,
          returned: contextRows.length,
          rows: contextRows.map(mapAiMessage),
          rawMessages: contextRows.map(mapAiMessage)
        }
      }
      return {
        success: true,
        total: hitMessages.length,
        returned: hitMessages.length,
        rows: hitMessages,
        rawMessages: hitMessages
      }
    }

    if (canonicalName === 'get_recent_messages') {
      let sessionId = readSessionId()
      if (!sessionId) {
        const sessions = await chatService.getSessions()
        if (sessions.success && Array.isArray(sessions.sessions) && sessions.sessions.length > 0) {
          sessionId = normalizeText(sessions.sessions[0].username)
        }
      }
      if (!sessionId) return { success: false, error: 'sessionId 不能为空' }
      const limit = Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 120)))
      const result = await chatService.getRecentMessagesForAI(sessionId, {
        startTs: beginTimestamp,
        endTs: endTimestamp
      }, limit)
      return {
        success: true,
        total: result.total,
        returned: result.messages.length,
        rawMessages: result.messages.map(mapAiMessage)
      }
    }

    if (canonicalName === 'get_message_context') {
      const sessionId = readSessionId()
      const ids = Array.isArray(args.message_ids)
        ? args.message_ids
        : Array.isArray(args.messageIds)
          ? args.messageIds
          : []
      const contextSize = Math.max(0, Math.min(120, parseIntSafe(args.context_size ?? args.contextSize, 20)))
      if (!sessionId) return { success: false, error: 'sessionId 不能为空' }
      if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, error: 'message_ids 不能为空' }
      }
      const rows = await chatService.getMessageContextForAI(sessionId, ids.map((item: any) => parseIntSafe(item)), contextSize)
      return { success: true, totalMessages: rows.length, rawMessages: rows.map(mapAiMessage) }
    }

    if (canonicalName === 'search_sessions') {
      const keywords = parseKeywordList()
      const limit = Math.max(1, Math.min(60, parseIntSafe(args.limit, 20)))
      const previewCount = Math.max(1, Math.min(20, parseIntSafe(args.previewCount, 5)))
      const rows = await chatService.searchSessionsForAI('', keywords, {
        startTs: beginTimestamp,
        endTs: endTimestamp
      }, limit, previewCount)
      return { success: true, total: rows.length, sessions: rows }
    }

    if (canonicalName === 'get_session_messages') {
      const sessionRef = args.session_id ?? args.sessionId
      const limit = Math.max(1, Math.min(1000, parseIntSafe(args.limit, 500)))
      const data = await chatService.getSessionMessagesForAI('', sessionRef, limit)
      return data ? { success: true, ...data } : { success: false, error: '会话不存在' }
    }

    if (canonicalName === 'get_session_summaries') {
      const sessionIds = Array.isArray(args.session_ids)
        ? args.session_ids.map((value: any) => normalizeText(value)).filter(Boolean)
        : []
      const limit = Math.max(1, Math.min(60, parseIntSafe(args.limit, 20)))
      const previewCount = Math.max(1, Math.min(20, parseIntSafe(args.previewCount, 3)))
      const rows = await chatService.getSessionSummariesForAI('', { sessionIds, limit, previewCount })
      return { success: true, total: rows.length, sessions: rows }
    }

    if (canonicalName === 'get_members') {
      const contactsResult = await chatService.getContacts({ lite: true })
      if (!contactsResult.success || !Array.isArray(contactsResult.contacts)) {
        return { success: false, error: contactsResult.error || '获取成员失败' }
      }
      const searchText = normalizeText(args.search).toLowerCase()
      const limit = Math.max(1, Math.min(300, parseIntSafe(args.limit, 120)))
      const members = contactsResult.contacts
        .map((contact: any) => {
          const username = normalizeText(contact.username)
          const displayName = normalizeText(contact.displayName || contact.remark || contact.nickname || username)
          let hash = 5381
          const text = username.toLowerCase()
          for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
          return {
            member_id: Math.abs(hash),
            display_name: displayName,
            platform_id: username,
            aliases: [normalizeText(contact.remark), normalizeText(contact.nickname)].filter(Boolean)
          }
        })
        .filter((member: any) => {
          if (!searchText) return true
          return (
            normalizeText(member.display_name).toLowerCase().includes(searchText) ||
            normalizeText(member.platform_id).toLowerCase().includes(searchText)
          )
        })
        .slice(0, limit)
      return { success: true, total: members.length, members }
    }

    if (canonicalName === 'get_conversation_between') {
      const sessionId = readSessionId()
      if (!sessionId) return { success: false, error: 'sessionId 不能为空' }
      const memberId1 = parseIntSafe(args.member_id1 ?? args.memberId1)
      const memberId2 = parseIntSafe(args.member_id2 ?? args.memberId2)
      const limit = Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 100)))
      const rows = await chatService.getConversationBetweenForAI(
        sessionId,
        memberId1,
        memberId2,
        { startTs: beginTimestamp, endTs: endTimestamp },
        limit
      )
      return {
        success: true,
        total: rows.total,
        member1Name: rows.member1Name,
        member2Name: rows.member2Name,
        rawMessages: rows.messages.map(mapAiMessage)
      }
    }

    if (canonicalName === 'get_chat_overview') {
      const summaries = await chatService.getSessionSummariesForAI('', {
        limit: Math.max(3, Math.min(30, parseIntSafe(args.limit, 12))),
        previewCount: 3
      })
      const totalMessages = summaries.reduce((sum, item) => sum + parseIntSafe(item.messageCount), 0)
      return {
        success: true,
        totalSessions: summaries.length,
        totalMessages,
        sessions: summaries
      }
    }

    if (canonicalName === 'get_member_stats' && !args.limit && args.top_n) {
      args.limit = parseIntSafe(args.top_n)
    }
    if (canonicalName === 'get_time_stats' && !args.period && args.type) {
      args.period = normalizeText(args.type)
    }
    if (canonicalName === 'response_time_analysis' || canonicalName === 'keyword_frequency' || canonicalName === 'get_member_name_history') {
      return {
        success: true,
        note: `工具 ${canonicalName} 在 WeFlow 当前数据模型下采用近似统计，请结合会话详情继续核验。`
      }
    }

    if (legacyName === 'ai_query_time_window_activity') {
      const namedWindow = resolveNamedTimeWindow(normalizeText(args.period))
      const beginTimestamp = namedWindow?.begin || normalizeTimestampSeconds(args.beginTimestamp)
      const endTimestamp = namedWindow?.end || normalizeTimestampSeconds(args.endTimestamp)
      if (beginTimestamp <= 0 || endTimestamp <= 0 || endTimestamp < beginTimestamp) {
        return { success: false, error: '请提供有效时间窗（period 或 beginTimestamp/endTimestamp）' }
      }

      const includeGroups = typeof args.includeGroups === 'boolean'
        ? args.includeGroups
        : true
      const includeOfficial = typeof args.includeOfficial === 'boolean'
        ? args.includeOfficial
        : false
      const scanLimit = Math.max(20, Math.min(1000, parseIntSafe(args.scanLimit, 260)))
      const topN = Math.max(1, Math.min(60, parseIntSafe(args.topN, 24)))

      const sessionsRes = await chatService.getSessions()
      if (!sessionsRes.success || !Array.isArray(sessionsRes.sessions)) {
        return { success: false, error: sessionsRes.error || '会话列表获取失败' }
      }

      const scannedSessions = sessionsRes.sessions
        .filter((session: any) => {
          const sessionId = normalizeText(session.username)
          if (!sessionId) return false
          const isGroup = sessionId.endsWith('@chatroom')
          const isOfficial = sessionId.startsWith('gh_')
          if (!includeGroups && isGroup) return false
          if (!includeOfficial && isOfficial) return false
          return true
        })
        .sort((a: any, b: any) => parseIntSafe(b.sortTimestamp || b.lastTimestamp) - parseIntSafe(a.sortTimestamp || a.lastTimestamp))
        .slice(0, scanLimit)

      const sessionIds = scannedSessions.map((session: any) => normalizeText(session.username)).filter(Boolean)
      if (sessionIds.length === 0) {
        return { success: true, beginTimestamp, endTimestamp, totalScanned: 0, activeCount: 0, items: [] }
      }

      const statsRes = await wcdbService.getSessionMessageTypeStatsBatch(sessionIds, {
        beginTimestamp,
        endTimestamp,
        quickMode: true,
        includeGroupSenderCount: false
      })
      if (!statsRes.success || !statsRes.data) {
        return { success: false, error: statsRes.error || '时间窗活跃扫描失败' }
      }

      const items = scannedSessions.map((session: any) => {
        const sessionId = normalizeText(session.username)
        const row = (statsRes.data as any)?.[sessionId] || {}
        return {
          sessionId,
          sessionName: normalizeText(session.displayName || sessionId),
          messageCount: Math.max(0, parseIntSafe(row.totalMessages ?? row.total_messages ?? row.total)),
          sentCount: Math.max(0, parseIntSafe(row.sentMessages ?? row.sent_messages ?? row.sent)),
          receivedCount: Math.max(0, parseIntSafe(row.receivedMessages ?? row.received_messages ?? row.received)),
          latestTime: parseIntSafe(session.lastTimestamp || session.sortTimestamp),
          isGroup: sessionId.endsWith('@chatroom')
        }
      })
        .filter((item) => item.messageCount > 0)
        .sort((a, b) => b.messageCount - a.messageCount || b.latestTime - a.latestTime)

      const top = items.slice(0, topN)
      if (detailLevel === 'full') {
        return {
          success: true,
          beginTimestamp,
          endTimestamp,
          totalScanned: scannedSessions.length,
          activeCount: items.length,
          items: top
        }
      }
      if (detailLevel === 'standard') {
        return {
          success: true,
          beginTimestamp,
          endTimestamp,
          totalScanned: scannedSessions.length,
          activeCount: items.length,
          items: top.map((item) => ({
            sessionId: item.sessionId,
            sessionName: item.sessionName,
            messageCount: item.messageCount,
            sentCount: item.sentCount,
            receivedCount: item.receivedCount,
            isGroup: item.isGroup
          }))
        }
      }
      return {
        success: true,
        beginTimestamp,
        endTimestamp,
        totalScanned: scannedSessions.length,
        activeCount: items.length,
        items: top.map((item) => ({
          sessionId: item.sessionId,
          sessionName: item.sessionName,
          messageCount: item.messageCount
        }))
      }
    }

    if (legacyName === 'ai_query_session_glimpse') {
      const sessionId = normalizeText(args.sessionId)
      if (!sessionId) return { success: false, error: 'sessionId 不能为空' }
      const limit = Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 12)))
      const offset = Math.max(0, parseIntSafe(args.offset, 0))
      const beginTimestamp = normalizeTimestampSeconds(args.beginTimestamp)
      const endTimestamp = normalizeTimestampSeconds(args.endTimestamp)
      const ascending = args.ascending !== false

      const result = await chatService.getMessages(
        sessionId,
        offset,
        limit,
        beginTimestamp,
        endTimestamp,
        ascending
      )
      if (!result.success) {
        return { success: false, error: result.error || '会话抽样读取失败' }
      }
      const messages = Array.isArray(result.messages) ? result.messages : []
      const rows = messages.map((message: any) => ({
        sessionId,
        localId: parseIntSafe(message.localId),
        createTime: parseIntSafe(message.createTime),
        sender: normalizeText(message.senderUsername || (message.isSend === 1 ? '我' : '对方')),
        localType: parseIntSafe(message.localType),
        content: normalizeText(message.parsedContent || message.rawContent)
      }))
      const compactRows = detailLevel === 'full'
        ? rows
        : rows.map((row) => ({
            sessionId: row.sessionId,
            localId: row.localId,
            createTime: row.createTime,
            sender: row.sender,
            localType: row.localType,
            snippet: row.content.slice(0, detailLevel === 'standard' ? 260 : 140)
          }))
      return {
        success: true,
        sessionId,
        count: rows.length,
        hasMore: result.hasMore === true,
        nextOffset: parseIntSafe(result.nextOffset),
        rows: compactRows
      }
    }

    if (legacyName === 'ai_query_session_candidates') {
      const result = await wcdbService.aiQuerySessionCandidates({
        keyword: normalizeText(args.keyword),
        limit: parseIntSafe(args.limit, 12),
        beginTimestamp: parseIntSafe(args.beginTimestamp),
        endTimestamp: parseIntSafe(args.endTimestamp)
      })
      if (!result.success) return result
      const rows = Array.isArray(result.rows) ? result.rows : []
      const compactRows = detailLevel === 'full'
        ? rows
        : rows.slice(0, 24).map((row: any) => ({
            sessionId: normalizeText(row.session_id || row._session_id || row.sessionId),
            sessionName: normalizeText(row.session_name || row.display_name || row.sessionName),
            hitCount: parseIntSafe(row.hit_count || row.count),
            latestTime: parseIntSafe(row.latest_time || row.latestTime)
          }))
      return {
        success: true,
        rows: compactRows,
        count: rows.length
      }
    }

    if (legacyName === 'ai_query_timeline') {
      const result = await wcdbService.aiQueryTimeline({
        sessionId: normalizeText(args.sessionId),
        keyword: normalizeText(args.keyword),
        limit: Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 120))),
        offset: parseIntSafe(args.offset),
        beginTimestamp: parseIntSafe(args.beginTimestamp),
        endTimestamp: parseIntSafe(args.endTimestamp)
      })
      if (!result.success) return result
      const rows = Array.isArray(result.rows) ? result.rows : []
      return {
        success: true,
        rows: this.compactRows(rows, detailLevel),
        count: rows.length
      }
    }

    if (legacyName === 'ai_query_topic_stats') {
      const sessionIds = Array.isArray(args.sessionIds)
        ? args.sessionIds.map((value: any) => normalizeText(value)).filter(Boolean)
        : []
      const result = await wcdbService.aiQueryTopicStats({
        sessionIds,
        beginTimestamp: parseIntSafe(args.beginTimestamp),
        endTimestamp: parseIntSafe(args.endTimestamp)
      })
      if (!result.success) return result
      return {
        success: true,
        data: this.compactStats(result.data || {}, detailLevel)
      }
    }

    if (legacyName === 'ai_query_source_refs') {
      const sessionIds = Array.isArray(args.sessionIds)
        ? args.sessionIds.map((value: any) => normalizeText(value)).filter(Boolean)
        : []
      const result = await wcdbService.aiQuerySourceRefs({
        sessionIds,
        beginTimestamp: parseIntSafe(args.beginTimestamp),
        endTimestamp: parseIntSafe(args.endTimestamp)
      })
      if (!result.success) return result
      if (detailLevel === 'full') return result
      return {
        success: true,
        data: {
          range: result.data?.range || { begin: 0, end: 0 },
          session_count: parseIntSafe(result.data?.session_count),
          message_count: parseIntSafe(result.data?.message_count),
          db_refs: Array.isArray(result.data?.db_refs)
            ? result.data.db_refs.slice(0, detailLevel === 'standard' ? 32 : 16)
            : []
        }
      }
    }

    if (legacyName === 'ai_query_top_contacts') {
      const limit = Math.max(1, Math.min(30, parseIntSafe(args.limit, 8)))
      const scanLimit = Math.max(limit, Math.min(800, parseIntSafe(args.scanLimit, 320)))
      let beginTimestamp = normalizeTimestampSeconds(args.beginTimestamp)
      let endTimestamp = normalizeTimestampSeconds(args.endTimestamp)
      const includeGroups = args.includeGroups === true
      const includeOfficial = args.includeOfficial === true

      const sessionsRes = await chatService.getSessions()
      if (!sessionsRes.success || !Array.isArray(sessionsRes.sessions)) {
        return { success: false, error: sessionsRes.error || '会话列表获取失败' }
      }

      const candidates = sessionsRes.sessions
        .filter((session: any) => {
          const username = normalizeText(session.username)
          if (!username) return false
          const isGroup = username.endsWith('@chatroom')
          const isOfficial = username.startsWith('gh_')
          if (!includeGroups && isGroup) return false
          if (!includeOfficial && isOfficial) return false
          return true
        })
        .sort((a: any, b: any) => parseIntSafe(b.sortTimestamp || b.lastTimestamp) - parseIntSafe(a.sortTimestamp || a.lastTimestamp))
        .slice(0, scanLimit)

      if (candidates.length === 0) {
        return { success: true, items: [], total: 0 }
      }

      const sessionIds = candidates.map((item: any) => normalizeText(item.username)).filter(Boolean)
      const countMap: Record<string, number> = {}
      const hasRange = beginTimestamp > 0 || endTimestamp > 0
      if (hasRange) {
        const statsRes = await wcdbService.getSessionMessageTypeStatsBatch(sessionIds, {
          beginTimestamp,
          endTimestamp,
          quickMode: true,
          includeGroupSenderCount: false
        })
        if (statsRes.success && statsRes.data) {
          for (const sessionId of sessionIds) {
            const row: any = (statsRes.data as any)?.[sessionId] || {}
            countMap[sessionId] = Math.max(0, parseIntSafe(row.totalMessages ?? row.total_messages ?? row.total))
          }
        } else {
          const countRes = await chatService.getSessionMessageCounts(sessionIds, { preferHintCache: true })
          if (!countRes.success || !countRes.counts) {
            return { success: false, error: countRes.error || '消息计数失败' }
          }
          Object.assign(countMap, countRes.counts)
        }
      } else {
        const countRes = await chatService.getSessionMessageCounts(sessionIds, { preferHintCache: true })
        if (!countRes.success || !countRes.counts) {
          return { success: false, error: countRes.error || '消息计数失败' }
        }
        Object.assign(countMap, countRes.counts)
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const rows = candidates.map((session: any) => {
        const sessionId = normalizeText(session.username)
        const messageCount = Math.max(0, parseIntSafe(countMap[sessionId]))
        const lastTime = parseIntSafe(session.lastTimestamp || session.sortTimestamp)
        const daysSinceLast = lastTime > 0 ? Math.max(0, Math.floor((nowSec - lastTime) / 86400)) : 9999
        const recencyBoost = Math.max(0, 30 - Math.min(30, daysSinceLast))
        const score = messageCount * 100 + recencyBoost
        return {
          sessionId,
          displayName: normalizeText(session.displayName || sessionId),
          messageCount,
          lastTime,
          isGroup: sessionId.endsWith('@chatroom'),
          score
        }
      })

      rows.sort((a, b) => b.score - a.score || b.messageCount - a.messageCount || b.lastTime - a.lastTime)
      const top = rows.slice(0, limit)

      if (detailLevel === 'full') {
        return {
          success: true,
          total: rows.length,
          beginTimestamp,
          endTimestamp,
          items: top
        }
      }
      if (detailLevel === 'standard') {
        return {
          success: true,
          total: rows.length,
          beginTimestamp,
          endTimestamp,
          items: top.map((item) => ({
            sessionId: item.sessionId,
            displayName: item.displayName,
            messageCount: item.messageCount,
            lastTime: item.lastTime,
            isGroup: item.isGroup,
            score: item.score
          }))
        }
      }
      return {
        success: true,
        total: rows.length,
        items: top.map((item) => ({
          sessionId: item.sessionId,
          displayName: item.displayName,
          messageCount: item.messageCount
        }))
      }
    }

    if (legacyName === 'ai_fetch_message_briefs') {
      const items = Array.isArray(args.items)
        ? args.items
          .map((item: any) => ({
            sessionId: normalizeText(item?.sessionId),
            localId: parseIntSafe(item?.localId)
          }))
          .filter((item) => item.sessionId && item.localId > 0)
        : []
      const requests = items.slice(0, 20)
      if (requests.length === 0) {
        return { success: false, error: '请提供 items: [{sessionId, localId}]' }
      }

      const rows: any[] = []
      for (const item of requests) {
        const result = await chatService.getMessageById(item.sessionId, item.localId)
        if (!result.success || !result.message) {
          rows.push({
            sessionId: item.sessionId,
            localId: item.localId,
            success: false,
            error: normalizeText(result.error, '消息不存在')
          })
          continue
        }
        const message = result.message
        const base = {
          sessionId: item.sessionId,
          localId: item.localId,
          createTime: parseIntSafe(message.createTime),
          sender: normalizeText(message.senderUsername),
          localType: parseIntSafe(message.localType),
          parsedContent: normalizeText(message.parsedContent)
        }
        if (detailLevel === 'full') {
          rows.push({
            ...base,
            rawContent: normalizeText(message.rawContent),
            serverId: message.serverIdRaw || message.serverId || '',
            isSend: parseIntSafe(message.isSend),
            appMsgKind: normalizeText(message.appMsgKind),
            fileName: normalizeText(message.fileName)
          })
        } else if (detailLevel === 'standard') {
          rows.push({
            ...base,
            rawContent: normalizeText(message.rawContent).slice(0, 320)
          })
        } else {
          rows.push({
            sessionId: base.sessionId,
            localId: base.localId,
            createTime: base.createTime,
            sender: base.sender,
            snippet: base.parsedContent.slice(0, 200)
          })
        }
      }

      return {
        success: true,
        count: rows.length,
        rows
      }
    }

    if (legacyName === 'ai_list_voice_messages') {
      const sessionId = normalizeText(args.sessionId)
      const list = await chatService.getResourceMessages({
        sessionId: sessionId || undefined,
        types: ['voice'],
        beginTimestamp: parseIntSafe(args.beginTimestamp),
        endTimestamp: parseIntSafe(args.endTimestamp),
        limit: Math.max(1, Math.min(maxMessagesPerRequest, parseIntSafe(args.limit, 80))),
        offset: parseIntSafe(args.offset)
      })
      if (!list.success) {
        return { success: false, error: list.error || '语音清单检索失败' }
      }
      const items = (list.items || []).map((item: any) => ({
        id: `${normalizeText(item.sessionId)}:${parseIntSafe(item.localId)}:${parseIntSafe(item.createTime)}`,
        sessionId: normalizeText(item.sessionId),
        sessionName: normalizeText(item.sessionDisplayName || item.sessionId),
        localId: parseIntSafe(item.localId),
        createTime: parseIntSafe(item.createTime),
        sender: normalizeText(item.senderUsername),
        durationSec: parseIntSafe(item.voiceDurationSeconds),
        hint: normalizeText(item.parsedContent || item.rawContent).slice(0, 80)
      }))
      if (detailLevel === 'minimal') {
        return {
          success: true,
          total: parseIntSafe(list.total, items.length),
          hasMore: list.hasMore === true,
          ids: items.slice(0, 50).map((item) => item.id),
          note: '先选择要转写的语音ID，再调用 ai_transcribe_voice_messages'
        }
      }
      return {
        success: true,
        total: parseIntSafe(list.total, items.length),
        hasMore: list.hasMore === true,
        items: detailLevel === 'full' ? items : items.slice(0, 40)
      }
    }

    if (legacyName === 'ai_transcribe_voice_messages') {
      const requestsFromIds = this.parseVoiceIds(Array.isArray(args.ids) ? args.ids : [])
      const requestsFromItems = Array.isArray(args.items)
        ? args.items.map((item: any) => ({
            sessionId: normalizeText(item?.sessionId),
            localId: parseIntSafe(item?.localId),
            createTime: parseIntSafe(item?.createTime) || undefined
          })).filter((item) => item.sessionId && item.localId > 0)
        : []

      const merged = [...requestsFromIds, ...requestsFromItems]
      const dedupMap = new Map<string, { sessionId: string; localId: number; createTime?: number }>()
      for (const item of merged) {
        const key = `${item.sessionId}:${item.localId}:${item.createTime || 0}`
        if (!dedupMap.has(key)) dedupMap.set(key, item)
      }
      const requests = Array.from(dedupMap.values()).slice(0, VOICE_TRANSCRIBE_BATCH_LIMIT)
      if (requests.length === 0) {
        return {
          success: false,
          error: '请先调用 ai_list_voice_messages 获取 IDs，再指定要转写的语音ID（sessionId:localId[:createTime]）'
        }
      }

      const results: Array<{
        id: string
        sessionId: string
        localId: number
        createTime?: number
        success: boolean
        transcript?: string
        error?: string
      }> = []

      for (const req of requests) {
        const transcript = await chatService.getVoiceTranscript(
          req.sessionId,
          String(req.localId),
          req.createTime
        )
        const id = `${req.sessionId}:${req.localId}:${req.createTime || 0}`
        if (transcript.success) {
          results.push({
            id,
            sessionId: req.sessionId,
            localId: req.localId,
            createTime: req.createTime,
            success: true,
            transcript: normalizeText(transcript.transcript)
          })
        } else {
          results.push({
            id,
            sessionId: req.sessionId,
            localId: req.localId,
            createTime: req.createTime,
            success: false,
            error: normalizeText(transcript.error, '转写失败')
          })
        }
      }

      return {
        success: true,
        requested: requests.length,
        successCount: results.filter((item) => item.success).length,
        results: detailLevel === 'full'
          ? results
          : results.map((item) => ({
              id: item.id,
              success: item.success,
              transcript: item.transcript
                ? item.transcript.slice(0, detailLevel === 'standard' ? 380 : 220)
                : undefined,
              error: item.error
            }))
      }
    }

    if (legacyName === 'activate_skill') {
      const skillId = normalizeText((args as any)?.skill_id)
      if (!skillId) return { success: false, error: '缺少 skill_id' }
      const skill = await aiSkillService.getConfig(skillId)
      if (!skill) return { success: false, error: `技能不存在: ${skillId}` }
      return {
        success: true,
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
        tools: skill.tools
      }
    }

    return { success: false, error: `未知工具: ${canonicalName || name}` }
  }

  private async recordToolRun(
    aiDbPath: string,
    runId: string,
    conversationId: string,
    messageId: string,
    trace: AiToolCallTrace,
    result: unknown
  ): Promise<void> {
    const sql = `INSERT INTO ai_tool_runs (
      run_id, conversation_id, message_id, tool_name, tool_args_json, tool_result_json, status, duration_ms, error, created_at
    ) VALUES (
      '${escSql(runId)}',
      '${escSql(conversationId)}',
      '${escSql(messageId)}',
      '${escSql(trace.toolName)}',
      '${escSql(JSON.stringify(trace.args || {}))}',
      '${escSql(JSON.stringify(result ?? {}))}',
      '${escSql(trace.status)}',
      ${parseIntSafe(trace.durationMs)},
      '${escSql(trace.error || '')}',
      ${Date.now()}
    )`
    await this.queryRows(aiDbPath, sql)
  }

  private async appendToolStepMessage(
    aiDbPath: string,
    conversationId: string,
    intent: AiIntentType,
    trace: AiToolCallTrace,
    toolResult: any
  ): Promise<void> {
    const payload = {
      type: 'tool_step',
      toolName: trace.toolName,
      status: trace.status,
      durationMs: trace.durationMs,
      args: trace.args || {},
      result: this.compactToolResultForStep(toolResult)
    }
    let raw = JSON.stringify(payload)
    if (raw.length > 2800) {
      raw = JSON.stringify({
        ...payload,
        result: {
          ...(payload.result || {}),
          truncated: true
        }
      })
    }
    const content = `__wf_tool_step__${raw}`

    await this.queryRows(
      aiDbPath,
      `INSERT INTO ai_messages (
        message_id,conversation_id,role,content,intent_type,components_json,tool_trace_json,usage_json,error,parent_message_id,created_at
      ) VALUES (
        '${escSql(randomUUID())}',
        '${escSql(conversationId)}',
        'tool',
        '${escSql(content)}',
        '${escSql(intent)}',
        '[]',
        '${escSql(JSON.stringify([trace]))}',
        '{}',
        '',
        '',
        ${Date.now()}
      )`
    )
  }

  private emitRunEvent(
    callback: ((event: AiAnalysisRunEvent) => void) | undefined,
    payload: AiAnalysisRunEvent
  ): void {
    if (!callback) return
    try {
      callback(payload)
    } catch {
      // ignore emitter errors
    }
  }

  private compactToolResultForStep(result: any): Record<string, unknown> {
    if (!result || typeof result !== 'object') return {}
    const data: Record<string, unknown> = {}
    if ('success' in result) data.success = Boolean(result.success)
    if ('count' in result) data.count = parseIntSafe((result as any).count)
    if ('total' in result) data.total = parseIntSafe((result as any).total)
    if ('activeCount' in result) data.activeCount = parseIntSafe((result as any).activeCount)
    if ('requested' in result) data.requested = parseIntSafe((result as any).requested)
    if ('successCount' in result) data.successCount = parseIntSafe((result as any).successCount)
    if ('hasMore' in result) data.hasMore = Boolean((result as any).hasMore)
    if ((result as any).error) data.error = normalizeText((result as any).error)
    if (Array.isArray((result as any).ids)) data.ids = (result as any).ids.slice(0, 8)
    if (Array.isArray((result as any).items)) data.itemsPreview = (result as any).items.slice(0, 2)
    if (Array.isArray((result as any).rows)) data.rowsPreview = (result as any).rows.slice(0, 2)
    if ((result as any).nextOffset) data.nextOffset = parseIntSafe((result as any).nextOffset)
    return data
  }

  private buildComponents(
    intent: AiIntentType,
    userText: string,
    tools: ToolBundle
  ): AiResultComponent[] {
    const sessionNameMap = new Map<string, string>()
    for (const row of Array.isArray(tools.sessionCandidates) ? tools.sessionCandidates : []) {
      const sessionId = normalizeText(row.sessionId || row.session_id || row._session_id)
      const sessionName = normalizeText(row.sessionName || row.session_name || row.display_name)
      if (sessionId && sessionName && !sessionNameMap.has(sessionId)) {
        sessionNameMap.set(sessionId, sessionName)
      }
    }

    const timelineItemsRaw = Array.isArray(tools.timelineRows) ? tools.timelineRows : []
    const timelineItems = timelineItemsRaw.slice(0, 120).map((row: any) => ({
      ts: parseIntSafe(row.create_time),
      sessionId: normalizeText(row._session_id),
      sessionName: normalizeText(row.session_name || sessionNameMap.get(normalizeText(row._session_id)) || row._session_id),
      sender: normalizeText(row.sender_username || '未知'),
      snippet: normalizeText(row.content).slice(0, 200),
      localId: parseIntSafe(row.local_id),
      createTime: parseIntSafe(row.create_time)
    }))

    const sessionIdsFromTimeline = Array.from(new Set(timelineItems.map((item) => item.sessionId).filter(Boolean)))
    const sourceData = tools.sourceRefs && typeof tools.sourceRefs === 'object' ? tools.sourceRefs : {}

    const summaryBullets = [
      `识别任务类型：${intent}`,
      `命中会话数：${sessionIdsFromTimeline.length || parseIntSafe(sourceData.session_count)}`,
      `时间轴事件数：${timelineItems.length}`
    ]
    if (timelineItems.length > 0) {
      const first = timelineItems[0]
      summaryBullets.push(`最近事件：${first.sessionName || first.sessionId} / ${first.snippet.slice(0, 30)}`)
    }
    if (tools.activeSessions.length > 0) {
      summaryBullets.push(`时间窗活跃会话：${tools.activeSessions.length} 个`)
    }
    if (tools.sessionGlimpses.length > 0) {
      summaryBullets.push(`抽样阅读消息：${tools.sessionGlimpses.length} 条`)
    }
    if (tools.topContacts.length > 0) {
      const top = tools.topContacts[0]
      summaryBullets.push(`高频联系人Top1：${normalizeText(top.displayName || top.sessionId)}（${parseIntSafe(top.messageCount)}条）`)
    }
    if (tools.messageBriefs.length > 0) {
      summaryBullets.push(`关键证据消息：${tools.messageBriefs.length} 条`)
    }
    if (tools.voiceCatalog.length > 0) {
      summaryBullets.push(`语音候选ID：${tools.voiceCatalog.length} 条`)
    }
    if (tools.voiceTranscripts.length > 0) {
      summaryBullets.push(`语音转写成功：${tools.voiceTranscripts.filter((item: any) => item.success).length}/${tools.voiceTranscripts.length}`)
    }
    if (normalizeText(userText).includes('去年')) {
      summaryBullets.push('已按“去年”语义优先检索相关时间范围')
    }

    const summary: SummaryComponent = {
      type: 'summary',
      title: 'AI 分析总结',
      bullets: summaryBullets,
      conclusion: timelineItems.length > 0
        ? '已完成检索与归纳，可继续追问“按月份展开”或“只看某个联系人”。'
        : '当前条件未检索到足够事件，建议补充关键词或时间范围。'
    }

    const timeline: TimelineComponent = {
      type: 'timeline',
      items: timelineItems
    }

    const source: SourceComponent = {
      type: 'source',
      range: {
        begin: parseIntSafe(sourceData?.range?.begin),
        end: parseIntSafe(sourceData?.range?.end)
      },
      sessionCount: parseIntSafe(sourceData?.session_count, sessionIdsFromTimeline.length),
      messageCount: parseIntSafe(sourceData?.message_count),
      dbRefs: Array.isArray(sourceData?.db_refs) ? sourceData.db_refs.map((item: any) => normalizeText(item)).filter(Boolean).slice(0, 24) : []
    }

    return [timeline, summary, source]
  }

  private isRunAborted(runId: string): boolean {
    const state = this.activeRuns.get(runId)
    return Boolean(state?.aborted)
  }

  private async upsertConversationTitle(aiDbPath: string, conversationId: string, fallbackInput: string): Promise<void> {
    const rows = await this.queryRows(aiDbPath, `SELECT title FROM ai_conversations WHERE conversation_id='${escSql(conversationId)}' LIMIT 1`)
    const currentTitle = normalizeText(rows?.[0]?.title)
    if (currentTitle) return
    const title = normalizeText(fallbackInput).slice(0, 40) || '新的 AI 对话'
    await this.queryRows(
      aiDbPath,
      `UPDATE ai_conversations SET title='${escSql(title)}', updated_at=${Date.now()} WHERE conversation_id='${escSql(conversationId)}'`
    )
  }

  private async maybeCompressContext(aiDbPath: string, conversationId: string): Promise<void> {
    const countRows = await this.queryRows(aiDbPath, `SELECT COUNT(1) AS cnt FROM ai_messages WHERE conversation_id='${escSql(conversationId)}'`)
    const count = parseIntSafe(countRows?.[0]?.cnt)
    if (count <= CONTEXT_COMPRESS_TRIGGER_COUNT) return

    const oldRows = await this.queryRows(
      aiDbPath,
      `SELECT id,role,content,created_at FROM ai_messages
       WHERE conversation_id='${escSql(conversationId)}'
       ORDER BY created_at ASC
       LIMIT ${Math.max(1, count - CONTEXT_KEEP_AFTER_COMPRESS)}`
    )
    if (!oldRows.length) return

    const summaryLines: string[] = []
    for (const row of oldRows.slice(-120)) {
      const role = normalizeText(row.role)
      if (role !== 'user' && role !== 'assistant') continue
      const createdAt = parseIntSafe(row.created_at)
      const content = normalizeText(row.content).replace(/\s+/g, ' ').slice(0, 100)
      if (!content) continue
      summaryLines.push(`- [${createdAt}] ${role}: ${content}`)
    }

    const prevSummaryRows = await this.queryRows(
      aiDbPath,
      `SELECT summary_text FROM ai_conversations WHERE conversation_id='${escSql(conversationId)}' LIMIT 1`
    )
    const prevSummary = normalizeText(prevSummaryRows?.[0]?.summary_text)
    const nextSummary = [
      prevSummary ? `历史摘要(旧):\n${prevSummary.slice(-2000)}` : '',
      '历史压缩补充:',
      ...summaryLines.slice(-80)
    ].filter(Boolean).join('\n')

    await this.queryRows(
      aiDbPath,
      `UPDATE ai_conversations
       SET summary_text='${escSql(nextSummary.slice(-CONTEXT_SUMMARY_MAX_CHARS))}', updated_at=${Date.now()}
       WHERE conversation_id='${escSql(conversationId)}'`
    )

    const removeIds = oldRows.map((row) => parseIntSafe(row.id)).filter((id) => id > 0)
    if (removeIds.length > 0) {
      await this.queryRows(
        aiDbPath,
        `DELETE FROM ai_messages WHERE id IN (${removeIds.join(',')})`
      )
    }
  }

  private async buildModelMessages(
    aiDbPath: string,
    conversationId: string,
    userInput: string,
    options?: {
      assistantSystemPrompt?: string
      manualSkillPrompt?: string
      autoSkillMenu?: string
    }
  ): Promise<any[]> {
    await this.maybeCompressContext(aiDbPath, conversationId)
    const historyLimit = Math.max(
      4,
      Math.min(60, parseIntSafe(this.config.get('aiAgentMaxHistoryRounds'), CONTEXT_RECENT_LIMIT))
    )

    const summaryRows = await this.queryRows(
      aiDbPath,
      `SELECT summary_text FROM ai_conversations WHERE conversation_id='${escSql(conversationId)}' LIMIT 1`
    )
    const summaryText = normalizeText(summaryRows?.[0]?.summary_text)

    const rows = await this.queryRows(
      aiDbPath,
      `SELECT role,content FROM ai_messages
       WHERE conversation_id='${escSql(conversationId)}'
       ORDER BY created_at DESC
       LIMIT ${historyLimit * 2}`
    )

    const recentTurns = rows
      .reverse()
      .filter((row) => {
        const role = normalizeText(row.role)
        return role === 'user' || role === 'assistant'
      })
      .slice(-historyLimit)
      .map((row) => ({ role: normalizeText(row.role), content: normalizeText(row.content) }))

    const baseSkill = await this.loadSkill('base')

    const messages: any[] = [
      { role: 'system', content: baseSkill }
    ]
    messages.push({
      role: 'system',
      content: `完成任务时请输出 ${FINAL_DONE_MARKER}，并用 <final_answer>...</final_answer> 包裹最终回答。`
    })

    if (options?.assistantSystemPrompt) {
      messages.push({
        role: 'system',
        content: `assistant_system_prompt:\n${options.assistantSystemPrompt}`
      })
    }

    if (summaryText) {
      const compressionSkill = await this.loadSkill('context_compression')
      messages.push({ role: 'system', content: `skill(context_compression):\n${compressionSkill}` })
      messages.push({ role: 'system', content: `conversation_summary:\n${summaryText}` })
    }

    if (options?.manualSkillPrompt) {
      messages.push({
        role: 'system',
        content: `active_skill_manual:\n${options.manualSkillPrompt}`
      })
    } else if (options?.autoSkillMenu) {
      messages.push({
        role: 'system',
        content: `auto_skill_menu:\n${options.autoSkillMenu}`
      })
    }

    const preprocessConfig = {
      clean: this.config.get('aiAgentPreprocessClean') !== false,
      merge: this.config.get('aiAgentPreprocessMerge') !== false,
      denoise: this.config.get('aiAgentPreprocessDenoise') !== false,
      desensitize: this.config.get('aiAgentPreprocessDesensitize') === true,
      anonymize: this.config.get('aiAgentPreprocessAnonymize') === true
    }
    const searchContextBefore = Math.max(0, Math.min(20, parseIntSafe(this.config.get('aiAgentSearchContextBefore'), 3)))
    const searchContextAfter = Math.max(0, Math.min(20, parseIntSafe(this.config.get('aiAgentSearchContextAfter'), 3)))
    messages.push({
      role: 'system',
      content: `tool_search_context: before=${searchContextBefore}, after=${searchContextAfter}; preprocess=${JSON.stringify(preprocessConfig)}`
    })

    let recentTotalChars = 0
    const boundedRecentTurns = recentTurns
      .slice()
      .reverse()
      .filter((turn) => {
        const content = normalizeText(turn.content)
        if (!content) return false
        const cost = content.length
        if (recentTotalChars + cost > CONTEXT_RECENT_MAX_CHARS) return false
        recentTotalChars += cost
        return true
      })
      .reverse()

    messages.push(...boundedRecentTurns)
    messages.push({ role: 'user', content: userInput })
    return messages
  }

  async listConversations(page = 1, pageSize = 20): Promise<{ success: boolean; conversations?: any[]; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const p = Math.max(1, page)
      const size = Math.max(1, Math.min(100, pageSize))
      const offset = (p - 1) * size
      const rows = await this.queryRows(
        dbPath,
        `SELECT conversation_id,title,created_at,updated_at,last_message_at FROM ai_conversations
         ORDER BY updated_at DESC LIMIT ${size} OFFSET ${offset}`
      )
      return {
        success: true,
        conversations: rows.map((row) => ({
          conversationId: normalizeText(row.conversation_id),
          title: normalizeText(row.title, '新的 AI 对话'),
          createdAt: parseIntSafe(row.created_at),
          updatedAt: parseIntSafe(row.updated_at),
          lastMessageAt: parseIntSafe(row.last_message_at)
        }))
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async createConversation(title = ''): Promise<{ success: boolean; conversationId?: string; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const conversationId = randomUUID()
      const now = Date.now()
      const safeTitle = normalizeText(title, '新的 AI 对话').slice(0, 80)
      await this.queryRows(
        dbPath,
        `INSERT INTO ai_conversations (conversation_id,title,summary_text,created_at,updated_at,last_message_at)
         VALUES ('${escSql(conversationId)}','${escSql(safeTitle)}','',${now},${now},${now})`
      )
      return { success: true, conversationId }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async deleteConversation(conversationId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const safeId = escSql(conversationId)
      await this.queryRows(dbPath, `DELETE FROM ai_messages WHERE conversation_id='${safeId}'`)
      await this.queryRows(dbPath, `DELETE FROM ai_tool_runs WHERE conversation_id='${safeId}'`)
      await this.queryRows(dbPath, `DELETE FROM ai_conversations WHERE conversation_id='${safeId}'`)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async renameConversation(conversationId: string, title: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const safeId = escSql(conversationId)
      const safeTitle = normalizeText(title, '新的 AI 对话').slice(0, 80)
      await this.queryRows(
        dbPath,
        `UPDATE ai_conversations SET title='${escSql(safeTitle)}', updated_at=${Date.now()} WHERE conversation_id='${safeId}'`
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async exportConversation(conversationId: string): Promise<{
    success: boolean
    conversation?: { conversationId: string; title: string; updatedAt: number }
    markdown?: string
    error?: string
  }> {
    try {
      const { dbPath } = await this.ensureReady()
      const safeId = escSql(conversationId)
      const convoRows = await this.queryRows(
        dbPath,
        `SELECT conversation_id,title,updated_at FROM ai_conversations WHERE conversation_id='${safeId}' LIMIT 1`
      )
      if (!convoRows.length) return { success: false, error: '会话不存在' }
      const messageRows = await this.queryRows(
        dbPath,
        `SELECT role,content,created_at FROM ai_messages WHERE conversation_id='${safeId}' ORDER BY created_at ASC LIMIT 2000`
      )
      const headerTitle = normalizeText(convoRows[0]?.title, 'AI 对话')
      const lines = [
        `# ${headerTitle}`,
        '',
        `导出时间: ${new Date().toISOString()}`,
        ''
      ]
      for (const row of messageRows) {
        const role = normalizeText(row.role, 'assistant')
        if (role === 'tool') continue
        const content = normalizeText(row.content)
        if (!content) continue
        const roleText = role === 'user' ? '用户' : role === 'assistant' ? '助手' : role
        lines.push(`## ${roleText} (${new Date(parseIntSafe(row.created_at)).toLocaleString('zh-CN')})`)
        lines.push('')
        lines.push(content)
        lines.push('')
      }
      return {
        success: true,
        conversation: {
          conversationId: normalizeText(convoRows[0]?.conversation_id),
          title: headerTitle,
          updatedAt: parseIntSafe(convoRows[0]?.updated_at)
        },
        markdown: lines.join('\n')
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async listMessages(conversationId: string, limit = 200): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const rows = await this.queryRows(
        dbPath,
        `SELECT message_id,conversation_id,role,content,intent_type,components_json,tool_trace_json,usage_json,error,parent_message_id,created_at
         FROM ai_messages WHERE conversation_id='${escSql(conversationId)}'
         ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(1000, limit))}`
      )
      return {
        success: true,
        messages: rows.map((row) => ({
          ...(function () {
            const role = normalizeText(row.role)
            const rawContent = normalizeText(row.content)
            if (role !== 'tool') {
              return { role, content: rawContent }
            }
            const parsed = parseStoredToolStep(rawContent)
            if (!parsed) {
              return { role, content: rawContent }
            }
            const compact = Object.entries(parsed.result || {})
              .slice(0, 4)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join('，')
            const suffix = compact ? `，${compact}` : ''
            return {
              role,
              content: `工具 ${parsed.toolName || 'unknown'} (${parsed.status || 'unknown'}, ${parsed.durationMs}ms)${suffix}`
            }
          })(),
          messageId: normalizeText(row.message_id),
          conversationId: normalizeText(row.conversation_id),
          intentType: normalizeText(row.intent_type),
          components: (() => { try { return JSON.parse(normalizeText(row.components_json, '[]')) } catch { return [] } })(),
          toolTrace: (() => { try { return JSON.parse(normalizeText(row.tool_trace_json, '[]')) } catch { return [] } })(),
          usage: (() => { try { return JSON.parse(normalizeText(row.usage_json, '{}')) } catch { return {} } })(),
          error: normalizeText(row.error),
          parentMessageId: normalizeText(row.parent_message_id),
          createdAt: parseIntSafe(row.created_at)
        }))
      }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  async abortRun(payload: { runId?: string; conversationId?: string }): Promise<{ success: boolean }> {
    const runId = normalizeText(payload?.runId)
    const conversationId = normalizeText(payload?.conversationId)
    if (runId && this.activeRuns.has(runId)) {
      const state = this.activeRuns.get(runId)!
      state.aborted = true
      return { success: true }
    }
    if (conversationId) {
      for (const state of this.activeRuns.values()) {
        if (state.conversationId === conversationId) state.aborted = true
      }
    }
    return { success: true }
  }

  async retryMessage(payload: {
    conversationId: string
    userMessageId?: string
  }, runtime?: {
    onRunEvent?: (event: AiAnalysisRunEvent) => void
  }): Promise<{ success: boolean; result?: SendMessageResult; error?: string }> {
    try {
      const { dbPath } = await this.ensureReady()
      const conversationId = normalizeText(payload.conversationId)
      const userMessageId = normalizeText(payload.userMessageId)
      let rows: any[] = []
      if (userMessageId) {
        rows = await this.queryRows(
          dbPath,
          `SELECT message_id,content FROM ai_messages WHERE conversation_id='${escSql(conversationId)}' AND message_id='${escSql(userMessageId)}' AND role='user' LIMIT 1`
        )
      }
      if (!rows.length) {
        rows = await this.queryRows(
          dbPath,
          `SELECT message_id,content FROM ai_messages WHERE conversation_id='${escSql(conversationId)}' AND role='user' ORDER BY created_at DESC LIMIT 1`
        )
      }
      if (!rows.length) return { success: false, error: '未找到可重试的用户消息' }
      const row = rows[0]
      const result = await this.sendMessage(conversationId, normalizeText(row.content), {
        parentMessageId: normalizeText(row.message_id),
        persistUserMessage: false
      }, runtime)
      if (!result.success) return { success: false, error: result.error }
      return { success: true, result: result.result }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }

  private async ensureToolSkillInjected(
    toolName: string,
    injectedSkills: Set<SkillKey>,
    modelMessages: any[]
  ): Promise<void> {
    const legacyToolName = toLegacyToolName(toolName)
    const map: Record<string, SkillKey> = {
      ai_query_time_window_activity: 'tool_time_window_activity',
      ai_query_session_glimpse: 'tool_session_glimpse',
      ai_query_session_candidates: 'tool_session_candidates',
      ai_query_timeline: 'tool_timeline',
      ai_query_topic_stats: 'tool_topic_stats',
      ai_query_source_refs: 'tool_source_refs',
      ai_query_top_contacts: 'tool_top_contacts',
      ai_fetch_message_briefs: 'tool_message_briefs',
      ai_list_voice_messages: 'tool_voice_list',
      ai_transcribe_voice_messages: 'tool_voice_transcribe'
    }
    const skill = map[legacyToolName]
    if (!skill || injectedSkills.has(skill)) return
    injectedSkills.add(skill)
    const skillText = await this.loadSkill(skill)
    modelMessages.push({ role: 'system', content: `skill(${toolName}):\n${skillText}` })
  }

  async sendMessage(
    conversationId: string,
    userInput: string,
    options?: SendMessageOptions,
    runtime?: {
      onRunEvent?: (event: AiAnalysisRunEvent) => void
    }
  ): Promise<{ success: boolean; result?: SendMessageResult; error?: string }> {
    const now = Date.now()
    const runId = randomUUID()
    const aiRun: AiRunState = {
      runId,
      conversationId,
      aborted: false
    }
    this.activeRuns.set(runId, aiRun)

    try {
      const { apiBaseUrl, apiKey, model } = this.getSharedModelConfig()
      if (!apiBaseUrl || !apiKey) {
        return { success: false, error: '请先在设置 > AI通用 中填写 Base URL 和 API Key' }
      }

      const { dbPath } = await this.ensureReady()
      const convId = normalizeText(conversationId)
      if (!convId) {
        const created = await this.createConversation()
        if (!created.success || !created.conversationId) {
          return { success: false, error: created.error || '创建会话失败' }
        }
        conversationId = created.conversationId
      } else {
        const existingConv = await this.queryRows(dbPath, `SELECT conversation_id FROM ai_conversations WHERE conversation_id='${escSql(convId)}' LIMIT 1`)
        if (!existingConv.length) {
          const created = await this.createConversation()
          if (!created.success || !created.conversationId) {
            return { success: false, error: created.error || '创建会话失败' }
          }
          conversationId = created.conversationId
        } else {
          conversationId = convId
        }
      }
      aiRun.conversationId = conversationId

      await this.upsertConversationTitle(dbPath, conversationId, userInput)

      const chatType = this.resolveChatType(options)
      const preferredAssistantId = normalizeText(options?.assistantId, 'general_cn')
      const selectedAssistant =
        await aiAssistantService.getConfig(preferredAssistantId) ||
        await aiAssistantService.getConfig('general_cn')
      const assistantSystemPrompt = normalizeText(selectedAssistant?.systemPrompt)
      const allowedToolNames = this.resolveAllowedToolNames(selectedAssistant?.allowedBuiltinTools)
      const allowedToolSet = new Set<string>(allowedToolNames)

      let manualSkillPrompt = ''
      const manualSkillId = normalizeText(options?.activeSkillId)
      if (manualSkillId) {
        const manualSkill = await aiSkillService.getConfig(manualSkillId)
        if (manualSkill) {
          const scopeMatched = manualSkill.chatScope === 'all' || manualSkill.chatScope === chatType
          const missingTools = manualSkill.tools
            .map((toolName) => toCanonicalToolName(toolName))
            .filter((toolName) => !allowedToolSet.has(toolName))
          if (scopeMatched && missingTools.length === 0) {
            manualSkillPrompt = normalizeText(manualSkill.prompt)
          }
        }
      }
      const enableAutoSkill = this.config.get('aiAgentEnableAutoSkill') === true
      const autoSkillMenu = !manualSkillPrompt && enableAutoSkill
        ? await aiSkillService.getAutoSkillMenu(
            chatType,
            Array.from(new Set([...allowedToolNames, ...allowedToolNames.map((name) => toLegacyToolName(name))]))
          )
        : null

      const userMessageId = randomUUID()
      const persistUserMessage = options?.persistUserMessage !== false
      const intent = defaultIntentType()
      this.emitRunEvent(runtime?.onRunEvent, {
        runId,
        conversationId,
        stage: 'run_started',
        ts: Date.now(),
        message: `开始分析请求（助手：${selectedAssistant?.name || '通用分析助手'}）`
      })
      this.emitRunEvent(runtime?.onRunEvent, {
        runId,
        conversationId,
        stage: 'intent_identified',
        ts: Date.now(),
        message: '意图由 AI 在推理中自主判断（本地不预匹配）',
        intent
      })
      if (persistUserMessage) {
        await this.queryRows(
          dbPath,
          `INSERT INTO ai_messages (message_id,conversation_id,role,content,intent_type,created_at,parent_message_id)
           VALUES ('${escSql(userMessageId)}','${escSql(conversationId)}','user','${escSql(userInput)}','${escSql(intent)}',${now},'${escSql(options?.parentMessageId || '')}')`
        )
      }

      const modelMessages = await this.buildModelMessages(dbPath, conversationId, userInput, {
        assistantSystemPrompt,
        manualSkillPrompt,
        autoSkillMenu: autoSkillMenu || undefined
      })
      const injectedSkills = new Set<SkillKey>(['base'])

      const toolTrace: AiToolCallTrace[] = []
      const toolBundle: ToolBundle = {
        activeSessions: [],
        sessionGlimpses: [],
        sessionCandidates: [],
        timelineRows: [],
        topicStats: null,
        sourceRefs: null,
        topContacts: [],
        messageBriefs: [],
        voiceCatalog: [],
        voiceTranscripts: []
      }

      let finalText = ''
      let usage: SendMessageResult['usage'] = {}
      let lastAssistantText = ''
      let protocolViolationCount = 0

      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
        if (this.isRunAborted(runId)) {
          this.emitRunEvent(runtime?.onRunEvent, {
            runId,
            conversationId,
            stage: 'aborted',
            ts: Date.now(),
            message: '任务已取消'
          })
          return { success: false, error: '任务已取消' }
        }

        this.emitRunEvent(runtime?.onRunEvent, {
          runId,
          conversationId,
          stage: 'llm_round_started',
          ts: Date.now(),
          round: loop + 1,
          message: `第 ${loop + 1} 轮推理开始`
        })
        const llmRes = await this.requestLlmStep(modelMessages, model, apiBaseUrl, apiKey, allowedToolNames)
        usage = llmRes.usage
        this.emitRunEvent(runtime?.onRunEvent, {
          runId,
          conversationId,
          stage: 'llm_round_result',
          ts: Date.now(),
          round: loop + 1,
          message: llmRes.toolCalls.length > 0
            ? `第 ${loop + 1} 轮返回 ${llmRes.toolCalls.length} 个工具调用`
            : `第 ${loop + 1} 轮直接产出答案`,
          data: {
            toolCalls: llmRes.toolCalls.length
          }
        })

        if (!llmRes.toolCalls.length) {
          const cleanedAssistant = this.stripFinalMarker(llmRes.content)
          if (cleanedAssistant) {
            lastAssistantText = cleanedAssistant
          }
          const delivery = this.parseFinalDelivery(llmRes.content)
          if (delivery.done && delivery.answer) {
            finalText = delivery.answer
            break
          }

          protocolViolationCount += 1
          const violationMessage = delivery.done
            ? `模型输出了 ${FINAL_DONE_MARKER} 但未提供有效 final_answer，继续执行协议回合（${protocolViolationCount}）`
            : `模型未输出结束标记，继续执行协议回合（${protocolViolationCount}）`
          this.emitRunEvent(runtime?.onRunEvent, {
            runId,
            conversationId,
            stage: 'llm_round_result',
            ts: Date.now(),
            round: loop + 1,
            message: violationMessage,
            data: {
              protocolViolationCount,
              missingDoneMarker: !delivery.done,
              emptyFinalAnswer: delivery.done && !delivery.answer
            }
          })

          if (loop < MAX_TOOL_LOOPS - 1) {
            this.emitRunEvent(runtime?.onRunEvent, {
              runId,
              conversationId,
              stage: 'llm_round_result',
              ts: Date.now(),
              round: loop + 1,
              message: '追加协议提醒并继续下一轮推理',
              data: {
                protocolReminder: true,
                protocolViolationCount
              }
            })
            if (cleanedAssistant) {
              modelMessages.push({
                role: 'assistant',
                content: cleanedAssistant
              })
            }
            modelMessages.push({
              role: 'system',
              content: [
                `协议提醒：当任务完成时，必须输出 ${FINAL_DONE_MARKER} 并给出 <final_answer>...</final_answer>。`,
                '如果信息不足，不要结束，继续调用工具。'
              ].join('\n')
            })
            continue
          }
          break
        }

        protocolViolationCount = 0
        modelMessages.push({
          role: 'assistant',
          content: llmRes.content || '',
          tool_calls: llmRes.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.argumentsJson
            }
          }))
        })

        for (const call of llmRes.toolCalls) {
          if (this.isRunAborted(runId)) {
            this.emitRunEvent(runtime?.onRunEvent, {
              runId,
              conversationId,
              stage: 'aborted',
              ts: Date.now(),
              message: '任务已取消'
            })
            return { success: false, error: '任务已取消' }
          }

          const canonicalCallName = toCanonicalToolName(call.name)
          const legacyCallName = toLegacyToolName(canonicalCallName)
          const displayToolName = canonicalCallName || call.name

          await this.ensureToolSkillInjected(displayToolName, injectedSkills, modelMessages)

          const started = Date.now()
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.argumentsJson || '{}')
          } catch {
            args = {}
          }

          const trace: AiToolCallTrace = {
            toolName: displayToolName,
            args,
            status: 'ok',
            durationMs: 0
          }
          this.emitRunEvent(runtime?.onRunEvent, {
            runId,
            conversationId,
            stage: 'tool_start',
            ts: Date.now(),
            round: loop + 1,
            toolName: displayToolName,
            message: `开始调用工具 ${displayToolName}`,
            data: { args }
          })

          let toolResult: any = {}
          try {
            if (!canonicalCallName) {
              toolResult = { success: false, error: `未知工具: ${call.name}` }
            } else if (!allowedToolSet.has(canonicalCallName)) {
              toolResult = { success: false, error: `当前助手未授权工具: ${canonicalCallName}` }
            } else {
              toolResult = await this.runTool(canonicalCallName, args, { userInput })
            }
            if (!toolResult?.success) {
              trace.status = 'error'
              trace.error = normalizeText(toolResult?.error, '工具执行失败')
            } else {
              if (canonicalCallName === 'get_time_stats' || legacyCallName === 'ai_query_time_window_activity') {
                toolBundle.activeSessions = Array.isArray(toolResult.items) ? toolResult.items : []
              } else if (
                canonicalCallName === 'get_recent_messages' ||
                canonicalCallName === 'get_session_messages' ||
                legacyCallName === 'ai_query_session_glimpse'
              ) {
                const rows = Array.isArray(toolResult.rows)
                  ? toolResult.rows
                  : Array.isArray(toolResult.rawMessages)
                    ? toolResult.rawMessages
                    : Array.isArray(toolResult.messages)
                      ? toolResult.messages
                      : []
                if (rows.length > 0) {
                  const normalizedRows = rows.map((row: any) => ({
                    sessionId: normalizeText(row.sessionId || row._session_id || row.session_id),
                    localId: parseIntSafe(row.localId || row.local_id || row.id),
                    createTime: parseIntSafe(row.createTime || row.create_time || row.timestamp),
                    sender: normalizeText(row.sender || row.senderName || row.sender_username),
                    localType: parseIntSafe(row.localType || row.local_type || row.type),
                    content: normalizeText(row.content || row.snippet)
                  }))
                  const merged = [...toolBundle.sessionGlimpses, ...normalizedRows]
                  const dedup = new Map<string, any>()
                  for (const row of merged) {
                    const key = `${normalizeText(row.sessionId || row._session_id)}:${parseIntSafe(row.localId || row.local_id)}:${parseIntSafe(row.createTime || row.create_time)}`
                    if (!dedup.has(key)) dedup.set(key, row)
                  }
                  toolBundle.sessionGlimpses = Array.from(dedup.values()).slice(0, MAX_TOOL_RESULT_ROWS)
                }
              } else if (canonicalCallName === 'search_sessions' || legacyCallName === 'ai_query_session_candidates') {
                const rows = Array.isArray(toolResult.rows)
                  ? toolResult.rows
                  : Array.isArray(toolResult.sessions)
                    ? toolResult.sessions
                    : []
                toolBundle.sessionCandidates = rows
              } else if (
                canonicalCallName === 'search_messages' ||
                canonicalCallName === 'deep_search_messages' ||
                legacyCallName === 'ai_query_timeline'
              ) {
                const rows = Array.isArray(toolResult.rows)
                  ? toolResult.rows
                  : Array.isArray(toolResult.rawMessages)
                    ? toolResult.rawMessages
                    : []
                if (rows.length > 0) {
                  const normalizedRows = rows.map((row: any) => ({
                    _session_id: normalizeText(row._session_id || row.sessionId || row.session_id),
                    local_id: parseIntSafe(row.local_id || row.localId || row.id),
                    create_time: parseIntSafe(row.create_time || row.createTime || row.timestamp),
                    sender_username: normalizeText(row.sender_username || row.sender || row.senderName),
                    local_type: parseIntSafe(row.local_type || row.localType || row.type),
                    content: normalizeText(row.content || row.snippet)
                  }))
                  const merged = [...toolBundle.timelineRows, ...normalizedRows]
                  const dedup = new Map<string, any>()
                  for (const row of merged) {
                    const key = `${normalizeText(row._session_id)}:${parseIntSafe(row.local_id)}:${parseIntSafe(row.create_time)}`
                    if (!dedup.has(key)) dedup.set(key, row)
                  }
                  toolBundle.timelineRows = Array.from(dedup.values()).slice(0, MAX_TOOL_RESULT_ROWS)
                }
              } else if (canonicalCallName === 'get_chat_overview' || legacyCallName === 'ai_query_topic_stats') {
                toolBundle.topicStats = toolResult.data || toolResult || {}
              } else if (canonicalCallName === 'get_session_summaries' || legacyCallName === 'ai_query_source_refs') {
                const summaries = Array.isArray(toolResult.sessions)
                  ? toolResult.sessions
                  : Array.isArray(toolResult.rows)
                    ? toolResult.rows
                    : []
                const totalMessages = summaries.reduce((sum: number, row: any) => (
                  sum + parseIntSafe(row.messageCount || row.message_count)
                ), 0)
                toolBundle.sourceRefs = toolResult.data || {
                  range: {
                    begin: normalizeTimestampSeconds(args.beginTimestamp ?? args.startTs),
                    end: normalizeTimestampSeconds(args.endTimestamp ?? args.endTs)
                  },
                  session_count: parseIntSafe(toolResult.total, summaries.length),
                  message_count: totalMessages,
                  db_refs: []
                }
                if (summaries.length > 0) {
                  toolBundle.sessionCandidates = summaries
                }
              } else if (
                canonicalCallName === 'get_member_stats' ||
                canonicalCallName === 'get_members' ||
                legacyCallName === 'ai_query_top_contacts'
              ) {
                if (Array.isArray(toolResult.items)) {
                  toolBundle.topContacts = toolResult.items
                } else if (Array.isArray(toolResult.members)) {
                  toolBundle.topContacts = toolResult.members.map((item: any) => ({
                    sessionId: normalizeText(item.platform_id || item.sessionId || item.member_id),
                    displayName: normalizeText(item.display_name || item.displayName || item.platform_id),
                    messageCount: parseIntSafe(item.messageCount || item.message_count || 0)
                  }))
                } else {
                  toolBundle.topContacts = []
                }
              } else if (canonicalCallName === 'get_message_context' || legacyCallName === 'ai_fetch_message_briefs') {
                toolBundle.messageBriefs = Array.isArray(toolResult.rows)
                  ? toolResult.rows
                  : Array.isArray(toolResult.rawMessages)
                    ? toolResult.rawMessages
                    : []
              } else if (canonicalCallName === 'ai_list_voice_messages' || legacyCallName === 'ai_list_voice_messages') {
                if (Array.isArray(toolResult.items)) {
                  toolBundle.voiceCatalog = toolResult.items
                } else if (Array.isArray(toolResult.ids)) {
                  toolBundle.voiceCatalog = toolResult.ids.map((id: string) => ({ id }))
                } else {
                  toolBundle.voiceCatalog = []
                }
              } else if (canonicalCallName === 'ai_transcribe_voice_messages' || legacyCallName === 'ai_transcribe_voice_messages') {
                toolBundle.voiceTranscripts = Array.isArray(toolResult.results) ? toolResult.results : []
              }
            }
          } catch (error) {
            trace.status = 'error'
            trace.error = (error as Error).message
            toolResult = { success: false, error: trace.error }
          }

          trace.durationMs = Date.now() - started
          toolTrace.push(trace)
          await this.recordToolRun(dbPath, runId, conversationId, userMessageId, trace, toolResult)
          await this.appendToolStepMessage(dbPath, conversationId, intent, trace, toolResult)
          this.emitRunEvent(runtime?.onRunEvent, {
            runId,
            conversationId,
            stage: trace.status === 'ok' ? 'tool_done' : 'tool_error',
            ts: Date.now(),
            round: loop + 1,
            toolName: displayToolName,
            status: trace.status,
            durationMs: trace.durationMs,
            message: trace.status === 'ok'
              ? `工具 ${displayToolName} 完成`
              : `工具 ${displayToolName} 执行失败`,
            data: {
              args,
              result: this.compactToolResultForStep(toolResult),
              ...(trace.error ? { error: trace.error } : {})
            }
          })

          modelMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult || {})
          })
          if (canonicalCallName === 'activate_skill' && toolResult?.success && normalizeText(toolResult?.prompt)) {
            modelMessages.push({
              role: 'system',
              content: `active_skill_from_tool:\n${normalizeText(toolResult.prompt)}`
            })
          }
        }
      }

      if (!finalText) {
        const tail = lastAssistantText ? `（最后一轮输出：${lastAssistantText.slice(0, 200)}）` : ''
        const errorMessage = `模型在 ${MAX_TOOL_LOOPS} 轮内未输出 ${FINAL_DONE_MARKER} + <final_answer>，任务终止${tail}`
        this.emitRunEvent(runtime?.onRunEvent, {
          runId,
          conversationId,
          stage: 'error',
          ts: Date.now(),
          message: errorMessage
        })
        return { success: false, error: errorMessage }
      }

      this.emitRunEvent(runtime?.onRunEvent, {
        runId,
        conversationId,
        stage: 'assembling',
        ts: Date.now(),
        message: '正在组装结构化结果组件'
      })
      const components = this.buildComponents(intent, userInput, toolBundle)
      const assistantMessageId = randomUUID()
      const createdAt = Date.now()
      await this.queryRows(
        dbPath,
        `INSERT INTO ai_messages (
          message_id,conversation_id,role,content,intent_type,components_json,tool_trace_json,usage_json,error,parent_message_id,created_at
        ) VALUES (
          '${escSql(assistantMessageId)}',
          '${escSql(conversationId)}',
          'assistant',
          '${escSql(finalText)}',
          '${escSql(intent)}',
          '${escSql(JSON.stringify(components))}',
          '${escSql(JSON.stringify(toolTrace))}',
          '${escSql(JSON.stringify(usage || {}))}',
          '',
          '${escSql(options?.parentMessageId || userMessageId)}',
          ${createdAt}
        )`
      )

      await this.queryRows(
        dbPath,
        `UPDATE ai_conversations
         SET updated_at=${createdAt}, last_message_at=${createdAt}
         WHERE conversation_id='${escSql(conversationId)}'`
      )

      this.emitRunEvent(runtime?.onRunEvent, {
        runId,
        conversationId,
        stage: 'completed',
        ts: Date.now(),
        message: '分析完成并已写入会话记录'
      })

      return {
        success: true,
        result: {
          conversationId,
          messageId: assistantMessageId,
          assistantText: finalText,
          components,
          toolTrace,
          usage,
          createdAt
        }
      }
    } catch (error) {
      this.emitRunEvent(runtime?.onRunEvent, {
        runId,
        conversationId: normalizeText(conversationId),
        stage: 'error',
        ts: Date.now(),
        message: `分析失败：${(error as Error).message}`
      })
      return { success: false, error: (error as Error).message }
    } finally {
      this.activeRuns.delete(runId)
    }
  }
}

export const aiAnalysisService = new AiAnalysisService()
