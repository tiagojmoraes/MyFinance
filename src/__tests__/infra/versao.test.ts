/**
 * (v80) TESTE DE VERSÃO — RELACIONAL, independente de número.
 *
 * Confere o ALINHAMENTO entre os lugares que carregam a versão:
 * package.json = package-lock.json (2 lugares) = app.json = título do
 * docs/CHANGELOG.md. Ao subir a versão NADA aqui se edita — se este teste
 * falhar, falta atualizar algum dos arquivos acima.
 */

import * as fs from 'fs';
import * as path from 'path';

const raiz = path.join(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')) as { version: string };
const lock = fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8');
const appJson = JSON.parse(fs.readFileSync(path.join(raiz, 'app.json'), 'utf8')) as { expo: { version: string } };
const changelog = fs.readFileSync(path.join(raiz, 'docs', 'CHANGELOG.md'), 'utf8');

describe('versão do projeto — alinhamento relacional', () => {
  test('package.json e app.json na MESMA versão, no formato X.Y.Z', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(appJson.expo.version).toBe(pkg.version);
  });

  test('package-lock.json carrega a versão nos 2 lugares (raiz e packages[""])', () => {
    const marca = `"version": "${pkg.version}"`;
    const primeiro = lock.indexOf(marca);
    expect(primeiro).toBeGreaterThanOrEqual(0);
    expect(lock.indexOf(marca, primeiro + 1)).toBeGreaterThanOrEqual(0);
  });

  test('docs/CHANGELOG.md abre com a seção da versão atual (mesmo major)', () => {
    const major = pkg.version.split('.')[0];
    expect(changelog).toMatch(new RegExp(`^## v${major}\\b`, 'm'));
  });
});
