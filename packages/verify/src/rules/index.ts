/** The ordered set of rules `kata verify` runs. */
import type { Rule } from '../types'

import { contextKeyNotRegistered } from './context-key-not-registered'
import { inlineSchema } from './inline-schema'
import { middlewareProvidesMismatch } from './middleware-provides-mismatch'
import { noAdhocErrorShape } from './no-adhoc-error-shape'
import { noClass } from './no-class'
import { noDecorator } from './no-decorator'
import { noRawBoundaryCast } from './no-raw-boundary-cast'
import { noRouteWithoutInputSchema } from './no-route-without-input-schema'
import { noRouteWithoutOutputSchema } from './no-route-without-output-schema'
import { schemaFileNaming } from './schema-file-naming'
import { scopedReadOutsideRequest } from './scoped-read-outside-request'
import { scopedSlotNotProvided } from './scoped-slot-not-provided'

// Re-export the imported bindings for direct consumers; the same bindings feed
// the ordered `rules` array below.
export {
  contextKeyNotRegistered,
  inlineSchema,
  middlewareProvidesMismatch,
  noAdhocErrorShape,
  noClass,
  noDecorator,
  noRawBoundaryCast,
  noRouteWithoutInputSchema,
  noRouteWithoutOutputSchema,
  schemaFileNaming,
  scopedReadOutsideRequest,
  scopedSlotNotProvided,
}

export const rules: readonly Rule[] = [
  noRouteWithoutOutputSchema,
  noRouteWithoutInputSchema,
  inlineSchema,
  contextKeyNotRegistered,
  scopedSlotNotProvided,
  scopedReadOutsideRequest,
  middlewareProvidesMismatch,
  noAdhocErrorShape,
  noRawBoundaryCast,
  schemaFileNaming,
  noDecorator,
  noClass,
]
