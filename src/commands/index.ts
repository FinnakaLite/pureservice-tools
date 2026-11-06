// Register commands and jobs here. Adding a command = one folder + one line below.

import { Registry } from '../core/registry.ts';
import { helpCommand } from './help.ts';
import { fireReminder, reminders, remindme } from './remindme/index.ts';

export function buildRegistry(): Registry {
  const registry = new Registry();
  registry.addCommand(remindme).addCommand(reminders).addJob(fireReminder);
  registry.addCommand(helpCommand(registry));
  return registry;
}
