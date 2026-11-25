// Makes desktop Node behave like the phone's cut-down build (no Intl, no
// TextDecoder/TextEncoder) so tests catch features the phone lacks.
delete globalThis.Intl;
delete globalThis.TextDecoder;
