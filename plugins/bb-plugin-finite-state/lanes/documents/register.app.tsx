import type { PluginAppBuilder } from "@bb/plugin-sdk/app";
import type { AppContext } from "../../lib/app-context.js";
import { DocumentOpener } from "./app/document-opener.js";
import { DocumentsPanel } from "./app/documents-panel.js";

export function registerDocumentsApp(
  app: PluginAppBuilder,
  _ctx: AppContext,
): void {
  app.slots.navPanel({
    id: "documents",
    title: "Documents",
    icon: "FileText",
    path: "documents",
    component: DocumentsPanel,
  });
  app.slots.fileOpener({
    id: "finite-state-document",
    title: "Finite State document",
    extensions: [
      "pdf",
      "csv",
      "xlsx",
      "svd",
      "xml",
      "txt",
      "h",
      "hpp",
      "c",
      "inc",
    ],
    component: DocumentOpener,
  });
}
