// Krok 6: překlad z formátu providera na náš protokol PocEvent a zápis do SSE.
// Jediné místo, které zná tvar chunku od OpenRouteru. Prohlížeč zná jen PocEvent,
// takže výměna providera (nebo přidání nástrojů v krocích 8–9) mění jen tenhle soubor.
import type { ServerResponse } from 'node:http';
import type { ChatStreamChunk, ReasoningDetailUnion } from '@openrouter/sdk/models';
import type { PocEvent } from '@ordinace/shared';

// Přemýšlení chodí buď jako prostý text v `reasoning`, nebo strukturovaně v `reasoningDetails`
// (discriminated union podle `type`). Šifrované přemýšlení a neznámé typy se nezobrazují.
function detailText(detail: ReasoningDetailUnion): string {
  switch (detail.type) {
    case 'reasoning.text':
      return detail.text ?? '';
    case 'reasoning.summary':
      return detail.summary; // jen shrnutí, ne surové přemýšlení (třeba u modelů OpenAI)
    default:
      return '';
  }
}

export function chunkToEvents(chunk: ChatStreamChunk): PocEvent[] {
  const events: PocEvent[] = [];
  // chyba může přijít i uprostřed streamu jako pole chunku, ne jako HTTP status
  if (chunk.error) events.push({ type: 'error', message: chunk.error.message });

  const delta = chunk.choices[0]?.delta;
  const thinking = delta?.reasoning || (delta?.reasoningDetails ?? []).map(detailText).join('');
  if (thinking) events.push({ type: 'thinking', text: thinking });
  if (delta?.content) events.push({ type: 'text', text: delta.content });

  if (chunk.usage) {
    events.push({
      type: 'usage',
      usage: {
        input: chunk.usage.promptTokens,
        output: chunk.usage.completionTokens,
        reasoning: chunk.usage.completionTokensDetails?.reasoningTokens ?? undefined,
      },
    });
  }
  return events;
}

/** Jeden SSE event; název eventu = pole type, ať jde filtrovat v DevTools. */
export function toSse(res: ServerResponse, event: PocEvent) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
