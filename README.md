# MyFinance

App Expo/React Native para finanças pessoais, cartões, NFC-e e despensa.

- Instalar dependências: `npm ci`
- Iniciar: `npm start`
- Validar tipos: `npm run typecheck`
- Executar toda a bateria: `npm test`
- Histórico e versões: [docs/CHANGELOG.md](./docs/CHANGELOG.md)

`npm test` mede a cobertura dos serviços e aplica limites mínimos de 60% de
statements, 50% de branches, 65% de funções e 65% de linhas.

A bateria Jest não renderiza nem automatiza todas as telas e navegações nativas.
Esse limite cobre regras de negócio em serviços, não garante que todo fluxo de
interface funcione no aparelho.

O workflow do GitHub Actions executa typecheck, testes e os limites de cobertura
em cada push e pull request.
