import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Home, MessageSquare, BarChart3, FileText, Settings,
  Download, Aperture, UserCircle, Lock, LockOpen,
  ChevronUp, FolderClosed, Footprints, Users, ArchiveRestore
} from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import * as configService from '../services/config'
import { onExportSessionStatus, requestExportSessionStatus } from '../services/exportBridge'
import { cn } from '@/lib/utils'

/* ─────────────────────────── Types & Helpers ─────────────────────────── */

interface SidebarUserProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

const SIDEBAR_USER_PROFILE_CACHE_KEY = 'sidebar_user_profile_cache_v1'
const ACCOUNT_PROFILES_CACHE_KEY = 'account_profiles_cache_v1'
const DEFAULT_DISPLAY_NAME = '微信用户'
const DEFAULT_SUBTITLE = '微信账号'

interface SidebarUserProfileCache extends SidebarUserProfile {
  updatedAt: number
}

interface AccountProfilesCache {
  [wxid: string]: {
    displayName: string
    avatarUrl?: string
    alias?: string
    updatedAt: number
  }
}

const readSidebarUserProfileCache = (): SidebarUserProfile | null => {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SidebarUserProfileCache
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.wxid) return null
    return {
      wxid: parsed.wxid,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      alias: parsed.alias,
      avatarUrl: parsed.avatarUrl
    }
  } catch {
    return null
  }
}

const writeSidebarUserProfileCache = (profile: SidebarUserProfile): void => {
  if (!profile.wxid) return
  try {
    const payload: SidebarUserProfileCache = {
      ...profile,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(SIDEBAR_USER_PROFILE_CACHE_KEY, JSON.stringify(payload))

    // 同时写入账号缓存池
    const accountsCache = readAccountProfilesCache()
    accountsCache[profile.wxid] = {
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      alias: profile.alias,
      updatedAt: Date.now()
    }
    window.localStorage.setItem(ACCOUNT_PROFILES_CACHE_KEY, JSON.stringify(accountsCache))
  } catch {
    // 忽略本地缓存失败，不影响主流程
  }
}

const readAccountProfilesCache = (): AccountProfilesCache => {
  try {
    const raw = window.localStorage.getItem(ACCOUNT_PROFILES_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

const normalizeAccountId = (value?: string | null): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

/* ─────────────────────────── Navigation Config ───────────────────────── */

interface NavItem {
  to: string
  icon: React.ElementType
  label: string
  badge?: string | null
}

/* ─────────────────────────── Component ────────────────────────────────── */

interface SidebarProps {
  collapsed: boolean
}

function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [activeExportTaskCount, setActiveExportTaskCount] = useState(0)
  const [userProfile, setUserProfile] = useState<SidebarUserProfile>({
    wxid: '',
    displayName: DEFAULT_DISPLAY_NAME
  })
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const accountCardWrapRef = useRef<HTMLDivElement | null>(null)
  const setLocked = useAppStore(state => state.setLocked)

  /* ── Side effects (unchanged logic) ─────────────────────────────── */

  useEffect(() => {
    window.electronAPI.auth.verifyEnabled().then(setAuthEnabled)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!isAccountMenuOpen) return
      const target = event.target as Node | null
      if (accountCardWrapRef.current && target && !accountCardWrapRef.current.contains(target)) {
        setIsAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isAccountMenuOpen])

  useEffect(() => {
    const unsubscribe = onExportSessionStatus((payload) => {
      const countFromPayload = typeof payload?.activeTaskCount === 'number'
        ? payload.activeTaskCount
        : Array.isArray(payload?.inProgressSessionIds)
          ? payload.inProgressSessionIds.length
          : 0
      const normalized = Math.max(0, Math.floor(countFromPayload))
      setActiveExportTaskCount(normalized)
    })

    requestExportSessionStatus()
    const timer = window.setTimeout(() => requestExportSessionStatus(), 120)

    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let loadSeq = 0

    const loadCurrentUser = async () => {
      const seq = ++loadSeq
      const patchUserProfile = (patch: Partial<SidebarUserProfile>) => {
        if (disposed || seq !== loadSeq) return
        setUserProfile(prev => {
          const next: SidebarUserProfile = {
            ...prev,
            ...patch
          }
          if (typeof next.displayName !== 'string' || next.displayName.length === 0) {
            next.displayName = DEFAULT_DISPLAY_NAME
          }
          writeSidebarUserProfileCache(next)
          return next
        })
      }

      try {
        const wxid = await configService.getMyWxid()
        if (disposed || seq !== loadSeq) return
        const resolvedWxidRaw = String(wxid || '').trim()
        const cleanedWxid = normalizeAccountId(resolvedWxidRaw)
        const resolvedWxid = cleanedWxid || resolvedWxidRaw

        if (!resolvedWxidRaw && !resolvedWxid) {
          window.localStorage.removeItem(SIDEBAR_USER_PROFILE_CACHE_KEY)
          patchUserProfile({
            wxid: '',
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          })
          return
        }

        setUserProfile((prev) => {
          if (prev.wxid === resolvedWxid) return prev
          const seeded: SidebarUserProfile = {
            wxid: resolvedWxid,
            displayName: DEFAULT_DISPLAY_NAME,
            alias: undefined,
            avatarUrl: undefined
          }
          writeSidebarUserProfileCache(seeded)
          return seeded
        })

        const wxidCandidates = new Set<string>([
          resolvedWxidRaw.toLowerCase(),
          resolvedWxid.trim().toLowerCase(),
          cleanedWxid.trim().toLowerCase()
        ].filter(Boolean))

        const normalizeName = (value?: string | null): string | undefined => {
          if (typeof value !== 'string') return undefined
          if (value.length === 0) return undefined
          const lowered = value.trim().toLowerCase()
          if (lowered === 'self') return undefined
          if (lowered.startsWith('wxid_')) return undefined
          if (wxidCandidates.has(lowered)) return undefined
          return value
        }

        const pickFirstValidName = (...candidates: Array<string | null | undefined>): string | undefined => {
          for (const candidate of candidates) {
            const normalized = normalizeName(candidate)
            if (normalized) return normalized
          }
          return undefined
        }

        // 并行获取名称和头像
        const [contactResult, avatarResult] = await Promise.allSettled([
          (async () => {
            const candidates = Array.from(new Set([resolvedWxidRaw, resolvedWxid, cleanedWxid].filter(Boolean)))
            for (const candidate of candidates) {
              const contact = await window.electronAPI.chat.getContact(candidate)
              if (contact?.remark || contact?.nickName || contact?.alias) {
                return contact
              }
            }
            return null
          })(),
          window.electronAPI.chat.getMyAvatarUrl()
        ])
        if (disposed || seq !== loadSeq) return

        const myContact = contactResult.status === 'fulfilled' ? contactResult.value : null
        const displayName = pickFirstValidName(
          myContact?.remark,
          myContact?.nickName,
          myContact?.alias
        ) || DEFAULT_DISPLAY_NAME
        const alias = normalizeName(myContact?.alias)

        patchUserProfile({
          wxid: resolvedWxid,
          displayName,
          alias,
          avatarUrl: avatarResult.status === 'fulfilled' && avatarResult.value.success
            ? avatarResult.value.avatarUrl
            : undefined
        })
      } catch (error) {
        console.error('加载侧边栏用户信息失败:', error)
      }
    }

    const cachedProfile = readSidebarUserProfileCache()
    if (cachedProfile) {
      setUserProfile(cachedProfile)
    }

    void loadCurrentUser()
    const onWxidChanged = () => { void loadCurrentUser() }
    const onWindowFocus = () => { void loadCurrentUser() }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadCurrentUser()
      }
    }
    window.addEventListener('wxid-changed', onWxidChanged as EventListener)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      loadSeq += 1
      window.removeEventListener('wxid-changed', onWxidChanged as EventListener)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  /* ── Derived ─────────────────────────────────────────────────────── */

  const getAvatarLetter = (name: string): string => {
    if (!name) return '微'
    const visible = name.trim()
    return (visible && [...visible][0]) || '微'
  }

  const openSettingsFromAccountMenu = () => {
    setIsAccountMenuOpen(false)
    navigate('/settings', {
      state: {
        backgroundLocation: location
      }
    })
  }

  const openAccountManagement = () => {
    setIsAccountMenuOpen(false)
    navigate('/account-management')
  }

  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }

  const exportTaskBadge = activeExportTaskCount > 99 ? '99+' : `${activeExportTaskCount}`

  /* ── Navigation items ────────────────────────────────────────────── */

  const navItems: NavItem[] = [
    { to: '/home', icon: Home, label: '首页' },
    { to: '/chat', icon: MessageSquare, label: '聊天' },
    { to: '/sns', icon: Aperture, label: '朋友圈' },
    { to: '/contacts', icon: UserCircle, label: '通讯录' },
    { to: '/resources', icon: FolderClosed, label: '资源浏览' },
    { to: '/analytics', icon: BarChart3, label: '聊天分析' },
    { to: '/annual-report', icon: FileText, label: '年度报告' },
    { to: '/footprint', icon: Footprints, label: '我的足迹' },
    {
      to: '/export', icon: Download, label: '导出',
      badge: activeExportTaskCount > 0 ? exportTaskBadge : null
    },
    { to: '/backup', icon: ArchiveRestore, label: '数据库备份' },
  ]

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <aside
      className={cn(
        'flex flex-col border-r border-border bg-surface-secondary',
        'transition-[width] duration-250 ease-in-out shrink-0 overflow-hidden',
        collapsed ? 'w-[var(--spacing-sidebar-collapsed)]' : 'w-[var(--spacing-sidebar)]'
      )}
    >
      {/* Navigation */}
      <nav className={cn(
        'flex-1 flex flex-col gap-0.5 overflow-y-auto scrollbar-thin',
        'pt-2',
        collapsed ? 'px-2' : 'px-3'
      )}>
        {navItems.map((item) => {
          const Icon = item.icon
          const active = isActive(item.to)

          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg no-underline',
                'transition-all duration-200 whitespace-nowrap relative',
                'border-none bg-transparent cursor-pointer font-[inherit]',
                collapsed ? 'justify-center px-2.5 py-2.5' : 'px-3 py-2.5',
                active
                  ? 'bg-accent text-on-accent'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text'
              )}
            >
              <span className="flex items-center justify-center w-5 h-5 shrink-0 relative">
                <Icon size={18} />
                {/* Badge on icon when collapsed */}
                {collapsed && item.badge && (
                  <span className={cn(
                    'absolute -top-1.5 -right-2.5',
                    'min-w-4 h-4 px-1 rounded-full',
                    'bg-[#ff3b30] text-white text-[10px] font-bold',
                    'inline-flex items-center justify-center leading-none',
                    'shadow-[0_0_0_2px_var(--bg-secondary)]'
                  )}>
                    {item.badge}
                  </span>
                )}
              </span>
              {!collapsed && (
                <>
                  <span className="text-sm font-medium">{item.label}</span>
                  {/* Badge when expanded */}
                  {item.badge && (
                    <span className={cn(
                      'ml-auto min-w-5 h-5 px-1.5 rounded-full',
                      'bg-[#ff3b30] text-white text-[11px] font-bold',
                      'inline-flex items-center justify-center leading-none',
                      'shadow-[0_0_0_2px_rgba(255,59,48,0.18)]'
                    )}>
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Footer: Lock + User Card */}
      <div className={cn(
        'border-t border-border pt-2.5 mt-1 flex flex-col gap-0.5',
        collapsed ? 'px-2' : 'px-3'
      )}>
        {/* Lock button */}
        <button
          className={cn(
            'flex items-center gap-3 rounded-lg',
            'transition-all duration-200 whitespace-nowrap',
            'border-none bg-transparent cursor-pointer font-[inherit]',
            'text-text-secondary hover:bg-surface-hover hover:text-text',
            collapsed ? 'justify-center px-2.5 py-2.5' : 'px-3 py-2.5'
          )}
          onClick={() => {
            if (authEnabled) {
              setLocked(true)
              return
            }
            navigate('/settings', {
              state: {
                initialTab: 'security',
                backgroundLocation: location
              }
            })
          }}
          title={collapsed ? (authEnabled ? '锁定' : '未锁定') : undefined}
        >
          <span className="flex items-center justify-center w-5 h-5 shrink-0">
            {authEnabled ? <Lock size={18} /> : <LockOpen size={18} />}
          </span>
          {!collapsed && (
            <span className="text-sm font-medium">
              {authEnabled ? '锁定' : '未锁定'}
            </span>
          )}
        </button>

        {/* User card */}
        <div className="relative pb-2" ref={accountCardWrapRef}>
          {/* Account popup menu */}
          <div
            className={cn(
              'absolute left-0 right-auto bottom-[calc(100%+6px)]',
              'min-w-full z-[12]',
              'border border-border rounded-xl',
              'bg-[var(--bg-secondary-solid,var(--bg-primary))]',
              'flex flex-col gap-1 p-1.5',
              'shadow-[0_8px_20px_rgba(15,23,42,0.12)]',
              'transition-all duration-200 origin-bottom',
              isAccountMenuOpen
                ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto'
                : 'opacity-0 scale-95 translate-y-2 pointer-events-none'
            )}
            role="menu"
            aria-label="账号菜单"
          >
            <button
              className={cn(
                'w-full border-none rounded-lg bg-transparent',
                'text-text px-2.5 py-2 flex items-center gap-2',
                'text-[13px] font-medium cursor-pointer text-left',
                'transition-colors duration-200',
                'hover:bg-surface-tertiary'
              )}
              onClick={openAccountManagement}
              type="button"
              role="menuitem"
            >
              <Users size={14} />
              <span>账号管理</span>
            </button>
            <button
              className={cn(
                'w-full border-none rounded-lg bg-transparent',
                'text-text px-2.5 py-2 flex items-center gap-2',
                'text-[13px] font-medium cursor-pointer text-left',
                'transition-colors duration-200',
                'hover:bg-surface-tertiary'
              )}
              onClick={openSettingsFromAccountMenu}
              type="button"
              role="menuitem"
            >
              <Settings size={14} />
              <span>设置</span>
            </button>
          </div>

          {/* User card trigger */}
          <div
            className={cn(
              'w-full px-2.5 py-2 border border-border rounded-xl',
              'bg-surface-secondary flex items-center gap-2.5',
              'min-h-[52px] cursor-pointer select-none',
              'transition-all duration-200',
              'hover:border-accent/30 hover:bg-surface-tertiary',
              isAccountMenuOpen && 'border-accent/40 shadow-[0_0_0_2px_var(--primary-light)]',
              collapsed && 'px-0 justify-center'
            )}
            title={collapsed ? `${userProfile.displayName}${(userProfile.alias) ? `\n${userProfile.alias}` : ''}` : undefined}
            onClick={() => setIsAccountMenuOpen(prev => !prev)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setIsAccountMenuOpen(prev => !prev)
              }
            }}
          >
            {/* Avatar */}
            <div className={cn(
              'w-8 h-8 rounded-lg overflow-hidden shrink-0',
              'bg-gradient-to-br from-accent to-accent-hover',
              'flex items-center justify-center'
            )}>
              {userProfile.avatarUrl ? (
                <img src={userProfile.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-on-accent text-xs font-semibold">
                  {getAvatarLetter(userProfile.displayName)}
                </span>
              )}
            </div>

            {/* Meta & caret — hidden when collapsed */}
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-text font-semibold truncate">
                    {userProfile.displayName || DEFAULT_DISPLAY_NAME}
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-muted truncate">
                    {userProfile.alias || DEFAULT_SUBTITLE}
                  </div>
                </div>
                <span className={cn(
                  'text-text-muted inline-flex transition-transform duration-200',
                  isAccountMenuOpen && 'rotate-180 text-text-secondary'
                )}>
                  <ChevronUp size={14} />
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
