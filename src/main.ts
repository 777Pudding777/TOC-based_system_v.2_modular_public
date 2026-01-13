import "./styles.css";

import * as BUI from "@thatopen/ui";

import { initViewer } from "./viewer/initViewer";
import { createViewerApi } from "./viewer/api";
import { createToast } from "./ui/toast";
import { mountTree } from "./ui/tree";
import { mountPanel } from "./ui/panel";
import { createIfcUpload } from "./viewer/upload";
import { createSnapshotCollector } from "./modules/snapshotCollector";
import { createSnapshotDb } from "./storage/snapshotDb";
import { createMockVlmAdapter, createVlmChecker } from "./modules/vlmChecker";
import { createComplianceDb } from "./storage/complianceDb";
import { createNavigationAgent } from "./modules/navigationAgent";
import { createComplianceRunner } from "./modules/complianceRunner";



// Application Initialization
BUI.Manager.init(); // do this immediately once

const viewerDiv = document.getElementById("viewer") as HTMLDivElement;
const treeRoot = document.getElementById("overlay-top-left") as HTMLDivElement;
const panelRoot = document.getElementById("overlay-top-right") as HTMLDivElement;
const toastRoot = document.getElementById("overlay-bottom-left") as HTMLDivElement;

const toast = createToast(toastRoot);

const ctx = await initViewer(viewerDiv);
const viewerApi = createViewerApi(ctx);

// Navigation Agent module initialization
const navigationAgent = createNavigationAgent({
  viewerApi,
  toast,
});
(window as any).navigationAgent = navigationAgent;

// Snapshot Collector and Storage DB module initialization
const snapshotDb = createSnapshotDb();

const snapshotCollector = createSnapshotCollector({
  viewerApi,
  toast,
  autoCaptureOnModelLoad: false,
  defaultMode: "RENDER_PLUS_JSON_METADATA",
  persistToIndexedDb: true,
});
snapshotCollector.start();
(window as any).snapshotCollector = snapshotCollector;

let panelHandle: { rerender: () => void } | null = null;

const upload = createIfcUpload({
  ifcLoader: ctx.ifcLoader,
  viewerApi,
  toast,
  onLoadingChange: () => panelHandle?.rerender(),
});

(window as any).snapshotDb = snapshotDb; // handy for debugging

// VLM Checker module initialization
const complianceDb = createComplianceDb();
const vlmChecker = createVlmChecker(createMockVlmAdapter());
(window as any).complianceDb = complianceDb;
(window as any).vlmChecker = vlmChecker;

// Compliance Runner module initialization
const complianceRunner = createComplianceRunner({
  viewerApi,
  snapshotCollector,
  vlmChecker,
  complianceDb,
  navigationAgent, // optional
  toast,
});

(window as any).complianceRunner = complianceRunner;

// UI Mounting
panelHandle = mountPanel({
  panelRoot,
  viewerApi,
  upload,
  snapshotCollector,
  vlmChecker,
  complianceDb,
  complianceRunner,
  navigationAgent, // optional
  toast,
});


viewerApi.onModelLoaded(() => panelHandle?.rerender());
mountTree({ treeRoot, ctx, viewerApi, toast });

toast("Viewer booted");

console.log("[BOOT] app initialized", new Date().toISOString());



