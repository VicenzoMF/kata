/**
 * Thin, typed helpers over the TypeScript compiler API. Every rule parses with
 * {@link parseSource} and walks with {@link forEachDescendant}; the shared
 * object-literal helpers below keep the AST-shape matching in one place.
 */
import ts from 'typescript'

/** Parse a single `.ts` source string into a full AST (parent pointers set). */
export function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 1-based line/column of a node's first token. */
export function positionOf(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return { line: line + 1, column: character + 1 }
}

/** Visit every descendant of `root` (excluding `root` itself), depth-first. */
export function forEachDescendant(root: ts.Node, visit: (node: ts.Node) => void): void {
  const recur = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, recur)
  }
  ts.forEachChild(root, recur)
}

/**
 * True when a call's callee is the bare identifier `name` (`name(...)`) or a
 * property access ending in `name` (`obj.name(...)`). Covers both the
 * destructured (`defineRoute`) and namespaced (`k.defineRoute`) call styles.
 */
export function isCalleeNamed(call: ts.CallExpression, name: string): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text === name
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === name
  return false
}

/** Static property name of an object-literal member, or `undefined` if dynamic. */
export function propertyName(member: ts.ObjectLiteralElementLike): string | undefined {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isShorthandPropertyAssignment(member) ||
    ts.isMethodDeclaration(member)
  ) {
    const name = member.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  }
  return undefined
}

/** Does the object literal statically declare a property named `key`? */
export function hasProperty(object: ts.ObjectLiteralExpression, key: string): boolean {
  return object.properties.some((member) => propertyName(member) === key)
}

/**
 * Does the object literal contain a spread (`...rest`)? A spread can inject
 * arbitrary keys, so presence-based rules must bail to avoid false positives.
 */
export function hasSpread(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((member) => ts.isSpreadAssignment(member))
}

/**
 * A function literal that can appear as a config value — `handler: (c) => ...`,
 * `handler: function (c) {}`, or the method shorthand `handler(c) {}`. Used by
 * rules that inspect middleware / route handler bodies.
 */
export type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

/** Strip `as const` / `satisfies T` / parenthesis wrappers from an expression. */
export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/**
 * The function-literal value of object-literal property `name` (an arrow,
 * function expression, or method shorthand). `undefined` when the property is
 * absent or its value is not a function literal — callers that inspect handler
 * bodies bail in that case.
 */
export function functionProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): FunctionLike | undefined {
  for (const member of object.properties) {
    if (ts.isMethodDeclaration(member) && propertyName(member) === name) return member
    if (ts.isPropertyAssignment(member) && propertyName(member) === name) {
      const value = unwrapExpression(member.initializer)
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
      return undefined
    }
  }
  return undefined
}

/** Name of a function's first parameter, or `undefined` if it is destructured or absent. */
export function firstParameterName(fn: FunctionLike): string | undefined {
  const first = fn.parameters[0]
  if (!first || !ts.isIdentifier(first.name)) return undefined
  return first.name.text
}

/**
 * The `provides` array-literal of a `defineMiddleware` config object literal:
 * `undefined` when there is no `provides` property, `null` when `provides` exists
 * but is not an array literal (an indeterminate shape), otherwise the literal.
 * Shared core of {@link declaredProvides} and {@link providesOf}.
 */
function providesArrayLiteral(
  config: ts.ObjectLiteralExpression,
): ts.ArrayLiteralExpression | null | undefined {
  for (const member of config.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== 'provides') continue
    const value = unwrapExpression(member.initializer)
    return ts.isArrayLiteralExpression(value) ? value : null
  }
  return undefined
}

/**
 * The string-literal keys in a config's `provides`, each paired with its node so
 * a rule can report the exact offending entry. Non-literal elements (a spread or
 * computed key) are skipped rather than fatal; an absent or non-array `provides`
 * yields `[]` (nothing provable). Contrast {@link providesOf}, which collapses
 * any indeterminacy to `null`.
 */
export function declaredProvides(
  config: ts.ObjectLiteralExpression,
): { key: string; node: ts.Node }[] {
  const array = providesArrayLiteral(config)
  if (!array) return [] // absent (undefined) or non-array (null) → nothing provable
  const out: { key: string; node: ts.Node }[] = []
  for (const element of array.elements) {
    if (ts.isStringLiteralLike(element)) out.push({ key: element.text, node: element })
  }
  return out
}

/**
 * A middleware's `provides` as a flat key set, or `null` when it cannot be fully
 * enumerated — a spread config, a non-array `provides`, or a non-literal element
 * (a spread or computed key) any of which could inject unknown keys. An absent
 * `provides` is the determinate empty set. Contrast {@link declaredProvides},
 * which keeps each key's node and tolerates non-literal elements.
 */
export function providesOf(call: ts.CallExpression): ReadonlySet<string> | null {
  const config = call.arguments[0]
  if (!config || !ts.isObjectLiteralExpression(config) || hasSpread(config)) return null
  const array = providesArrayLiteral(config)
  if (array === undefined) return new Set() // no `provides` property → provides nothing
  if (array === null) return null // present but not an array literal → indeterminate
  const keys = new Set<string>()
  for (const element of array.elements) {
    if (!ts.isStringLiteralLike(element)) return null // spread / computed → can't enumerate
    keys.add(element.text)
  }
  return keys
}
