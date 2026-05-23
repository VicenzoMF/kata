import type { z } from 'zod'

export type FieldIssue = {
  path: string
  message: string
  code: string
  expected?: unknown
  received?: unknown
}

export function formatZodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => {
    const out: FieldIssue = {
      path: pathToDotNotation(issue.path),
      message: issue.message,
      code: issue.code,
    }
    if ('expected' in issue && issue.expected !== undefined) out.expected = issue.expected
    if ('received' in issue && issue.received !== undefined) out.received = issue.received
    return out
  })
}

function pathToDotNotation(path: ReadonlyArray<string | number>): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else if (out === '') {
      out = segment
    } else {
      out += `.${segment}`
    }
  }
  return out
}
