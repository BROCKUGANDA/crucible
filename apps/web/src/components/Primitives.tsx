"use client";

import type { ReactNode } from "react";

type Tone = "success" | "warning" | "error" | "info" | "pending" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "badge badge--success",
  warning: "badge badge--warning",
  error: "badge badge--error",
  info: "badge badge--info",
  pending: "badge badge--pending",
  neutral: "badge badge--neutral",
};

export function StatusBadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={TONE_CLASS[tone]}>{children}</span>;
}

export function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="metric-card">
      <p className="metric-card__label">{label}</p>
      <p className={`metric-card__value metric-card__value--${tone}`}>{value}</p>
      {hint ? <p className="metric-card__hint">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      <p className="empty-state__body">{body}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="section-header">
      <h2 className="section-header__title">{title}</h2>
      {subtitle ? <p className="section-header__subtitle">{subtitle}</p> : null}
    </div>
  );
}
