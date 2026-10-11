import { useState } from 'react'
import './App.css'

// Hotový chat shell. Nové je jen napojení na server:
// krok 5 = čtení streamu z POST /api/chat, krok 6 = stav přes eventy PocEvent (@ordinace/shared).

type Usage = { input: number; output: number; reasoning?: number }
type Status = 'idle' | 'streaming' | 'done' | 'error'

type ChatState = {
  text: string
  thinking: string
  usage: Usage | null
  status: Status
  error: string | null
}

const initial: ChatState = { text: '', thinking: '', usage: null, status: 'idle', error: null }

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [chat, setChat] = useState<ChatState>(initial)
  const streaming = chat.status === 'streaming'

  async function send() {
    setChat({ ...initial, status: 'streaming' })
    // TODO krok 5: fetch('/api/chat', { method: 'POST', body: { prompt }, signal }) a čtení streamu.
    // Do té doby UI jen ukáže, co by odešlo:
    setChat({ ...initial, text: `(zatím bez serveru) ${prompt}`, status: 'done' })
  }

  function stop() {
    // TODO krok 5: AbortController.abort(); server pak ukončí volání modelu (krok 4)
    setChat((prev) => ({ ...prev, status: 'idle' }))
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
