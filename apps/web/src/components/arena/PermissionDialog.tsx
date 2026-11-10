"use client";

/**
 * PermissionDialog — a permission-denied state that explains what is required
 * and how to obtain it.
 */
export function PermissionDialog({
  open,
  title,
  message,
  requiredRole,
  onClose,
  onSignIn,
}: {
  open: boolean;
  title: string;
  message: string;
  requiredRole?: string;
  onClose: () => void;
  onSignIn?: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="surface permission-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-dialog-title"
    >
      <h3 id="permission-dialog-title" className="permission-dialog__title" data-tone="sear">
        {title}
      </h3>
      <p className="permission-dialog__message">{message}</p>
      {requiredRole && (
        <p className="permission-dialog__role mono">
          Required role: {requiredRole}
        </p>
      )}
      <div className="permission-dialog__actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        {onSignIn && (
          <button type="button" className="btn btn-primary" onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}
