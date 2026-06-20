// Templates for the `kata new <domain>` module generator (Epic #99 / Issue #102).
// These form the five-file module skeleton required by ADRs and the strict layout.

export function moduleRouteSource(domain: string): string {
  return `import { defineRoute } from '../../context'

import { ${domain}Action } from './${domain}.service'
import { ${capitalize(domain)}Schema } from './${domain}.schema'

export const ${domain}Route = defineRoute({
  method: 'GET',
  path: '/${domain}',
  input: {},
  output: ${capitalize(domain)}Schema,
  handler: () => ${domain}Action(),
})
`
}

export function moduleServiceSource(domain: string): string {
  return `import type { ${capitalize(domain)} } from './${domain}.schema'

export function ${domain}Action(): ${capitalize(domain)} {
  return { status: 'ok' }
}
`
}

export function moduleSchemaSource(domain: string): string {
  return `import { z } from 'zod'

export const ${capitalize(domain)}Schema = z.object({
  status: z.literal('ok'),
})

export type ${capitalize(domain)} = z.infer<typeof ${capitalize(domain)}Schema>
`
}

export function moduleTestSource(domain: string): string {
  return `import { describe, expect, it } from 'vitest'

import { ${domain}Action } from './${domain}.service'

describe('${domain}Action', () => {
  it('returns ok status', () => {
    expect(${domain}Action()).toEqual({ status: 'ok' })
  })
})
`
}

export function moduleHurlSource(domain: string): string {
  return `GET {{host}}/${domain}
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
`
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
