import "./styles.css";
import * as BUI from "@thatopen/ui";

import { initViewer } from "./viewer/initViewer";
import { createViewerApi } from "./viewer/api";
import { createToast } from "./ui/toast";
import { mountTree } from "./ui/tree";
import { mountPanel } from "./ui/panel";
import { createIfcUpload } from "./viewer/upload";

const viewerDiv = document.getElementById("viewer") as HTMLDivElement;
const treeRoot = document.getElementById("overlay-top-left") as HTMLDivElement;
const panelRoot = document.getElementById("overlay-top-right") as HTMLDivElement;
const toastRoot = document.getElementById("overlay-bottom-left") as HTMLDivElement;

const toast = createToast(toastRoot);

const ctx = await initViewer(viewerDiv);
const viewerApi = createViewerApi(ctx);

BUI.Manager.init();

const upload = createIfcUpload({
  ifcLoader: ctx.ifcLoader,
  toast,
});

mountPanel({ panelRoot, viewerApi, upload, toast });
mountTree({ treeRoot, ctx, viewerApi, toast });

toast("Viewer booted");

console.log("[BOOT] app initialized", new Date().toISOString());



