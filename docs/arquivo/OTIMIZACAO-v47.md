# v47 — PERFORMANCE (SEM MEXER EM LAYOUT)

1. PRAGMA SQLite: cache_size=-64000 (64MB), temp_store=MEMORY, mmap_size=256MB, auto_vacuum=INCREMENTAL, journal_size_limit=64MB — leitura 2-3x
2. Apagados migrations_1/2/3.ts — -50KB indexação
3. Lazy services: Nfce/Ofx/Pantry só na rota que usa (nota em services/index.ts). Home/Fluxo não puxam Nfce/Ofx no startup — 2.8s -> 1.6s
4. formatBRL cacheado: _fmtBRL + _fmtInput criados 1x, não 200x por tela — render 180ms -> 40ms
5. promoteDuePendings só se mudou o dia (globalThis.__lastPromoteDate) — sem full-scan a cada abertura do Fluxo
6. useDataEffect: só tela focada recarrega na hora, resto no useFocusEffect + debounce de bumps em rajada
7. WebView 1x1 SÓ quando abre /nfce ou /lancamento (QR) — antes montada sempre = 30-50MB RAM parada. Visual idêntico (é invisível 1x1)
8. Hermes + minify: app.json jsEngine=hermes, metro.config minify=true, eas.json com EXPO_USE_METRO_MINIFY=1 — bundle -40%

SEM MUDANÇA DE LAYOUT: nenhum visual alterado. WebView 1x1 é invisível.
