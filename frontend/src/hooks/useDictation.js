import React from 'react'

/**
 * Speaking to Simeli.
 *
 * The Web Speech API does the recognition — in-browser, no audio leaves the
 * page through us, and nothing is added to the payload the app already sends.
 * Chrome, Edge and Safari implement it; Firefox does not. Where it is missing
 * `supported` is false and the caller renders no microphone at all, because a
 * button that silently does nothing is worse than no button.
 *
 * Two transcripts come back while you speak: final segments, which are settled,
 * and an interim one that keeps being rewritten as the recogniser changes its
 * mind. Both go into the composer so you can watch it land, but only the final
 * text is kept — otherwise a half-heard word survives into the message you send.
 *
 * Dictation appends to what is already typed rather than replacing it, so you
 * can start a sentence with the keyboard and finish it out loud.
 */

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null

/** What actually went wrong, in words worth showing someone. */
const REASONS = {
  'not-allowed': 'Microphone access is blocked for this site. Allow it in your browser’s address bar and try again.',
  'service-not-allowed': 'This browser refused to start speech recognition.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection and could not reach it.',
  aborted: null, // you stopped it; that is not an error worth a message
  'no-speech': null, // silence is not a failure either
}

export default function useDictation({ locale, onText, onError } = {}) {
  const [listening, setListening] = React.useState(false)

  // Everything the recogniser's callbacks need, held in refs: those callbacks
  // are attached once and would otherwise close over the first render's values.
  const recRef = React.useRef(null)
  const baseRef = React.useRef('')
  const finalRef = React.useRef('')
  const onTextRef = React.useRef(onText)
  const onErrorRef = React.useRef(onError)
  React.useEffect(() => { onTextRef.current = onText }, [onText])
  React.useEffect(() => { onErrorRef.current = onError }, [onError])

  const stop = React.useCallback(() => {
    try { recRef.current?.stop() } catch { /* already stopped */ }
  }, [])

  const start = React.useCallback((currentText = '') => {
    if (!Recognition || recRef.current) return

    const rec = new Recognition()
    rec.continuous = true
    rec.interimResults = true
    if (locale) rec.lang = locale
    recRef.current = rec

    baseRef.current = currentText ? `${currentText.replace(/\s+$/, '')} ` : ''
    finalRef.current = ''

    rec.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0]?.transcript || ''
        if (event.results[i].isFinal) finalRef.current += chunk
        else interim += chunk
      }
      const settled = finalRef.current.replace(/\s+/g, ' ').trimStart()
      onTextRef.current?.(baseRef.current + settled + interim, { settled: false })
    }

    rec.onerror = (event) => {
      const reason = REASONS[event.error]
      if (reason) onErrorRef.current?.(reason)
    }

    rec.onend = () => {
      recRef.current = null
      setListening(false)
      // Commit only what was settled — the interim tail is dropped so nothing
      // the recogniser was still unsure about ends up in a sent message.
      const settled = finalRef.current.replace(/\s+/g, ' ').trim()
      onTextRef.current?.((baseRef.current + settled).trimEnd(), { settled: true })
    }

    try {
      rec.start()
      setListening(true)
    } catch {
      recRef.current = null
      setListening(false)
      onErrorRef.current?.('Could not start the microphone.')
    }
  }, [locale])

  const toggle = React.useCallback((currentText) => {
    if (recRef.current) stop()
    else start(currentText)
  }, [start, stop])

  // Leaving the page must not leave the microphone open.
  React.useEffect(() => () => {
    try { recRef.current?.abort() } catch { /* nothing running */ }
    recRef.current = null
  }, [])

  return { supported: !!Recognition, listening, start, stop, toggle }
}
