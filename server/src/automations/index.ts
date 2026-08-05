import { registerLogAutomation } from './logAutomation.js';
import { registerPushAutomation } from './pushAutomation.js';
import { registerSupportIntake } from './supportIntake.js';
import { registerTicketStatus } from './ticketStatus.js';

export function registerAutomations(): void {
  registerLogAutomation();
  registerPushAutomation();
  registerSupportIntake();
  registerTicketStatus();
}
