'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useLayoutEffect, useSyncExternalStore } from 'react';

import { applyTheme, readTheme, saveTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  // Another tab changed the choice: follow it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyTheme(readTheme());
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Light, dark or system. The inline script in the root layout applies the stored choice before paint. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'system' as const);
  // React's development remount resets <html> attributes, clearing the one the inline script set.
  useLayoutEffect(() => applyTheme(readTheme()), []);
  function choose(next: Theme) {
    saveTheme(next);
    applyTheme(next);
    listeners.forEach((listener) => listener());
  }
  return (
    <fieldset className="inline-flex shrink-0 items-center rounded-full border border-border p-0.5">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <label
          key={value}
          title={label}
          className="relative grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground has-[:checked]:bg-muted has-[:checked]:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            onChange={() => choose(value)}
            className="absolute inset-0 cursor-pointer appearance-none rounded-full opacity-0"
          />
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </label>
      ))}
    </fieldset>
  );
}
