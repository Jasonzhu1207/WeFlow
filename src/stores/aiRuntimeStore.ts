import { create } from 'zustand'
import type { AgentRuntimeStatus, AgentStreamChunk, TokenUsage } from '../types/electron'

export type RuntimeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'think'; tag: string; text: string; durationMs?: number }
  | {
    type: 'tool'
    tool: {
      id: string
      name: string
      status: 'running' | 'done' | 'error'
      params?: Record<string, unknown>
      result?: unknown
      durationMs?: number
    }
  }

export interface RuntimeSourceMessage {
  id: number
  localId: number
  sessionId: string
  senderName: string
  senderPlatformId: string
  senderUsername: string
  content: string
  timestamp: number
  type: number
}

interface ConversationRuntimeState {
  requestId: string
  runId: string
  running: boolean
  draft: string
  chunks: AgentStreamChunk[]
  blocks: RuntimeContentBlock[]
  sourceMessages: RuntimeSourceMessage[]
  currentKeywords: string[]
  usage?: TokenUsage
  status?: AgentRuntimeStatus
  error?: string
  updatedAt: number
}

interface AiRuntimeStoreState {
  activeRequestId: string
  states: Record<string, ConversationRuntimeState>
  startRun: (conversationId: string, requestId: string) => void
  appendChunk: (conversationId: string, chunk: AgentStreamChunk) => void
  completeRun: (
    conversationId: string,
    payload?: { runId?: string; conversationId?: string; error?: string; canceled?: boolean }
  ) => void
  clearConversation: (conversationId: string) => void
}

function nextConversationState(previous?: ConversationRuntimeState): ConversationRuntimeState {
  return previous || {
    requestId: '',
    runId: '',
    running: false,
    draft: '',
    chunks: [],
    blocks: [],
    sourceMessages: [],
    currentKeywords: [],
    usage: undefined,
    status: undefined,
    error: '',
    updatedAt: Date.now()
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function toRuntimeSourceMessage(row: any): RuntimeSourceMessage | null {
  if (!row || typeof row !== 'object') return null
  const id = Number(row.id ?? row.localId ?? row.local_id ?? 0)
  const timestamp = Number(row.timestamp ?? row.createTime ?? row.create_time ?? 0)
  const senderName = normalizeText(row.senderName ?? row.sender ?? row.sender_username)
  const content = normalizeText(row.content ?? row.snippet ?? row.message_content)
  const sessionId = normalizeText(row.sessionId ?? row._session_id ?? row.session_id)
  if (id <= 0 || !content) return null
  return {
    id,
    localId: Number(row.localId ?? row.local_id ?? id),
    sessionId,
    senderName: senderName || '未知成员',
    senderPlatformId: normalizeText(row.senderPlatformId ?? row.sender_platform_id ?? row.sender_username),
    senderUsername: normalizeText(row.senderUsername ?? row.sender_username),
    content,
    timestamp,
    type: Number(row.type ?? row.localType ?? row.local_type ?? 0)
  }
}

function extractRuntimeSourceMessages(payload: unknown): RuntimeSourceMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const bag = payload as Record<string, unknown>
  const candidates: unknown[] = []

  if (Array.isArray(bag.rawMessages)) candidates.push(...bag.rawMessages)
  if (Array.isArray(bag.messages)) candidates.push(...bag.messages)
  if (Array.isArray(bag.rows)) candidates.push(...bag.rows)

  const nestedResult = bag.result
  if (nestedResult && typeof nestedResult === 'object') {
    const nested = nestedResult as Record<string, unknown>
    if (Array.isArray(nested.rawMessages)) candidates.push(...nested.rawMessages)
    if (Array.isArray(nested.messages)) candidates.push(...nested.messages)
    if (Array.isArray(nested.rows)) candidates.push(...nested.rows)
    if (Array.isArray(nested.items)) candidates.push(...nested.items)
  }

  const output: RuntimeSourceMessage[] = []
  const dedup = new Set<string>()
  for (const row of candidates) {
    const normalized = toRuntimeSourceMessage(row)
    if (!normalized) continue
    const key = `${normalized.sessionId}:${normalized.localId}:${normalized.timestamp}`
    if (dedup.has(key)) continue
    dedup.add(key)
    output.push(normalized)
    if (output.length >= 120) break
  }
  return output
}

function upsertToolBlock(blocks: RuntimeContentBlock[], chunk: AgentStreamChunk): RuntimeContentBlock[] {
  const toolName = normalizeText(chunk.toolName)
  if (!toolName) return blocks

  if (chunk.type === 'tool_start') {
    return [
      ...blocks,
      {
        type: 'tool',
        tool: {
          id: `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: toolName,
          status: 'running',
          params: chunk.toolParams
        }
      }
    ]
  }

  if (chunk.type !== 'tool_result') return blocks

  const next = [...blocks]
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const block = next[i]
    if (block.type !== 'tool') continue
    if (block.tool.name !== toolName) continue
    if (block.tool.status !== 'running') continue
    next[i] = {
      type: 'tool',
      tool: {
        ...block.tool,
        status: chunk.error ? 'error' : 'done',
        result: chunk.toolResult,
        durationMs: Number((chunk.toolResult as any)?.durationMs || 0) || undefined
      }
    }
    return next
  }

  next.push({
    type: 'tool',
    tool: {
      id: `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: toolName,
      status: chunk.error ? 'error' : 'done',
      params: chunk.toolParams,
      result: chunk.toolResult,
      durationMs: Number((chunk.toolResult as any)?.durationMs || 0) || undefined
    }
  })
  return next
}

export const useAiRuntimeStore = create<AiRuntimeStoreState>((set) => ({
  activeRequestId: '',
  states: {},
  startRun: (conversationId, requestId) => set((state) => {
    const prev = nextConversationState(state.states[conversationId])
    return {
      activeRequestId: requestId,
      states: {
        ...state.states,
        [conversationId]: {
          ...prev,
          requestId,
          runId: '',
          running: true,
          draft: '',
          chunks: [],
          blocks: [],
          error: '',
          sourceMessages: [],
          currentKeywords: [],
          usage: undefined,
          status: {
            phase: 'thinking',
            updatedAt: Date.now()
          },
          updatedAt: Date.now()
        }
      }
    }
  }),
  appendChunk: (conversationId, chunk) => set((state) => {
    const prev = nextConversationState(state.states[conversationId])
    const nextBlocks = [...prev.blocks]
    let nextDraft = prev.draft
    const nextKeywords = [...prev.currentKeywords]

    if (chunk.type === 'content') {
      const text = normalizeText(chunk.content)
      if (text) {
        nextDraft = `${prev.draft}${text}`
        const last = nextBlocks[nextBlocks.length - 1]
        if (last && last.type === 'text') {
          last.text = `${last.text}${text}`
        } else {
          nextBlocks.push({ type: 'text', text })
        }
      }
    }

    if (chunk.type === 'think') {
      const text = normalizeText(chunk.content)
      if (text) {
        nextBlocks.push({
          type: 'think',
          tag: normalizeText(chunk.thinkTag) || 'thinking',
          text,
          durationMs: chunk.thinkDurationMs
        })
      }
    }

    const mergedBlocks = upsertToolBlock(nextBlocks, chunk)
    const extractedSource = chunk.type === 'tool_result'
      ? extractRuntimeSourceMessages(chunk.toolResult)
      : []

    const sourceDedup = new Map<string, RuntimeSourceMessage>()
    for (const item of [...prev.sourceMessages, ...extractedSource]) {
      const key = `${item.sessionId}:${item.localId}:${item.timestamp}`
      sourceDedup.set(key, item)
    }

    if (chunk.toolParams) {
      const keywordRaw = chunk.toolParams.keyword ?? chunk.toolParams.keywords
      if (Array.isArray(keywordRaw)) {
        for (const item of keywordRaw) {
          const keyword = normalizeText(item)
          if (keyword && !nextKeywords.includes(keyword)) nextKeywords.push(keyword)
        }
      } else {
        const keyword = normalizeText(keywordRaw)
        if (keyword && !nextKeywords.includes(keyword)) nextKeywords.push(keyword)
      }
    }

    return {
      states: {
        ...state.states,
        [conversationId]: {
          ...prev,
          runId: normalizeText(chunk.runId) || prev.runId,
          draft: nextDraft,
          blocks: mergedBlocks,
          chunks: [...prev.chunks, chunk].slice(-500),
          sourceMessages: Array.from(sourceDedup.values()).slice(-120),
          currentKeywords: nextKeywords.slice(-12),
          usage: chunk.usage || prev.usage,
          status: chunk.status || prev.status,
          error: chunk.error || prev.error,
          running: chunk.type === 'done' || chunk.type === 'error' || chunk.isFinished ? false : prev.running,
          updatedAt: Date.now()
        }
      }
    }
  }),
  completeRun: (conversationId, payload) => set((state) => {
    const prev = state.states[conversationId]
    if (!prev) return state
    const failed = normalizeText(payload?.error)
    const canceled = payload?.canceled === true || failed === '任务已取消' || failed === '任务已停止'
    return {
      activeRequestId: '',
      states: {
        ...state.states,
        [conversationId]: {
          ...prev,
          runId: normalizeText(payload?.runId) || prev.runId,
          running: false,
          error: canceled ? '' : (failed || prev.error),
          status: canceled
            ? { phase: 'aborted', updatedAt: Date.now(), totalUsage: prev.usage }
            : failed
            ? { phase: 'error', updatedAt: Date.now(), totalUsage: prev.usage }
            : { phase: 'completed', updatedAt: Date.now(), totalUsage: prev.usage },
          updatedAt: Date.now()
        }
      }
    }
  }),
  clearConversation: (conversationId) => set((state) => {
    const next = { ...state.states }
    delete next[conversationId]
    return { states: next }
  })
}))
