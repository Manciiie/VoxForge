// Les 99 langues reconnues par Whisper (code → nom en français)
window.LANGUAGES = {
  af: 'Afrikaans', sq: 'Albanais', de: 'Allemand', am: 'Amharique', en: 'Anglais', ar: 'Arabe', hy: 'Arménien',
  as: 'Assamais', az: 'Azéri', ba: 'Bachkir', eu: 'Basque', bn: 'Bengali', be: 'Biélorusse', my: 'Birman',
  bs: 'Bosniaque', br: 'Breton', bg: 'Bulgare', yue: 'Cantonais', ca: 'Catalan', zh: 'Chinois (mandarin)',
  ko: 'Coréen', ht: 'Créole haïtien', hr: 'Croate', da: 'Danois', es: 'Espagnol', et: 'Estonien', fo: 'Féroïen',
  fi: 'Finnois', fr: 'Français', gl: 'Galicien', cy: 'Gallois', ka: 'Géorgien', el: 'Grec', gu: 'Gujarati',
  ha: 'Haoussa', haw: 'Hawaïen', he: 'Hébreu', hi: 'Hindi', hu: 'Hongrois', id: 'Indonésien', is: 'Islandais',
  it: 'Italien', ja: 'Japonais', jw: 'Javanais', kn: 'Kannada', kk: 'Kazakh', km: 'Khmer', lo: 'Lao', la: 'Latin',
  lv: 'Letton', ln: 'Lingala', lt: 'Lituanien', lb: 'Luxembourgeois', mk: 'Macédonien', ms: 'Malais',
  ml: 'Malayalam', mg: 'Malgache', mt: 'Maltais', mi: 'Maori', mr: 'Marathi', mn: 'Mongol', nl: 'Néerlandais',
  ne: 'Népalais', no: 'Norvégien', nn: 'Norvégien (nynorsk)', oc: 'Occitan', ur: 'Ourdou', uz: 'Ouzbek',
  ps: 'Pachto', pa: 'Pendjabi', fa: 'Persan', pl: 'Polonais', pt: 'Portugais', ro: 'Roumain', ru: 'Russe',
  sa: 'Sanskrit', sr: 'Serbe', sn: 'Shona', sd: 'Sindhi', si: 'Cingalais', sk: 'Slovaque', sl: 'Slovène',
  so: 'Somali', su: 'Soundanais', sv: 'Suédois', sw: 'Swahili', tg: 'Tadjik', tl: 'Tagalog', ta: 'Tamoul',
  tt: 'Tatar', cs: 'Tchèque', te: 'Télougou', th: 'Thaï', bo: 'Tibétain', tk: 'Turkmène', tr: 'Turc',
  uk: 'Ukrainien', vi: 'Vietnamien', yi: 'Yiddish', yo: 'Yoruba',
};
window.LANG_FLAGS = {
  fr: '🇫🇷', en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', nl: '🇳🇱', ru: '🇷🇺', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷',
  ar: '🇸🇦', tr: '🇹🇷', pl: '🇵🇱', uk: '🇺🇦', sv: '🇸🇪', no: '🇳🇴', da: '🇩🇰', fi: '🇫🇮', el: '🇬🇷', he: '🇮🇱', hi: '🇮🇳',
  vi: '🇻🇳', th: '🇹🇭', id: '🇮🇩', ro: '🇷🇴', cs: '🇨🇿', hu: '🇭🇺', bg: '🇧🇬', hr: '🇭🇷', sr: '🇷🇸', fa: '🇮🇷',
};
window.langName = (code) => (code && window.LANGUAGES[code]) || (code ? code.toUpperCase() : '—');
