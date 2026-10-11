// Krok 4.1: pokusný skript, stream z modelu do terminálu (bez serveru).
// Spuštění v apps/server: node --env-file=.env src/try-stream.ts
import { client, model } from './model.ts';

const stream = await client.chat.completions.create({
  model: model!,
  stream: true,
  // usage přijde v posledním chunku (OpenRouter ho posílá vždy, OpenAI jen s touto volbou)
  stream_options: { include_usage: true },
  messages: [
    { role: 'system', content: 'Jsi recepční Ordinace Lipová. Odpovídej česky.' },
    { role: 'user', content: 'Popiš ve třech větách, jak se objednat na odběr krve.' },
  ],
});

for await (const chunk of stream) {
  // chunk nese jen přírůstek textu v delta; poslední chunk má prázdné choices a nese usage
  const text = chunk.choices[0]?.delta.content;
  if (text) process.stdout.write(text);
  if (chunk.usage) console.log('\n\nusage:', chunk.usage);
}
