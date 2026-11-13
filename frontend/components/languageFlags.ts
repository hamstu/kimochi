/**
 * The flag pictures the language table names (`flag` in `ui/languages.ts`), from `circle-flags`
 * (MIT, NOTICE). Each file is imported by name so the build carries only these, never the whole
 * set: a glob over the package folder would bundle all 430. Vite inlines each (all are under
 * 4 kB) as a data URL.
 *
 * Keys are the table's names. A name with no country file is looked up among the package's
 * language flags (`language/<name>.svg`): Esperanto (`eo`) is one.
 */
import flag_jp from 'circle-flags/flags/jp.svg'
import flag_kr from 'circle-flags/flags/kr.svg'
import flag_cn from 'circle-flags/flags/cn.svg'
import flag_tw from 'circle-flags/flags/tw.svg'
import flag_hk from 'circle-flags/flags/hk.svg'
import flag_us from 'circle-flags/flags/us.svg'
import flag_es from 'circle-flags/flags/es.svg'
import flag_fr from 'circle-flags/flags/fr.svg'
import flag_de from 'circle-flags/flags/de.svg'
import flag_it from 'circle-flags/flags/it.svg'
import flag_br from 'circle-flags/flags/br.svg'
import flag_ru from 'circle-flags/flags/ru.svg'
import flag_in from 'circle-flags/flags/in.svg'
import flag_th from 'circle-flags/flags/th.svg'
import flag_vn from 'circle-flags/flags/vn.svg'
import flag_id from 'circle-flags/flags/id.svg'
import flag_tr from 'circle-flags/flags/tr.svg'
import flag_pl from 'circle-flags/flags/pl.svg'
import flag_nl from 'circle-flags/flags/nl.svg'
import flag_se from 'circle-flags/flags/se.svg'
import flag_no from 'circle-flags/flags/no.svg'
import flag_dk from 'circle-flags/flags/dk.svg'
import flag_fi from 'circle-flags/flags/fi.svg'
import flag_gr from 'circle-flags/flags/gr.svg'
import flag_ua from 'circle-flags/flags/ua.svg'
import flag_cz from 'circle-flags/flags/cz.svg'
import flag_hu from 'circle-flags/flags/hu.svg'
import flag_ro from 'circle-flags/flags/ro.svg'
import flag_ph from 'circle-flags/flags/ph.svg'
import flag_va from 'circle-flags/flags/va.svg'
import flag_bg from 'circle-flags/flags/bg.svg'
import flag_ie from 'circle-flags/flags/ie.svg'
import flag_gb_wls from 'circle-flags/flags/gb-wls.svg'
import flag_eo from 'circle-flags/flags/language/eo.svg'
import flag_ge from 'circle-flags/flags/ge.svg'
import flag_am from 'circle-flags/flags/am.svg'
import flag_kh from 'circle-flags/flags/kh.svg'
import flag_la from 'circle-flags/flags/la.svg'
import flag_mn from 'circle-flags/flags/mn.svg'
import flag_ee from 'circle-flags/flags/ee.svg'
import flag_lv from 'circle-flags/flags/lv.svg'
import flag_al from 'circle-flags/flags/al.svg'
import flag_by from 'circle-flags/flags/by.svg'
import flag_es_pv from 'circle-flags/flags/es-pv.svg'
import flag_gb_sct from 'circle-flags/flags/gb-sct.svg'
import flag_mt from 'circle-flags/flags/mt.svg'

export const FLAG_URLS: Readonly<Record<string, string>> = {
  jp: flag_jp,
  kr: flag_kr,
  cn: flag_cn,
  tw: flag_tw,
  hk: flag_hk,
  us: flag_us,
  es: flag_es,
  fr: flag_fr,
  de: flag_de,
  it: flag_it,
  br: flag_br,
  ru: flag_ru,
  in: flag_in,
  th: flag_th,
  vn: flag_vn,
  id: flag_id,
  tr: flag_tr,
  pl: flag_pl,
  nl: flag_nl,
  se: flag_se,
  no: flag_no,
  dk: flag_dk,
  fi: flag_fi,
  gr: flag_gr,
  ua: flag_ua,
  cz: flag_cz,
  hu: flag_hu,
  ro: flag_ro,
  ph: flag_ph,
  va: flag_va,
  bg: flag_bg,
  ie: flag_ie,
  'gb-wls': flag_gb_wls,
  eo: flag_eo,
  ge: flag_ge,
  am: flag_am,
  kh: flag_kh,
  la: flag_la,
  mn: flag_mn,
  ee: flag_ee,
  lv: flag_lv,
  al: flag_al,
  by: flag_by,
  'es-pv': flag_es_pv,
  'gb-sct': flag_gb_sct,
  mt: flag_mt
}

/** A flag's picture by the table's name (`language/eo` is accepted for `eo`), or null. */
export function flagUrl(name: string | null | undefined): string | null {
  if (!name) return null
  return FLAG_URLS[name] ?? FLAG_URLS[name.replace(/^language\//, '')] ?? null
}
