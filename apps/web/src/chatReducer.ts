// Krok 6: stav chatu skládaný z eventů PocEvent (stejný typ posílá server).
// Akce = eventy ze serveru + dvě lokální akce UI (start a stop).
// Krok 9.5: volání nástrojů agenta v poli toolCalls, v UI jako řádky nad odpovědí.
// Krok 10: zápis čekající na schválení v poli approval (karta se Schválit / Zamítnout); po kliknutí akce
// resume: chat se nemaže, rozhodnutí přibude jako řádek a stream z approve/decline pokračuje do stejného stavu.
import type { PocEvent, Usage } from '@ordinace/shared'

export type ChatState = {
  text: string
  thinking: string
  toolCalls: string[] // popisky od serveru, třeba „hledám pacienta Dvořáková…“
  approval: { runId: string; label: string } | null // zápis čeká na rozhodnutí člověka
  usage: Usage | null
  status: 'idle' | 'streaming' | 'done' | 'error'
  error: string | null
}

export type ChatAction =
  | PocEvent
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'resume'; decision: 'approve' | 'decline' }

export const initialChat: ChatState = {
  text: '', thinking: '', toolCalls: [], approval: null, usage: null, status: 'idle', error: null,
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'start':
      return { ...initialChat, status: 'streaming' }
    case 'stop':
      return { ...state, status: 'idle' }
    case 'resume': {
      const decided = state.approval ? [`${state.approval.label}: ${action.decision === 'approve' ? 'schváleno' : 'zamítnuto'}`] : []
      return { ...state, toolCalls: [...state.toolCalls, ...decided], approval: null, status: 'streaming', error: null }
    }
    case 'thinking':
      return { ...state, thinking: state.thinking + action.text }
    case 'tool_call':
      return { ...state, toolCalls: [...state.toolCalls, action.label] }
    case 'approval_required':
      return { ...state, approval: { runId: action.runId, label: action.label } }
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
