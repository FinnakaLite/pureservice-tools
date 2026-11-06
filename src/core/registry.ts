// The plugin surface. A command is one object with a name and a run() function;
// a job is a named handler the scheduler calls when its time comes.
// Commands only get a context (reply / schedule / cancel / read-only queries) —
// never the HTTP client — so they cannot bypass the bot's safety rules.

import type { DateTime } from 'luxon';
import type { Config } from '../config.ts';
import type { Logger } from './log.ts';
import type { JobRow, Store } from './store.ts';

export interface NoteAuthor {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  role: number;
  email: string | null;
}

export interface NoteEvent {
  communicationId: number;
  ticketId: number;
  author: NoteAuthor;
  html: string;
  created: DateTime;
}

/** Read-only queries a command may use. */
export interface JobQueries {
  get(id: number): JobRow | null;
  active(filter: { type?: string; createdBy?: number; ticketId?: number }): JobRow[];
}

interface BaseContext {
  readonly now: DateTime;            // in the configured time zone
  readonly config: Config;
  readonly jobs: JobQueries;
  readonly log: Logger;
  /** Queue an internal note on the current ticket. The 🤖 prefix is added for you. */
  reply(html: string): void;
}

export interface CommandContext extends BaseContext {
  readonly note: NoteEvent;
  /** Schedule a job; returns its id immediately (shown to users as e.g. R-12). */
  schedule(type: string, runAt: DateTime, payload: unknown): number;
  /** Cancel a pending job (applied together with the rest of this command's effects). */
  cancelJob(id: number): void;
}

export interface JobContext<P = unknown> extends BaseContext {
  readonly job: JobRow;
  readonly payload: P;
  /** How late the job is running (0 when on time). */
  readonly lateByMs: number;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  summary: string;
  /** Example lines for !help, without the leading "!" (it is added in <code>). */
  usage: string[];
  run(ctx: CommandContext, args: string): void | Promise<void>;
}

export interface JobDef<P = any> {
  type: string;
  run(ctx: JobContext<P>): void | Promise<void>;
}

export const defineCommand = (c: CommandDef) => c;
export const defineJob = <P>(j: JobDef<P>) => j;

export class Registry {
  private readonly commands = new Map<string, CommandDef>();
  private readonly primary: CommandDef[] = [];
  private readonly jobDefs = new Map<string, JobDef>();

  addCommand(c: CommandDef): this {
    for (const key of [c.name, ...(c.aliases ?? [])].map((k) => k.toLowerCase())) {
      if (this.commands.has(key)) throw new Error(`Command name/alias "${key}" registered twice`);
      this.commands.set(key, c);
    }
    this.primary.push(c);
    return this;
  }

  addJob(j: JobDef): this {
    if (this.jobDefs.has(j.type)) throw new Error(`Job type "${j.type}" registered twice`);
    this.jobDefs.set(j.type, j);
    return this;
  }

  command(name: string): CommandDef | undefined { return this.commands.get(name.toLowerCase()); }
  job(type: string): JobDef | undefined { return this.jobDefs.get(type); }
  list(): readonly CommandDef[] { return this.primary; }
}

export function jobQueries(store: Store): JobQueries {
  return {
    get: (id) => store.getJob(id),
    active: (f) => store.activeJobs(f),
  };
}
