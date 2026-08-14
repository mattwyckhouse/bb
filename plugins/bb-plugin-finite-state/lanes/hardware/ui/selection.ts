import { useSyncExternalStore } from "react";

export interface HardwareSelection {
  projectKey: string;
  kind: "part" | "net" | null;
  reference?: string;
  netName?: string;
}

const emptySelection: HardwareSelection = { projectKey: "", kind: null };
let selection: HardwareSelection = emptySelection;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSelection(next: HardwareSelection): void {
  selection = next;
  for (const listener of listeners) listener();
}

export function useHardwareSelection(): [
  HardwareSelection,
  (next: HardwareSelection) => void,
] {
  const current = useSyncExternalStore(
    subscribe,
    () => selection,
    () => emptySelection,
  );
  return [current, setSelection];
}

export function resetHardwareSelectionForTests(): void {
  setSelection(emptySelection);
}
