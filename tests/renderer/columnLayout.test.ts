import { describe, expect, it } from 'vitest'
import { MIN_COLUMN_WIDTH, mergeColumnOrder, moveColumn, resizeWidth } from '../../src/renderer/src/columnLayout'

describe('mergeColumnOrder', () => {
  it('keeps the user order, appends new columns and drops missing ones', () => {
    expect(mergeColumnOrder(['Name', 'Id', 'Type'], ['Id', 'Name', 'Owner.Name'])).toEqual(['Name', 'Id', 'Owner.Name'])
    expect(mergeColumnOrder([], ['A', 'B'])).toEqual(['A', 'B'])
  })
})

describe('moveColumn', () => {
  const order = ['A', 'B', 'C', 'D']
  it('moves before or after the target', () => {
    expect(moveColumn(order, 'D', 'B', 'before')).toEqual(['A', 'D', 'B', 'C'])
    expect(moveColumn(order, 'A', 'C', 'after')).toEqual(['B', 'C', 'A', 'D'])
    expect(moveColumn(order, 'A', 'D', 'after')).toEqual(['B', 'C', 'D', 'A'])
  })
  it('ignores no-op and unknown moves', () => {
    expect(moveColumn(order, 'B', 'B', 'after')).toBe(order)
    expect(moveColumn(order, 'X', 'B', 'after')).toBe(order)
  })
})

describe('resizeWidth', () => {
  it('applies the drag delta with a minimum', () => {
    expect(resizeWidth(120, 30.4)).toBe(150)
    expect(resizeWidth(120, -500)).toBe(MIN_COLUMN_WIDTH)
  })
})
