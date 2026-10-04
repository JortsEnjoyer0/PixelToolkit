// Where Img to PixelArt's images come from besides the open dialog: picking the image from a drop or a clipboard
// paste, and useImagePaste() for Ctrl+V while a sub-tool is shown. Shared by ImageInput.vue and the sub-tools.
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, type Ref } from 'vue';
import { OPEN_IMAGE_EXTENSIONS } from '@shared/image';
import { isModalOpen } from '../../services/dialogs';
import { isTextEditable } from '../../services/shortcuts';

const EXTENSIONS: readonly string[] = OPEN_IMAGE_EXTENSIONS;

/** An image/* type, or no type but an extension the open dialog offers. */
export function isImageFile(file: File): boolean {
  if (file.type !== '')
    return file.type.startsWith('image/');
  const dot = file.name.lastIndexOf('.');
  return dot >= 0 && EXTENSIONS.includes(file.name.slice(dot + 1).toLowerCase());
}

/** The first image among dropped files; otherwise the first file, so decoding can say why it is not one. */
export function pickDroppedFile(files: FileList | null | undefined): File | null {
  const list = [...files ?? []];
  return list.find(isImageFile) ?? list[0] ?? null;
}

/** The first image on the clipboard (a copied image, or a copied image file), or null. */
export function clipboardImageFile(data: DataTransfer | null): File | null {
  if (!data)
    return null;
  for (const item of data.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/'))
      continue;
    const file = item.getAsFile();
    if (file)
      return file;
  }
  return [...data.files].find(isImageFile) ?? null;
}

/**
 * Call `onImage` for Ctrl+V of an image while the calling component is shown: the document listener lives from mount /
 * activation to deactivation / unmount (KeepAlive), and a `root` that is not in the document (hidden tool) ignores it.
 * Skipped while a modal is open, when pasting into a text field and when another handler took the paste.
 */
export function useImagePaste(root: Readonly<Ref<HTMLElement | null>>, onImage: (file: File) => void): void {
  let listening = false;

  function onPaste(e: ClipboardEvent): void {
    if (e.defaultPrevented || isModalOpen() || isTextEditable(e.target) || !root.value?.isConnected)
      return;
    const file = clipboardImageFile(e.clipboardData);
    if (!file)
      return;
    e.preventDefault();
    onImage(file);
  }

  function start(): void {
    if (listening)
      return;
    listening = true;
    document.addEventListener('paste', onPaste);
  }

  function stop(): void {
    listening = false;
    document.removeEventListener('paste', onPaste);
  }

  // onActivated does not run for a component mounted later inside an already active KeepAlive tree: onMounted covers it
  onMounted(start);
  onActivated(start);
  onDeactivated(stop);
  onBeforeUnmount(stop);
}
