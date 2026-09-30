import { useEffect, type ReactNode } from 'react'

interface Props {
  title: ReactNode
  className?: string
  onClose(): void
  footer?: ReactNode
  children: ReactNode
}

export function Modal({ title, className, onClose, footer, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true">
        <header>
          {title}
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}
