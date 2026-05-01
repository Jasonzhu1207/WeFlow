import { useNavigate } from 'react-router-dom'
import { BarChart2, History, RefreshCcw } from 'lucide-react'
import { useAnalyticsStore } from '../stores/analyticsStore'
import ChatAnalysisHeader from '../components/ChatAnalysisHeader'
import { cn } from '@/lib/utils'

function AnalyticsWelcomePage() {
    const navigate = useNavigate()
    const { lastLoadTime } = useAnalyticsStore()

    const handleLoadCache = () => {
        navigate('/analytics/private/view')
    }

    const handleNewAnalysis = () => {
        navigate('/analytics/private/view', { state: { forceRefresh: true } })
    }

    const formatLastTime = (ts: number | null) => {
        if (!ts) return '无记录'
        return new Date(ts).toLocaleString()
    }

    return (
        <div className="flex flex-col gap-4 min-h-full">
            <ChatAnalysisHeader currentMode="private" />

            <div className={cn(
                'flex flex-col flex-1 items-center justify-center',
                'min-h-0 px-10 py-10 rounded-2xl',
                'border border-border overflow-y-auto',
                'bg-[radial-gradient(circle_at_top,rgba(7,193,96,0.05),transparent_48%),var(--bg-primary)]',
                'animate-fade-in'
            )}>
                <div className="text-center max-w-[600px]">
                    {/* Icon */}
                    <div className={cn(
                        'w-20 h-20 mx-auto mb-6',
                        'bg-success/10 rounded-2xl',
                        'flex items-center justify-center text-success'
                    )}>
                        <BarChart2 size={40} />
                    </div>

                    <h1 className="text-[28px] font-semibold mb-3 text-text">私聊数据分析</h1>
                    <p className="text-text-secondary mb-10 text-base leading-relaxed">
                        WeFlow 可以分析你的好友聊天记录，生成详细的统计报表。<br />
                        你可以选择加载上次的分析结果，或者重新开始一次新的私聊分析。
                    </p>

                    {/* Action cards */}
                    <div className="grid grid-cols-2 gap-5 mt-5 max-[768px]:grid-cols-1">
                        <button
                            onClick={handleLoadCache}
                            className={cn(
                                'group flex flex-col items-center p-8',
                                'bg-surface-secondary border border-border rounded-xl',
                                'cursor-pointer text-center transition-all duration-200',
                                'hover:-translate-y-0.5 hover:border-success',
                                'hover:shadow-[0_4px_12px_rgba(7,193,96,0.1)]'
                            )}
                        >
                            <div className={cn(
                                'w-[50px] h-[50px] rounded-xl mb-4',
                                'bg-surface-tertiary flex items-center justify-center',
                                'text-text-secondary transition-all duration-200',
                                'group-hover:text-success group-hover:bg-success/10'
                            )}>
                                <History size={24} />
                            </div>
                            <h3 className="text-lg mb-2 text-text font-semibold">加载缓存</h3>
                            <span className="text-[13px] text-text-muted">
                                查看上次分析结果<br />(上次更新: {formatLastTime(lastLoadTime)})
                            </span>
                        </button>

                        <button
                            onClick={handleNewAnalysis}
                            className={cn(
                                'group flex flex-col items-center p-8',
                                'bg-surface-secondary border border-border rounded-xl',
                                'cursor-pointer text-center transition-all duration-200',
                                'hover:-translate-y-0.5 hover:border-success',
                                'hover:shadow-[0_4px_12px_rgba(7,193,96,0.1)]'
                            )}
                        >
                            <div className={cn(
                                'w-[50px] h-[50px] rounded-xl mb-4',
                                'bg-surface-tertiary flex items-center justify-center',
                                'text-text-secondary transition-all duration-200',
                                'group-hover:text-success group-hover:bg-success/10'
                            )}>
                                <RefreshCcw size={24} />
                            </div>
                            <h3 className="text-lg mb-2 text-text font-semibold">新的分析</h3>
                            <span className="text-[13px] text-text-muted">
                                重新扫描并计算数据<br />(可能需要几分钟)
                            </span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default AnalyticsWelcomePage
