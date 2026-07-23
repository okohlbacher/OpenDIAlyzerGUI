/** The only bridge between renderer and data layer. Message passing, so the
 *  same surface works when the data layer moves into a Web Worker. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  pick: () => ipcRenderer.invoke("session:pick"),
  open: (report: string, archive?: string) => ipcRenderer.invoke("session:open", report, archive),
  filter: (spec: unknown, offset?: number, limit?: number, grain?: string, view?: unknown) =>
    ipcRenderer.invoke("rows:filter", spec, offset, limit, grain, view),
  page: (offset: number, limit: number) => ipcRenderer.invoke("rows:page", offset, limit),
  evidence: (k: number) => ipcRenderer.invoke("evidence:for", k),
  presence: (k: number) => ipcRenderer.invoke("evidence:presence", k),
  interrogate: (k: number, runIndex: number) =>
    ipcRenderer.invoke("evidence:interrogate", k, runIndex),
  /** Fired once at startup when a path was given on the command line. */
  onAutoload: (fn: (report: string) => void) =>
    ipcRenderer.on("session:autoload", (_e, p: string) => fn(p)),
  onAutoloadFailed: (fn: (input: string) => void) =>
    ipcRenderer.on("session:autoload-failed", (_e, p: string) => fn(p)),
});
