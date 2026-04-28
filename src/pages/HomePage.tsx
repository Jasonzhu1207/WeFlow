import { Archive, BarChart3, Database, MessageSquare } from 'lucide-react'
import './HomePage.scss'

const highlights = [
  { icon: MessageSquare, label: '聊天记录', value: '本地读取' },
  { icon: BarChart3, label: '分析视图', value: '轻量呈现' },
  { icon: Archive, label: '导出备份', value: '保持原流程' },
  { icon: Database, label: '数据处理', value: '不离开本机' }
]

function HomePage() {
  return (
    <div className="home-page">
      <section className="home-hero" aria-label="WeFlow">
        <div className="home-kicker">LOCAL FIRST WECHAT WORKSPACE</div>
        <h1 className="hero-title">WeFlow</h1>
        <p className="hero-subtitle">每一条消息的背后，都藏着一段温暖的时光。</p>
        <div className="home-highlight-grid">
          {highlights.map((item) => (
            <div className="home-highlight" key={item.label}>
              <item.icon size={18} />
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export default HomePage
