// !help — lists every registered command. Usage examples are wrapped in <code>,
// which the dispatcher ignores, so the help note can never trigger a command.

import { escapeHtml } from '../core/html.ts';
import { defineCommand, type Registry } from '../core/registry.ts';

export function helpCommand(registry: Registry) {
  return defineCommand({
    name: 'help',
    aliases: ['hjelp', 'bot'],
    summary: 'Viser hvilke kommandoer boten forstår.',
    usage: ['help'],
    run(ctx) {
      const items = registry.list()
        .filter((c) => c.name !== 'help')
        .map((c) => `<b>${escapeHtml(c.name)}</b> – ${escapeHtml(c.summary)}<br>` +
          c.usage.map((u) => `<code>!${escapeHtml(u)}</code>`).join(' · '));
      ctx.reply(`Kommandoer (skriv dem først på en linje i et internt notat):<br><br>${items.join('<br><br>')}`);
    },
  });
}
