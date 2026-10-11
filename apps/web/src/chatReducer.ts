// Krok 6: stav chatu skládaný z eventů PocEvent (stejný typ posílá server).
// Akce = eventy ze serveru + dvě lokální akce UI (start a stop).
import type { PocEvent, Usage } from '@ordinace/shared'

export type ChatState = {
  text: string
  thinking: string
  usage: Usage | null
  status: 'idle' | 'streaming' | 'done' | 'error'
  error: string | null
}

export type ChatAction = PocEvent | { type: 'start' } | { type: 'stop' }

export const initialChat: ChatState = { text: '', thinking: '', usage: null, status: 'idle', error: null }

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'start':
      return { ...initialChat, status: 'streaming' }
    case 'stop':
      return { ...state, status: 'idle' }
    case 'thinking':
      return { ...state, thinking: state.thinking + action.text }
    case 'text':
      return { ...state, text: state.text + action.text }
    case 'usage':
      return { ...state, usage: action.usage }
    case 'done':
      return { ...state, status: 'done' }
    case 'error':
      return { ...state, status: 'error', error: action.message }
    default: {
      // když ve shared přibude nový event a tady chybí case, typecheck spadne právě tady
      const unhandled: never = action
      return unhandled
    }
  }
}
