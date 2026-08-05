import { registerLogAutomation } from './logAutomation.js';
import { registerPushAutomation } from './pushAutomation.js';

export function registerAutomations(): void {
  registerLogAutomation();
  registerPushAutomation();
}
