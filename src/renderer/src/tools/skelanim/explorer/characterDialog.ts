// Opens the Character dialog (tools/skelanim/CharacterDialog.vue) as a custom modal. Used by the explorer (double-click,
// "Edit Character…", after New Character); other UI (e.g. the control panel's reference picker) may call it too.
import type { CharacterMeta } from '../../../core/model';
import { dialogs } from '../../../services/dialogs';
import CharacterDialog from '../CharacterDialog.vue';

/** Resolves the saved meta, or undefined when the dialog was closed without saving. */
export function openCharacterDialog(charRel: string): Promise<CharacterMeta | undefined> {
  return dialogs.open<CharacterMeta>(CharacterDialog, { charRel });
}
