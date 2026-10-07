/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
// Linux only: the main-window media loader may return PNG for unsupported AVIF.
// Keep the original dictionary path, but store the true MIME type with the bytes.
import { DictionaryImporter } from '../js/dictionary/dictionary-importer.js'
import { dictionaryImageType } from './linux-dictionary-images.js'
import '../js/dictionary/dictionary-worker-main.js'

const original = DictionaryImporter.prototype._getImageMedia
DictionaryImporter.prototype._getImageMedia = async function (...args) {
  const media = await original.apply(this, args)
  media.mediaType = dictionaryImageType(media)
  return media
}
