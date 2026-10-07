/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
// Preserve the vendor importer and try its normal browser decoder first.
export function linuxImageLoader(original, invoke) {
  return async function (content, mediaType, transfer) {
    try {
      return await original.call(this, content, mediaType, transfer)
    } catch (error) {
      if (mediaType !== 'image/avif') throw error
      const png = await invoke('linux_dictionary_image', {
        content: Array.from(new Uint8Array(content))
      })
      const converted = new Uint8Array(png).buffer
      return original.call(this, converted, 'image/png', transfer)
    }
  }
}

export async function installLinuxDictionaryImages(win) {
  if ((await win.chrome.runtime.getPlatformInfo()).os !== 'linux') return
  const { DictionaryImporterMediaLoader } = await import('/js/dictionary/dictionary-importer-media-loader.js')
  const prototype = DictionaryImporterMediaLoader.prototype
  if (prototype.kimochiLinuxImages) return
  prototype.getImageDetails = linuxImageLoader(
    prototype.getImageDetails,
    (command, args) => win.__TAURI__.core.invoke(command, args)
  )
  prototype.kimochiLinuxImages = true
}

export function dictionaryImageType(media) {
  if (media.mediaType !== 'image/avif') return media.mediaType
  const bytes = new Uint8Array(media.content)
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  return signature.every((byte, index) => bytes[index] === byte) ? 'image/png' : media.mediaType
}
