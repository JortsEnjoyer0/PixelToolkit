import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type ApiEventName, type ApiEvents, type PixelToolkitApi } from '../shared/api';

// Sandboxed preload: may only import 'electron'. Expose a narrow, typed API; never ipcRenderer itself.

const EVENTS: readonly ApiEventName[] = [IPC.appBeforeClose, IPC.jobsUpdate];

const closeListeners = new Set<() => void>();

ipcRenderer.on(IPC.appBeforeClose, () => {
  if (closeListeners.size === 0) {
    // Nothing registered (e.g. the testbed): nothing to flush, close right away
    void ipcRenderer.invoke(IPC.appCloseReady);
    return;
  }
  ipcRenderer.send(IPC.appCloseAck);
  for (const cb of closeListeners) {
    try {
      cb();
    } catch (e) {
      console.error(`[${IPC.appBeforeClose}] listener failed`, e);
    }
  }
});

function on<K extends ApiEventName>(event: K, cb: (payload: ApiEvents[K]) => void): () => void {
  if (!EVENTS.includes(event))
    throw new Error(`Unknown api event: ${String(event)}`);
  if (event === IPC.appBeforeClose) {
    const listener = (): void => (cb as () => void)();
    closeListeners.add(listener);
    return () => {
      closeListeners.delete(listener);
    };
  }
  const listener = (_e: IpcRendererEvent, payload: ApiEvents[K]): void => cb(payload);
  ipcRenderer.on(event, listener);
  return () => {
    ipcRenderer.removeListener(event, listener);
  };
}

const api: PixelToolkitApi = {
  fs: {
    readJson: (rel) => ipcRenderer.invoke(IPC.fsReadJson, rel),
    writeJson: (rel, data, opts) => ipcRenderer.invoke(IPC.fsWriteJson, rel, data, opts),
    readBinary: (rel) => ipcRenderer.invoke(IPC.fsReadBinary, rel),
    writeBinary: (rel, bytes, opts) => ipcRenderer.invoke(IPC.fsWriteBinary, rel, bytes, opts),
    rename: (fromRel, toRel) => ipcRenderer.invoke(IPC.fsRename, fromRel, toRel),
    mkdir: (rel) => ipcRenderer.invoke(IPC.fsMkdir, rel),
    trash: (rel) => ipcRenderer.invoke(IPC.fsTrash, rel),
    deleteFiles: (rels) => ipcRenderer.invoke(IPC.fsDeleteFiles, rels),
    exists: (rel) => ipcRenderer.invoke(IPC.fsExists, rel),
    scanData: () => ipcRenderer.invoke(IPC.fsScanData),
    listDir: (rel) => ipcRenderer.invoke(IPC.fsListDir, rel)
  },
  settings: {
    read: () => ipcRenderer.invoke(IPC.settingsRead),
    write: (patch) => ipcRenderer.invoke(IPC.settingsWrite, patch)
  },
  images: {
    importBase: (charRel) => ipcRenderer.invoke(IPC.imagesImportBase, charRel),
    importReference: (charRel, animName) => ipcRenderer.invoke(IPC.imagesImportReference, charRel, animName),
    copyToAnimation: (charRel, srcFile, animName) => ipcRenderer.invoke(IPC.imagesCopyToAnimation, charRel, srcFile, animName)
  },
  pixellab: {
    balance: () => ipcRenderer.invoke(IPC.plBalance),
    estimateSkeleton: (imageRel) => ipcRenderer.invoke(IPC.plEstimateSkeleton, imageRel)
  },
  jobs: {
    submitAnimate: (input) => ipcRenderer.invoke(IPC.jobsSubmitAnimate, input),
    list: () => ipcRenderer.invoke(IPC.jobsList),
    get: (key) => ipcRenderer.invoke(IPC.jobsGet, key),
    ack: (key) => ipcRenderer.invoke(IPC.jobsAck, key),
    cancel: (key) => ipcRenderer.invoke(IPC.jobsCancel, key),
    retarget: (key, animRel) => ipcRenderer.invoke(IPC.jobsRetarget, key, animRel),
    rekey: (key, docId) => ipcRenderer.invoke(IPC.jobsRekey, key, docId)
  },
  app: {
    closeReady: () => ipcRenderer.invoke(IPC.appCloseReady),
    revealInExplorer: (rel) => ipcRenderer.invoke(IPC.appRevealInExplorer, rel),
    flashFrame: () => ipcRenderer.invoke(IPC.appFlashFrame),
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo)
  },
  on
};

contextBridge.exposeInMainWorld('api', api);
