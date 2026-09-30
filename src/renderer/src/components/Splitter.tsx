import { useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'

const STORAGE_KEY = 'qn.editorHeight'
const DEFAULT_HEIGHT = 260
const MIN_EDITOR = 80
/** Space always left for the toolbar and at least a few result rows. */
const MIN_BELOW = 180

function storedHeight(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY))
    return v > 0 ? v : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

/** Editor height controlled by a full-width horizontal divider; remembered across restarts. */
export function useEditorHeight() {
  const [height, setHeight] = useState(storedHeight)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(height))
    } catch {
      // storage unavailable: just don't remember it
    }
  }, [height])
  return [height, setHeight] as const
}

interface Props {
  /** The element whose height is being set (the editor wrapper) */
  target: RefObject<HTMLElement | null>
  /** The container both panes live in, for the maximum */
  container: RefObject<HTMLElement | null>
  onResize(height: number): void
}

export function Splitter({ target, container, onResize }: Props) {
  const start = (e: ReactMouseEvent) => {
    if (e.button !== 0 || !target.current) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = target.current.getBoundingClientRect().height
    const max = Math.max(MIN_EDITOR, (container.current?.getBoundingClientRect().height ?? 800) - MIN_BELOW)
    document.body.classList.add('row-resizing')
    const onMove = (ev: MouseEvent) => onResize(Math.round(Math.min(max, Math.max(MIN_EDITOR, startHeight + ev.clientY - startY))))
    const onUp = () => {
      document.body.classList.remove('row-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return <div className="splitter" role="separator" aria-orientation="horizontal" title="Drag to resize" onMouseDown={start} />
}
