/**
 * lib/toast — shim de compatibilidade na raiz (v20).
 *
 * As telas em app/ importam `../lib/toast` (e as rotas aninhadas,
 * `../../lib/toast` etc.). A implementação real vive em src/lib/toast.ts
 * (mesma usada pelos testes e pelo componente Toast). Este arquivo só
 * re-exporta tudo para que os dois caminhos resolvam para a MESMA fonte.
 */
export * from '../src/lib/toast';
