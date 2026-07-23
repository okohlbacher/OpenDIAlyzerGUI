/** The only bridge between renderer and data layer. Message passing, so the
 *  same surface works when the data layer moves into a Web Worker. */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("api", {
  pick: () => ipcRenderer.invoke("session:pick"),
  /** Electron removed File.path; this is the supported replacement. Without it
   *  drag-and-drop silently drops every file. */
  pathOf: (f: File) => webUtils.getPathForFile(f),
  engines: (paths?: string[]) => ipcRenderer.invoke("setup:engines", paths),
  pickRuns: () => ipcRenderer.invoke("setup:pickRuns"),
  pickFile: (kind: string) => ipcRenderer.invoke("setup:pickFile", kind),
  inspect: (paths: string[], enginePath?: string) =>
    ipcRenderer.invoke("setup:inspect", paths, enginePath),
  buildPlan: (job: unknown) => ipcRenderer.invoke("setup:plan", job),
  presets: () => ipcRenderer.invoke("setup:presets"),
  open: (report: string, archive?: string) => ipcRenderer.invoke("session:open", report, archive),
  filter: (spec: unknown, offset?: number, limit?: number, grain?: string, view?: unknown) =>
    ipcRenderer.invoke("rows:filter", spec, offset, limit, grain, view),
  page: (offset: number, limit: number) => ipcRenderer.invoke("rows:page", offset, limit),
  toggle: (id: string, open?: boolean) => ipcRenderer.invoke("tree:toggle", id, open),
  expandLevel: (level: string) => ipcRenderer.invoke("tree:level", level),
  evidence: (k: number) => ipcRenderer.invoke("evidence:for", k),
  presence: (k: number) => ipcRenderer.invoke("evidence:presence", k),
  frame: (k: number, mzWindow?: number) => ipcRenderer.invoke("evidence:frame", k, mzWindow),
  interrogate: (k: number, runIndex: number) =>
    ipcRenderer.invoke("evidence:interrogate", k, runIndex),
  /** Fired once at startup when a path was given on the command line. */
  onAutoload: (fn: (report: string) => void) =>
    ipcRenderer.on("session:autoload", (_e, p: string) => fn(p)),
  onAutoloadFailed: (fn: (input: string) => void) =>
    ipcRenderer.on("session:autoload-failed", (_e, p: string) => fn(p)),
});
