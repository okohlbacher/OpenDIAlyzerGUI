/** The only bridge between renderer and data layer. Message passing, so the
 *  same surface works when the data layer moves into a Web Worker. */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("api", {
  pick: () => ipcRenderer.invoke("session:pick"),
  /** Electron removed File.path; this is the supported replacement. Without it
   *  drag-and-drop silently drops every file. */
  pathOf: (f: File) => webUtils.getPathForFile(f),
  project: {
    get: () => ipcRenderer.invoke("project:get"),
    addFiles: (paths: string[]) => ipcRenderer.invoke("project:addFiles", paths),
    setValue: (row: number, column: string, value: string) =>
      ipcRenderer.invoke("project:setValue", row, column, value),
    addColumn: (name: string) => ipcRenderer.invoke("project:addColumn", name),
    setInvestigation: (inv: unknown) => ipcRenderer.invoke("project:setInvestigation", inv),
    import: () => ipcRenderer.invoke("project:import"),
    export: () => ipcRenderer.invoke("project:export"),
    forRuns: () => ipcRenderer.invoke("project:forRuns"),
    clear: () => ipcRenderer.invoke("project:clear"),
  },
  engines: (paths?: string[]) => ipcRenderer.invoke("setup:engines", paths),
  pickRuns: () => ipcRenderer.invoke("setup:pickRuns"),
  pickFile: (kind: string) => ipcRenderer.invoke("setup:pickFile", kind),
  inspect: (paths: string[], enginePath?: string) =>
    ipcRenderer.invoke("setup:inspect", paths, enginePath),
  buildPlan: (job: unknown) => ipcRenderer.invoke("setup:plan", job),
  presets: () => ipcRenderer.invoke("setup:presets"),
  open: (report: string, archive?: string) => ipcRenderer.invoke("session:open", report, archive),
  targets: () => ipcRenderer.invoke("targets:list"),
  filter: (spec: unknown, offset?: number, limit?: number, grain?: string, view?: unknown) =>
    ipcRenderer.invoke("rows:filter", spec, offset, limit, grain, view),
  page: (offset: number, limit: number) => ipcRenderer.invoke("rows:page", offset, limit),
  toggle: (id: string, open?: boolean) => ipcRenderer.invoke("tree:toggle", id, open),
  expandLevel: (level: string) => ipcRenderer.invoke("tree:level", level),
  evidence: (k: number) => ipcRenderer.invoke("evidence:for", k),
  presence: (k: number) => ipcRenderer.invoke("evidence:presence", k),
  frame: (k: number, mzWindow?: number, specLimit?: number) =>
    ipcRenderer.invoke("evidence:frame", k, mzWindow, specLimit),
  interrogate: (k: number, runIndex: number) =>
    ipcRenderer.invoke("evidence:interrogate", k, runIndex),
  forRun: (k: number, runIndex: number) =>
    ipcRenderer.invoke("evidence:forRun", k, runIndex),
  /** Fired once at startup when a path was given on the command line. */
  onAutoload: (fn: (report: string) => void) =>
    ipcRenderer.on("session:autoload", (_e, p: string) => fn(p)),
  onAutoloadFailed: (fn: (input: string) => void) =>
    ipcRenderer.on("session:autoload-failed", (_e, p: string) => fn(p)),
});
