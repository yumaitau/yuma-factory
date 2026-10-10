'use client';
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, PointerSensor, pointerWithin, rectIntersection,
  useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

type Board = { active: string | null; columnOf: (card: string) => string | undefined; canDrop: (card: string, column: string) => boolean };
const BoardContext = createContext<Board>({ active: null, columnOf: () => undefined, canDrop: () => false });

// Keyboard drags have no pointer, so fall back to the dragged card's rectangle.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

// Arrow keys jump to the next column that accepts the card, instead of nudging it 25px.
const columnKeys: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (event.code !== 'ArrowRight' && event.code !== 'ArrowLeft') return;
  event.preventDefault();
  const width = context.collisionRect?.width ?? 0;
  // Start from the column the card is over: on fast key repeats the card's own rectangle can lag.
  const over = context.over && context.droppableRects.get(context.over.id);
  const center = over ? over.left + over.width / 2 : currentCoordinates.x + width / 2;
  const rects = context.droppableContainers.getEnabled().flatMap((column) => context.droppableRects.get(column.id) ?? [])
    .sort((a, b) => a.left - b.left);
  const next = event.code === 'ArrowRight' ? rects.find((rect) => rect.left > center) : rects.reverse().find((rect) => rect.right < center);
  return next && { x: next.left + (next.width - width) / 2, y: currentCoordinates.y };
};

/** Drag and drop for a column board. Invalid columns are disabled, so a drop only ever lands on a valid one. */
export function BoardDnd({ id, children, columnOf, canDrop, onMove, onDragging, cardLabel, columnLabel, overlay }: {
  id: string; children: ReactNode;
  columnOf: (card: string) => string | undefined;
  canDrop: (card: string, column: string) => boolean;
  onMove: (card: string, column: string) => void;
  onDragging?: (dragging: boolean) => void;
  cardLabel: (card: string) => string;
  columnLabel: (column: string) => string;
  overlay: (card: string) => ReactNode;
}) {
  const [active, setActive] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeys, scrollBehavior: 'auto' }),
  );
  function end(card: string | null, column?: string) {
    setActive(null);
    onDragging?.(false);
    if (card && column && canDrop(card, column)) onMove(card, column);
  }
  return <BoardContext value={{ active, columnOf, canDrop }}>
    <DndContext id={id} sensors={sensors} collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      accessibility={{ announcements: {
        onDragStart: ({ active }) => `Picked up ${cardLabel(String(active.id))}. Use left and right arrows to choose a column.`,
        onDragOver: ({ over }) => over ? `Over ${columnLabel(String(over.id))}.` : 'Not over a column that accepts this task.',
        onDragEnd: ({ active, over }) => over ? `Moved ${cardLabel(String(active.id))} to ${columnLabel(String(over.id))}.` : `${cardLabel(String(active.id))} was not moved.`,
        onDragCancel: ({ active }) => `Cancelled. ${cardLabel(String(active.id))} was not moved.`,
      } }}
      onDragStart={({ active }) => { setActive(String(active.id)); onDragging?.(true); }}
      onDragEnd={({ active, over }) => end(String(active.id), over ? String(over.id) : undefined)}
      onDragCancel={() => end(null)}>
      {children}
      <DragOverlay dropAnimation={null}>{active && overlay(active)}</DragOverlay>
    </DndContext>
  </BoardContext>;
}

/** A drop target. While a card is dragged it is highlighted when valid and dimmed when not. */
export function BoardColumn({ id, className, children, ...props }: { id: string } & ComponentProps<'section'>) {
  const board = useContext(BoardContext);
  const valid = !!board.active && board.canDrop(board.active, id);
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !valid });
  const state = !board.active ? undefined : valid ? (isOver ? 'over' : 'valid') : board.columnOf(board.active) === id ? 'source' : 'invalid';
  return <section ref={setNodeRef} data-drop={state} {...props} className={cn(className, 'transition-[opacity,background-color,box-shadow] duration-150 ease-out',
    state === 'valid' && 'ring-1 ring-inset ring-primary/25',
    state === 'over' && 'bg-primary/5 ring-1 ring-inset ring-primary/60',
    state === 'invalid' && 'opacity-50')}>{children}</section>;
}

// Form controls keep their own pointer behaviour; the handle, links and text start a drag.
const ownsPointer = (target: EventTarget) => target instanceof Element && !!target.closest('select, input, textarea, button:not([aria-roledescription])');

/**
 * A draggable card. Pointer drags start anywhere on the card; keyboard drags start from the handle
 * passed to `children`. `blocked` explains why the card cannot move. With `onOpen`, the card is
 * focusable and Enter or Space on the card itself opens it.
 */
export function BoardCard({ id, label, blocked, onOpen, className, children }: {
  id: string; label: string; blocked?: string | null; onOpen?: () => void; className?: string; children: (handle: ReactNode) => ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({ id, disabled: !!blocked });
  const handle = <button type="button" ref={setActivatorNodeRef} {...attributes}
    aria-label={blocked ? `Cannot move ${label}. ${blocked}` : `Move ${label}`}
    title={blocked ?? 'Drag to move. With the keyboard, press Space, then the arrow keys.'}
    className={cn('-m-1 shrink-0 rounded p-1 text-muted-foreground/60 transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      blocked ? 'cursor-not-allowed' : 'cursor-grab')}>
    <GripVertical className="size-3.5" aria-hidden />
  </button>;
  return <article ref={setNodeRef} {...listeners} title={blocked ?? undefined} data-card={id}
    tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? label : undefined}
    onPointerDown={(event) => { if (!ownsPointer(event.target)) listeners?.onPointerDown?.(event); }}
    onKeyDown={(event) => {
      // The keyboard sensor only starts a drag from the handle, so keys on the card itself are free.
      listeners?.onKeyDown?.(event);
      if (onOpen && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); }
    }}
    className={cn(className, !blocked && 'cursor-grab active:cursor-grabbing', isDragging && 'opacity-40',
      onOpen && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
    {children(handle)}
  </article>;
}
