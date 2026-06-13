/** The ordered set of rules `kata verify` runs. */
import type { Rule } from '../types'

import { contextKeyNotRegistered } from './context-key-not-registered'
import { noRouteWithoutOutputSchema } from './no-route-without-output-schema'

export { contextKeyNotRegistered } from './context-key-not-registered'
export { noRouteWithoutOutputSchema } from './no-route-without-output-schema'

export const rules: readonly Rule[] = [noRouteWithoutOutputSchema, contextKeyNotRegistered]
