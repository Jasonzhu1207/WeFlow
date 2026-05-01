import { ChevronDown, ChevronLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

export type ChatAnalysisMode = 'private' | 'group'

interface ChatAnalysisHeaderProps {
  currentMode: ChatAnalysisMode
  actions?: ReactNode
}

const MODE_CONFIG: Record<ChatAnalysisMode, { label: string; path: string }> = {
  private: {
    label: '私聊分析',
    path: '/analytics/private'
  },
  group: {
    label: '群聊分析',
    path: '/analytics/group'
  }
}

function ChatAnalysisHeader({ currentMode, actions }: ChatAnalysisHeaderProps) {
  const navigate = useNavigate()
  const currentLabel = MODE_CONFIG[currentMode].label
  const [menuOpen, setMenuOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const alternateMode = useMemo(
    () => (currentMode === 'private' ? 'group' : 'private'),
    [currentMode]
  )

  useEffect(() => {
    if (!menuOpen) return

    const handleClickOutside = (event: MouseEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [menuOpen])

  return (
    <div className="flex items-center justify-between gap-3 shrink-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm">
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1.5',
            'border-none rounded-lg bg-transparent',
            'text-text-secondary cursor-pointer',
            'transition-colors duration-200',
            'hover:bg-surface-tertiary hover:text-text'
          )}
          onClick={() => navigate('/analytics')}
        >
          <ChevronLeft size={16} />
          <span>聊天分析</span>
        </button>

        <span className="text-text-muted select-none">/</span>

        {/* Mode dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1.5',
              'border-none rounded-lg bg-transparent',
              'text-text font-medium cursor-pointer',
              'transition-colors duration-200',
              'hover:bg-surface-tertiary',
              menuOpen && 'bg-surface-tertiary'
            )}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <span>{currentLabel}</span>
            <ChevronDown
              size={14}
              className={cn(
                'transition-transform duration-200',
                menuOpen && 'rotate-180'
              )}
            />
          </button>

          {/* Dropdown menu */}
          <div
            className={cn(
              'absolute left-0 top-[calc(100%+4px)] z-20',
              'min-w-[140px] p-1 rounded-xl',
              'border border-border',
              'bg-[var(--bg-secondary-solid,var(--bg-primary))]',
              'shadow-[0_8px_20px_rgba(15,23,42,0.12)]',
              'transition-all duration-200 origin-top',
              menuOpen
                ? 'opacity-100 scale-100 pointer-events-auto'
                : 'opacity-0 scale-95 pointer-events-none'
            )}
            role="menu"
            aria-label="切换聊天分析类型"
          >
            <button
              type="button"
              role="menuitem"
              className={cn(
                'w-full border-none rounded-lg bg-transparent',
                'text-text px-3 py-2 text-[13px] font-medium',
                'cursor-pointer text-left',
                'transition-colors duration-200',
                'hover:bg-surface-tertiary'
              )}
              onClick={() => {
                setMenuOpen(false)
                navigate(MODE_CONFIG[alternateMode].path)
              }}
            >
              {MODE_CONFIG[alternateMode].label}
            </button>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export default ChatAnalysisHeader
