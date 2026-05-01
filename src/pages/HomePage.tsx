import { cn } from '@/lib/utils'

function HomePage() {
  return (
    <div className="h-full flex items-center justify-center relative overflow-hidden">
      {/* Subtle animated gradient blobs */}
      <div className="absolute inset-0 pointer-events-none opacity-40 blur-[80px]">
        <div
          className={cn(
            'absolute w-[400px] h-[400px] rounded-full',
            'bg-[rgba(var(--primary-rgb),0.2)]',
            '-top-24 -left-12',
            'animate-[blob_25s_infinite_alternate_ease-in-out]'
          )}
        />
        <div
          className={cn(
            'absolute w-[350px] h-[350px] rounded-full',
            'bg-[rgba(var(--primary-rgb),0.12)]',
            '-bottom-12 -right-12',
            'animate-[blob_30s_infinite_alternate_ease-in-out]',
            '[animation-delay:-5s]'
          )}
        />
      </div>

      {/* Hero content */}
      <div className="relative z-10 animate-[heroIn_0.8s_cubic-bezier(0.2,0.8,0.2,1)]">
        <div className="text-center">
          <h1
            className={cn(
              'text-[64px] font-extrabold m-0 mb-4 tracking-[-2px]',
              'bg-gradient-to-br from-accent to-[rgba(var(--primary-rgb),0.6)]',
              'bg-clip-text [-webkit-background-clip:text] [-webkit-text-fill-color:transparent]'
            )}
          >
            WeFlow
          </h1>
          <p className="text-lg text-text-secondary max-w-[520px] mx-auto leading-relaxed opacity-80">
            每一条消息的背后，都藏着一段温暖的时光
          </p>
        </div>
      </div>
    </div>
  )
}

export default HomePage
