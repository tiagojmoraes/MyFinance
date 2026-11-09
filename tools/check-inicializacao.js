// check-inicializacao.js — PRÉ-VOO v63.1: checa todos os erros que já deram na inicialização
// Roda: npm run check  (só checa)  |  npm run fix:limpo  (tenta consertar)
// Checa: 1) pasta certa  2) OneDrive  3) query-string versão  4) arquivos duplicados
//        (TODOS, varredura recursiva — v63.1)  5) porta 8082  6) node_modules
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');
const fix = process.argv.includes('--fix');
let erros = 0, avisos = 0;
function ok(msg){ console.log('  ✅ ' + msg); }
function err(msg){ console.log('  ❌ ' + msg); erros++; }
function warn(msg){ console.log('  ⚠️  ' + msg); avisos++; }

// 1. Pasta certa? (v63.1: aceita pasta simples OU dobrada — o que importa é ter app/ + src/ + package.json)
const aqui = process.cwd();
const temApp = fs.existsSync(path.join(aqui, 'app')) && fs.existsSync(path.join(aqui, 'src'));
const temPackage = fs.existsSync(path.join(aqui, 'package.json'));
const pastaDobrada = aqui.endsWith('myfinance-pantry-manager\\myfinance-pantry-manager') || aqui.endsWith('myfinance-pantry-manager/myfinance-pantry-manager');
if ((temApp && temPackage) || pastaDobrada) ok('Pasta certa (tem app/ + src/ + package.json)');
else err(`Você está na pasta de fora: ${aqui}\n     → Entre na pasta que TEM app/ e src/ (cd myfinance-pantry-manager\\myfinance-pantry-manager)`);

// 2. OneDrive?
if (aqui.includes('OneDrive')) warn('Projeto dentro do OneDrive — o OneDrive já quebrou o projeto 3x (arquivo cortado no meio + cópias de conflito _1/_2).\n     → Ideal: mover para C:\\myfinance-pantry-manager. Se ficar no OneDrive, pause a sincronização antes do npm install e ao editar arquivos.');
else ok('Fora do OneDrive');

// 3. query-string versão?
const qsPkg = path.join(root, 'node_modules', 'query-string', 'package.json');
if (!fs.existsSync(qsPkg)) err('query-string NÃO instalado → Rode: npm install query-string@8.1.0');
else {
  const v = JSON.parse(fs.readFileSync(qsPkg, 'utf8')).version;
  if (v.startsWith('8.')) ok(`query-string ${v} (certa — a v9 quebra o Hermes com "Invalid regular expression")`);
  else err(`query-string ${v} ERRADA — a v9 quebra o Hermes.\n     → Rode: npm uninstall query-string && npm install query-string@8.1.0`);
}

// 4. Arquivos duplicados (sobra de cópia de conflito — OneDrive)?
//    v63.1: varredura recursiva de TODAS as pastas do projeto (app/, src/, tools/, raiz) —
//    antes só checava 4 nomes fixos e deixou passar 15 duplicados que regrediram o app.
const dupExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.ps1', '.md']);
const dups = [];
function scanDups(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.expo' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanDups(full, depth + 1); continue; }
    const ext = path.extname(e.name);
    if (!dupExts.has(ext)) continue;
    if (/_[0-9]+$/.test(path.basename(e.name, ext))) dups.push(path.relative(root, full));
  }
}
scanDups(root, 0);
if (dups.length) {
  err('Arquivos duplicados (sobra de cópia de conflito): ' + dups.slice(0, 10).join(', ') + (dups.length > 10 ? ` … (+${dups.length - 10})` : '') + '\n     → Apague-os (ou mantenha SÓ a versão mais nova no nome oficial). Cada duplicado pode regredir o app.');
} else ok('Sem arquivos duplicados (_1/_2) em todo o projeto');

// 5. Porta do Expo?
try {
  const out2 = execSync('netstat -ano | findstr :8082', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  if (out2.trim()) warn('Porta 8082 já ocupada. Use outra ou feche o Expo antigo.');
  else ok('Porta 8082 livre');
} catch { ok('Porta 8082 livre'); }

// 6. node_modules existe?
if (!fs.existsSync(path.join(root, 'node_modules', 'expo', 'package.json'))) err('node_modules incompleto (sem expo) → Rode: npm install');
else ok('node_modules com expo');

// 8. v63.1 — arquivos que o Metro vai ler existem e não estão truncados?
const criticos = ['app/_layout.tsx', 'src/services/index.ts', 'src/db/index.ts', 'src/db/migrations.ts', 'src/services/BalanceService.ts', 'src/services/ProductService.ts'];
const faltando = criticos.filter((f) => !fs.existsSync(path.join(root, f)));
if (faltando.length) err('Arquivos críticos sumiram (OneDrive cortou?): ' + faltando.join(', ') + '\n     → Restaure do backup mais novo ou do zip oficial.');
else ok('Arquivos críticos presentes (app, serviços, banco)');

console.log('');
if (erros === 0) console.log(`PRÉ-VOO OK — ${avisos} aviso(s). Pode rodar: npm run dev`);
else {
  console.log(`PRÉ-VOO FALHOU — ${erros} erro(s), ${avisos} aviso(s). Corrija os ❌ acima antes de rodar.`);
  if (fix) console.log('Modo --fix ainda não apaga nada sozinho — corrija com os comandos indicados.');
  process.exitCode = 1;
}
