import { useEffect, useState } from 'react'
import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TitleBarProps {
  title?: string
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  showWindowControls?: boolean
  customControls?: React.ReactNode
  showLogo?: boolean
}

function TitleBar({
  title,
  sidebarCollapsed = false,
  onToggleSidebar,
  showWindowControls = true,
  customControls,
  showLogo = true
}: TitleBarProps = {}) {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!showWindowControls) return

    void window.electronAPI.window.isMaximized().then(setIsMaximized).catch(() => {
      setIsMaximized(false)
    })

    return window.electronAPI.window.onMaximizeStateChanged((maximized) => {
      setIsMaximized(maximized)
    })
  }, [showWindowControls])

  return (
    <div
      className={cn(
        'h-[var(--spacing-titlebar)] flex items-center justify-between',
        'px-4 border-b border-border drag shrink-0',
        'bg-surface-secondary relative z-[2101]',
        'select-none'
      )}
    >
      {/* Left: Brand + sidebar toggle */}
      <div className="inline-flex items-center gap-2">
        {showLogo && (
          <img
            src="./logo.png"
            alt="WeFlow"
            className="w-5 h-5 object-contain"
          />
        )}
        <span className="text-[15px] font-medium text-text-secondary antialiased">
          {title || 'WeFlow'}
        </span>
        {onToggleSidebar ? (
          <button
            type="button"
            className={cn(
              'w-7 h-7 p-0 border-none rounded-lg',
              'bg-transparent text-text-muted',
              'inline-flex items-center justify-center cursor-pointer',
              'transition-colors duration-200 no-drag',
              'hover:bg-surface-tertiary hover:text-text'
            )}
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>

      {/* Center: custom controls */}
      {customControls}

      {/* Right: window controls */}
      {showWindowControls ? (
        <div className="inline-flex items-center gap-1.5 no-drag">
          <button
            type="button"
            className={cn(
              'w-7 h-7 p-0 border-none rounded-lg',
              'bg-transparent text-text-muted',
              'inline-flex items-center justify-center cursor-pointer',
              'transition-colors duration-200',
              'hover:bg-surface-tertiary hover:text-text'
            )}
            aria-label="最小化"
            title="最小化"
            onClick={() => window.electronAPI.window.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className={cn(
              'w-7 h-7 p-0 border-none rounded-lg',
              'bg-transparent text-text-muted',
              'inline-flex items-center justify-center cursor-pointer',
              'transition-colors duration-200',
              'hover:bg-surface-tertiary hover:text-text'
            )}
            aria-label={isMaximized ? '还原' : '最大化'}
            title={isMaximized ? '还原' : '最大化'}
            onClick={() => window.electronAPI.window.maximize()}
          >
            {isMaximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className={cn(
              'w-7 h-7 p-0 border-none rounded-lg',
              'bg-transparent text-text-muted',
              'inline-flex items-center justify-center cursor-pointer',
              'transition-colors duration-200',
              'hover:bg-[#e5484d] hover:text-white'
            )}
            aria-label="关闭"
            title="关闭"
            onClick={() => window.electronAPI.window.close()}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default TitleBar
