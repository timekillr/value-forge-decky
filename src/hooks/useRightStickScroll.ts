import { useEffect, useState, type RefObject } from 'react';

interface ControllerState { unControllerIndex: number; sRightStickY: number }
interface Registration { unregister(): void }
interface NativeInput {
  RegisterForControllerStateChanges?: (callback: (states: ControllerState[]) => void) => Registration | undefined;
  RegisterForControllerListChanges?: (callback: (controllers: { nControllerIndex: number }[]) => void) => Registration | undefined;
}
const DEAD_ZONE = 0.22;

/** Observe the controller only while this plugin is visible. Never change a
 * controller layout, synthesize game input, or unregister Steam's other listeners.
 */
export function useRightStickScroll(rootRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;
    let active = true;
    let focused = true;
    let frame = 0;
    let lastFrame = window.performance.now();
    const nativeAxes = new Map<number, { axis: number; at: number }>();
    let connectedControllers: Set<number> | null = null;
    const input = (window as unknown as { SteamClient?: { Input?: NativeInput } }).SteamClient?.Input;
    let registration: Registration | undefined;
    let listRegistration: Registration | undefined;
    let disconnectTracking = false;
    let nativeAvailable = false;
    if (typeof input?.RegisterForControllerStateChanges === 'function') {
      try {
        registration = input.RegisterForControllerStateChanges(states => {
          if (!active || !Array.isArray(states)) return;
          for (const state of states) {
            if (connectedControllers && !connectedControllers.has(state.unControllerIndex)) continue;
            if (typeof state.sRightStickY !== 'number' || !Number.isFinite(state.sRightStickY)) continue;
            nativeAxes.set(state.unControllerIndex, {
              // Steam's signed short is positive up; DOM scroll is positive down.
              axis: Math.max(-1, Math.min(1, -state.sRightStickY / 32767)),
              at: window.performance.now(),
            });
          }
        });
        nativeAvailable = true;
        if (typeof input.RegisterForControllerListChanges === 'function') {
          listRegistration = input.RegisterForControllerListChanges(controllers => {
            if (!active || !Array.isArray(controllers)) return;
            const connected = new Set(controllers.map(controller => controller.nControllerIndex));
            connectedControllers = connected;
            for (const index of nativeAxes.keys()) if (!connected.has(index)) nativeAxes.delete(index);
          });
          disconnectTracking = true;
        }
      } catch { /* Fall back to the browser Gamepad API when Steam omits it. */ }
    }
    const webAvailable = typeof window.navigator.getGamepads === 'function';
    setAvailable(nativeAvailable || webAvailable);
    const oldMaxHeight = root.style.maxHeight;
    const oldOverflow = root.style.overflowY;
    let ownScroller = false;
    const scrollTarget = () => {
      for (let node: HTMLElement | null = root; node; node = node.parentElement) {
        if (node.scrollHeight <= node.clientHeight + 1) continue;
        if (/auto|scroll/.test(window.getComputedStyle(node).overflowY)) return node;
      }
      // Normally Steam provides the scroll container. On clients that do not,
      // bound just this plugin instead of scrolling unrelated Steam UI.
      if (!ownScroller) {
        root.style.maxHeight = 'calc(100vh - 180px)';
        root.style.overflowY = 'auto';
        ownScroller = true;
      }
      return root.scrollHeight > root.clientHeight + 1 ? root : null;
    };
    const reset = () => { nativeAxes.clear(); focused = false; };
    const focus = () => { focused = true; lastFrame = window.performance.now(); };
    window.addEventListener('blur', reset);
    window.addEventListener('focus', focus);
    const tick = (now: number) => {
      if (!active) return;
      frame = window.requestAnimationFrame(tick);
      const dt = Math.max(0, Math.min(0.05, (now - lastFrame) / 1000));
      lastFrame = now;
      if (!focused || document.hidden || !root.isConnected || !root.getClientRects().length) return;
      const target = document.activeElement;
      if (target && target !== document.body && target !== document.documentElement && !root.contains(target)) return;
      let axis = 0;
      if (webAvailable) {
        try {
          for (const controller of Array.from(window.navigator.getGamepads())) {
            if (!controller || controller.connected === false) continue;
            const value = controller.axes[3];
            if (Number.isFinite(value) && Math.abs(value) > Math.abs(axis)) axis = Math.max(-1, Math.min(1, value));
          }
        } catch { /* Native callbacks may still be available. */ }
      }
      for (const [index, value] of nativeAxes) {
        // Avoid stuck scrolling if a controller disconnects without a neutral report.
        if (!disconnectTracking && now - value.at > 1000) { nativeAxes.delete(index); continue; }
        if (Math.abs(value.axis) > Math.abs(axis)) axis = value.axis;
      }
      if (Math.abs(axis) <= DEAD_ZONE) return;
      const scroller = scrollTarget();
      if (!scroller) return;
      const speed = Math.sign(axis) * (Math.abs(axis) - DEAD_ZONE) / (1 - DEAD_ZONE) * 900;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + speed * dt));
    };
    if (nativeAvailable || webAvailable) frame = window.requestAnimationFrame(tick);
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('blur', reset);
      window.removeEventListener('focus', focus);
      // Only release our own registration. The global unregister call could
      // remove Steam's listeners or another plugin's input subscription.
      registration?.unregister?.();
      listRegistration?.unregister?.();
      nativeAxes.clear();
      if (ownScroller) { root.style.maxHeight = oldMaxHeight; root.style.overflowY = oldOverflow; }
    };
  }, [rootRef, enabled]);
  return available;
}
