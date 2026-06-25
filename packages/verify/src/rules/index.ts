/** The ordered set of rules `kata verify` runs. */
import type { Rule } from '../types'

import { contextKeyNotRegistered } from './context-key-not-registered'
import { inlineSchema } from './inline-schema'
import { jwtAuthProvidesSlot } from './jwt-auth-provides-slot'
import { middlewareProvidesMismatch } from './middleware-provides-mismatch'
import { noRouteWithoutInputSchema } from './no-route-without-input-schema'
import { noRouteWithoutOutputSchema } from './no-route-without-output-schema'
import { scopedSlotNotProvided } from './scoped-slot-not-provided'

export { contextKeyNotRegistered } from './context-key-not-registered'
export { inlineSchema } from './inline-schema'
export { jwtAuthProvidesSlot } from './jwt-auth-provides-slot'
export { middlewareProvidesMismatch } from './middleware-provides-mismatch'
export { noRouteWithoutInputSchema } from './no-route-without-input-schema'
export { noRouteWithoutOutputSchema } from './no-route-without-output-schema'
export { scopedSlotNotProvided } from './scoped-slot-not-provided'

export const rules: readonly Rule[] = [
  noRouteWithoutOutputSchema,
  noRouteWithoutInputSchema,
  inlineSchema,
  contextKeyNotRegistered,
  scopedSlotNotProvided,
  middlewareProvidesMismatch,
  jwtAuthProvidesSlot,
]
