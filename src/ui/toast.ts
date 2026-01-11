// src/ui/toast.ts
/**
 * Toast helper for bottom-left overlay.
 *
 * Design decisions:
 * - Simple DOM-based: no dependencies, deterministic, easy to debug.
 * - Returns a function (closure) instead of a class:
 *   - makes it easy to pass around to UI modules without storing state elsewhere.
 * - pointer-events are disabled in CSS to avoid blocking 3D interaction.
 */
export type ToastFn = (message: string, ms?: number) => void;

export function createToast(toastRoot: HTMLElement | null): ToastFn {
  return (message: string, ms = 5000) => {
    if (!toastRoot) return;

    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;

    toastRoot.appendChild(el);

    window.setTimeout(() => {
      el.remove();
    }, ms);
  };
}
