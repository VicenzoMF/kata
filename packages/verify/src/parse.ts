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
