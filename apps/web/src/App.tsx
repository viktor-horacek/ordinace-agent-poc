import { useReducer, useRef, useState } from 'react'
import './App.css'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import type { PocEvent } from '@ordinace/shared'
import { chatReducer, initialChat } from './chatReducer.ts'

// Chat shell: krok 5 = čtení streamu z POST /api/chat, krok 6 = stav přes eventy PocEvent (@ordinace/shared).

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [chat, dispatch] = useReducer(chatReducer, initialChat)
  const streaming = chat.status === 'streaming'
  const abortRef = useRef<AbortController | null>(null)

  async function send() {
    dispatch({ type: 'start' })
    const abort = new AbortController()
    abortRef.current = abort

    try {
      // EventSource umí jen GET, proto fetch a ruční čtení těla odpovědi
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      // bajty → text (TextDecoderStream nerozbije znak s diakritikou rozdělený mezi dva kusy)
      // → hotové SSE eventy (eventsource-parser skládá rozdělené eventy, řeší komentáře, \r\n, id)
      const reader = res.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        // data jsou JSON s tvarem PocEvent; za běhu to neověřujeme (věříme vlastnímu serveru),
        // pro jistotu by šel přidat zod i tady
        dispatch(JSON.parse(value.data) as PocEvent)
      }
    } catch (error) {
      if (abort.signal.aborted) return // zastavil uživatel, stav už nastavil stop()
      dispatch({ type: 'error', message: String(error) })
    }
  }

  function stop() {
    // zrušení fetch zavře spojení; server to pozná a zruší volání modelu (krok 4.4)
    abortRef.current?.abort()
    dispatch({ type: 'stop' })
  }

  return (
    <main className="chat">
      <h1>Recepce Ordinace Lipová</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Zpráva pacienta, třeba: Máte zítra ráno volno?"
          rows={4}
        />
        <div className="actions">
          <button type="submit" disabled={streaming || !prompt.trim()}>
            Odeslat
          </button>
          <button type="button" onClick={stop} disabled={!streaming}>
            Zastavit
          </button>
        </div>
      </form>

      {chat.thinking && (
        <details className="thinking" open={streaming && !chat.text}>
          <summary>Přemýšlí…</summary>
          <pre>{chat.thinking}</pre>
        </details>
      )}

      <section className="answer" aria-live="polite">
        {chat.text || <span className="muted">Odpověď se objeví tady.</span>}
      </section>

      {chat.error && <p className="error">{chat.error}</p>}

      {chat.usage && (
        <p className="usage">
          vstup {chat.usage.input} · výstup {chat.usage.output} tokenů
          {chat.usage.reasoning ? ` · přemýšlení ${chat.usage.reasoning}` : ''}
        </p>
      )}
    </main>
  )
}
