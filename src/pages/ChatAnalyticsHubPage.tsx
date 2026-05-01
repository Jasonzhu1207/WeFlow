import { ArrowRight, BarChart3, MessageSquare, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

function ChatAnalyticsHubPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-[860px] flex flex-col items-center text-center animate-slide-up">
        {/* Badge */}
        <div className={cn(
          'inline-flex items-center gap-2 px-3.5 py-2',
          'rounded-full bg-accent-light text-accent',
          'text-[13px] font-semibold'
        )}>
          <BarChart3 size={16} />
          <span>聊天分析</span>
        </div>

        {/* Title */}
        <h1 className="mt-5 mb-3 text-[32px] font-bold leading-tight text-text">
          选择你要进入的分析视角
        </h1>
        <p className="max-w-[620px] mb-8 text-text-secondary text-[15px] leading-relaxed">
          私聊分析更适合看好友聊天统计和趋势，群聊分析则用于查看群成员、发言排行和活跃时段。
        </p>

        {/* Cards Grid */}
        <div className="w-full grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
          {/* Private Chat Card */}
          <button
            type="button"
            className={cn(
              'group flex flex-col items-start text-left gap-3.5',
              'min-h-[260px] p-7',
              'border border-border rounded-2xl',
              'bg-surface-card text-text',
              'cursor-pointer transition-all duration-200',
              'hover:-translate-y-1 hover:border-success/35',
              'hover:shadow-[0_20px_36px_rgba(7,193,96,0.1)]'
            )}
            onClick={() => navigate('/analytics/private')}
          >
            <div className={cn(
              'w-[52px] h-[52px] rounded-2xl',
              'flex items-center justify-center',
              'bg-success/12 text-success'
            )}>
              <MessageSquare size={24} />
            </div>
            <div className="w-full flex items-center justify-between gap-3">
              <h2 className="m-0 text-2xl font-bold leading-tight">私聊分析</h2>
              <ArrowRight size={18} className="text-text-muted group-hover:text-success transition-colors" />
            </div>
            <p className="m-0 text-text-secondary text-sm leading-relaxed">
              查看好友聊天统计、消息趋势、活跃时段与联系人排名。
            </p>
            <span className="mt-auto text-accent text-[13px] font-semibold">
              进入私聊分析
            </span>
          </button>

          {/* Group Chat Card */}
          <button
            type="button"
            className={cn(
              'group flex flex-col items-start text-left gap-3.5',
              'min-h-[260px] p-7',
              'border border-border rounded-2xl',
              'bg-surface-card text-text',
              'cursor-pointer transition-all duration-200',
              'hover:-translate-y-1 hover:border-[#1877f2]/35',
              'hover:shadow-[0_20px_36px_rgba(24,119,242,0.1)]'
            )}
            onClick={() => navigate('/analytics/group')}
          >
            <div className={cn(
              'w-[52px] h-[52px] rounded-2xl',
              'flex items-center justify-center',
              'bg-[#1877f2]/12 text-[#1877f2]'
            )}>
              <Users size={24} />
            </div>
            <div className="w-full flex items-center justify-between gap-3">
              <h2 className="m-0 text-2xl font-bold leading-tight">群聊分析</h2>
              <ArrowRight size={18} className="text-text-muted group-hover:text-[#1877f2] transition-colors" />
            </div>
            <p className="m-0 text-text-secondary text-sm leading-relaxed">
              查看群成员信息、发言排行、活跃时段和媒体内容统计。
            </p>
            <span className="mt-auto text-accent text-[13px] font-semibold">
              进入群聊分析
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default ChatAnalyticsHubPage
