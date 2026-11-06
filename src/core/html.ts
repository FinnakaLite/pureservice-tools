// Note text in PureService is HTML (e.g. "<p>!remindme 5d</p>"). These helpers
// turn it into plain lines for command matching, and build safe HTML for replies.

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

/**
 * HTML → trimmed, non-empty plain-text lines.
 * Quoted/pasted content (blockquote, pre, code) and HTML comments are dropped,
 * so a pasted bot reply or a quoted command can never trigger anything.
 */
export function htmlToLines(html: string): string[] {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(blockquote|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|table)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/[ ​]/g, ' ');
  return s.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface MentionTarget {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
}

/**
 * Same markup the PureService editor produces. The markup alone only renders the
 * @-chip: the *notification* comes from a separate Mention record, which the
 * outbox creates for every user found by mentionedUserIds() (see api.ts).
 */
export function mentionHtml(u: MentionTarget): string {
  const name = `${u.firstName} ${u.lastName}`.trim();
  const href = u.email ? `mailto:${escapeHtml(u.email)}` : '#';
  return `<a class="x-ps-autocomplete-mention" href="${href}" data-mention="true" data-mention-user-id="${u.id}"` +
    ` data-mention-firstname="${escapeHtml(u.firstName)}" data-mention-lastname="${escapeHtml(u.lastName)}">@${escapeHtml(name)}</a>`;
}

export const MAX_MENTIONS_PER_NOTE = 10;

/**
 * User ids of the mention anchors in bot-generated HTML, deduplicated, in order.
 * User-supplied text is always escaped (quotes become &quot;), so it can't fake one.
 */
export function mentionedUserIds(html: string): number[] {
  const ids = new Set<number>();
  for (const m of html.matchAll(/<a\b[^>]*\bclass="x-ps-autocomplete-mention"[^>]*\bdata-mention-user-id="(\d+)"/g)) {
    ids.add(Number(m[1]));
    if (ids.size >= MAX_MENTIONS_PER_NOTE) break;
  }
  return [...ids];
}

/** A command is "!name" at the very start of a line. Returns name (lowercased) + raw args. */
export function commandLines(html: string): { name: string; args: string }[] {
  const out: { name: string; args: string }[] = [];
  for (const line of htmlToLines(html)) {
    const m = /^!([\p{L}][\p{L}\d_-]*)(?:\s+(.*))?$/u.exec(line);
    if (m) out.push({ name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() });
  }
  return out;
}
