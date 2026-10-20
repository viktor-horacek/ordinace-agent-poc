// Krok 4.1: pokusný skript, stream z modelu do terminálu (bez serveru).
// Spuštění v apps/server: node --env-file=.env src/try-stream.ts
import { describeError } from './errors.ts';
import { streamChat } from './model.ts';

try {
  const stream = await streamChat({
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
} catch (error) {
  // nezachycenou chybu by Node vypsal celou, i s Authorization hlavičkou z SDK
  console.error(describeError(error));
  process.exitCode = 1;
}
