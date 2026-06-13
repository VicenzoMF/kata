import { describe, expect, it } from 'vitest'

import { resolveOutputValidationMode } from './output-validation'

describe('resolveOutputValidationMode()', () => {
  it('prefers an explicit configured mode over everything else', () => {
    expect(resolveOutputValidationMode('off', { NODE_ENV: 'production' })).toBe('off')
    expect(resolveOutputValidationMode('strict', { KATA_OUTPUT_VALIDATION: 'log' })).toBe('strict')
  })

  it('uses KATA_OUTPUT_VALIDATION when no explicit mode is given', () => {
    expect(resolveOutputValidationMode(undefined, { KATA_OUTPUT_VALIDATION: 'log' })).toBe('log')
    expect(resolveOutputValidationMode(undefined, { KATA_OUTPUT_VALIDATION: 'off' })).toBe('off')
  })

  it('ignores an invalid KATA_OUTPUT_VALIDATION value and falls through to NODE_ENV', () => {
    expect(resolveOutputValidationMode(undefined, { KATA_OUTPUT_VALIDATION: 'bogus' })).toBe(
      'strict',
    )
    expect(
      resolveOutputValidationMode(undefined, {
        KATA_OUTPUT_VALIDATION: 'bogus',
        NODE_ENV: 'production',
      }),
    ).toBe('log')
  })

  it('derives log from NODE_ENV=production', () => {
    expect(resolveOutputValidationMode(undefined, { NODE_ENV: 'production' })).toBe('log')
  })

  it('derives strict from a non-production NODE_ENV', () => {
    expect(resolveOutputValidationMode(undefined, { NODE_ENV: 'development' })).toBe('strict')
    expect(resolveOutputValidationMode(undefined, { NODE_ENV: 'test' })).toBe('strict')
  })

  it('defaults to strict when the environment is empty', () => {
    expect(resolveOutputValidationMode(undefined, {})).toBe('strict')
  })
})
