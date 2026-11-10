"use client";

/**
 * ConfirmationDialog — an accessible dialog for consequential, irreversible
 * operations. Never makes irreversible operations look like ordinary navigation.
 */
export function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  destructive = false,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  if (!open) return null;

  return (
    <div
      className="surface confirmation-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-dialog-title"
      aria-describedby="confirmation-dialog-message"
    >
      <h3 id="confirmation-dialog-title" className="confirmation-dialog__title">
        {title}
      </h3>
      <p id="confirmation-dialog-message" className="confirmation-dialog__message">
        {message}
      </p>
      <div className="confirmation-dialog__actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${destructive ? "btn-destructive" : "btn-primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
