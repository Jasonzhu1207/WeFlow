import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Braces,
  CircleStop,
  Database,
  Download,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  ChevronDown,
  ChevronUp
} from 'lucide-react'
import type {
  AiConversation,
  AiMessageRecord,
  AssistantSummary,
  SkillSummary,
  SqlResultPayload,
  SqlSchemaPayload,
  ToolCatalogEntry
} from '../types/aiAnalysis'
import { useAiRuntimeStore } from '../stores/aiRuntimeStore'
import './AiAnalysisPage.scss'

type MainTab = 'chat' | 'sql'
type ScopeMode = 'global' | 'contact' | 'session'

function formatDateTime(ts: number): string {
  if (!ts) return '--'
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function extractSqlTarget(
  schema: SqlSchemaPayload | null,
  key: string
): { kind: 'message' | 'contact' | 'biz'; path: string | null } | null {
  if (!schema) return null
  for (const source of schema.sources) {
    const sourceKey = `${source.kind}:${source.path || ''}`
    if (sourceKey === key) return { kind: source.kind, path: source.path }
  }
  return null
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (value: unknown) => {
    const text = String(value ?? '')
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
    return text
  }
  const header = columns.map((column) => esc(column)).join(',')
  const body = rows
    .map((row) => columns.map((column) => esc(row[column])).join(','))
    .join('\n')
  return `${header}\n${body}`
}

function AiAnalysisPage() {
  const aiApi = window.electronAPI.aiApi
  const agentApi = window.electronAPI.agentApi
  const assistantApi = window.electronAPI.assistantApi
  const skillApi = window.electronAPI.skillApi

  const [activeTab, setActiveTab] = useState<MainTab>('chat')
  const [showDataPanel, setShowDataPanel] = useState(true)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('global')
  const [scopeTarget, setScopeTarget] = useState('')
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [currentConversationId, setCurrentConversationId] = useState('')
  const [messages, setMessages] = useState<AiMessageRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantSummary[]>([])
  const [selectedAssistantId, setSelectedAssistantId] = useState('general_cn')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState('')
  const [contacts, setContacts] = useState<Array<{ username: string; displayName: string }>>([])
  const [input, setInput] = useState('')
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [errorText, setErrorText] = useState('')

  const [sqlPrompt, setSqlPrompt] = useState('')
  const [sqlGenerated, setSqlGenerated] = useState('')
  const [sqlGenerating, setSqlGenerating] = useState(false)
  const [sqlSchema, setSqlSchema] = useState<SqlSchemaPayload | null>(null)
  const [sqlSchemaText, setSqlSchemaText] = useState('')
  const [sqlTargetKey, setSqlTargetKey] = useState('message:')
  const [sqlResult, setSqlResult] = useState<SqlResultPayload | null>(null)
  const [sqlError, setSqlError] = useState('')
  const [sqlHistory, setSqlHistory] = useState<string[]>([])
  const [sqlSortBy, setSqlSortBy] = useState('')
  const [sqlSortOrder, setSqlSortOrder] = useState<'asc' | 'desc'>('asc')
  const [sqlPage, setSqlPage] = useState(1)
  const [sqlPageSize] = useState(50)

  const messageContainerRef = useRef<HTMLDivElement | null>(null)
  const sqlGeneratedRef = useRef('')
  const [showScrollBottom, setShowScrollBottom] = useState(false)

  const runtimeState = useAiRuntimeStore((state) => (
    currentConversationId ? state.states[currentConversationId] : undefined
  ))
  const activeRequestId = useAiRuntimeStore((state) => state.activeRequestId)
  const startRun = useAiRuntimeStore((state) => state.startRun)
  const appendChunk = useAiRuntimeStore((state) => state.appendChunk)
  const completeRun = useAiRuntimeStore((state) => state.completeRun)

  const selectedAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === selectedAssistantId) || null,
    [assistants, selectedAssistantId]
  )
  const showThinkBlocks = useMemo(() => {
    try {
      const query = new URLSearchParams(window.location.search)
      if (query.get('debugThink') === '1') return true
      return window.localStorage.getItem('wf_ai_debug_think') === '1'
    } catch {
      return false
    }
  }, [])

  const slashSuggestions = useMemo(() => {
    const text = normalizeText(input)
    if (!text.startsWith('/')) return []
    const key = text.slice(1).toLowerCase()
    return skills
      .filter((skill) => !key || skill.id.includes(key) || skill.name.toLowerCase().includes(key))
      .slice(0, 8)
  }, [input, skills])

  const mentionSuggestions = useMemo(() => {
    const match = input.match(/@([^\s@]*)$/)
    if (!match) return []
    const keyword = match[1].toLowerCase()
    return contacts
      .filter((contact) =>
        !keyword ||
        contact.displayName.toLowerCase().includes(keyword) ||
        contact.username.toLowerCase().includes(keyword)
      )
      .slice(0, 8)
  }, [contacts, input])

  const sqlTargetOptions = useMemo(() => {
    if (!sqlSchema) return []
    return sqlSchema.sources.map((source) => ({
      key: `${source.kind}:${source.path || ''}`,
      label: `[${source.kind}] ${source.label}`
    }))
  }, [sqlSchema])

  const sqlSortedRows = useMemo(() => {
    const rows = sqlResult?.rows || []
    if (!sqlSortBy) return rows
    const copied = [...rows]
    copied.sort((a, b) => {
      const left = String(a[sqlSortBy] ?? '')
      const right = String(b[sqlSortBy] ?? '')
      if (left === right) return 0
      return sqlSortOrder === 'asc' ? (left > right ? 1 : -1) : (left > right ? -1 : 1)
    })
    return copied
  }, [sqlResult, sqlSortBy, sqlSortOrder])

  const sqlPagedRows = useMemo(() => {
    const start = (sqlPage - 1) * sqlPageSize
    return sqlSortedRows.slice(start, start + sqlPageSize)
  }, [sqlPage, sqlPageSize, sqlSortedRows])

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true)
    try {
      const res = await aiApi.listConversations({ page: 1, pageSize: 200 })
      if (!res.success) {
        setErrorText(res.error || '加载会话失败')
        return
      }
      const list = res.conversations || []
      setConversations(list)
      if (!currentConversationId && list.length > 0) {
        setCurrentConversationId(list[0].conversationId)
      }
    } finally {
      setLoadingConversations(false)
    }
  }, [aiApi, currentConversationId])

  const loadMessages = useCallback(async (conversationId: string) => {
    if (!conversationId) return
    setLoadingMessages(true)
    try {
      const res = await aiApi.listMessages({ conversationId, limit: 1200 })
      if (!res.success) {
        setErrorText(res.error || '加载消息失败')
        return
      }
      setMessages((res.messages || []).filter((message) => normalizeText(message.role) !== 'tool'))
    } finally {
      setLoadingMessages(false)
    }
  }, [aiApi])

  const loadAssistantsAndSkills = useCallback(async () => {
    try {
      const [assistantList, skillList] = await Promise.all([
        assistantApi.getAll(),
        skillApi.getAll()
      ])
      setAssistants(assistantList || [])
      setSkills(skillList || [])
      if (
        assistantList &&
        assistantList.length > 0 &&
        !assistantList.some((item) => item.id === selectedAssistantId)
      ) {
        setSelectedAssistantId(assistantList[0].id)
      }
    } catch (error) {
      setErrorText(String((error as Error)?.message || error))
    }
  }, [assistantApi, skillApi, selectedAssistantId])

  const loadContacts = useCallback(async () => {
    try {
      const res = await window.electronAPI.chat.getContacts({ lite: true })
      if (!res.success || !res.contacts) return
      const list = res.contacts
        .map((contact) => ({
          username: normalizeText(contact.username),
          displayName: normalizeText(
            contact.displayName ||
            contact.remark ||
            contact.nickname ||
            contact.username
          )
        }))
        .filter((contact) => contact.username && contact.displayName)
        .slice(0, 300)
      setContacts(list)
    } catch {
      // ignore
    }
  }, [])

  const loadSchema = useCallback(async () => {
    const res = await window.electronAPI.chat.getSchema({})
    if (!res.success || !res.schema) {
      setSqlError(res.error || 'Schema 加载失败')
      return
    }
    setSqlSchema(res.schema)
    setSqlSchemaText(res.schemaText || '')
    if (res.schema.sources.length > 0) {
      setSqlTargetKey(`${res.schema.sources[0].kind}:${res.schema.sources[0].path || ''}`)
    }
  }, [])

  useEffect(() => {
    void loadConversations()
    void loadAssistantsAndSkills()
    void loadContacts()
  }, [loadConversations, loadAssistantsAndSkills, loadContacts])

  useEffect(() => {
    if (!currentConversationId) return
    void loadMessages(currentConversationId)
  }, [currentConversationId, loadMessages])

  useEffect(() => {
    if (activeTab === 'sql' && !sqlSchema) {
      void loadSchema()
    }
  }, [activeTab, sqlSchema, loadSchema])

  useEffect(() => {
    const panel = messageContainerRef.current
    if (!panel) return
    const onScroll = () => {
      const distance = panel.scrollHeight - panel.scrollTop - panel.clientHeight
      setShowScrollBottom(distance > 64)
    }
    panel.addEventListener('scroll', onScroll)
    onScroll()
    return () => panel.removeEventListener('scroll', onScroll)
  }, [messageContainerRef.current])

  useEffect(() => {
    const panel = messageContainerRef.current
    if (!panel) return
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' })
  }, [messages, runtimeState?.blocks.length, runtimeState?.draft])

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (currentConversationId) return currentConversationId
    const created = await aiApi.createConversation({ title: '新的 AI 对话' })
    if (!created.success || !created.conversationId) {
      throw new Error(created.error || '创建会话失败')
    }
    setCurrentConversationId(created.conversationId)
    await loadConversations()
    return created.conversationId
  }, [aiApi, currentConversationId, loadConversations])

  const handleCreateConversation = async () => {
    const created = await aiApi.createConversation({ title: '新的 AI 对话' })
    if (!created.success || !created.conversationId) {
      setErrorText(created.error || '创建会话失败')
      return
    }
    setCurrentConversationId(created.conversationId)
    setMessages([])
    setErrorText('')
    await loadConversations()
  }

  const handleRenameConversation = async (conversationId: string) => {
    const current = conversations.find((item) => item.conversationId === conversationId)
    const nextTitle = window.prompt('请输入新的会话标题', current?.title || '新的 AI 对话')
    if (!nextTitle) return
    const result = await aiApi.renameConversation({ conversationId, title: nextTitle })
    if (!result.success) {
      setErrorText(result.error || '重命名失败')
      return
    }
    await loadConversations()
  }

  const handleDeleteConversation = async (conversationId: string) => {
    const ok = window.confirm('确认删除该会话吗？')
    if (!ok) return
    const result = await aiApi.deleteConversation(conversationId)
    if (!result.success) {
      setErrorText(result.error || '删除失败')
      return
    }
    if (currentConversationId === conversationId) {
      setCurrentConversationId('')
      setMessages([])
    }
    await loadConversations()
  }

  const handleSend = async () => {
    const text = normalizeText(input)
    if (!text) return

    setErrorText('')
    const conversationId = await ensureConversation()

    setMessages((prev) => ([
      ...prev,
      {
        messageId: `temp-${Date.now()}`,
        conversationId,
        role: 'user',
        content: text,
        intentType: '',
        components: [],
        toolTrace: [],
        createdAt: Date.now()
      }
    ]))
    setInput('')

    const run = agentApi.runStream({
      mode: 'chat',
      conversationId,
      userInput: text,
      assistantId: selectedAssistantId,
      activeSkillId: selectedSkillId || undefined,
      chatScope: scopeMode === 'session' ? 'private' : 'private'
    }, (chunk) => {
      appendChunk(conversationId, chunk)
    })

    startRun(conversationId, run.requestId)
    const result = await run.promise
    completeRun(conversationId, result.result || { error: result.error, canceled: false })

    if (!result.success && !result.result?.canceled) {
      setErrorText(result.error || '执行失败')
    }

    await loadMessages(conversationId)
    await loadConversations()
  }

  const handleStop = async () => {
    if (!currentConversationId) return
    const requestId = runtimeState?.requestId || activeRequestId
    if (!requestId) return
    setErrorText('')
    await agentApi.abort(requestId)
    completeRun(currentConversationId, { canceled: true })
  }

  const handleExportConversation = async () => {
    if (!currentConversationId) return
    const result = await aiApi.exportConversation({ conversationId: currentConversationId })
    if (!result.success || !result.markdown) {
      setErrorText(result.error || '导出失败')
      return
    }
    await navigator.clipboard.writeText(result.markdown)
    window.alert('会话 Markdown 已复制到剪贴板')
  }

  const handleGenerateSql = async () => {
    const prompt = normalizeText(sqlPrompt)
    if (!prompt) return
    setSqlGenerating(true)
    setSqlGenerated('')
    sqlGeneratedRef.current = ''
    setSqlError('')

    const target = extractSqlTarget(sqlSchema, sqlTargetKey)
    const run = agentApi.runStream({
      mode: 'sql',
      userInput: prompt,
      sqlContext: {
        schemaText: sqlSchemaText,
        targetHint: target ? `${target.kind}:${target.path || ''}` : ''
      }
    }, (chunk) => {
      if (chunk.type === 'content') {
        setSqlGenerated((prev) => {
          const next = `${prev}${chunk.content || ''}`
          sqlGeneratedRef.current = next
          return next
        })
      }
    })

    const result = await run.promise
    setSqlGenerating(false)
    if (!result.success) {
      setSqlError(result.error || 'SQL 生成失败')
      return
    }

    if (normalizeText(sqlGeneratedRef.current)) {
      setSqlHistory((prev) => [sqlGeneratedRef.current.trim(), ...prev].slice(0, 30))
    }
  }

  const handleExecuteSql = async () => {
    const sql = normalizeText(sqlGenerated)
    if (!sql) return
    const target = extractSqlTarget(sqlSchema, sqlTargetKey)
    if (!target) {
      setSqlError('请选择 SQL 数据源')
      return
    }
    const result = await window.electronAPI.chat.executeSQL({
      kind: target.kind,
      path: target.path,
      sql,
      limit: 500
    })
    if (!result.success || !result.rows || !result.columns) {
      setSqlError(result.error || '执行失败')
      return
    }
    setSqlError('')
    setSqlResult({
      rows: result.rows,
      columns: result.columns,
      total: result.total || result.rows.length
    })
    setSqlHistory((prev) => [sql, ...prev].slice(0, 30))
    setSqlPage(1)
  }

  const handleExportSqlRows = () => {
    if (!sqlResult || sqlResult.rows.length === 0) return
    const csv = toCsv(sqlResult.rows, sqlResult.columns)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sql-result-${Date.now()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="ai-analysis-chatlab">
      <header className="ai-topbar">
        <div className="title-group">
          <Sparkles size={18} />
          <h1>AI Analysis</h1>
          <span>ChatLab 交互同构模式</span>
        </div>
        <div className="top-actions">
          <button type="button" className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>
            <Bot size={14} />
            AI Chat
          </button>
          <button type="button" className={activeTab === 'sql' ? 'active' : ''} onClick={() => setActiveTab('sql')}>
            <Database size={14} />
            SQL Lab
          </button>
        </div>
      </header>

      {activeTab === 'chat' && (
        <div className={`chat-shell ${showDataPanel ? 'with-data' : ''}`}>
          <aside className="conversation-sidebar">
            <div className="sidebar-head">
              <h3>会话</h3>
              <button type="button" onClick={() => void handleCreateConversation()} title="新建会话">+</button>
            </div>
            {loadingConversations ? (
              <div className="empty"><Loader2 className="spin" size={14} /> 加载中...</div>
            ) : (
              <div className="conversation-list">
                {conversations.map((conversation) => (
                  <button
                    type="button"
                    key={conversation.conversationId}
                    className={`conversation-item ${currentConversationId === conversation.conversationId ? 'active' : ''}`}
                    onClick={() => setCurrentConversationId(conversation.conversationId)}
                  >
                    <div className="main">
                      <strong>{conversation.title || '新的 AI 对话'}</strong>
                      <small>{formatDateTime(conversation.updatedAt)}</small>
                    </div>
                    <div className="ops" onClick={(event) => event.stopPropagation()}>
                      <span onClick={() => void handleRenameConversation(conversation.conversationId)}>重命名</span>
                      <span onClick={() => void handleDeleteConversation(conversation.conversationId)}>
                        <Trash2 size={12} />
                      </span>
                    </div>
                  </button>
                ))}
                {conversations.length === 0 && <div className="empty">暂无会话</div>}
              </div>
            )}
          </aside>

          <section className="chat-main-panel">
            <div className="chat-toolbar">
              <div className="controls-row">
                <label>助手</label>
                <select value={selectedAssistantId} onChange={(event) => setSelectedAssistantId(event.target.value)}>
                  {assistants.map((assistant) => (
                    <option key={assistant.id} value={assistant.id}>{assistant.name}</option>
                  ))}
                </select>
                <label>技能</label>
                <select value={selectedSkillId} onChange={(event) => setSelectedSkillId(event.target.value)}>
                  <option value="">无</option>
                  {skills.map((skill) => (
                    <option key={skill.id} value={skill.id}>{skill.name}</option>
                  ))}
                </select>
                <label>范围</label>
                <select value={scopeMode} onChange={(event) => setScopeMode(event.target.value as ScopeMode)}>
                  <option value="global">全局</option>
                  <option value="contact">联系人</option>
                  <option value="session">会话</option>
                </select>
                {scopeMode !== 'global' && (
                  <input
                    type="text"
                    value={scopeTarget}
                    onChange={(event) => setScopeTarget(event.target.value)}
                    placeholder={scopeMode === 'contact' ? '联系人昵称/账号' : '会话ID'}
                  />
                )}
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowDataPanel((prev) => !prev)}
                  title={showDataPanel ? '隐藏数据面板' : '显示数据面板'}
                >
                  {showDataPanel ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
                  数据源
                </button>
              </div>

              {selectedAssistant?.presetQuestions?.length ? (
                <div className="preset-row">
                  {selectedAssistant.presetQuestions.slice(0, 8).map((question) => (
                    <button key={question} type="button" onClick={() => setInput(question)}>{question}</button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="messages-wrap" ref={messageContainerRef}>
              {loadingMessages ? (
                <div className="empty"><Loader2 className="spin" size={14} /> 加载消息...</div>
              ) : (
                <>
                  {messages.map((message) => (
                    <article key={message.messageId} className={`message-card ${message.role === 'user' ? 'user' : 'assistant'}`}>
                      <header>
                        <span>{message.role === 'user' ? '你' : '助手'}</span>
                        <time>{formatDateTime(message.createdAt)}</time>
                      </header>
                      <div className="message-body">{message.content || '（空）'}</div>
                      {message.role === 'assistant' && Array.isArray(message.toolTrace) && message.toolTrace.length > 0 ? (
                        <details className="tool-trace">
                          <summary>工具调用轨迹（{message.toolTrace.length}）</summary>
                          <ul>
                            {message.toolTrace.map((trace, index) => (
                              <li key={`${message.messageId}-trace-${index}`}>
                                {String(trace?.toolName || 'unknown')} · {String(trace?.status || 'unknown')} · {Number(trace?.durationMs || 0)}ms
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </article>
                  ))}

                  {runtimeState?.running ? (
                    <article className="message-card assistant streaming">
                      <header>
                        <span>助手（实时）</span>
                        <time>{runtimeState?.status?.phase || 'thinking'}</time>
                      </header>
                      <div className="message-body blocks">
                        {(runtimeState?.blocks || []).map((block, index) => {
                          if (block.type === 'text') {
                            return <div key={`text-${index}`} className="text-block">{block.text}</div>
                          }
                          if (block.type === 'think') {
                            if (!showThinkBlocks) return null
                            return (
                              <details key={`think-${index}`} className="think-block">
                                <summary>
                                  思考过程
                                  {block.durationMs ? <small>{Math.max(0, block.durationMs)}ms</small> : null}
                                </summary>
                                <pre>{block.text}</pre>
                              </details>
                            )
                          }
                          return (
                            <div key={`tool-${index}`} className={`tool-block ${block.tool.status}`}>
                              <div className="line">
                                <strong>{block.tool.name}</strong>
                                <span>{block.tool.status}</span>
                              </div>
                              {block.tool.params ? (
                                <pre>{JSON.stringify(block.tool.params, null, 2)}</pre>
                              ) : null}
                              {block.tool.result ? (
                                <pre>{JSON.stringify(block.tool.result, null, 2)}</pre>
                              ) : null}
                            </div>
                          )
                        })}
                        {runtimeState?.running ? (
                          <span className="typing-cursor">|</span>
                        ) : null}
                      </div>
                    </article>
                  ) : null}
                </>
              )}

              {showScrollBottom ? (
                <button
                  type="button"
                  className="scroll-bottom"
                  onClick={() => messageContainerRef.current?.scrollTo({ top: messageContainerRef.current.scrollHeight, behavior: 'smooth' })}
                >
                  <ChevronDown size={14} />
                </button>
              ) : null}
            </div>

            <div className="status-row">
              <div className="left">
                <span>状态：{runtimeState?.status?.phase || 'idle'}</span>
                {typeof runtimeState?.usage?.totalTokens === 'number' ? (
                  <span>Tokens: {runtimeState?.usage?.totalTokens}</span>
                ) : null}
              </div>
              <div className="right">
                <button type="button" className="ghost" onClick={() => void loadConversations()}>
                  <RefreshCw size={13} /> 刷新
                </button>
                <button type="button" className="ghost" onClick={() => void handleExportConversation()}>
                  <Download size={13} /> 导出
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={!runtimeState?.running}
                  onClick={() => void handleStop()}
                >
                  <CircleStop size={13} /> 停止
                </button>
              </div>
            </div>

            <div className="input-panel">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="输入问题，支持 /技能 和 @成员，Ctrl/Cmd + Enter 发送"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void handleSend()
                  }
                }}
              />

              {slashSuggestions.length > 0 && (
                <div className="suggestions">
                  {slashSuggestions.map((skill) => (
                    <button key={skill.id} type="button" onClick={() => { setSelectedSkillId(skill.id); setInput('') }}>
                      /{skill.id} · {skill.name}
                    </button>
                  ))}
                </div>
              )}

              {mentionSuggestions.length > 0 && (
                <div className="suggestions">
                  {mentionSuggestions.map((contact) => (
                    <button
                      key={contact.username}
                      type="button"
                      onClick={() => {
                        setInput((prev) => prev.replace(/@([^\s@]*)$/, `@${contact.displayName} `))
                      }}
                    >
                      @{contact.displayName}
                    </button>
                  ))}
                </div>
              )}

              <div className="input-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleSend()}
                  disabled={runtimeState?.running}
                >
                  {runtimeState?.running ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
                  发送
                </button>
              </div>
            </div>
          </section>

          {showDataPanel ? (
            <aside className="data-panel">
              <header>
                <h3>数据源面板</h3>
                <span>{runtimeState?.sourceMessages?.length || 0} 条</span>
              </header>

              <section className="keywords">
                <h4>关键词</h4>
                <div className="chips">
                  {(runtimeState?.currentKeywords || []).length ? (
                    runtimeState?.currentKeywords.map((keyword) => (
                      <span key={keyword}>{keyword}</span>
                    ))
                  ) : (
                    <small>暂无</small>
                  )}
                </div>
              </section>

              <section className="sources">
                <h4>引用消息</h4>
                <div className="source-list">
                  {(runtimeState?.sourceMessages || []).map((message) => (
                    <article key={`${message.sessionId}-${message.localId}-${message.timestamp}`}>
                      <header>
                        <strong>{message.senderName || '未知成员'}</strong>
                        <time>{formatDateTime((message.timestamp || 0) * 1000)}</time>
                      </header>
                      <p>{message.content}</p>
                    </article>
                  ))}
                  {(runtimeState?.sourceMessages || []).length === 0 ? (
                    <div className="empty">暂无检索来源</div>
                  ) : null}
                </div>
              </section>
            </aside>
          ) : null}
        </div>
      )}

      {activeTab === 'sql' && (
        <div className="sql-shell">
          <aside className="schema-panel">
            <div className="panel-head">
              <h3>Schema</h3>
              <button type="button" onClick={() => void loadSchema()}><RefreshCw size={13} /></button>
            </div>
            <div className="schema-list">
              {sqlSchema?.sources.map((source) => (
                <div key={`${source.kind}:${source.path || ''}`} className="schema-source">
                  <h4>[{source.kind}] {source.label}</h4>
                  <ul>
                    {source.tables.slice(0, 24).map((table) => (
                      <li key={table.name}>
                        <strong>{table.name}</strong>
                        <small>{table.columns.slice(0, 10).join(', ')}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </aside>
          <section className="sql-main">
            <div className="sql-bar">
              <select value={sqlTargetKey} onChange={(event) => setSqlTargetKey(event.target.value)}>
                {sqlTargetOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
              <button type="button" onClick={() => void handleGenerateSql()} disabled={sqlGenerating}>
                {sqlGenerating ? <Loader2 className="spin" size={14} /> : <Braces size={14} />}
                生成 SQL
              </button>
              <button type="button" onClick={() => void handleExecuteSql()}>
                <Play size={14} />
                执行 SQL
              </button>
              <button type="button" onClick={handleExportSqlRows} disabled={!sqlResult?.rows?.length}>
                <Download size={14} />
                导出结果
              </button>
            </div>
            <textarea
              className="sql-prompt"
              value={sqlPrompt}
              onChange={(event) => setSqlPrompt(event.target.value)}
              placeholder="输入需求，例如：统计过去7天最活跃的10个联系人"
            />
            <textarea
              className="sql-generated"
              value={sqlGenerated}
              onChange={(event) => {
                setSqlGenerated(event.target.value)
                sqlGeneratedRef.current = event.target.value
              }}
              placeholder="生成的 SQL 将显示在这里"
            />

            {sqlError ? <div className="error">{sqlError}</div> : null}

            <div className="sql-table-wrap">
              {sqlResult?.rows?.length ? (
                <>
                  <table className="sql-table">
                    <thead>
                      <tr>
                        {sqlResult.columns.map((column) => (
                          <th
                            key={column}
                            onClick={() => {
                              if (sqlSortBy === column) {
                                setSqlSortOrder((prev) => prev === 'asc' ? 'desc' : 'asc')
                              } else {
                                setSqlSortBy(column)
                                setSqlSortOrder('asc')
                              }
                            }}
                          >
                            {column}
                            {sqlSortBy === column ? (sqlSortOrder === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sqlPagedRows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`}>
                          {sqlResult.columns.map((column) => (
                            <td key={`${rowIndex}-${column}`}>{String(row[column] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="pager">
                    <span>共 {sqlResult.total} 行</span>
                    <button type="button" onClick={() => setSqlPage((prev) => Math.max(1, prev - 1))}>上一页</button>
                    <span>{sqlPage}</span>
                    <button type="button" onClick={() => setSqlPage((prev) => prev + 1)}>下一页</button>
                  </div>
                </>
              ) : (
                <div className="empty">暂无执行结果</div>
              )}
            </div>

            <div className="sql-history">
              <h4>历史 SQL</h4>
              <div className="history-list">
                {sqlHistory.map((sql, index) => (
                  <button key={`sql-${index}`} type="button" onClick={() => setSqlGenerated(sql)}>
                    {sql.slice(0, 160)}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {errorText ? <div className="global-error">{errorText}</div> : null}
    </div>
  )
}

export default AiAnalysisPage
