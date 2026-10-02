// Opens the Settings dialog (NavBar cog, Ctrl+,). A second call while it is open returns the same promise.
import { dialogs } from '../../services/dialogs';
import SettingsDialog from './SettingsDialog.vue';

let open: Promise<boolean | undefined> | null = null;

/** Resolves true after a successful save, undefined when cancelled. */
export function openSettings(): Promise<boolean | undefined> {
  open ??= dialogs.open<boolean>(SettingsDialog).finally(() => {
    open = null;
  });
  return open;
}
