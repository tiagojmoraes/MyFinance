/**
 * (v81) ARRANQUE ROBUSTO — desempenho e robustez da abertura do app.
 *
 * 1. ORDEM do boot (marker em services/index.ts): o `readyResolve()` — que
 *    libera a UI ("Preparando seus dados...") — vem ANTES da chamada de
 *    `runStartupRoutines` — as rotinas pesadas rodam em background, depois
 *    da 1ª tela (antes o boot esperava todas terminarem);
 * 2. runStartupRoutines (comportamento real, services falsos): roda TODAS as
 *    rotinas mesmo quando uma delas falha (falha isolada — antes um único
 *    try/catch pulava as demais) e na ORDEM definida;
 * 3. BOUNDARY GLOBAL de render: app/_layout.tsx monta <GlobalErrorBoundary>
 *    na raiz (cobre a carga E a árvore de telas) e o componente
 *    src/components/ErrorBoundary.tsx captura o erro (getDerivedStateFromError
 *    + componentDidCatch) e oferece o botão "Tentar de novo".
 */

import * as fs from 'fs';
import * as path from 'path';
import { runStartupRoutines } from '../../services';

const raiz = path.join(__dirname, '..', '..', '..');
const fonteServices = fs.readFileSync(path.join(raiz, 'src', 'services', 'index.ts'), 'utf8');
const fonteLayout = fs.readFileSync(path.join(raiz, 'app', '_layout.tsx'), 'utf8');
const fonteBoundary = fs.readFileSync(path.join(raiz, 'src', 'components', 'ErrorBoundary.tsx'), 'utf8');

describe('arranque — rotinas pesadas em background (origem v81 · 1)', () => {
  test('v88: o arranque NUNCA apaga os dados (a preferência "a cada abertura" foi removida)', () => {
    // v86: os dados persistiam por padrão; v88: a preferência foi REMOVIDA —
    // não existe mais limpeza automática no boot. Quem quiser, usa o botão
    // "Começar do zero agora" (Ajustes › Dados).
    expect(fonteServices).not.toContain("'zerar_ao_abrir'");
    expect(fonteServices).not.toContain('await resetUserData(driver)');
    expect(fonteServices).not.toContain('ensureMockData');
    expect(fonteLayout).toContain('Não foi possível preparar o banco de dados');
  });

  test('bootstrap libera a UI (readyResolve) ANTES das rotinas de fundo', () => {
    const posReady = fonteServices.indexOf('readyResolve();');
    const posRotinas = fonteServices.indexOf('void runStartupRoutines(');
    expect(posReady).toBeGreaterThanOrEqual(0);
    expect(posRotinas).toBeGreaterThanOrEqual(0);
    expect(posReady).toBeLessThan(posRotinas);
  });

  test('as 4 rotinas do arranque: falha em uma NÃO pula as demais (em ordem)', async () => {
    const chamadas: string[] = [];
    const svc = {
      recurrences: {
        runDueRecurrences: async () => {
          chamadas.push('due');
          throw new Error('boom na 1ª rotina');
        },
        runForecast: async () => {
          chamadas.push('forecast');
        },
      },
      transactions: {
        promoteDuePendings: async () => {
          chamadas.push('promote');
        },
      },
      savings: {
        generateForecast: async () => {
          chamadas.push('savings');
        },
      },
    } as unknown as Parameters<typeof runStartupRoutines>[0];

    await runStartupRoutines(svc);

    expect(chamadas).toEqual(['due', 'forecast', 'promote', 'savings']);
  });
});

describe('boundary global de render (origem v81 · 2)', () => {
  test('raiz do app (app/_layout.tsx) monta o GlobalErrorBoundary', () => {
    expect(fonteLayout).toContain('<GlobalErrorBoundary>');
  });

  test('layout NÃO repete mais as rotinas do arranque (só no bootstrap)', () => {
    expect(fonteLayout).not.toContain('runDueRecurrences');
    expect(fonteLayout).not.toContain('__lastForecastDate');
  });

  test('componente captura erro e oferece "Tentar de novo"', () => {
    expect(fonteBoundary).toContain('getDerivedStateFromError');
    expect(fonteBoundary).toContain('componentDidCatch');
    expect(fonteBoundary).toContain('Tentar de novo');
  });
});
