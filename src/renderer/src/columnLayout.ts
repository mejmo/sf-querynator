/**
 * Column order after the result's columns change: keep the user's order for columns that still exist, append new ones
 * (e.g. a relationship column that first appears after "Load more"), drop missing ones.
 */
export function mergeColumnOrder(previous: string[], columns: string[]): string[] {
  const present = new Set(columns)
  const kept = previous.filter((c) => present.has(c))
  const known = new Set(kept)
  return [...kept, ...columns.filter((c) => !known.has(c))]
}

/** Move `column` so it lands right before or after `target`. */
export function moveColumn(order: string[], column: string, target: string, side: 'before' | 'after'): string[] {
  if (column === target || !order.includes(column) || !order.includes(target)) return order
  const without = order.filter((c) => c !== column)
  const index = without.indexOf(target) + (side === 'after' ? 1 : 0)
  return [...without.slice(0, index), column, ...without.slice(index)]
}

export const MIN_COLUMN_WIDTH = 50
export const MAX_AUTO_COLUMN_WIDTH = 420

/** Resized width, never below the minimum. */
export function resizeWidth(startWidth: number, dx: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + dx))
}
