/** The ordered set of rules `kata verify` runs. */
import type { Rule } from '../types'

import { contextKeyNotRegistered } from './context-key-not-registered'
import { inlineSchema } from './inline-schema'
import { jwtAuthProvidesSlot } from './jwt-auth-provides-slot'
import { middlewareProvidesMismatch } from './middleware-provides-mismatch'
import { noAdhocErrorShape } from './no-adhoc-error-shape'
import { noClass } from './no-class'
import { noDecorator } from './no-decorator'
import { noRawBoundaryCast } from './no-raw-boundary-cast'
import { noRouteWithoutInputSchema } from './no-route-without-input-schema'
import { noRouteWithoutOutputSchema } from './no-route-without-output-schema'
import { schemaFileNaming } from './schema-file-naming'
import { scopedSlotNotProvided } from './scoped-slot-not-provided'

export { contextKeyNotRegistered } from './context-key-not-registered'
export { inlineSchema } from './inline-schema'
export { jwtAuthProvidesSlot } from './jwt-auth-provides-slot'
export { middlewareProvidesMismatch } from './middleware-provides-mismatch'
export { noAdhocErrorShape } from './no-adhoc-error-shape'
export { noClass } from './no-class'
export { noDecorator } from './no-decorator'
export { noRawBoundaryCast } from './no-raw-boundary-cast'
export { noRouteWithoutInputSchema } from './no-route-without-input-schema'
export { noRouteWithoutOutputSchema } from './no-route-without-output-schema'
export { schemaFileNaming } from './schema-file-naming'
export { scopedSlotNotProvided } from './scoped-slot-not-provided'

export const rules: readonly Rule[] = [
  noRouteWithoutOutputSchema,
  noRouteWithoutInputSchema,
  inlineSchema,
  contextKeyNotRegistered,
  scopedSlotNotProvided,
  middlewareProvidesMismatch,
  jwtAuthProvidesSlot,
  noAdhocErrorShape,
  noRawBoundaryCast,
  schemaFileNaming,
  noDecorator,
  noClass,
]
