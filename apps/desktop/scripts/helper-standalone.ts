/** Dependency policy for the helper copied outside the installed application. */
import { isBuiltin } from 'node:module'
import ts from 'typescript'

/**
 * Reject external modules that cannot resolve beside only node.exe and helper.mjs.
 * @param source - Exact packaged helper JavaScript.
 * @returns Nothing; throws for nonbuiltin or computed external module references.
 */
export function assertStandaloneDesktopHelper(source: string): void {
  const file = ts.createSourceFile('helper.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const check = (specifier: ts.Node | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier) || !isBuiltin(specifier.text)) {
      throw new Error('desktop fork release: standalone helper contains a nonbuiltin external module')
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) check(node.moduleSpecifier)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) check(node.moduleSpecifier)
    else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve'))) {
      check(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
