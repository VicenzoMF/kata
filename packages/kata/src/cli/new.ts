import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  renderModuleHurl,
  renderModuleRoute,
  renderModuleSchema,
  renderModuleService,
  renderModuleTest,
} from './generators'

export type NewOptions = {
  /** Domain name for the new module. */
  domain: string
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string
  /** Overwrite existing files instead of skipping them. */
  force?: boolean
}

export type FileStatus = 'created' | 'overwritten' | 'skipped'

export type GeneratedFile = {
  /** Path relative to the project root. */
  path: string
  status: FileStatus
}

export type NewResult = {
  /** Absolute project root the files were written under. */
  cwd: string
  /** The domain that was generated. */
  domain: string
  files: readonly GeneratedFile[]
}

type Target = {
  path: string
  render: () => string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeTarget(cwd: string, force: boolean, target: Target): Promise<GeneratedFile> {
  const absolute = join(cwd, target.path)
  const present = await exists(absolute)

  if (present && !force) {
    return { path: target.path, status: 'skipped' }
  }

  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, target.render(), 'utf8')
  return { path: target.path, status: present ? 'overwritten' : 'created' }
}

export async function createModule(options: NewOptions): Promise<NewResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const force = options.force ?? false
  const domain = options.domain

  const targets: readonly Target[] = [
    { path: `src/modules/${domain}/${domain}.route.ts`, render: () => renderModuleRoute(domain) },
    {
      path: `src/modules/${domain}/${domain}.service.ts`,
      render: () => renderModuleService(domain),
    },
    { path: `src/modules/${domain}/${domain}.schema.ts`, render: () => renderModuleSchema(domain) },
    { path: `src/modules/${domain}/${domain}.test.ts`, render: () => renderModuleTest(domain) },
    { path: `src/modules/${domain}/${domain}.hurl`, render: () => renderModuleHurl(domain) },
  ]

  const files = await Promise.all(targets.map((target) => writeTarget(cwd, force, target)))
  return { cwd, domain, files }
}
