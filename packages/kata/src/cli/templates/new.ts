// Templates for the `kata new <domain>` module generator (Epic #99 / Issue #102).
// These form the five-file module skeleton required by ADRs and the strict layout.
//
// Cut from the same cloth as the `greetings` example `kata init` ships
// (issue #214): a create/read pair — POST validates a body, GET validates a
// path param and 404s via `c.error` on a miss — rather than a single GET
// stub. It is the only generator output that exercises `c.error` with a
// status, a `params` schema, and the schema/service/route split working
// together, so a newcomer copies a shape that actually teaches the framework.

export function moduleRouteSource(domain: string): string {
  const cap = capitalize(domain)
  return `import { defineRoute } from '../../context'

import { Create${cap}BodySchema, ${cap}ParamsSchema, ${cap}Schema } from './${domain}.schema'
import { create${cap}, get${cap} } from './${domain}.service'

export const create${cap}Route = defineRoute({
  method: 'POST',
  path: '/${domain}',
  input: { body: Create${cap}BodySchema },
  output: ${cap}Schema,
  handler: (c) => create${cap}(c.input.body),
})

export const get${cap}Route = defineRoute({
  method: 'GET',
  path: '/${domain}/:id',
  input: { params: ${cap}ParamsSchema },
  output: ${cap}Schema,
  handler: (c) => {
    const record = get${cap}(c.input.params.id)
    if (!record) return c.error('not_found', '${cap} not found', { status: 404 })
    return record
  },
})
`
}

export function moduleServiceSource(domain: string): string {
  const cap = capitalize(domain)
  return `import type { Create${cap}Body, ${cap} } from './${domain}.schema'

const store = new Map<string, ${cap}>()

export function create${cap}(input: Create${cap}Body): ${cap} {
  const id = crypto.randomUUID()
  const record: ${cap} = { id, name: input.name }
  store.set(id, record)
  return record
}

export function get${cap}(id: string): ${cap} | null {
  return store.get(id) ?? null
}
`
}

export function moduleSchemaSource(domain: string): string {
  const cap = capitalize(domain)
  return `import { z } from 'zod'

export const Create${cap}BodySchema = z.object({
  name: z.string().min(1),
})

export const ${cap}ParamsSchema = z.object({
  id: z.string(),
})

export const ${cap}Schema = z.object({
  id: z.string(),
  name: z.string(),
})

export type Create${cap}Body = z.infer<typeof Create${cap}BodySchema>
export type ${cap} = z.infer<typeof ${cap}Schema>
`
}

export function moduleTestSource(domain: string): string {
  const cap = capitalize(domain)
  return `import { describe, expect, it } from 'vitest'

import { create${cap}, get${cap} } from './${domain}.service'

describe('${domain}.service', () => {
  it('creates a record with a generated id', () => {
    const record = create${cap}({ name: 'Ada' })
    expect(record.id.length).toBeGreaterThan(0)
    expect(record.name).toBe('Ada')
  })

  it('reads a created record back by id', () => {
    const created = create${cap}({ name: 'Linus' })
    expect(get${cap}(created.id)).toEqual(created)
  })

  it('returns null for an unknown id', () => {
    expect(get${cap}('does-not-exist')).toBeNull()
  })
})
`
}

export function moduleHurlSource(domain: string): string {
  return `# API E2E for the ${domain} module. Run with the server already listening:
#   pnpm start    # in another terminal
#   pnpm hurl

# Create a record, capture the returned id, then read it back.
POST {{host}}/${domain}
Content-Type: application/json
{ "name": "Ada" }
HTTP 200
[Captures]
${domain}_id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "Ada"

GET {{host}}/${domain}/{{${domain}_id}}
HTTP 200
[Asserts]
jsonpath "$.name" == "Ada"
`
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}
