import type { Issue, Rule } from '../types'

const NAME = 'kata/schema-file-naming'

export const schemaFileNaming = {
  name: NAME,
  description: 'domain module files are named <domain>.<suffix>',
  adr: 'ADR-0018',
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      // Only check files in src/modules/<domain>/
      const match = file.relPath.match(/^src\/modules\/([^/]+)\/([^/]+)$/)
      if (!match) continue

      const domain = match[1]
      const filename = match[2]

      if (!domain || !filename) continue

      const allowedNames = [
        `${domain}.route.ts`,
        `${domain}.service.ts`,
        `${domain}.schema.ts`,
        // Note: fs-walk excludes .test.ts and .d.ts, and .hurl is not a .ts
        // file, so <domain>.test.ts and <domain>.hurl never reach this rule —
        // but they are legal module files, so the message below lists them.
      ]

      if (!allowedNames.includes(filename)) {
        issues.push({
          rule: NAME,
          severity: 'error',
          file: file.relPath,
          line: 1,
          column: 1,
          message: `File ${filename} violates the naming convention. Expected one of: ${domain}.{route,service,schema,test}.ts or ${domain}.hurl`,
          why: 'ADR-0018: files within a domain module must be named <domain>.<suffix>. Ad-hoc file names dilute findability and introduce cognitive load.',
          fix: `Rename the file to match the ${domain} domain (e.g. ${domain}.schema.ts) or move it out of the domain module.`,
          example: {
            bad: `src/modules/${domain}/auth.schema.ts\nsrc/modules/${domain}/utils.ts`,
            good: `src/modules/${domain}/${domain}.schema.ts\nsrc/modules/${domain}/${domain}.service.ts`,
          },
        })
      }
    }
    return issues
  },
} satisfies Rule
