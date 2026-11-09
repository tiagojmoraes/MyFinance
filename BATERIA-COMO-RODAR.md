# Testes e cobertura

Execute `npm test` para rodar toda a bateria automatizada e verificar os limites
de cobertura dos serviços.

Para validar os tipos, execute `npm run typecheck`. Ambos os comandos também
rodam no GitHub Actions a cada push e pull request.

**Escopo:** Jest verifica os serviços e regras de negócio; não renderiza nem
automatiza todas as telas/navegações do app. Cobertura de serviços não garante
que todos os fluxos de interface foram exercitados no aparelho.
