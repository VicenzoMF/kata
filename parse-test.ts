import ts from 'typescript'

const code = `
const a = 1 as never;
const b = 2 as unknown as string;
const c = 3 as unknown;
`

const sf = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true)
const visit = (node: ts.Node) => {
  if (ts.isAsExpression(node)) {
    console.log(
      'AsExpression type:',
      node.type.kind === ts.SyntaxKind.NeverKeyword
        ? 'never'
        : node.type.kind === ts.SyntaxKind.UnknownKeyword
          ? 'unknown'
          : 'other',
    )
  }
  ts.forEachChild(node, visit)
}
visit(sf)
