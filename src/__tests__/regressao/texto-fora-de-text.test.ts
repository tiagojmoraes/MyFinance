/**
 * v88 (BUG) — NENHUM TEXTO FORA DE <Text> (qualquer tela).
 *
 * O React Native avisa no terminal:
 *   "ERROR Warning: Text strings must be rendered within a <Text> component."
 * quando uma string (ou número) é renderizada como FILHO de um elemento que
 * não é <Text> (View, ScrollView, Pressable, Card, ...). O aviso aparece no
 * Metro e a tela pode até "quebrar" sem o usuário entender o motivo.
 *
 * Este teste varre TODAS as telas (app/**, src/components/**) com o
 * compilador do TypeScript e falha se existir texto fora de <Text>:
 *  · texto solto no JSX            → <View>texto</View>
 *  · string/número como expressão  → <View>{'texto'}</View> · <View>{n}</View>
 *  · template sem interpolação     → <View>{`texto`}</View>
 *  · ternário/&& com string        → <View>{x ? 'a' : 'b'}</View>
 *
 * Componentes que renderizam os filhos DENTRO de <Text> (SectionTitle) estão
 * na lista de exceções — se um novo for criado, ele entra na lista.
 *
 * v88: a varredura (TypeScript + Babel, 44 telas) NÃO achou nenhum caso no
 * app — este teste trava a regra para o warning não voltar em nenhuma tela
 * (Fluxo incluído).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Telas e componentes varridos. */
const DIRS = ['app', path.join('src', 'components')];

/** Elementos que aceitam texto como filho. */
const TEXT_HOSTS = new Set(['Text', 'TextInput']);

/** Componentes que renderizam os filhos DENTRO de <Text> (exceção). */
const TEXT_SAFE_COMPONENTS = new Set(['SectionTitle']);

function listTsx(dir: string): string[] {
  const out: string[] = [];
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const p = path.join(full, entry.name);
    if (entry.isDirectory()) out.push(...listTsx(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** O tipo da expressão é texto (string) ou número? (união também conta) */
function isTextualType(t: ts.Type | undefined): boolean {
  if (!t) return false;
  if (t.isUnion()) return t.types.some(isTextualType);
  if (t.flags & ts.TypeFlags.Any) return false;
  return (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) !== 0;
}

/** A expressão devolve texto de CERTEZA (literal), mesmo sem o compilador? */
function isLiteralText(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return isLiteralText(node.operand);
  if (ts.isParenthesizedExpression(node)) return isLiteralText(node.expression);
  if (ts.isAsExpression(node)) return isLiteralText(node.expression);
  if (ts.isConditionalExpression(node)) {
    return isLiteralText(node.whenTrue) || isLiteralText(node.whenFalse);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return isLiteralText(node.right);
  }
  return false;
}

describe('v88 — texto sempre dentro de <Text>', () => {
  let violations: string[] = [];

  beforeAll(() => {
    const files = DIRS.flatMap(listTsx);
    expect(files.length).toBeGreaterThan(10); // sanidade: as telas existem

    const program = ts.createProgram(files, {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
      esModuleInterop: true,
      strict: false,
      // não resolve os módulos (speed): os tipos importados viram "any" e os
      // literais do próprio arquivo continuam sendo detectados.
      noResolve: true,
      noLib: true,
      types: [],
    });
    const checker = program.getTypeChecker();

    for (const file of files) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      const rel = path.relative(ROOT, file);

      const checkChildren = (children: readonly ts.Node[], tag: string): void => {
        if (TEXT_HOSTS.has(tag) || TEXT_SAFE_COMPONENTS.has(tag)) return;
        for (const child of children) {
          if (ts.isJsxText(child)) {
            const raw = child.getText(sf).trim();
            if (raw.length > 0) {
              const line = sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1;
              violations.push(`${rel}:${line} — texto solto dentro de <${tag}>: ${JSON.stringify(raw.slice(0, 60))}`);
            }
            continue;
          }
          if (ts.isJsxExpression(child) && child.expression) {
            const expr = child.expression;
            const type = checker.getTypeAtLocation(expr);
            if (isTextualType(type) || isLiteralText(expr)) {
              const line = sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1;
              const resumo = child.getText(sf).replace(/\s+/g, ' ').slice(0, 70);
              violations.push(`${rel}:${line} — texto fora de <Text> dentro de <${tag}>: ${resumo}`);
            }
            continue;
          }
          if (ts.isJsxFragment(child)) checkChildren(child.children, tag);
        }
      };

      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node)) {
          checkChildren(node.children, node.openingElement.tagName.getText(sf));
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }, 120_000);

  test('nenhuma tela renderiza texto fora de <Text>', () => {
    expect(violations).toEqual([]);
  });
});
