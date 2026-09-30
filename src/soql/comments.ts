/** A line comment: the line's first two characters are `//`. Salesforce doesn't support comments, so they never reach it. */
export const isCommentLine = (line: string): boolean => line.startsWith('//')

/**
 * Replace comment lines with spaces of the same length. Offsets and row/column positions stay identical, so
 * Salesforce error positions ("Row:3:Column:7") and editor offsets still line up with what the user sees.
 */
export function maskLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (isCommentLine(line) ? ' '.repeat(line.length) : line))
    .join('\n')
}

/** Split into the comment lines (in order) and the query without them. */
export function splitLineComments(text: string): { comments: string[]; body: string } {
  const comments: string[] = []
  const body: string[] = []
  for (const line of text.split('\n')) (isCommentLine(line.replace(/\r$/, '')) ? comments : body).push(line)
  return { comments, body: body.join('\n') }
}

/** Put comment lines back on top of a (re-formatted) query. */
export function withComments(comments: string[], body: string): string {
  return comments.length ? [...comments, body].join('\n') : body
}

/**
 * Ctrl+/ behaviour: if every non-blank line is a comment, remove the `//` (and one following space); otherwise
 * prepend `// ` to every non-blank line. Always at column 1, because only a leading `//` counts as a comment.
 */
export function toggleLineComments(lines: string[]): string[] {
  const content = lines.filter((l) => l.trim() !== '')
  if (content.length === 0) return lines.map((l) => `// ${l}`)
  const uncomment = content.every(isCommentLine)
  return lines.map((l) => {
    if (l.trim() === '') return l
    return uncomment ? l.replace(/^\/\/ ?/, '') : `// ${l}`
  })
}
