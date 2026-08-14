import { configure } from "@testing-library/react";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#values.set(String(key), String(value));
  }
}

function hasWebStorageMethods(storage: Storage): boolean {
  return (
    typeof storage.clear === "function" &&
    typeof storage.getItem === "function" &&
    typeof storage.key === "function" &&
    typeof storage.removeItem === "function" &&
    typeof storage.setItem === "function"
  );
}

function readLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const existingLocalStorage =
  typeof window === "undefined" ? null : readLocalStorage();

if (
  typeof window !== "undefined" &&
  (existingLocalStorage === null || !hasWebStorageMethods(existingLocalStorage))
) {
  const localStorage = new MemoryStorage();
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    value: localStorage,
  };

  Object.defineProperty(window, "localStorage", descriptor);
  Object.defineProperty(globalThis, "localStorage", descriptor);
}

// Match loaded CI runners: the default 1s async-utility timeout flakes while
// the suite-level Vitest timeout still bounds real hangs.
configure({ asyncUtilTimeout: 10_000 });
