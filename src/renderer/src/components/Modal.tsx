import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  title: ReactNode
  className?: string
  onClose(): void
  footer?: ReactNode
  children: ReactNode
}

/** Open modals, innermost last: Escape closes only the top one (e.g. Export on top of Settings). */
const openModals: symbol[] = []

export function Modal({ title, className, onClose, footer, children }: Props) {
  // Latest onClose without re-registering: re-registering on every render would move this modal to the top of the stack.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = Symbol('modal')
    openModals.push(id)
    // Take keyboard focus from whatever is behind (e.g. the query editor), unless a field inside already has it.
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openModals[openModals.length - 1] !== id) return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    // Capture phase: the Monaco editor would otherwise swallow Escape before it reaches us.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      openModals.splice(openModals.indexOf(id), 1)
    }
  }, [])

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={dialogRef}>
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
