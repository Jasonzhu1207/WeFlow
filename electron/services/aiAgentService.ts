import http from 'http'
import https from 'https'
import { randomUUID } from 'crypto'
import { URL } from 'url'
import { ConfigService } from './config'
import { aiAnalysisService, type AiAnalysisRunEvent } from './aiAnalysisService'

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface AgentRuntimeStatus {
  phase: 'idle' | 'thinking' | 'tool_running' | 'responding' | 'completed' | 'error' | 'aborted'
  round?: number
  currentTool?: string
  toolsUsed?: number
  updatedAt: number
  totalUsage?: TokenUsage
}

export interface AgentStreamChunk {
  runId: string
  conversationId?: string
  type: 'content' | 'think' | 'tool_start' | 'tool_result' | 'status' | 'done' | 'error'
  content?: string
  thinkTag?: string
  thinkDurationMs?: number
  toolName?: string
  toolParams?: Record<string, unknown>
  toolResult?: unknown
  error?: string
  isFinished?: boolean
  usage?: TokenUsage
  status?: AgentRuntimeStatus
}

export interface AgentRunPayload {
  mode?: 'chat' | 'sql'
  conversationId?: string
  userInput: string
  assistantId?: string
  activeSkillId?: string
  chatScope?: 'group' | 'private'
  sqlContext?: {
    schemaText?: string
    targetHint?: string
  }
}

interface ActiveAgentRun {
  runId: string
  mode: 'chat' | 'sql'
  conversationId?: string
  innerRunId?: string
  aborted: boolean
}

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function parseOptionalInt(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.floor(n) : undefined
}

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

function extractSqlText(raw: string): string {
  const text = normalizeText(raw)
  if (!text) return ''
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  return text
}

class AiAgentService {
  private readonly config = ConfigService.getInstance()
  private readonly runs = new Map<string, ActiveAgentRun>()

  private getSharedModelConfig(): { apiBaseUrl: string; apiKey: string; model: string } {
    return {
      apiBaseUrl: normalizeText(this.config.get('aiModelApiBaseUrl')),
      apiKey: normalizeText(this.config.get('aiModelApiKey')),
      model: normalizeText(this.config.get('aiModelApiModel'), 'gpt-4o-mini')
    }
  }

  private emitStatus(
    run: ActiveAgentRun,
    onChunk: (chunk: AgentStreamChunk) => void,
    phase: AgentRuntimeStatus['phase'],
    extra?: Partial<AgentRuntimeStatus>
  ): void {
    onChunk({
      runId: run.runId,
      conversationId: run.conversationId,
      type: 'status',
      status: {
        phase,
        updatedAt: Date.now(),
        ...extra
      }
    })
  }

  private mapRunEventToChunk(
    run: ActiveAgentRun,
    event: AiAnalysisRunEvent
  ): AgentStreamChunk | null {
    run.innerRunId = event.runId
    run.conversationId = event.conversationId || run.conversationId
    if (event.stage === 'llm_round_started') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'think',
        content: event.message,
        thinkTag: 'round'
      }
    }
    if (event.stage === 'tool_start') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'tool_start',
        toolName: event.toolName,
        toolParams: (event.data || {}) as Record<string, unknown>
      }
    }
    if (event.stage === 'tool_done' || event.stage === 'tool_error') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'tool_result',
        toolName: event.toolName,
        toolResult: event.data || { status: event.status, durationMs: event.durationMs }
      }
    }
    if (event.stage === 'completed') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'status',
        status: { phase: 'completed', updatedAt: Date.now() }
      }
    }
    if (event.stage === 'aborted') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'status',
        status: { phase: 'aborted', updatedAt: Date.now() }
      }
    }
    if (event.stage === 'error') {
      return {
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'status',
        status: { phase: 'error', updatedAt: Date.now() }
      }
    }
    return null
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
      req.setTimeout(45_000, () => {
        req.destroy()
        reject(new Error('AI 请求超时'))
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  async runStream(
    payload: AgentRunPayload,
    runtime: {
      onChunk: (chunk: AgentStreamChunk) => void
      onFinished?: (result: { success: boolean; runId: string; conversationId?: string; error?: string }) => void
    }
  ): Promise<{ success: boolean; runId: string }> {
    const runId = randomUUID()
    const mode = payload.mode === 'sql' ? 'sql' : 'chat'
    const run: ActiveAgentRun = {
      runId,
      mode,
      conversationId: normalizeText(payload.conversationId) || undefined,
      aborted: false
    }
    this.runs.set(runId, run)

    this.execute(run, payload, runtime).catch((error) => {
      runtime.onChunk({
        runId,
        conversationId: run.conversationId,
        type: 'error',
        error: String((error as Error)?.message || error),
        isFinished: true
      })
      runtime.onFinished?.({
        success: false,
        runId,
        conversationId: run.conversationId,
        error: String((error as Error)?.message || error)
      })
      this.runs.delete(runId)
    })

    return { success: true, runId }
  }

  private async execute(
    run: ActiveAgentRun,
    payload: AgentRunPayload,
    runtime: {
      onChunk: (chunk: AgentStreamChunk) => void
      onFinished?: (result: { success: boolean; runId: string; conversationId?: string; error?: string }) => void
    }
  ): Promise<void> {
    if (run.mode === 'sql') {
      await this.executeSqlMode(run, payload, runtime)
      return
    }
    this.emitStatus(run, runtime.onChunk, 'thinking')
    const result = await aiAnalysisService.sendMessage(
      normalizeText(payload.conversationId),
      normalizeText(payload.userInput),
      {
        assistantId: normalizeText(payload.assistantId),
        activeSkillId: normalizeText(payload.activeSkillId),
        chatScope: payload.chatScope === 'group' ? 'group' : 'private'
      },
      {
        onRunEvent: (event) => {
          const mapped = this.mapRunEventToChunk(run, event)
          if (mapped) runtime.onChunk(mapped)
        }
      }
    )
    if (run.aborted) {
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'error',
        error: '任务已取消',
        isFinished: true
      })
      runtime.onFinished?.({
        success: false,
        runId: run.runId,
        conversationId: run.conversationId,
        error: '任务已取消'
      })
      this.runs.delete(run.runId)
      return
    }
    if (!result.success || !result.result) {
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'error',
        error: result.error || '执行失败',
        isFinished: true
      })
      runtime.onFinished?.({
        success: false,
        runId: run.runId,
        conversationId: run.conversationId,
        error: result.error || '执行失败'
      })
      this.runs.delete(run.runId)
      return
    }

    run.conversationId = result.result.conversationId || run.conversationId
    runtime.onChunk({
      runId: run.runId,
      conversationId: run.conversationId,
      type: 'content',
      content: result.result.assistantText
    })
    runtime.onChunk({
      runId: run.runId,
      conversationId: run.conversationId,
      type: 'done',
      usage: result.result.usage,
      isFinished: true
    })
    runtime.onFinished?.({ success: true, runId: run.runId, conversationId: run.conversationId })
    this.runs.delete(run.runId)
  }

  private async executeSqlMode(
    run: ActiveAgentRun,
    payload: AgentRunPayload,
    runtime: {
      onChunk: (chunk: AgentStreamChunk) => void
      onFinished?: (result: { success: boolean; runId: string; conversationId?: string; error?: string }) => void
    }
  ): Promise<void> {
    const { apiBaseUrl, apiKey, model } = this.getSharedModelConfig()
    if (!apiBaseUrl || !apiKey) {
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'error',
        error: '请先在设置 > AI 通用中配置模型',
        isFinished: true
      })
      runtime.onFinished?.({ success: false, runId: run.runId, conversationId: run.conversationId, error: '模型未配置' })
      this.runs.delete(run.runId)
      return
    }
    this.emitStatus(run, runtime.onChunk, 'thinking')
    const schemaText = normalizeText(payload.sqlContext?.schemaText)
    const targetHint = normalizeText(payload.sqlContext?.targetHint)
    const systemPrompt = [
      '你是 WeFlow SQL Lab 助手。',
      '只输出一段只读 SQL。',
      '禁止输出解释、Markdown、注释、DML、DDL。'
    ].join('\n')
    const userPrompt = [
      targetHint ? `目标数据源: ${targetHint}` : '',
      schemaText ? `可用 Schema:\n${schemaText}` : '',
      `需求: ${normalizeText(payload.userInput)}`
    ].filter(Boolean).join('\n\n')

    const res = await this.callModel({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      stream: false
    }, apiBaseUrl, apiKey)

    if (run.aborted) {
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'error',
        error: '任务已取消',
        isFinished: true
      })
      runtime.onFinished?.({ success: false, runId: run.runId, conversationId: run.conversationId, error: '任务已取消' })
      this.runs.delete(run.runId)
      return
    }

    const rawContent = normalizeText(res?.choices?.[0]?.message?.content)
    const sql = extractSqlText(rawContent)
    const usage: TokenUsage = {
      promptTokens: parseOptionalInt(res?.usage?.prompt_tokens),
      completionTokens: parseOptionalInt(res?.usage?.completion_tokens),
      totalTokens: parseOptionalInt(res?.usage?.total_tokens)
    }
    if (!sql) {
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'error',
        error: 'SQL 生成失败',
        isFinished: true
      })
      runtime.onFinished?.({ success: false, runId: run.runId, conversationId: run.conversationId, error: 'SQL 生成失败' })
      this.runs.delete(run.runId)
      return
    }
    for (let i = 0; i < sql.length; i += 36) {
      if (run.aborted) break
      runtime.onChunk({
        runId: run.runId,
        conversationId: run.conversationId,
        type: 'content',
        content: sql.slice(i, i + 36)
      })
    }
    runtime.onChunk({
      runId: run.runId,
      conversationId: run.conversationId,
      type: 'done',
      usage,
      isFinished: true
    })
    runtime.onFinished?.({ success: true, runId: run.runId, conversationId: run.conversationId })
    this.runs.delete(run.runId)
  }

  async abort(payload: { runId?: string; conversationId?: string }): Promise<{ success: boolean }> {
    const runId = normalizeText(payload.runId)
    const conversationId = normalizeText(payload.conversationId)
    if (runId) {
      const run = this.runs.get(runId)
      if (run) {
        run.aborted = true
        if (run.mode === 'chat') {
          await aiAnalysisService.abortRun({ runId: run.innerRunId, conversationId: run.conversationId })
        }
      }
      return { success: true }
    }

    if (conversationId) {
      for (const run of this.runs.values()) {
        if (run.conversationId !== conversationId) continue
        run.aborted = true
        if (run.mode === 'chat') {
          await aiAnalysisService.abortRun({ runId: run.innerRunId, conversationId: run.conversationId })
        }
      }
      return { success: true }
    }
    return { success: true }
  }
}

export const aiAgentService = new AiAgentService()
