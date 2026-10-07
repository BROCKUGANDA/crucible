"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The one dialog in the app, in the forge's own language.
 *
 * Not a `<dialog>`: `showModal()` gives focus trapping and a top layer for free, but its
 * backdrop cannot be animated with the pour, and Safari's implementation still differs on
 * Esc handling inside forms. So the three things that make a dialog *usable* are done here
 * explicitly and can be tested:
 *
 *   1. Esc closes it, and only the topmost one.
 *   2. Tab and Shift-Tab cannot leave it.
 *   3. Focus returns to whatever opened it, so a keyboard operator is not dropped at the
 *      top of the document.
 *
 * Closing is requested, never performed by this component: the parent owns `open`, because
 * a dialog that dismisses itself mid-transaction is how a stake gets lost.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** the footer actions */
  actions?: ReactNode;
  onRequestClose: () => void;
  /** set while the parent is mid-action: blocks Esc, the backdrop and the close button */
  busy?: boolean;
}

export function Modal({ open, title, children, actions, onRequestClose, busy = false }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<Element | null>(null);

  // Portal targets only exist after hydration; rendering it on the server would emit a
  // document.createElement during render.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    setClosing(false);
    const node = panel.current;
    // The panel itself is the first stop: a dialog nobody can reach by keyboard is a trap
    // in the wrong direction.
    node?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = restoreTo.current;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onRequestClose();
        return;
      }
      if (e.key !== "Tab") return;

      const node = panel.current;
      if (!node) return;
      const stops = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }
      // The document's active element, not the panel's: the panel is itself focusable, and
      // `document.activeElement` is how you can tell "still on the panel" from "inside".
      const active = document.activeElement as HTMLElement | null;
      const index = active ? stops.indexOf(active) : -1;

      let target: HTMLElement | undefined = e.shiftKey ? stops[index - 1] : stops[index + 1];
      // Walking off either end wraps, which is what makes the dialog a ring rather than a wall.
      if (index === -1) target = e.shiftKey ? stops[stops.length - 1] : stops[0];
      else if (index === 0 && e.shiftKey) target = stops[stops.length - 1];
      else if (index === stops.length - 1 && !e.shiftKey) target = stops[0];

      if (!target) return;
      e.preventDefault();
      target.focus();
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onRequestClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="scrim"
      // A backdrop click is a request, not a close: clicking through a modal that is
      // waiting on a transaction receipt would discard the only record of it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onRequestClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="dialog"
        data-state={closing ? "closing" : "open"}
        data-busy={busy || undefined}
      >
        <header>
          <h2>{title}</h2>
          <button
            type="button"
            className="dialog-x"
            onClick={() => {
              setClosing(true);
              setTimeout(() => onRequestClose(), 200);
            }}
            disabled={busy}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {actions ? <footer>{actions}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A pour is anything that moves the caller's own money: the bond, the break stake, the
 * reward escrow. A click should never be able to spend without naming the amount first —
 * a wallet prompt describing `0x…` calldata is not informed consent.
 */
export function PourConfirm({
  open,
  title,
  amount,
  detail,
  confirmLabel,
  busy,
  onConfirm,
  onRequestClose,
}: {
  open: boolean;
  title: string;
  amount: string;
  detail: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onRequestClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      busy={busy}
      onRequestClose={onRequestClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRequestClose} disabled={busy}>
            Step back
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Heating…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="pour-amount">
        <span className="kicker">Leaving your wallet</span>
        <strong>{amount}</strong>
      </p>
      <div className="pour-detail">{detail}</div>
    </Modal>
  );
}
