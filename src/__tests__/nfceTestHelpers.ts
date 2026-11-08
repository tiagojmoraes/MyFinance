/** Helpers de teste v23 — reexporta os parsers NFC-e (evita import relativo confuso). */
export {
  sanitizeSefazUrl,
  isFirewallRejectionPage,
  looksLikeNfcePage as looksLikeNfceNoteHtml,
  listConsultUrls,
  extractAccessKey,
} from '../parsers/nfce';
