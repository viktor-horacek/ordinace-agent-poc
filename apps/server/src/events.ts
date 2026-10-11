// Krok 6: překlad z formátu providera na náš protokol PocEvent a zápis do SSE.
// Jediné místo, které zná tvar chunku z OpenAI SDK. Prohlížeč zná jen PocEvent,
// takže výměna providera (nebo přidání reasoning a nástrojů v krocích 7–9) mění jen tenhle soubor.
import type { ServerResponse } from 'node:http';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { PocEvent } from '@ordinace/shared';

// OpenRouter přidává do delta přemýšlení modelu; typy openai SDK o těchto polích nevědí.
// Podle dokumentace chodí ve streamu reasoning_details, některé modely posílají i prostý reasoning.
type OrDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning?: string | null;
  reasoning_details?: { type: string; text?: string; summary?: string }[];
};

function reasoningText(delta: OrDelta | undefined): string {
  if (!delta) return '';
  if (delta.reasoning) return delta.reasoning;
  // reasoning.text nese text přemýšlení, reasoning.summary jen shrnutí (třeba u modelů OpenAI)
  return (delta.reasoning_details ?? []).map((d) => d.text ?? d.summary ?? '').join('');
}

export function chunkToEvents(chunk: ChatCompletionChunk): PocEvent[] {
  const events: PocEvent[] = [];
  const delta = chunk.choices[0]?.delta as OrDelta | undefined;
  const thinking = reasoningText(delta);
  if (thinking) events.push({ type: 'thinking', text: thinking });
  const text = delta?.content;
  if (text) events.push({ type: 'text', text });
  if (chunk.usage) {
    events.push({
      type: 'usage',
      usage: {
        input: chunk.usage.prompt_tokens,
        output: chunk.usage.completion_tokens,
        reasoning: chunk.usage.completion_tokens_details?.reasoning_tokens,
      },
    });
  }
  return events;
}

/** Jeden SSE event; název eventu = pole type, ať jde filtrovat v DevTools. */
export function toSse(res: ServerResponse, event: PocEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
