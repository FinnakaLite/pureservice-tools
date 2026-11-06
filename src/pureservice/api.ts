// Typed, purpose-built calls on top of the client. Field names and filter
// syntax were verified against smith.pureservice.com (docs/PROPOSAL.md §9).

import type { PureServiceClient } from './client.ts';

export const CommunicationType = { Note: 1, Message: 2, Sms: 3, Solution: 4 } as const;
export const Direction = { Inbound: 1, Outbound: 2, None: 3 } as const;
export const UserRole = { Enduser: 10, Agent: 20, ZoneAdmin: 25, Administrator: 30, System: 50 } as const;

export interface Communication {
  id: number;
  type: number;
  direction: number;
  visibility: number;
  text: string | null;
  ticketId: number | null;
  createdById: number;
  created: string;
  modified: string;
}

export interface User {
  id: number;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  role: number;
  emailAddressId: number | null;
  disabled?: boolean;
}

export interface NotesPage {
  notes: Communication[];
  users: Map<number, User>;
}

/** The narrow surface the rest of the bot depends on — easy to fake in tests. */
export interface PureServiceApi {
  newestNoteId(): Promise<number | null>;
  notesAfter(afterId: number, limit: number): Promise<NotesPage>;
  findBotNote(ticketId: number, marker: string): Promise<Communication | null>;
  /** mentionUserIds: users to notify. Each gets a Mention record, created in the same request as the note. */
  createInternalNote(ticketId: number, html: string, mentionUserIds?: number[]): Promise<Communication>;
  userEmail(user: User): Promise<string | null>;
}

const first = <T>(body: any, key: string): T[] => (Array.isArray(body?.[key]) ? body[key] : []);

export function createApi(client: PureServiceClient): PureServiceApi {
  const emailCache = new Map<number, string | null>();

  return {
    async newestNoteId() {
      const body = await client.get('/communication/', { filter: `type == ${CommunicationType.Note}`, sort: 'id desc', limit: 1 });
      return first<Communication>(body, 'communications')[0]?.id ?? null;
    },

    async notesAfter(afterId, limit) {
      // Server-side: internal notes only, after the cursor, containing "!" at all.
      // The dispatcher does the precise "command at line start" matching.
      const body = await client.get('/communication/', {
        filter: `type == ${CommunicationType.Note} AND id > ${Math.max(0, Math.floor(afterId))} AND text.Contains("!")`,
        sort: 'id asc',
        limit,
        include: 'createdBy',
      });
      const users = new Map<number, User>();
      for (const u of first<User>(body?.linked, 'users')) users.set(u.id, u);
      return { notes: first<Communication>(body, 'communications'), users };
    },

    async findBotNote(ticketId, marker) {
      const safe = marker.replace(/[^A-Za-z0-9:_-]/g, '');
      const body = await client.get('/communication/', {
        filter: `ticketId == ${ticketId} AND type == ${CommunicationType.Note} AND text.Contains("${safe}")`,
        limit: 1,
      });
      return first<Communication>(body, 'communications')[0] ?? null;
    },

    async createInternalNote(ticketId, html, mentionUserIds = []) {
      // Hard-coded type/direction: the bot can never create a Message (which e-mails the end user).
      //
      // Mentions: the @-markup in the text only renders the chip. PureService notifies a
      // mentioned agent (regardless of who the ticket is assigned to) only when a Mention
      // record exists for the note, which is what the agent UI creates. The records are
      // side-loaded with JSON:API temporary ids, so the note and its mentions are created
      // atomically in one request. Verified on smith.pureservice.com 2026-11-06: this
      // produces a "notification-mention-other" notification.
      const tmp = mentionUserIds.map((_, i) => `m${i + 1}`);
      const links: Record<string, unknown> = { ticket: { id: ticketId } };
      if (tmp.length) links.mentions = tmp.map((temporaryId) => ({ temporaryId, type: 'mention' }));
      const payload: Record<string, unknown> = {
        communications: [{ text: html, type: CommunicationType.Note, direction: Direction.None, links }],
      };
      if (tmp.length) {
        payload.linked = {
          mentions: mentionUserIds.map((userId, i) => ({
            temporaryId: tmp[i], userId, ticketId, links: { user: { id: userId }, ticket: { id: ticketId } },
          })),
        };
      }
      const body = await client.post('/communication/', payload);
      const created = first<Communication>(body, 'communications')[0];
      if (!created) throw new Error('PureService accepted the note but returned no communication');
      return created;
    },

    async userEmail(user) {
      if (!user.emailAddressId) return null;
      if (emailCache.has(user.emailAddressId)) return emailCache.get(user.emailAddressId) ?? null;
      let email: string | null = null;
      try {
        const body = await client.get(`/emailaddress/${user.emailAddressId}`);
        const e = first<any>(body, 'emailaddresses')[0] ?? first<any>(body, 'emailAddresses')[0];
        email = typeof e?.email === 'string' ? e.email : typeof e?.address === 'string' ? e.address : null;
      } catch {
        email = null; // a mention still works via data-mention-user-id; the mailto is cosmetic
      }
      emailCache.set(user.emailAddressId, email);
      return email;
    },
  };
}
