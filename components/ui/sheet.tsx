'use client';

import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export const Sheet = SheetPrimitive.Root;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;

/** A full-height dialog that slides in from the right, over the page. */
export function SheetContent({ className, children, ...props }: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-40 bg-foreground/10 motion-safe:data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <SheetPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[600px] flex-col border-l border-border bg-background shadow-xl outline-none motion-safe:data-[state=open]:animate-[sheet-in_200ms_ease-out]',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute right-3 top-3 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" aria-hidden />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}
